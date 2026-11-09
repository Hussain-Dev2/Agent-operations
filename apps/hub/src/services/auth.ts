import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { Secret, TOTP } from "otpauth";
import { randomToken } from "@operator/shared/crypto";
import type { Db } from "../db/index.js";
import { sessions, users } from "../db/schema.js";
import { DUMMY_PASSWORD_HASH, hashPassword, sha256, verifyPassword, type SecretBox } from "../lib/crypto.js";

export const SESSION_COOKIE = "operator_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_MS = 24 * 60 * 60 * 1000;
const TICKET_TTL_MS = 30_000;

export interface SessionInfo {
  sessionId: string;
  userId: string;
  email: string;
}

function totpFor(email: string, base32: string): TOTP {
  return new TOTP({ issuer: "Operator", label: email, algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(base32) });
}

export class AuthService {
  /** Single-use, short-lived tickets for authenticating dashboard WebSockets. */
  private readonly tickets = new Map<string, { session: SessionInfo; expiresAt: number }>();

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    /** Printed in the hub log while setup is open; required to create the owner account. */
    readonly setupToken: string = randomToken(12),
  ) {}

  async setupRequired(): Promise<boolean> {
    const [owner] = await this.db.select({ id: users.id }).from(users).where(eq(users.verified, true)).limit(1);
    return owner === undefined;
  }

  /** Step 1 of setup: store a pending (unverified) owner and return the TOTP enrolment URL. */
  async startSetup(email: string, password: string): Promise<{ otpauthUrl: string; secret: string }> {
    const secret = new Secret({ size: 20 }).base32;
    const passwordHash = await hashPassword(password);
    await this.db.transaction(async (tx) => {
      await tx.delete(users).where(eq(users.verified, false));
      await tx.insert(users).values({ email, passwordHash, totpSecretEnc: this.box.seal(secret) });
    });
    return { otpauthUrl: totpFor(email, secret).toString(), secret };
  }

  /** Step 2 of setup: confirm password + first TOTP code, activating the owner. */
  async finishSetup(email: string, password: string, code: string): Promise<string | null> {
    const [pending] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.email, email), eq(users.verified, false)));
    if (!pending || !(await verifyPassword(password, pending.passwordHash))) return null;
    const step = this.checkTotp(email, this.box.open(pending.totpSecretEnc), code, null);
    if (step === null) return null;
    await this.db.update(users).set({ verified: true, totpLastStep: step }).where(eq(users.id, pending.id));
    return pending.id;
  }

  /** Returns the user id when email + password + TOTP all check out. */
  async login(email: string, password: string, code: string): Promise<string | null> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.email, email), eq(users.verified, true)));
    const passwordOk = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !passwordOk) return null;
    const step = this.checkTotp(email, this.box.open(user.totpSecretEnc), code, user.totpLastStep);
    if (step === null) return null;
    // Conditional update so two concurrent logins cannot both spend the same code.
    const updated = await this.db
      .update(users)
      .set({ totpLastStep: step })
      .where(and(eq(users.id, user.id), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))))
      .returning({ id: users.id });
    return updated.length === 1 ? user.id : null;
  }

  async createSession(userId: string, meta: { userAgent: string | undefined; ip: string }): Promise<string> {
    const token = randomToken(32);
    await this.db.insert(sessions).values({
      userId,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
      ip: meta.ip,
    });
    return token;
  }

  /** Resolve a cookie token to a session, sliding its expiry forward at most once a day. */
  async resolveSession(token: string | undefined): Promise<SessionInfo | null> {
    if (!token) return null;
    const now = new Date();
    const [row] = await this.db
      .select({ sessionId: sessions.id, userId: users.id, email: users.email, expiresAt: sessions.expiresAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, now)));
    if (!row) return null;
    if (row.expiresAt.getTime() - now.getTime() < SESSION_TTL_MS - SESSION_REFRESH_MS) {
      await this.db
        .update(sessions)
        .set({ expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
        .where(eq(sessions.id, row.sessionId));
    }
    return { sessionId: row.sessionId, userId: row.userId, email: row.email };
  }

  async destroySession(sessionId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, sessionId));
    for (const [ticket, entry] of this.tickets) if (entry.session.sessionId === sessionId) this.tickets.delete(ticket);
  }

  issueTicket(session: SessionInfo): string {
    const now = Date.now();
    for (const [t, entry] of this.tickets) if (entry.expiresAt < now) this.tickets.delete(t);
    const ticket = randomToken(24);
    this.tickets.set(ticket, { session, expiresAt: now + TICKET_TTL_MS });
    return ticket;
  }

  consumeTicket(ticket: string): SessionInfo | null {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return entry && entry.expiresAt >= Date.now() ? entry.session : null;
  }

  /** Validate a TOTP code (±1 step) and return its time step, rejecting reuse of old steps. */
  private checkTotp(email: string, secret: string, code: string, lastStep: number | null): number | null {
    const now = Date.now();
    const delta = totpFor(email, secret).validate({ token: code, timestamp: now, window: 1 });
    if (delta === null) return null;
    const step = Math.floor(now / 30_000) + delta;
    return lastStep !== null && step <= lastStep ? null : step;
  }
}
