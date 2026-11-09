import { z } from "zod";

export const PermissionLevel = z.enum(["view_only", "assisted", "autonomous"]);
export type PermissionLevel = z.infer<typeof PermissionLevel>;

export const DeviceOs = z.enum(["windows", "macos", "linux"]);
export type DeviceOs = z.infer<typeof DeviceOs>;

/** Base64url-encoded raw 32-byte Ed25519 public key. */
export const PublicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Invalid Ed25519 public key");

export const DeviceFacts = z.object({
  name: z.string().trim().min(1).max(64),
  os: DeviceOs,
  arch: z.string().max(32),
  hostname: z.string().max(255),
  agentVersion: z.string().max(32),
});
export type DeviceFacts = z.infer<typeof DeviceFacts>;

/** What the connected agent can do on this OS/session. Reported at connect time. */
export const DeviceCapabilities = z.object({
  /** Screen capture + input backend, or null when unavailable (e.g. headless, unsupported session). */
  desktop: z.enum(["portal", "nut"]).nullable(),
  /** Why desktop control is unavailable, for the dashboard. */
  desktopUnavailableReason: z.string().max(500).nullable(),
  pty: z.boolean(),
  clipboard: z.boolean(),
});
export type DeviceCapabilities = z.infer<typeof DeviceCapabilities>;

export const Device = z.object({
  id: z.uuid(),
  name: z.string(),
  os: DeviceOs,
  arch: z.string(),
  hostname: z.string(),
  agentVersion: z.string(),
  permissionLevel: PermissionLevel,
  online: z.boolean(),
  /** Present while online. */
  capabilities: DeviceCapabilities.nullable(),
  /** Kill switch engaged on the device: all actions are blocked until resumed. */
  killed: z.boolean(),
  lastSeenAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Device = z.infer<typeof Device>;

export const DeviceList = z.object({ devices: z.array(Device) });
export type DeviceList = z.infer<typeof DeviceList>;

export const UpdateDeviceRequest = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    permissionLevel: PermissionLevel.optional(),
  })
  .refine((v) => v.name !== undefined || v.permissionLevel !== undefined, "Nothing to update");
export type UpdateDeviceRequest = z.infer<typeof UpdateDeviceRequest>;

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

export const PairingCode = z.string().regex(/^\d{6}$/, "Pairing code must be 6 digits");

export const PairingCodeResponse = z.object({
  code: PairingCode,
  expiresAt: z.iso.datetime(),
  /** URL the agent should be given with --hub (serves /api/pair and /ws/agent). */
  hubUrl: z.url(),
});
export type PairingCodeResponse = z.infer<typeof PairingCodeResponse>;

export const PairRequest = DeviceFacts.extend({
  code: PairingCode,
  publicKey: PublicKey,
});
export type PairRequest = z.infer<typeof PairRequest>;

export const PairResponse = z.object({
  deviceId: z.uuid(),
  hubPublicKey: PublicKey,
});
export type PairResponse = z.infer<typeof PairResponse>;
