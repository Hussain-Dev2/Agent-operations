import { arch, hostname } from "node:os";
import { ApiError, PairResponse, type DeviceOs, type PairRequest } from "@operator/shared";
import { generateEd25519KeyPair } from "@operator/shared/crypto";
import { assertSecureHubUrl, type Identity } from "./identity.js";
import { AGENT_VERSION } from "./version.js";

export function currentOs(): DeviceOs {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

/** Exchange a one-time pairing code for a device identity. The keypair is generated here and never sent. */
export async function pair(hubUrl: string, code: string, name: string = hostname()): Promise<Identity> {
  const base = assertSecureHubUrl(hubUrl);
  const keys = generateEd25519KeyPair();
  const body: PairRequest = {
    code,
    publicKey: keys.publicKey,
    name: name.slice(0, 64),
    os: currentOs(),
    arch: arch(),
    hostname: hostname().slice(0, 255),
    agentVersion: AGENT_VERSION,
  };
  const res = await fetch(new URL("api/pair", base.href.endsWith("/") ? base : `${base.href}/`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = ApiError.safeParse(json);
    throw new Error(`Pairing failed (${res.status}): ${err.success ? err.data.message : res.statusText}`);
  }
  const { deviceId, hubPublicKey } = PairResponse.parse(json);
  return { hubUrl: base.href.replace(/\/$/, ""), deviceId, publicKey: keys.publicKey, privateKey: keys.privateKey, hubPublicKey };
}
