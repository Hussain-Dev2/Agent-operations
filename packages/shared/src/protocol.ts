import { z } from "zod";
import { InputEvent, StreamQuality, ToolCall } from "./commands.js";
import { Device, DeviceCapabilities } from "./devices.js";

export const PROTOCOL_VERSION = 2;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 45_000;
/** Commands older/newer than this relative to the agent clock are rejected. */
export const COMMAND_MAX_SKEW_MS = 60_000;
/** Largest WebSocket message either side accepts (file chunks are ≤1 MiB of base64). */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/);
const Id = z.string().min(1).max(64);

/** Exact string the agent signs to prove possession of its device key. */
export function agentAuthMessage(deviceId: string, nonce: string): string {
  return `operator-agent-auth:v1:${deviceId}:${nonce}`;
}

// ---------- hub -> agent ----------

/** The signed part of a command. Serialized to a string, signed, sent verbatim. */
export const CommandPayload = z.object({
  id: z.uuid(),
  deviceId: z.uuid(),
  nonce: Base64Url.min(16),
  issuedAt: z.number().int(),
  call: ToolCall,
});
export type CommandPayload = z.infer<typeof CommandPayload>;

export const HubToAgent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("challenge"), nonce: Base64Url, protocol: z.number().int() }),
  z.object({ type: z.literal("auth_ok"), deviceId: z.uuid() }),
  z.object({
    type: z.literal("command"),
    /** JSON string of CommandPayload. Verify the signature over these exact bytes before parsing. */
    payload: z.string().max(MAX_MESSAGE_BYTES),
    signature: Base64Url,
  }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type HubToAgent = z.infer<typeof HubToAgent>;

// ---------- agent -> hub ----------

/** Unsolicited agent events (not replies to a command). */
export const AgentEvent = z.discriminatedUnion("event", [
  z.object({ event: z.literal("pty_data"), id: Id, data: z.string() }),
  z.object({ event: z.literal("pty_exit"), id: Id, exitCode: z.number().int().nullable() }),
  z.object({ event: z.literal("stream_ended"), streamId: Id, reason: z.string().max(500) }),
  /** Kill switch state changed on the device. */
  z.object({ event: z.literal("control"), killed: z.boolean(), source: z.enum(["hotkey", "notification", "remote"]) }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

export const AgentToHub = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("auth"),
    deviceId: z.uuid(),
    signature: Base64Url,
    agentVersion: z.string().max(32),
    capabilities: DeviceCapabilities,
    killed: z.boolean(),
  }),
  z.object({ type: z.literal("heartbeat") }),
  z.object({
    type: z.literal("result"),
    id: z.uuid(),
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().max(10_000).optional(),
  }),
  /** The agent refused a command (bad signature, replay, clock skew, wrong device). */
  z.object({
    type: z.literal("rejected"),
    reason: z.enum(["bad_signature", "malformed", "wrong_device", "stale", "replay"]),
  }),
  z.object({ type: z.literal("event"), payload: AgentEvent }),
]);
export type AgentToHub = z.infer<typeof AgentToHub>;

// ---------- binary screen frames ----------

/**
 * Binary frame layout (agent → hub → dashboard):
 *   [uint32 big-endian header length][UTF-8 JSON header][JPEG bytes]
 * The hub rewrites nothing but adds `deviceId` when relaying to dashboards.
 */
export const FrameHeader = z.object({
  streamId: Id,
  monitor: Id,
  seq: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  capturedAt: z.number(),
  deviceId: z.uuid().optional(),
});
export type FrameHeader = z.infer<typeof FrameHeader>;

export function encodeFrame(header: FrameHeader, jpeg: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + head.length + jpeg.length);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  out.set(jpeg, 4 + head.length);
  return out;
}

export function decodeFrame(data: Uint8Array): { header: FrameHeader; jpeg: Uint8Array } | null {
  if (data.length < 4) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const length = view.getUint32(0);
  if (length > 4096 || 4 + length > data.length) return null;
  try {
    const header = FrameHeader.safeParse(JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + length))));
    return header.success ? { header: header.data, jpeg: data.subarray(4 + length) } : null;
  } catch {
    return null;
  }
}

// ---------- dashboard <-> hub ----------

export const DashboardToHub = z.discriminatedUnion("type", [
  z.object({ type: z.literal("watch_screen"), deviceId: z.uuid(), monitor: Id.optional(), quality: StreamQuality }),
  z.object({ type: z.literal("unwatch_screen"), deviceId: z.uuid() }),
  z.object({ type: z.literal("input"), deviceId: z.uuid(), events: z.array(InputEvent).min(1).max(200) }),
  z.object({ type: z.literal("watch_pty"), deviceId: z.uuid(), id: Id }),
  z.object({ type: z.literal("unwatch_pty"), deviceId: z.uuid(), id: Id }),
  z.object({ type: z.literal("pty_input"), deviceId: z.uuid(), id: Id, data: z.string().min(1).max(100_000) }),
  z.object({ type: z.literal("pty_resize"), deviceId: z.uuid(), id: Id, cols: z.number().int().min(10).max(500), rows: z.number().int().min(5).max(200) }),
]);
export type DashboardToHub = z.infer<typeof DashboardToHub>;

export const HubToDashboard = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello") }),
  z.object({
    type: z.literal("device_presence"),
    deviceId: z.uuid(),
    online: z.boolean(),
    lastSeenAt: z.iso.datetime().nullable(),
  }),
  z.object({ type: z.literal("device_updated"), device: Device }),
  z.object({ type: z.literal("device_removed"), deviceId: z.uuid() }),
  z.object({ type: z.literal("screen_started"), deviceId: z.uuid(), streamId: Id, monitor: Id }),
  z.object({ type: z.literal("screen_ended"), deviceId: z.uuid(), reason: z.string() }),
  z.object({ type: z.literal("pty_data"), deviceId: z.uuid(), id: Id, data: z.string() }),
  z.object({ type: z.literal("pty_exit"), deviceId: z.uuid(), id: Id, exitCode: z.number().int().nullable() }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type HubToDashboard = z.infer<typeof HubToDashboard>;

/**
 * Close codes used on agent sockets. Only `authFailed` (bad signature / unknown device) and
 * `revoked` are fatal for an agent; everything else is retried with backoff.
 */
export const CloseCode = {
  authFailed: 4001,
  replaced: 4002,
  revoked: 4003,
  protocol: 4004,
  heartbeatTimeout: 4005,
  authTimeout: 4006,
  /** Hub-side failure (e.g. database unavailable). Transient. */
  internalError: 1011,
} as const;
