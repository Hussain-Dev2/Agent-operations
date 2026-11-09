import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CloseCode,
  PairRequest,
  UpdateDeviceRequest,
  type Device,
  type DeviceList,
  type PairResponse,
  type PairingCodeResponse,
  ToolName,
  isActTool,
  type ToolInput,
} from "@operator/shared";
import type { Hub } from "../context.js";
import { HttpError, parse } from "../http.js";
import { authorizeTool } from "../services/access.js";
import { AgentOfflineError, InvalidArgsError, ToolError } from "../services/agents.js";
import { PairingLockedError, toDevice } from "../services/devices.js";
import { requireSession } from "./auth.js";

const IdParams = z.object({ id: z.uuid() });
const ToolParams = z.object({ id: z.uuid(), name: ToolName });
const ToolBody = z.object({ args: z.unknown().default({}) });
const PathQuery = z.object({ path: z.string().min(1).max(4096) });
const UploadQuery = PathQuery.extend({ offset: z.coerce.number().int().min(0).default(0) });
const CHUNK = 1024 * 1024;
/**
 * Tools that may open the desktop session. The first time on a machine that waits for the user to
 * approve the system's screen-sharing/remote-control dialog, so allow longer than usual.
 */
const DESKTOP_TOOLS = new Set<ToolName>(["list_monitors", "screenshot", "stream_start", "click", "double_click", "right_click", "drag", "scroll", "type_text", "press_keys", "input"]);
const DESKTOP_TIMEOUT_MS = 120_000;

function timeoutFor(name: ToolName): number {
  if (name === "run_command") return 610_000;
  return DESKTOP_TOOLS.has(name) ? DESKTOP_TIMEOUT_MS : 30_000;
}
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** Map device-side failures to HTTP errors the dashboard can show. */
function deviceError(error: unknown): never {
  if (error instanceof AgentOfflineError) throw new HttpError(409, "offline", "Device is offline");
  if (error instanceof InvalidArgsError) throw new HttpError(400, "validation", error.message);
  if (error instanceof ToolError) throw new HttpError(502, "device_error", error.message);
  throw error;
}

/** Audit-friendly copy of tool args: long strings (file data, typed text) are shortened. */
function summarizeArgs(args: unknown): unknown {
  if (typeof args === "string") return args.length > 200 ? `${args.slice(0, 200)}… (${args.length} chars)` : args;
  if (Array.isArray(args)) return args.slice(0, 20).map(summarizeArgs);
  if (args && typeof args === "object") return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, summarizeArgs(v)]));
  return args;
}

