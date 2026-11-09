"use client";

import { useTranslations } from "next-intl";
import { ApiRequestError } from "./api";

const KNOWN = [
  "bad_credentials",
  "bad_code",
  "bad_setup_token",
  "setup_closed",
  "rate_limited",
  "pairing_locked",
  "offline",
  "unauthorized",
  "view_only",
  "killed",
  "device_error",
  "validation",
] as const;
type Known = (typeof KNOWN)[number];

const isKnown = (code: string): code is Known => (KNOWN as readonly string[]).includes(code);

/** Localized message for a hub error code; falls back to the hub's (English) message. */
export function useErrorMessage(): (error: unknown) => string {
  const t = useTranslations("errors");
  return (error) => {
    // Device errors carry the device's own message, which is more useful than a generic line.
    if (error instanceof ApiRequestError) return isKnown(error.code) && error.code !== "device_error" ? t(error.code) : error.message;
    return t("generic");
  };
}
