"use client";

import { useQuery } from "@tanstack/react-query";
import { MonitorSmartphone, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { DeviceCard } from "@/components/devices/device-card";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useErrorMessage } from "@/lib/errors";
import { devicesKey, fetchDevices, useUi } from "@/lib/live";

export function DevicesView() {
  const t = useTranslations("devices");
  const tc = useTranslations("common");
  const errorMessage = useErrorMessage();
  const setPairOpen = useUi((s) => s.setPairOpen);
  const devices = useQuery({ queryKey: devicesKey, queryFn: fetchDevices });

  const pairButton = (
    <Button onClick={() => { setPairOpen(true); }}>
      <Plus />
      {t("pair")}
    </Button>
  );

  return (
    <>
      <PageHeader title={t("title")} description={t("subtitle")} actions={pairButton} />
      {devices.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-52 rounded-xl" />
          ))}
        </div>
      ) : devices.isError ? (
        <EmptyState
          icon={MonitorSmartphone}
          title={tc("error")}
          body={errorMessage(devices.error)}
          action={<Button variant="outline" onClick={() => void devices.refetch()}>{tc("retry")}</Button>}
        />
      ) : devices.data.devices.length === 0 ? (
        <EmptyState icon={MonitorSmartphone} title={t("emptyTitle")} body={t("emptyBody")} action={pairButton} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {devices.data.devices.map((device) => (
            <DeviceCard key={device.id} device={device} />
          ))}
        </div>
      )}
    </>
  );
}
