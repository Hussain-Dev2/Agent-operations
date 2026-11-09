"use client";

import { useTranslations } from "next-intl";
import { useUi } from "@/lib/live";
import { cn } from "@/lib/utils";

export function LiveIndicator({ className }: { className?: string }) {
  const t = useTranslations("shell");
  const live = useUi((s) => s.live);
  const label = live === "live" ? t("live") : live === "connecting" ? t("connecting") : t("disconnected");
  return (
    <span
      role="status"
      className={cn("inline-flex items-center gap-2 text-xs font-medium text-muted-foreground", className)}
    >
      <span className="relative flex size-2">
        {live === "live" && <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />}
        <span
          className={cn(
            "relative inline-flex size-2 rounded-full",
            live === "live" && "bg-success",
            live === "connecting" && "bg-warning",
            live === "disconnected" && "bg-destructive",
          )}
        />
      </span>
      {label}
    </span>
  );
}
