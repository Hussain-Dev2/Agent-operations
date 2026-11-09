"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, CircleCheck, Copy, Loader2, RefreshCw } from "lucide-react";
import { useNow, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { PAIRING_CODE_TTL_MS, PairingCodeResponse } from "@operator/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useErrorMessage } from "@/lib/errors";
import { devicesKey, fetchDevices, useUi } from "@/lib/live";

function CopyLine({ text }: { text: string }) {
  const t = useTranslations("common");
  const [copied, setCopied] = useState(false);
  return (
    <div dir="ltr" className="group flex items-center gap-2 rounded-lg border bg-muted/50 py-1.5 ps-3 pe-1.5">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap">{text}</code>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label={copied ? t("copied") : t("copy")}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => { setCopied(false); }, 1500);
          });
        }}
      >
        {copied ? <Check className="text-success" /> : <Copy />}
      </Button>
    </div>
  );
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const t = useTranslations("pairing");
  const now = useNow({ updateInterval: 1000 });
  const left = Math.max(0, Math.round((new Date(expiresAt).getTime() - now.getTime()) / 1000));
  if (left === 0) return <span className="text-destructive">{t("expired")}</span>;
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");
  return <span>{t("expiresIn", { time: `${mm}:${ss}` })}</span>;
}

export function PairDialog() {
  const t = useTranslations("pairing");
  const errorMessage = useErrorMessage();
  const open = useUi((s) => s.pairOpen);
  const setOpen = useUi((s) => s.setPairOpen);
  const devices = useQuery({ queryKey: devicesKey, queryFn: fetchDevices });

  const create = useMutation({
    mutationFn: () => api("/api/devices/pairing-codes", { method: "POST", body: {}, schema: PairingCodeResponse }),
  });
  const { mutate: createCode, reset } = create;

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    createCode();
  }, [open, createCode, reset]);

  const pairing = create.data;
  // A device created after this code was issued (both timestamps come from the hub) means pairing succeeded.
  const issuedAt = pairing ? new Date(pairing.expiresAt).getTime() - PAIRING_CODE_TTL_MS : null;
  const paired = issuedAt === null ? undefined : devices.data?.devices.find((d) => new Date(d.createdAt).getTime() >= issuedAt);
  const now = useNow({ updateInterval: 1000 });
  const expired = pairing ? new Date(pairing.expiresAt).getTime() <= now.getTime() : false;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("subtitle")}</DialogDescription>
        </DialogHeader>

        {paired ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-success/15">
              {paired.online ? <CircleCheck className="size-7 text-success" /> : <Loader2 className="size-7 animate-spin text-success" />}
            </div>
            <p className="text-lg font-semibold">
              {paired.online ? t("pairedOnline", { name: paired.name }) : t("paired", { name: paired.name })}
            </p>
          </div>
        ) : create.error ? (
          <p className="py-6 text-center text-sm text-destructive">{errorMessage(create.error)}</p>
        ) : !pairing ? (
          <div className="flex justify-center py-10">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid gap-5">
            <div className="flex flex-col items-center gap-2 rounded-xl border bg-gradient-to-b from-primary/10 to-transparent py-5">
              <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t("code")}</span>
              <span dir="ltr" className="font-mono text-4xl font-semibold tracking-[0.3em] tabular-nums">
                {pairing.code.slice(0, 3)} {pairing.code.slice(3)}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                <Countdown expiresAt={pairing.expiresAt} />
              </span>
            </div>
            <ol className="grid gap-3 text-sm">
              <li className="grid gap-1.5">
                <span className="text-muted-foreground">1. {t("step1")}</span>
              </li>
              <li className="grid gap-1.5">
                <span className="text-muted-foreground">2. {t("step2")}</span>
                <CopyLine text={`operator-agent pair --hub ${pairing.hubUrl} --code ${pairing.code}`} />
              </li>
              <li className="grid gap-1.5">
                <span className="text-muted-foreground">3. {t("step3")}</span>
                <CopyLine text="operator-agent run" />
              </li>
            </ol>
            <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {t("waiting")}
            </p>
          </div>
        )}

        <DialogFooter>
          {!paired && pairing && expired && (
            <Button variant="outline" onClick={() => { createCode(); }}>
              <RefreshCw />
              {t("newCode")}
            </Button>
          )}
          <Button variant={paired ? "default" : "outline"} onClick={() => { setOpen(false); }}>
            {t("done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
