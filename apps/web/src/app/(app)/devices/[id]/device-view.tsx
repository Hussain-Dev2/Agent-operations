"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Eye, FolderOpen, Monitor, OctagonX, Play, PlugZap, SquareTerminal } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { LastSeen, OsIcon, StatusBadge } from "@/components/devices/device-card";
import { FilesView } from "@/components/devices/files-view";
import { ScreenView } from "@/components/devices/screen-view";
import { TerminalView } from "@/components/devices/terminal-view";
import { EmptyState } from "@/components/empty-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useErrorMessage } from "@/lib/errors";
import { devicesKey, fetchDevices } from "@/lib/live";
import { callTool } from "@/lib/tools";

export function DeviceView({ id }: { id: string }) {
  const t = useTranslations("device");
  const tp = useTranslations("devices");
  const errorMessage = useErrorMessage();
  const devices = useQuery({ queryKey: devicesKey, queryFn: fetchDevices });
  const device = devices.data?.devices.find((d) => d.id === id);

  const kill = useMutation({
    mutationFn: () => callTool(id, "kill", {}),
    onSuccess: () => toast.success(t("stopDone", { name: device?.name ?? "" })),
    onError: (error) => toast.error(errorMessage(error)),
  });
  const resume = useMutation({
    mutationFn: () => callTool(id, "resume", {}),
    onSuccess: () => toast.success(t("resumeDone")),
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (devices.isPending) return <Skeleton className="h-96 rounded-xl" />;
  if (!device) return <EmptyState icon={Monitor} title={tp("emptyTitle")} body="" action={<Button asChild variant="outline"><Link href="/devices">{t("back")}</Link></Button>} />;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="ghost" size="icon" aria-label={t("back")}>
          <Link href="/devices">
            <ArrowLeft className="rtl:rotate-180" />
          </Link>
        </Button>
        <OsIcon os={device.os} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 dir="auto" className="truncate text-xl font-semibold tracking-tight">
              {device.name}
            </h1>
            <StatusBadge online={device.online} />
          </div>
          <p className="text-xs text-muted-foreground">
            {tp(`permissionLevels.${device.permissionLevel}`)}
            {!device.online && (
              <>
                {" · "}
                <LastSeen device={device} />
              </>
            )}
          </p>
        </div>
        {device.online &&
          (device.killed ? (
            <Button onClick={() => { resume.mutate(); }} disabled={resume.isPending || device.permissionLevel === "view_only"}>
              <Play />
              {t("resume")}
            </Button>
          ) : (
            <Button variant="destructive" onClick={() => { kill.mutate(); }} disabled={kill.isPending} title={t("stopHint")}>
              <OctagonX />
              {t("stop")}
            </Button>
          ))}
      </div>

      {device.killed && (
        <Alert variant="destructive">
          <OctagonX />
          <AlertTitle>{t("stopped")}</AlertTitle>
          <AlertDescription>{t("stoppedBody")}</AlertDescription>
        </Alert>
      )}
      {device.online && !device.killed && device.permissionLevel === "view_only" && (
        <Alert>
          <Eye />
          <AlertDescription>{t("viewOnlyNote")}</AlertDescription>
        </Alert>
      )}

      {!device.online ? (
        <EmptyState icon={PlugZap} title={t("offlineTitle")} body={t("offlineBody")} />
      ) : (
        <Tabs defaultValue="screen" className="gap-4">
          <TabsList>
            <TabsTrigger value="screen">
              <Monitor />
              {t("tabs.screen")}
            </TabsTrigger>
            <TabsTrigger value="terminal">
              <SquareTerminal />
              {t("tabs.terminal")}
            </TabsTrigger>
            <TabsTrigger value="files">
              <FolderOpen />
              {t("tabs.files")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="screen">
            <ScreenView device={device} />
          </TabsContent>
          <TabsContent value="terminal">
            <TerminalView device={device} />
          </TabsContent>
          <TabsContent value="files">
            <FilesView device={device} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
