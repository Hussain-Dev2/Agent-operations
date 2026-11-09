"use client";

import { Ellipsis, Languages, LogOut, Moon, Search, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PairDialog } from "@/components/devices/pair-dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useLiveUpdates, useUi } from "@/lib/live";
import { cn } from "@/lib/utils";
import { CommandPalette } from "./command-palette";
import { LiveIndicator } from "./live-indicator";
import { NAV, isActive } from "./nav";
import { usePreferences } from "./use-preferences";

function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" aria-hidden className={className}>
      <circle cx="256" cy="256" r="170" fill="none" stroke="currentColor" strokeWidth="56" className="text-primary" />
      <path d="M226 180 L226 350 L270 308 L298 372 L330 358 L302 294 L362 292 Z" className="fill-foreground" />
    </svg>
  );
}

function AccountMenu({ email }: { email: string }) {
  const t = useTranslations("shell");
  const prefs = usePreferences();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" aria-label={t("account")}>
          <Avatar className="size-8">
            <AvatarFallback className="bg-primary/15 text-xs font-semibold text-primary">
              {email.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={prefs.toggleTheme}>
          {prefs.resolvedTheme === "dark" ? <Sun /> : <Moon />}
          {t("toggleTheme")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={prefs.toggleLocale}>
          <Languages />
          {t("switchLanguage")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => void prefs.signOut()}>
          <LogOut />
          {t("signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({ email, children }: { email: string; children: ReactNode }) {
  useLiveUpdates();
  const t = useTranslations();
  const pathname = usePathname();
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-e bg-sidebar md:flex">
        <div className="flex h-16 items-center gap-2.5 px-5">
          <Logo className="size-7" />
          <span className="text-base font-semibold tracking-tight">{t("common.appName")}</span>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-3 py-2">
          {NAV.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.key}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
                  active && "bg-sidebar-accent text-sidebar-foreground",
                )}
              >
                <item.icon className={cn("size-4", active && "text-primary")} />
                {t(`nav.${item.key}`)}
              </Link>
            );
          })}
        </nav>
        <div className="border-t px-5 py-4">
          <LiveIndicator />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:px-8">
          <div className="flex items-center gap-2 md:hidden">
            <Logo className="size-7" />
            <span className="font-semibold tracking-tight">{t("common.appName")}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setPaletteOpen(true);
            }}
            className="ms-auto flex h-9 items-center gap-2 rounded-lg border bg-muted/40 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted md:ms-0 md:w-80"
          >
            <Search className="size-4" />
            <span className="hidden md:inline">{t("shell.search")}</span>
            <kbd className="ms-auto hidden rounded border bg-background px-1.5 font-mono text-[10px] md:inline">Ctrl K</kbd>
          </button>
          <LiveIndicator className="hidden md:ms-auto md:inline-flex" />
          <AccountMenu email={email} />
        </header>

        <main className="flex-1 px-4 pb-28 pt-6 md:px-8 md:pb-12 md:pt-8">{children}</main>
      </div>

      {/* Mobile bottom bar */}
      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {NAV.filter((i) => i.primary).map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.key}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium text-muted-foreground",
                active && "text-primary",
              )}
            >
              <item.icon className="size-5" />
              {t(`nav.${item.key}`)}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => {
            setMoreOpen(true);
          }}
          className="flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium text-muted-foreground"
        >
          <Ellipsis className="size-5" />
          {t("nav.more")}
        </button>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="rounded-t-2xl pb-[calc(env(safe-area-inset-bottom)+1rem)]">
          <SheetHeader>
            <SheetTitle>{t("nav.more")}</SheetTitle>
          </SheetHeader>
          <div className="grid grid-cols-3 gap-2 px-4">
            {NAV.filter((i) => !i.primary).map((item) => (
              <Link
                key={item.key}
                href={item.href}
                onClick={() => {
                  setMoreOpen(false);
                }}
                className="flex flex-col items-center gap-2 rounded-xl border bg-card p-4 text-xs font-medium"
              >
                <item.icon className="size-5 text-primary" />
                {t(`nav.${item.key}`)}
              </Link>
            ))}
          </div>
          <div className="flex justify-center pt-2">
            <LiveIndicator />
          </div>
        </SheetContent>
      </Sheet>

      <CommandPalette />
      <PairDialog />
    </div>
  );
}
