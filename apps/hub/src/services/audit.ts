import type { Db } from "../db/index.js";
import { auditLog } from "../db/schema.js";

export type AuditActor = "owner" | "system" | "device" | "anonymous";

export interface AuditEntry {
  actor: AuditActor;
  action: string;
  deviceId?: string | null;
  ip?: string | null;
  details?: Record<string, unknown>;
}

export class Audit {
  constructor(private readonly db: Db) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLog).values({
      actor: entry.actor,
      action: entry.action,
      deviceId: entry.deviceId ?? null,
      ip: entry.ip ?? null,
      details: entry.details ?? {},
    });
  }
}
