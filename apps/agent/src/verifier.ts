import { COMMAND_MAX_SKEW_MS, CommandPayload } from "@operator/shared";
import { verifyMessage } from "@operator/shared/crypto";

export type Verdict =
  | { ok: true; command: CommandPayload }
  | { ok: false; reason: "bad_signature" | "malformed" | "wrong_device" | "stale" | "replay" };

/**
 * Accepts only commands signed by the paired hub, addressed to this device, fresh (±60 s) and
 * never seen before. Nonces are remembered for the whole acceptance window, so a captured
 * command cannot be replayed.
 */
export class CommandVerifier {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly hubPublicKey: string,
    private readonly deviceId: string,
    private readonly now: () => number = Date.now,
  ) {}

  verify(payload: string, signature: string): Verdict {
    // Signature first, over the exact bytes received — never over re-serialized JSON.
    if (!verifyMessage(this.hubPublicKey, payload, signature)) return { ok: false, reason: "bad_signature" };

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return { ok: false, reason: "malformed" };
    }
    const result = CommandPayload.safeParse(parsed);
    if (!result.success) return { ok: false, reason: "malformed" };
    const command = result.data;

    if (command.deviceId !== this.deviceId) return { ok: false, reason: "wrong_device" };
    const now = this.now();
    if (Math.abs(now - command.issuedAt) > COMMAND_MAX_SKEW_MS) return { ok: false, reason: "stale" };

    for (const [nonce, expiresAt] of this.seen) if (expiresAt < now) this.seen.delete(nonce);
    if (this.seen.has(command.nonce)) return { ok: false, reason: "replay" };
    this.seen.set(command.nonce, command.issuedAt + COMMAND_MAX_SKEW_MS * 2);
    return { ok: true, command };
  }
}
