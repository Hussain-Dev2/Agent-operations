import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import { Secret, TOTP } from "otpauth";
import { buildHub } from "./app.js";
import type { Config } from "./config.js";
import type { Hub } from "./context.js";
import { migrationsFolder, schema } from "./db/index.js";

export interface TestHub {
  app: FastifyInstance;
  hub: Hub;
  url: string;
  /** Session cookie of the signed-in owner. */
  cookie: string;
  totpSecret: string;
  close: () => Promise<void>;
}

export const OWNER = { email: "owner@example.com", password: "correct horse battery staple" };

export function totpCode(secret: string, offsetSteps = 0): string {
  const totp = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 });
  return totp.generate({ timestamp: Date.now() + offsetSteps * 30_000 });
}

/** Boots a hub on an in-memory Postgres (PGlite), on a random port, with an owner signed in. */
export async function startTestHub(): Promise<TestHub> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });

  const config: Config = {
    databaseUrl: "pglite://memory",
    masterKey: randomBytes(32),
    host: "127.0.0.1",
    port: 0,
    publicWebUrl: "http://localhost:3000",
    publicWsUrl: "ws://localhost:4000",
    trustProxy: "127.0.0.1",
    tls: null,
    logLevel: "silent",
    secureCookies: false,
  };
  const { app, hub } = await buildHub(config, db);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const start = await post("/api/auth/setup/start", { setupToken: hub.auth.setupToken, ...OWNER });
  const { secret } = (await start.json()) as { secret: string };
  const verify = await post("/api/auth/setup/verify", { ...OWNER, code: totpCode(secret) });
  const setCookie = verify.headers.get("set-cookie");
  if (!verify.ok || !setCookie) throw new Error(`Test owner setup failed: ${verify.status}`);

  return {
    app,
    hub,
    url,
    cookie: setCookie.split(";")[0] ?? "",
    totpSecret: secret,
    close: async () => {
      await app.close();
      await client.close();
    },
  };
}
