import { readFileSync } from "node:fs";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { MAX_MESSAGE_BYTES } from "@operator/shared";
import type { Config } from "./config.js";
import type { Hub } from "./context.js";
import type { Db } from "./db/index.js";
import { HttpError } from "./http.js";
import { SecretBox } from "./lib/crypto.js";
import { authRoutes } from "./routes/auth.js";
import { deviceRoutes } from "./routes/devices.js";
import { AgentRegistry } from "./services/agents.js";
import { Audit } from "./services/audit.js";
import { AuthService, SESSION_COOKIE } from "./services/auth.js";
import { DashboardBus } from "./services/dashboardBus.js";
import { DeviceService } from "./services/devices.js";
import { loadHubSigningKey } from "./services/hubKey.js";
import { ScreenRelay, TerminalRelay } from "./services/relays.js";
import { agentGateway } from "./ws/agent.js";
import { dashboardGateway } from "./ws/dashboard.js";

export async function buildHub(config: Config, db: Db): Promise<{ app: FastifyInstance; hub: Hub }> {
  const box = new SecretBox(config.masterKey);
  const signingKey = await loadHubSigningKey(db, box);
  const app = Fastify({
    logger: { level: config.logLevel, redact: ["req.headers.cookie", "req.headers.authorization"] },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    ...(config.tls && {
      https: { cert: readFileSync(config.tls.cert), key: readFileSync(config.tls.key) },
    }),
  });

  const agents = new AgentRegistry(signingKey);
  const hub: Hub = {
    config,
    db,
    box,
    hubPublicKey: signingKey.publicKey,
    audit: new Audit(db),
    auth: new AuthService(db, box),
    devices: new DeviceService(db),
    agents,
    bus: new DashboardBus(),
    screens: new ScreenRelay(agents, app.log),
    terminals: new TerminalRelay(),
  };

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });

  app.decorateRequest("session", null);
  app.addHook("onRequest", async (request) => {
    request.session = await hub.auth.resolveSession(request.cookies[SESSION_COOKIE]);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ error: error.code, message: error.message });
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, "request failed");
    return reply
      .status(status)
      .send({ error: status === 429 ? "rate_limited" : "error", message: status >= 500 ? "Internal error" : error.message });
  });

  app.get("/api/health", async () => ({ ok: true }));
  authRoutes(app, hub);
  deviceRoutes(app, hub);
  agentGateway(app, hub);
  dashboardGateway(app, hub);

  app.addHook("onClose", async () => {
    hub.agents.closeAll();
  });

  return { app, hub };
}
