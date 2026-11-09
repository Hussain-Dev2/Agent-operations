import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const permissionLevel = pgEnum("permission_level", ["view_only", "assisted", "autonomous"]);
export const deviceOs = pgEnum("device_os", ["windows", "macos", "linux"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  /** AES-256-GCM encrypted base32 TOTP secret. */
  totpSecretEnc: text("totp_secret_enc").notNull(),
  /** Last accepted TOTP time step, to block code reuse. */
  totpLastStep: integer("totp_last_step"),
  /** False until the first TOTP code is confirmed during setup. */
  verified: boolean("verified").notNull().default(false),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the cookie token. */
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const pairingCodes = pgTable("pairing_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** SHA-256 of the 6-digit code. */
  codeHash: text("code_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  os: deviceOs("os").notNull(),
  arch: text("arch").notNull(),
  hostname: text("hostname").notNull(),
  agentVersion: text("agent_version").notNull(),
  publicKey: text("public_key").notNull().unique(),
  permissionLevel: permissionLevel("permission_level").notNull().default("view_only"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const hubKeys = pgTable("hub_keys", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKeyEnc: text("private_key_enc").notNull(),
  createdAt: createdAt(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** "owner" | "system" | "device" | "anonymous" */
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    deviceId: uuid("device_id"),
    ip: text("ip"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    /** Reference to a stored screenshot for device actions (Phase 3). */
    screenshotRef: text("screenshot_ref"),
  },
  (t) => [index("audit_at_idx").on(t.at), index("audit_device_idx").on(t.deviceId)],
);
