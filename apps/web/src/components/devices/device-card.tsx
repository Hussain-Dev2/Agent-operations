"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Activity, Apple, AppWindow, ArrowRight, Loader2, MoreHorizontal, Pencil, Terminal, Trash2 } from "lucide-react";
import Link from "next/link";
import { useFormatter, useLocale, useNow, useTranslations } from "next-intl";
import { useState, type SyntheticEvent } from "react";
import { toast } from "sonner";
import { Device, PermissionLevel, type DeviceList, type DeviceOs } from "@operator/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useErrorMessage } from "@/lib/errors";
import { formatBytes, formatDuration } from "@/lib/format";
import { devicesKey } from "@/lib/live";
import { callTool } from "@/lib/tools";
import { cn } from "@/lib/utils";

const OS_ICON: Record<DeviceOs, typeof AppWindow> = { windows: AppWindow, macos: Apple, linux: Terminal };
const OS_LABEL: Record<DeviceOs, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };

export function StatusBadge({ online }: { online: boolean }) {
  const t = useTranslations("devices");
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 font-medium", online ? "border-success/30 bg-success/10 text-success" : "text-muted-foreground")}
    >
      <span className={cn("size-1.5 rounded-full", online ? "bg-success" : "bg-muted-foreground/60")} />
      {online ? t("online") : t("offline")}
    </Badge>
  );
}

export function OsIcon({ os, className }: { os: DeviceOs; className?: string }) {
  const Icon = OS_ICON[os];
  return (
    <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary", className)}>
      <Icon className="size-5" />
    </div>
  );
}

export function LastSeen({ device }: { device: Device }) {
  const t = useTranslations("devices");
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  if (device.online) return null;
  return (
    <span className="text-xs text-muted-foreground">
      {device.lastSeenAt ? t("lastSeen", { time: format.relativeTime(new Date(device.lastSeenAt), now) }) : t("neverSeen")}
    </span>
  );
}

function useUpdateDevice(device: Device) {
  const client = useQueryClient();
  const t = useTranslations("devices");
  const errorMessage = useErrorMessage();
  return useMutation({
    mutationFn: (patch: { name?: string; permissionLevel?: PermissionLevel }) =>
      api(`/api/devices/${device.id}`, { method: "PATCH", body: patch, schema: Device }),
    onSuccess: (updated) => {
      client.setQueryData<DeviceList>(devicesKey, (cur) =>
        cur ? { devices: cur.devices.map((d) => (d.id === updated.id ? updated : d)) } : cur,
      );
      toast.success(t("updated"));
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
}

export function DeviceCard({ device }: { device: Device }) {
  const t = useTranslations("devices");
  const tDevice = useTranslations("device");
  const tc = useTranslations("common");
  const locale = useLocale();
  const format = useFormatter();
  const client = useQueryClient();
  const errorMessage = useErrorMessage();
  const update = useUpdateDevice(device);
  const [renameOpen, setRenameOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [name, setName] = useState(device.name);

  const ping = useMutation({
    mutationFn: () => callTool(device.id, "system_info", {}),
    onSuccess: (info) =>
      toast.success(t("systemInfoTitle"), {
        description: t("systemInfoResult", {
          cpus: info.cpus,
          free: formatBytes(info.freeMemBytes, locale),
          total: formatBytes(info.totalMemBytes, locale),
          uptime: formatDuration(info.uptimeSec, locale),
        }),
      }),
    onError: (error) => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: () => api(`/api/devices/${device.id}`, { method: "DELETE" }),
    onSuccess: () => {
      client.setQueryData<DeviceList>(devicesKey, (cur) => (cur ? { devices: cur.devices.filter((d) => d.id !== device.id) } : cur));
      setRemoveOpen(false);
      toast.success(t("removed", { name: device.name }));
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const submitRename = (e: SyntheticEvent): void => {
    e.preventDefault();
    update.mutate({ name: name.trim() }, { onSuccess: () => { setRenameOpen(false); } });
  };

  return (
    <Card className="gap-0 p-0">
      <div className="flex items-start gap-3 p-4">
        <OsIcon os={device.os} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 dir="auto" className="truncate font-semibold">{device.name}</h3>
          </div>
          <p className="truncate text-xs text-muted-foreground" dir="ltr">
            {OS_LABEL[device.os]} · {device.arch} · {device.hostname}
          </p>
        </div>
        <StatusBadge online={device.online} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="-me-2 -mt-1 size-8" aria-label={t("actions")}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => {
                setName(device.name);
                setRenameOpen(true);
              }}
            >
              <Pencil />
              {t("rename")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => { setRemoveOpen(true); }}>
              <Trash2 />
              {t("remove")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="grid gap-1.5 border-t px-4 py-3">
        <Label className="text-xs text-muted-foreground">{t("permission")}</Label>
        <Select
          value={device.permissionLevel}
          onValueChange={(value) => { update.mutate({ permissionLevel: PermissionLevel.parse(value) }); }}
          disabled={update.isPending}
        >
          <SelectTrigger className="w-full">
            <SelectValue>{t(`permissionLevels.${device.permissionLevel}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {PermissionLevel.options.map((level) => (
              <SelectItem key={level} value={level}>
                <div className="flex flex-col items-start">
                  <span>{t(`permissionLevels.${level}`)}</span>
                  <span className="text-xs text-muted-foreground">{t(`permissionHints.${level}`)}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-2 border-t px-4 py-3">
        <span className="text-xs text-muted-foreground">
          {device.online ? (
            <span dir="ltr">v{device.agentVersion}</span>
          ) : (
            <LastSeen device={device} />
          )}
          <span className="sr-only"> · {t("pairedOn", { date: format.dateTime(new Date(device.createdAt), { dateStyle: "medium" }) })}</span>
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={!device.online || ping.isPending} onClick={() => { ping.mutate(); }}>
            {ping.isPending ? <Loader2 className="animate-spin" /> : <Activity />}
            {t("systemInfo")}
          </Button>
          <Button size="sm" asChild>
            <Link href={`/devices/${device.id}`}>
              {tDevice("open")}
              <ArrowRight className="rtl:rotate-180" />
            </Link>
          </Button>
        </div>
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <form onSubmit={submitRename} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{t("rename")}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor={`name-${device.id}`}>{t("name")}</Label>
              <Input id={`name-${device.id}`} value={name} maxLength={64} required onChange={(e) => { setName(e.target.value); }} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setRenameOpen(false); }}>
                {tc("cancel")}
              </Button>
              <Button type="submit" disabled={update.isPending || !name.trim()}>
                {tc("save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("removeTitle", { name: device.name })}</DialogTitle>
            <DialogDescription>{t("removeBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRemoveOpen(false); }}>
              {tc("cancel")}
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => { remove.mutate(); }}>
              {remove.isPending && <Loader2 className="animate-spin" />}
              {tc("remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
