import { z } from "zod";

export const TotpCode = z.string().regex(/^\d{6}$/, "Enter the 6-digit code");

export const Email = z.email().max(254).transform((v) => v.toLowerCase());
export const Password = z.string().min(12, "Use at least 12 characters").max(256);

export const AuthStatus = z.object({
  /** True until the owner account has been created and TOTP verified. */
  setupRequired: z.boolean(),
  user: z.object({ email: z.string() }).nullable(),
});
export type AuthStatus = z.infer<typeof AuthStatus>;

export const SetupStartRequest = z.object({
  /** One-time token printed in the hub log while setup is open. */
  setupToken: z.string().min(1).max(64),
  email: Email,
  password: Password,
});
export type SetupStartRequest = z.infer<typeof SetupStartRequest>;

export const SetupStartResponse = z.object({
  otpauthUrl: z.string(),
  secret: z.string(),
});
export type SetupStartResponse = z.infer<typeof SetupStartResponse>;

export const SetupVerifyRequest = z.object({ email: Email, password: Password, code: TotpCode });
export type SetupVerifyRequest = z.infer<typeof SetupVerifyRequest>;

export const LoginRequest = z.object({
  email: Email,
  password: z.string().min(1).max(256),
  code: TotpCode,
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const WsTicketResponse = z.object({ ticket: z.string(), wsUrl: z.string() });
export type WsTicketResponse = z.infer<typeof WsTicketResponse>;

export const ApiError = z.object({ error: z.string(), message: z.string() });
export type ApiError = z.infer<typeof ApiError>;
