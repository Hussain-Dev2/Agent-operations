import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import {
  AgentToHub,
  CloseCode,
  HEARTBEAT_TIMEOUT_MS,
  PROTOCOL_VERSION,
  agentAuthMessage,
  type AgentEvent,
  type HubToAgent,
} from "@operator/shared";
import { randomToken, verifyMessage } from "@operator/shared/crypto";
import type { Hub } from "../context.js";
import { toDevice } from "../services/devices.js";

const AUTH_TIMEOUT_MS = 10_000;

function send(socket: WebSocket, message: HubToAgent): void {
  socket.send(JSON.stringify(message));
}

function toBuffer(raw: RawData): Buffer {
  return Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
}

function decode(raw: Buffer): AgentToHub | null {
  try {
    const result = AgentToHub.safeParse(JSON.parse(raw.toString("utf8")));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * /ws/agent — agents dial out to the hub. The first message must answer the challenge with a
 * signature from the device key registered at pairing. Only then does the device count as online.
 * After that: JSON text messages (results, events, heartbeats) and binary screen frames.
 */
export function agentGateway(app: FastifyInstance, hub: Hub): void {
  const { agents, devices, audit, bus, screens, terminals } = hub;

  async function publishDevice(deviceId: string): Promise<void> {
    const row = await devices.get(deviceId);
    if (row) bus.publish({ type: "device_updated", device: toDevice(row, agents.state(deviceId)) });
  }

  async function onEvent(deviceId: string, event: AgentEvent): Promise<void> {
    switch (event.event) {
      case "pty_data":
        terminals.publish(deviceId, { type: "pty_data", deviceId, id: event.id, data: event.data });
        return;
      case "pty_exit":
        terminals.publish(deviceId, { type: "pty_exit", deviceId, id: event.id, exitCode: event.exitCode });
        return;
      case "stream_ended":
        screens.ended(deviceId, event.reason);
        return;
      case "control":
        agents.setKilled(deviceId, event.killed);
        await audit.record({ actor: "device", action: event.killed ? "device.killed" : "device.resumed", deviceId, details: { source: event.source } });
        if (event.killed) screens.ended(deviceId, "Stopped on the device");
        else await screens.resume(deviceId);
        await publishDevice(deviceId);
        return;
    }
  }

  app.get("/ws/agent", { websocket: true }, (socket, request) => {
    const nonce = randomToken(24);
    let deviceId: string | null = null;
    let heartbeatTimer: NodeJS.Timeout | undefined;

    const authTimer = setTimeout(() => {
      socket.close(CloseCode.authTimeout, "Authentication timeout");
    }, AUTH_TIMEOUT_MS);

    const armHeartbeat = (): void => {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        socket.terminate();
      }, HEARTBEAT_TIMEOUT_MS);
    };

    const fail = async (reason: string, claimedDeviceId?: string): Promise<void> => {
      await audit.record({
        actor: "anonymous",
        action: "agent.auth_failed",
        ip: request.ip,
        details: { reason, ...(claimedDeviceId !== undefined && { claimedDeviceId }) },
      });
      socket.close(CloseCode.authFailed, "Authentication failed");
    };

    const handle = async (message: AgentToHub): Promise<void> => {
      if (deviceId === null) {
        if (message.type !== "auth") return fail("expected_auth");
        const row = await devices.get(message.deviceId);
        if (!row) return fail("unknown_device", message.deviceId);
        if (!verifyMessage(row.publicKey, agentAuthMessage(row.id, nonce), message.signature)) {
          return fail("bad_signature", message.deviceId);
        }
        clearTimeout(authTimer);
        deviceId = row.id;
        agents.attach(row.id, socket, { capabilities: message.capabilities, killed: message.killed });
        armHeartbeat();
        await devices.touch(row.id, message.agentVersion);
        send(socket, { type: "auth_ok", deviceId: row.id });
        await audit.record({ actor: "device", action: "agent.connected", deviceId: row.id, ip: request.ip, details: { capabilities: message.capabilities } });
        await publishDevice(row.id);
        await screens.resume(row.id);
        return;
      }

      switch (message.type) {
        case "heartbeat":
          armHeartbeat();
          await devices.touch(deviceId);
          return;
        case "result":
          agents.settle(deviceId, message.id, message.ok, message.data, message.error);
          return;
        case "rejected":
          await audit.record({ actor: "device", action: "agent.command_rejected", deviceId, details: { reason: message.reason } });
          return;
        case "event":
          await onEvent(deviceId, message.payload);
          return;
        case "auth":
          return;
      }
    };

    socket.on("message", (raw, isBinary) => {
      const data = toBuffer(raw);
      if (isBinary) {
        // Screen frames are only accepted from an authenticated device.
        if (deviceId !== null) screens.frame(deviceId, data);
        return;
      }
      const message = decode(data);
      if (!message) {
        socket.close(CloseCode.protocol, "Malformed message");
        return;
      }
      handle(message).catch((error: unknown) => {
        request.log.error({ err: error }, "agent message handling failed");
        // A hub-side failure must not look like a rejected identity, or the agent would give up.
        if (deviceId === null) socket.close(CloseCode.internalError, "Hub error during authentication");
      });
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      clearTimeout(heartbeatTimer);
      const id = deviceId;
      if (id === null || !agents.detach(id, socket)) return;
      screens.ended(id, "Device went offline");
      void devices.touch(id).catch(() => undefined);
      void audit.record({ actor: "device", action: "agent.disconnected", deviceId: id }).catch(() => undefined);
      bus.publish({ type: "device_presence", deviceId: id, online: false, lastSeenAt: new Date().toISOString() });
    });

    send(socket, { type: "challenge", nonce, protocol: PROTOCOL_VERSION });
  });
}
