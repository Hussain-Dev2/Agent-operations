"use client";

import { Languages, LogOut, Monitor, Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { usePreferences } from "@/components/shell/use-preferences";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function SettingsView({ email }: { email: string }) {
  const t = useTranslations("shell");
  const prefs = usePreferences();
  const { theme } = useTheme();
  const themes = [
    { value: "light", label: t("light"), icon: Sun },
    { value: "dark", label: t("dark"), icon: Moon },
    { value: "system", label: t("system"), icon: Monitor },
  ] as const;

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("account")}</CardTitle>
          <CardDescription dir="ltr" className="rtl:text-end">{email}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => void prefs.signOut()}>
            <LogOut />
            {t("signOut")}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("theme")}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-2">
          {themes.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => { prefs.setTheme(option.value); }}
              className={cn(
                "flex flex-col items-center gap-2 rounded-lg border p-3 text-sm transition-colors hover:bg-muted",
                theme === option.value && "border-primary bg-primary/10",
              )}
            >
              <option.icon className="size-5" />
              {option.label}
            </button>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("language")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="outline" disabled={prefs.pending} onClick={prefs.toggleLocale}>
            <Languages />
            {t("switchLanguage")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
