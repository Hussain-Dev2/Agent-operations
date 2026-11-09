import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  LoginRequest,
  SetupStartRequest,
  SetupVerifyRequest,
  type AuthStatus,
  type SetupStartResponse,
  type WsTicketResponse,
} from "@operator/shared";
import type { Hub } from "../context.js";
import { HttpError, parse } from "../http.js";
import { SESSION_COOKIE, SESSION_TTL_MS } from "../services/auth.js";

const strictLimit = { rateLimit: { max: 5, timeWindow: "1 minute" } };

export async function requireSession(request: FastifyRequest): Promise<void> {
  if (!request.session) throw new HttpError(401, "unauthorized", "Sign in required");
}

export function authRoutes(app: FastifyInstance, hub: Hub): void {
  const { auth, audit, config } = hub;

  async function startSession(request: FastifyRequest, reply: FastifyReply, userId: string): Promise<void> {
    const token = await auth.createSession(userId, { userAgent: request.headers["user-agent"], ip: request.ip });
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.secureCookies,
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
  }

  app.get("/api/auth/status", async (request): Promise<AuthStatus> => {
    return {
      setupRequired: await auth.setupRequired(),
      user: request.session ? { email: request.session.email } : null,
    };
  });

  app.post("/api/auth/setup/start", { config: strictLimit }, async (request): Promise<SetupStartResponse> => {
    const body = parse(SetupStartRequest, request.body);
    if (!(await auth.setupRequired())) throw new HttpError(409, "setup_closed", "Owner account already exists");
    if (body.setupToken !== auth.setupToken) {
      await audit.record({ actor: "anonymous", action: "auth.setup_token_invalid", ip: request.ip });
      throw new HttpError(403, "bad_setup_token", "Setup token is incorrect. Find it in the hub log.");
    }
    return auth.startSetup(body.email, body.password);
  });

  app.post("/api/auth/setup/verify", { config: strictLimit }, async (request, reply) => {
    const body = parse(SetupVerifyRequest, request.body);
    if (!(await auth.setupRequired())) throw new HttpError(409, "setup_closed", "Owner account already exists");
    const userId = await auth.finishSetup(body.email, body.password, body.code);
    if (!userId) throw new HttpError(400, "bad_code", "That code didn't match. Check your authenticator app.");
    await startSession(request, reply, userId);
    await audit.record({ actor: "owner", action: "auth.setup_completed", ip: request.ip, details: { email: body.email } });
    return { ok: true };
  });

  app.post("/api/auth/login", { config: strictLimit }, async (request, reply) => {
    const body = parse(LoginRequest, request.body);
    const userId = await auth.login(body.email, body.password, body.code);
    if (!userId) {
      await audit.record({ actor: "anonymous", action: "auth.login_failed", ip: request.ip, details: { email: body.email } });
      throw new HttpError(401, "bad_credentials", "Email, password or code is incorrect");
    }
    await startSession(request, reply, userId);
    await audit.record({ actor: "owner", action: "auth.login", ip: request.ip });
    return { ok: true };
  });

  app.post("/api/auth/logout", { preHandler: requireSession }, async (request, reply) => {
    if (request.session) await auth.destroySession(request.session.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    await audit.record({ actor: "owner", action: "auth.logout", ip: request.ip });
    return { ok: true };
  });

  app.post(
    "/api/ws-ticket",
    { preHandler: requireSession, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request): Promise<WsTicketResponse> => {
      if (!request.session) throw new HttpError(401, "unauthorized", "Sign in required");
      return { ticket: auth.issueTicket(request.session), wsUrl: `${config.publicWsUrl}/ws/dashboard` };
    },
  );
}
