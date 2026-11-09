import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import { z } from "zod";
import { CloseCode, DashboardToHub, type HubToDashboard } from "@operator/shared";
import type { Hub } from "../context.js";
import { HttpError } from "../http.js";
import { authorizeTool } from "../services/access.js";
import type { SessionInfo } from "../services/auth.js";

const Query = z.object({ ticket: z.string().min(1).max(128) });
/** A burst of input after this much quiet counts as a new take-over in the audit log. */
const TAKEOVER_GAP_MS = 60_000;

function parse(raw: RawData): DashboardToHub | null {
  try {
    const text = (Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw)).toString("utf8");
    const result = DashboardToHub.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * /ws/dashboard?ticket=… — live channel for signed-in browsers. Carries live updates down, and
 * viewer subscriptions + take-over input up. Every action is authorized exactly like REST calls
 * and reaches the device as a hub-signed command.
 */
export function dashboardGateway(app: FastifyInstance, hub: Hub): void {
  const sockets = new Map<string, Set<WebSocket>>();
  const lastInput = new Map<string, number>();

  async function handle(socket: WebSocket, session: SessionInfo, message: DashboardToHub, ip: string): Promise<void> {
    switch (message.type) {
      case "watch_screen":
        await authorizeTool(hub, message.deviceId, "stream_start");
        await hub.screens.watch(message.deviceId, socket, message.monitor, message.quality);
        return;
      case "unwatch_screen":
        hub.screens.unwatch(message.deviceId, socket);
        return;
      case "input": {
        await authorizeTool(hub, message.deviceId, "input");
        const key = `${session.sessionId}/${message.deviceId}`;
        const now = Date.now();
        if (now - (lastInput.get(key) ?? 0) > TAKEOVER_GAP_MS) {
          await hub.audit.record({ actor: "owner", action: "device.takeover", deviceId: message.deviceId, ip });
        }
        lastInput.set(key, now);
        hub.agents.fire(message.deviceId, "input", { events: message.events });
        return;
      }
      case "watch_pty": {
        await authorizeTool(hub, message.deviceId, "pty_read");
        hub.terminals.watch(message.deviceId, message.id, socket);
        const { data } = await hub.agents.invoke(message.deviceId, "pty_read", { id: message.id });
        if (data) send(socket, { type: "pty_data", deviceId: message.deviceId, id: message.id, data });
        return;
      }
      case "unwatch_pty":
        hub.terminals.unwatch(message.deviceId, message.id, socket);
        return;
      case "pty_input":
        await authorizeTool(hub, message.deviceId, "pty_write");
        hub.agents.fire(message.deviceId, "pty_write", { id: message.id, data: message.data });
        return;
      case "pty_resize":
        await authorizeTool(hub, message.deviceId, "pty_resize");
        hub.agents.fire(message.deviceId, "pty_resize", { id: message.id, cols: message.cols, rows: message.rows });
        return;
    }
  }

  function send(socket: WebSocket, message: HubToDashboard): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  app.get("/ws/dashboard", { websocket: true }, (socket, request) => {
    const query = Query.safeParse(request.query);
    const session = query.success ? hub.auth.consumeTicket(query.data.ticket) : null;
    if (!session) {
      socket.close(CloseCode.authFailed, "Invalid ticket");
      return;
    }

    const unsubscribe = hub.bus.subscribe((message) => {
      send(socket, message);
    });
    const set = sockets.get(session.sessionId) ?? new Set();
    set.add(socket);
    sockets.set(session.sessionId, set);

    socket.on("message", (raw, isBinary) => {
      const message = isBinary ? null : parse(raw);
      if (!message) {
        send(socket, { type: "error", code: "malformed", message: "Malformed message" });
        return;
      }
      handle(socket, session, message, request.ip).catch((error: unknown) => {
        if (error instanceof HttpError) send(socket, { type: "error", code: error.code, message: error.message });
        else {
          request.log.warn({ err: error }, "dashboard message failed");
          send(socket, { type: "error", code: "error", message: error instanceof Error ? error.message : "Request failed" });
        }
      });
    });

    socket.on("close", () => {
      unsubscribe();
      hub.screens.dropSocket(socket);
      hub.terminals.dropSocket(socket);
      set.delete(socket);
      if (set.size === 0) sockets.delete(session.sessionId);
    });

    send(socket, { type: "hello" });
  });

  /** Close live sockets when their session ends. */
  app.addHook("onResponse", async (request) => {
    if (request.routeOptions.url !== "/api/auth/logout" || !request.session) return;
    for (const socket of sockets.get(request.session.sessionId) ?? []) socket.close(CloseCode.revoked, "Signed out");
  });
}
