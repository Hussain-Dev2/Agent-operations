import { randomUUID } from "node:crypto";
import { describe, expect, it } from "bun:test";
import type { CommandPayload } from "@operator/shared";
import { generateEd25519KeyPair, randomToken, signMessage } from "@operator/shared/crypto";
import { CommandVerifier } from "./verifier.js";

const hub = generateEd25519KeyPair();
const deviceId = randomUUID();

function signed(overrides: Partial<CommandPayload> = {}, keys = hub): { payload: string; signature: string } {
  const payload = JSON.stringify({
    id: randomUUID(),
    deviceId,
    nonce: randomToken(18),
    issuedAt: Date.now(),
    call: { name: "system_info", args: {} },
    ...overrides,
  });
  return { payload, signature: signMessage(keys, payload) };
}

describe("CommandVerifier", () => {
  it("accepts a fresh command signed by the hub", () => {
    const v = new CommandVerifier(hub.publicKey, deviceId);
    const { payload, signature } = signed();
    expect(v.verify(payload, signature)).toMatchObject({ ok: true });
  });

  it("rejects a replayed command", () => {
    const v = new CommandVerifier(hub.publicKey, deviceId);
    const { payload, signature } = signed();
    expect(v.verify(payload, signature).ok).toBe(true);
    expect(v.verify(payload, signature)).toEqual({ ok: false, reason: "replay" });
  });

  it("rejects a tampered payload", () => {
    const v = new CommandVerifier(hub.publicKey, deviceId);
    const { payload, signature } = signed();
    const tampered = payload.replace("system_info", "system_inf0");
    expect(v.verify(tampered, signature)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects commands signed by another key", () => {
    const v = new CommandVerifier(hub.publicKey, deviceId);
    const { payload, signature } = signed({}, generateEd25519KeyPair());
    expect(v.verify(payload, signature)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects commands for another device", () => {
    const v = new CommandVerifier(hub.publicKey, deviceId);
    const { payload, signature } = signed({ deviceId: randomUUID() });
    expect(v.verify(payload, signature)).toEqual({ ok: false, reason: "wrong_device" });
  });

  it("rejects stale and future-dated commands", () => {
    const v = new CommandVerifier(hub.publicKey, deviceId);
    const old = signed({ issuedAt: Date.now() - 61_000 });
    const future = signed({ issuedAt: Date.now() + 61_000 });
    expect(v.verify(old.payload, old.signature)).toEqual({ ok: false, reason: "stale" });
    expect(v.verify(future.payload, future.signature)).toEqual({ ok: false, reason: "stale" });
  });

  it("rejects well-signed payloads that fail the schema", () => {
    const v = new CommandVerifier(hub.publicKey, deviceId);
    const payload = JSON.stringify({ hello: "world" });
    expect(v.verify(payload, signMessage(hub, payload))).toEqual({ ok: false, reason: "malformed" });
  });

  it("forgets nonces only after the acceptance window has passed", () => {
    let now = Date.now();
    const v = new CommandVerifier(hub.publicKey, deviceId, () => now);
    const cmd = signed({ issuedAt: now });
    expect(v.verify(cmd.payload, cmd.signature).ok).toBe(true);
    now += 59_000;
    expect(v.verify(cmd.payload, cmd.signature)).toEqual({ ok: false, reason: "replay" });
    now += 10_000;
    expect(v.verify(cmd.payload, cmd.signature)).toEqual({ ok: false, reason: "stale" });
  });
});
