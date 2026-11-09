"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUp, History, Mic, MonitorSmartphone, Plus } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState, type SyntheticEvent } from "react";
import { toast } from "sonner";
import { LastSeen, OsIcon, StatusBadge } from "@/components/devices/device-card";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { devicesKey, fetchDevices, useUi } from "@/lib/live";

function CommandBox() {
  const t = useTranslations("home");
  const [goal, setGoal] = useState("");
  const submit = (e?: SyntheticEvent): void => {
    e?.preventDefault();
    if (!goal.trim()) return;
    toast.info(t("commandSoon"));
  };
  return (
    <form onSubmit={submit} className="rounded-2xl border bg-card p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/40">
      <Textarea
        value={goal}
        onChange={(e) => { setGoal(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={t("commandPlaceholder")}
        rows={2}
        className="min-h-16 resize-none border-0 bg-transparent text-base shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      <div className="flex items-center justify-between px-1 pt-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" aria-label={t("mic")} onClick={() => toast.info(t("commandSoon"))}>
              <Mic />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("mic")}</TooltipContent>
        </Tooltip>
        <Button type="submit" size="icon" className="rounded-full" aria-label={t("send")} disabled={!goal.trim()}>
          <ArrowUp />
        </Button>
      </div>
    </form>
  );
}

export function HomeView() {
  const t = useTranslations("home");
  const td = useTranslations("devices");
  const setPairOpen = useUi((s) => s.setPairOpen);
  const devices = useQuery({ queryKey: devicesKey, queryFn: fetchDevices });
  const list = devices.data?.devices ?? [];
  const online = list.filter((d) => d.online).length;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-10">
      <section className="flex flex-col gap-4 pt-2 md:pt-8">
        <h1 className="text-center text-2xl font-semibold tracking-tight md:text-3xl">{t("greeting")}</h1>
        <CommandBox />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-3">
            <h2 className="text-lg font-semibold">{t("devicesTitle")}</h2>
            {list.length > 0 && <span className="text-sm text-muted-foreground">{t("stats", { online, total: list.length })}</span>}
          </div>
          {list.length > 0 && (
            <Button variant="ghost" size="sm" asChild>
              <Link href="/devices">
                {t("viewAll")}
                <ArrowRight className="rtl:rotate-180" />
              </Link>
            </Button>
          )}
        </div>
        {devices.isPending ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            icon={MonitorSmartphone}
            title={t("noDevices")}
            body={t("noDevicesHint")}
            action={
              <Button onClick={() => { setPairOpen(true); }}>
                <Plus />
                {td("pair")}
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list.slice(0, 6).map((device) => (
              <Card key={device.id} className="relative flex-row items-center gap-3 p-4 transition-colors hover:bg-muted/40">
                <Link href={`/devices/${device.id}`} className="absolute inset-0 rounded-xl" aria-label={device.name} />
                <OsIcon os={device.os} />
                <div className="min-w-0 flex-1">
                  <p dir="auto" className="truncate font-medium">{device.name}</p>
                  {device.online ? (
                    <p dir="ltr" className="truncate text-xs text-muted-foreground rtl:text-end">{device.hostname}</p>
                  ) : (
                    <LastSeen device={device} />
                  )}
                </div>
                <StatusBadge online={device.online} />
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">{t("recentTasks")}</h2>
        <EmptyState icon={History} title={t("noTasks")} body={t("noTasksHint")} />
      </section>
    </div>
  );
}
