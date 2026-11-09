"use client";

import { Languages, LogOut, Plus, SunMoon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useUi } from "@/lib/live";
import { NAV } from "./nav";
import { usePreferences } from "./use-preferences";

export function CommandPalette() {
  const t = useTranslations();
  const router = useRouter();
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const setPairOpen = useUi((s) => s.setPairOpen);
  const prefs = usePreferences();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(!useUi.getState().paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [setOpen]);

  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title={t("shell.search")} description={t("shell.search")}>
      <Command>
      <CommandInput placeholder={t("shell.search")} />
      <CommandList>
        <CommandEmpty>{t("shell.noResults")}</CommandEmpty>
        <CommandGroup heading={t("shell.groupActions")}>
          <CommandItem
            onSelect={run(() => {
              router.push("/devices");
              setPairOpen(true);
            })}
          >
            <Plus />
            {t("devices.pair")}
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t("shell.groupNavigate")}>
          {NAV.map((item) => (
            <CommandItem key={item.key} onSelect={run(() => { router.push(item.href); })}>
              <item.icon />
              {t(`nav.${item.key}`)}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t("shell.groupPreferences")}>
          <CommandItem onSelect={run(prefs.toggleTheme)}>
            <SunMoon />
            {t("shell.toggleTheme")}
          </CommandItem>
          <CommandItem onSelect={run(prefs.toggleLocale)}>
            <Languages />
            {t("shell.switchLanguage")}
          </CommandItem>
          <CommandItem onSelect={run(() => void prefs.signOut())}>
            <LogOut />
            {t("shell.signOut")}
          </CommandItem>
        </CommandGroup>
      </CommandList>
      </Command>
    </CommandDialog>
  );
}
