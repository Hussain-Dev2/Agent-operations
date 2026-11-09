import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { PublicKey } from "@operator/shared";

export const Identity = z.object({
  hubUrl: z.url(),
  deviceId: z.uuid(),
  publicKey: PublicKey,
  privateKey: z.string().min(43),
  hubPublicKey: PublicKey,
});
export type Identity = z.infer<typeof Identity>;

/** Per-OS config directory: %APPDATA%, ~/Library/Application Support, or $XDG_CONFIG_HOME. */
export function defaultConfigDir(): string {
  if (process.env.OPERATOR_AGENT_HOME) return process.env.OPERATOR_AGENT_HOME;
  const home = homedir();
  switch (process.platform) {
    case "win32":
      return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "operator-agent");
    case "darwin":
      return join(home, "Library", "Application Support", "operator-agent");
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "operator-agent");
  }
}

const identityPath = (dir: string): string => join(dir, "identity.json");

export async function loadIdentity(dir: string): Promise<Identity | null> {
  let raw: string;
  try {
    raw = await readFile(identityPath(dir), "utf8");
  } catch {
    return null;
  }
  return Identity.parse(JSON.parse(raw));
}

/** Written atomically with owner-only permissions: the private key never leaves this file. */
export async function saveIdentity(dir: string, identity: Identity): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${identityPath(dir)}.tmp`;
  await writeFile(tmp, JSON.stringify(identity, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, identityPath(dir));
}

/** TLS is mandatory except for loopback hubs (local development). */
export function assertSecureHubUrl(raw: string): URL {
  const url = new URL(raw);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && loopback) return url;
  throw new Error(`Refusing insecure hub URL ${raw}: use https:// (http:// is only allowed for localhost)`);
}

export function agentSocketUrl(hubUrl: string): string {
  const url = assertSecureHubUrl(hubUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws/agent`;
  url.search = "";
  return url.toString();
}