export function deviceRoutes(app: FastifyInstance, hub: Hub): void {
  // Uploads stream straight through; never buffer whole files in memory.
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
    done(null, payload);
  });

  const { devices, agents, audit, bus } = hub;

  async function load(id: string): Promise<NonNullable<Awaited<ReturnType<typeof devices.get>>>> {
    const row = await devices.get(id);
    if (!row) throw new HttpError(404, "not_found", "Device not found");
    return row;
  }

  // ---- Agent-facing (unauthenticated, code-gated) ----

  app.post(
    "/api/pair",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request): Promise<PairResponse> => {
      const body = parse(PairRequest, request.body);
      let row;
      try {
        row = await devices.pair(body);
      } catch (error) {
        if (error instanceof PairingLockedError) throw new HttpError(429, "pairing_locked", error.message);
        throw error;
      }
      if (!row) {
        await audit.record({ actor: "anonymous", action: "pairing.failed", ip: request.ip });
        throw new HttpError(400, "bad_code", "Pairing code is invalid, expired or already used");
      }
      await audit.record({
        actor: "device",
        action: "pairing.completed",
        deviceId: row.id,
        ip: request.ip,
        details: { name: row.name, os: row.os, hostname: row.hostname },
      });
      bus.publish({ type: "device_updated", device: toDevice(row, null) });
      return { deviceId: row.id, hubPublicKey: hub.hubPublicKey };
    },
  );

  // ---- Dashboard (session required) ----

  app.register((scoped, _opts, done) => {
    scoped.addHook("preHandler", requireSession);

    scoped.get("/api/devices", async (): Promise<DeviceList> => {
      const rows = await devices.list();
      return { devices: rows.map((r) => toDevice(r, agents.state(r.id))) };
    });

    scoped.post("/api/devices/pairing-codes", async (request): Promise<PairingCodeResponse> => {
      const { code, expiresAt } = await devices.createPairingCode();
      await audit.record({ actor: "owner", action: "pairing.code_created", ip: request.ip });
      const hubUrl = hub.config.publicWsUrl.replace(/^ws/, "http");
      return { code, expiresAt: expiresAt.toISOString(), hubUrl };
    });

    scoped.patch("/api/devices/:id", async (request): Promise<Device> => {
      const { id } = parse(IdParams, request.params);
      const patch = parse(UpdateDeviceRequest, request.body);
      const before = await load(id);
      const row = await devices.update(id, patch);
      if (!row) throw new HttpError(404, "not_found", "Device not found");
      await audit.record({
        actor: "owner",
        action: "device.updated",
        deviceId: id,
        ip: request.ip,
        details: {
          ...(patch.name !== undefined && { name: { from: before.name, to: row.name } }),
          ...(patch.permissionLevel !== undefined && {
            permissionLevel: { from: before.permissionLevel, to: row.permissionLevel },
          }),
        },
      });
      const device = toDevice(row, agents.state(id));
      bus.publish({ type: "device_updated", device });
      return device;
    });

    scoped.delete("/api/devices/:id", async (request) => {
      const { id } = parse(IdParams, request.params);
      if (!(await devices.remove(id))) throw new HttpError(404, "not_found", "Device not found");
      agents.disconnect(id, CloseCode.revoked, "Device removed");
      await audit.record({ actor: "owner", action: "device.removed", deviceId: id, ip: request.ip });
      bus.publish({ type: "device_removed", deviceId: id });
      return { ok: true };
    });

    /**
     * Run any Host Agent tool. Args are validated against the tool's schema before signing;
     * the access gate enforces permission level and kill switch; every action is audited.
     */
    scoped.post("/api/devices/:id/tools/:name", async (request) => {
      const { id, name } = parse(ToolParams, request.params);
      const { args } = parse(ToolBody, request.body ?? {});
      await authorizeTool(hub, id, name);
      if (isActTool(name) || name === "kill") {
        await audit.record({ actor: "owner", action: `tool.${name}`, deviceId: id, ip: request.ip, details: { args: summarizeArgs(args) } });
      }
      try {
        return await agents.invoke(id, name, args as ToolInput<typeof name>, timeoutFor(name));
      } catch (error) {
        deviceError(error);
      }
    });

    /** Stream a file from the device in 1 MiB signed chunks. */
    scoped.get("/api/devices/:id/files/download", async (request, reply) => {
      const { id } = parse(IdParams, request.params);
      const { path } = parse(PathQuery, request.query);
      await authorizeTool(hub, id, "file_read");
      const first = await agents.invoke(id, "file_read", { path, offset: 0, length: CHUNK }).catch(deviceError);
      await audit.record({ actor: "owner", action: "file.download", deviceId: id, ip: request.ip, details: { path, size: first.size } });
      async function* chunks(): AsyncGenerator<Buffer> {
        let chunk = first;
        let offset = 0;
        for (;;) {
          const data = Buffer.from(chunk.data, "base64");
          yield data;
          offset += data.length;
          if (chunk.eof || data.length === 0) return;
          chunk = await agents.invoke(id, "file_read", { path, offset, length: CHUNK });
        }
      }
      const filename = path.split(/[\\/]/).pop() ?? "download";
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-length", String(first.size))
        .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
        .send(Readable.from(chunks()));
    });

    /**
     * Upload (part of) a file to the device, written at `offset` (offset 0 truncates first). The
     * dashboard sends large files as several requests so no proxy body limit applies; each body
     * is streamed through in 1 MiB signed chunks.
     */
    scoped.put("/api/devices/:id/files/upload", async (request) => {
      const { id } = parse(IdParams, request.params);
      const { path, offset: start } = parse(UploadQuery, request.query);
      await authorizeTool(hub, id, "file_write");
      if (!(request.body instanceof Readable)) throw new HttpError(415, "unsupported", "Send the file as application/octet-stream");
      let offset = start;
      let pending = Buffer.alloc(0);
      const flush = async (data: Buffer): Promise<void> => {
        await agents.invoke(id, "file_write", { path, data: data.toString("base64"), offset }).catch(deviceError);
        offset += data.length;
      };
      for await (const piece of request.body as AsyncIterable<Buffer>) {
        pending = Buffer.concat([pending, piece]);
        if (offset + pending.length > MAX_UPLOAD_BYTES) throw new HttpError(413, "too_large", "File is larger than 2 GiB");
        while (pending.length >= CHUNK) {
          await flush(pending.subarray(0, CHUNK));
          pending = pending.subarray(CHUNK);
        }
      }
      if (pending.length > 0 || offset === 0) await flush(pending);
      if (start === 0) await audit.record({ actor: "owner", action: "file.upload", deviceId: id, ip: request.ip, details: { path } });
      return { ok: true, size: offset };
    });

    done();
  });
}
