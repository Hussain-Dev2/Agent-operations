import "server-only";
import { cookies } from "next/headers";
import { AuthStatus } from "@operator/shared";

const HUB_URL = process.env.HUB_URL ?? "http://127.0.0.1:4000";

/** Server-side auth check: forwards the browser's cookies to the hub. */
export async function getAuthStatus(): Promise<AuthStatus> {
  const res = await fetch(`${HUB_URL}/api/auth/status`, {
    headers: { cookie: (await cookies()).toString() },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Hub unavailable (${res.status})`);
  return AuthStatus.parse(await res.json());
}
