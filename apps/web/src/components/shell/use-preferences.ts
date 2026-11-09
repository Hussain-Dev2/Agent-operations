"use client";

import { useRouter } from "next/navigation";
import { useLocale } from "next-intl";
import { useTheme } from "next-themes";
import { useTransition } from "react";
import { setLocale } from "@/i18n/actions";
import { api } from "@/lib/api";

/** Shared actions for the account menu and the command palette. */
export function usePreferences() {
  const router = useRouter();
  const locale = useLocale();
  const { resolvedTheme, setTheme } = useTheme();
  const [pending, startTransition] = useTransition();

  return {
    locale,
    pending,
    resolvedTheme,
    setTheme,
    toggleTheme: () => {
      setTheme(resolvedTheme === "dark" ? "light" : "dark");
    },
    toggleLocale: () => {
      startTransition(async () => {
        await setLocale(locale === "ar" ? "en" : "ar");
        router.refresh();
      });
    },
    signOut: async () => {
      await api("/api/auth/logout", { method: "POST", body: {} }).catch(() => undefined);
      window.location.assign("/login");
    },
  };
}
