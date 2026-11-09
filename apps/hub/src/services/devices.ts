import { randomInt } from "node:crypto";
import { and, desc, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import { PAIRING_CODE_TTL_MS, type Device, type DeviceCapabilities, type PairRequest, type UpdateDeviceRequest } from "@operator/shared";
import type { Db } from "../db/index.js";
import { devices, pairingCodes } from "../db/schema.js";
import { sha256 } from "../lib/crypto.js";

/** Hub-wide cap on failed code exchanges per window, on top of per-IP rate limits. */
const MAX_FAILED_PAIRINGS = 20;
const FAILED_PAIRING_WINDOW_MS = 10 * 60 * 1000;

type DeviceRow = typeof devices.$inferSelect;

export function toDevice(row: DeviceRow, live: { capabilities: DeviceCapabilities; killed: boolean } | null): Device {
  return {
    id: row.id,
    name: row.name,
    os: row.os,
    arch: row.arch,
    hostname: row.hostname,
    agentVersion: row.agentVersion,
    permissionLevel: row.permissionLevel,
    online: live !== null,
    capabilities: live?.capabilities ?? null,
    killed: live?.killed ?? false,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PairingLockedError extends Error {}

export class DeviceService {
  private failedPairings: number[] = [];

  constructor(private readonly db: Db) {}

  async list(): Promise<DeviceRow[]> {
    return this.db.select().from(devices).orderBy(desc(devices.createdAt));
  }

  async get(id: string): Promise<DeviceRow | undefined> {
    const [row] = await this.db.select().from(devices).where(eq(devices.id, id));
    return row;
  }

  async update(id: string, patch: UpdateDeviceRequest): Promise<DeviceRow | undefined> {
    const [row] = await this.db
      .update(devices)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.permissionLevel !== undefined && { permissionLevel: patch.permissionLevel }),
      })
      .where(eq(devices.id, id))
      .returning();
    return row;
  }

  async remove(id: string): Promise<boolean> {
    const rows = await this.db.delete(devices).where(eq(devices.id, id)).returning({ id: devices.id });
    return rows.length > 0;
  }

  async touch(id: string, agentVersion?: string): Promise<void> {
    await this.db
      .update(devices)
      .set({ lastSeenAt: new Date(), ...(agentVersion !== undefined && { agentVersion }) })
      .where(eq(devices.id, id));
  }

  /** Create a single-use 6-digit code. Only its hash is stored. */
  async createPairingCode(): Promise<{ code: string; expiresAt: Date }> {
    const now = new Date();
    await this.db.delete(pairingCodes).where(or(lt(pairingCodes.expiresAt, now), isNotNull(pairingCodes.usedAt)));
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
      const inserted = await this.db
        .insert(pairingCodes)
        .values({ codeHash: sha256(code), expiresAt })
        .onConflictDoNothing()
        .returning({ id: pairingCodes.id });
      if (inserted.length === 1) return { code, expiresAt };
    }
    throw new Error("Could not allocate a unique pairing code");
  }

  /** Burn a valid code and register the device. Returns null for unknown/expired/used codes. */
  async pair(request: PairRequest): Promise<DeviceRow | null> {
    const now = Date.now();
    this.failedPairings = this.failedPairings.filter((t) => now - t < FAILED_PAIRING_WINDOW_MS);
    if (this.failedPairings.length >= MAX_FAILED_PAIRINGS) throw new PairingLockedError("Too many failed pairing attempts");

    return this.db.transaction(async (tx) => {
      const burned = await tx
        .update(pairingCodes)
        .set({ usedAt: new Date() })
        .where(
          and(eq(pairingCodes.codeHash, sha256(request.code)), isNull(pairingCodes.usedAt), gt(pairingCodes.expiresAt, new Date())),
        )
        .returning({ id: pairingCodes.id });
      if (burned.length === 0) {
        this.failedPairings.push(now);
        return null;
      }
      const [device] = await tx
        .insert(devices)
        .values({
          name: request.name,
          os: request.os,
          arch: request.arch,
          hostname: request.hostname,
          agentVersion: request.agentVersion,
          publicKey: request.publicKey,
        })
        .returning();
      return device ?? null;
    });
  }
}
