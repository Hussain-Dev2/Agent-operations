import { z } from "zod";

const Bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const ConfigSchema = z.object({
  DATABASE_URL: z.url(),
  /** 32 random bytes, base64. Generate with: openssl rand -base64 32 */
  MASTER_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "MASTER_KEY must be 32 bytes, base64-encoded"),
  HUB_HOST: z.string().default("127.0.0.1"),
  HUB_PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  /** Origin users open in the browser, e.g. https://operator.tailnet.ts.net */
  PUBLIC_WEB_URL: z.url().default("http://localhost:3100"),
  /** WebSocket base URL browsers use for /ws/dashboard. */
  PUBLIC_WS_URL: z.url().default("ws://localhost:4000"),
  /** Comma-separated proxy addresses whose X-Forwarded-For is trusted (Next.js rewrites run here). */
  TRUST_PROXY: z.string().default("127.0.0.1,::1"),
  TLS_CERT_FILE: z.string().optional(),
  TLS_KEY_FILE: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  LOG_PRETTY: Bool.default(false),
});

export interface Config {
  databaseUrl: string;
  masterKey: Buffer;
  host: string;
  port: number;
  publicWebUrl: string;
  publicWsUrl: string;
  trustProxy: string;
  tls: { cert: string; key: string } | null;
  logLevel: z.infer<typeof ConfigSchema>["LOG_LEVEL"];
  /** Secure cookies whenever the browser origin is HTTPS. */
  secureCookies: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid hub configuration:\n${issues}`);
  }
  const c = parsed.data;
  if ((c.TLS_CERT_FILE === undefined) !== (c.TLS_KEY_FILE === undefined)) {
    throw new Error("Set both TLS_CERT_FILE and TLS_KEY_FILE, or neither");
  }
  return {
    databaseUrl: c.DATABASE_URL,
    masterKey: Buffer.from(c.MASTER_KEY, "base64"),
    host: c.HUB_HOST,
    port: c.HUB_PORT,
    publicWebUrl: c.PUBLIC_WEB_URL,
    publicWsUrl: c.PUBLIC_WS_URL.replace(/\/$/, ""),
    trustProxy: c.TRUST_PROXY,
    tls: c.TLS_CERT_FILE && c.TLS_KEY_FILE ? { cert: c.TLS_CERT_FILE, key: c.TLS_KEY_FILE } : null,
    logLevel: c.LOG_LEVEL,
    secureCookies: c.PUBLIC_WEB_URL.startsWith("https://"),
  };
}
