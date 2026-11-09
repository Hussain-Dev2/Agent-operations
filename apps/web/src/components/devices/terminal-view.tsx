"use client";

import "@xterm/xterm/css/xterm.css";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, SquareTerminal, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Device } from "@operator/shared";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { useErrorMessage } from "@/lib/errors";
import { live } from "@/lib/live";
import { callTool } from "@/lib/tools";
import { cn } from "@/lib/utils";

function XtermPane({ deviceId, id, writable }: { deviceId: string; id: string; writable: boolean }) {
  const t = useTranslations("device.terminal");
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const lifecycle = { disposed: false };
    const cleanups: (() => void)[] = [];

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (lifecycle.disposed) return;
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
        fontSize: 13,
        scrollback: 5000,
        disableStdin: !writable,
        theme: { background: "#0b0e12", foreground: "#e6edf3", cursor: "#5fd4c4", selectionBackground: "#5fd4c455" },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(element);
      fit.fit();
      cleanups.push(() => {
        term.dispose();
      });

      cleanups.push(
        live.onMessage((m) => {
          if (m.type === "pty_data" && m.deviceId === deviceId && m.id === id) term.write(m.data);
          if (m.type === "pty_exit" && m.deviceId === deviceId && m.id === id) term.write(`\r\n\x1b[2m${t("exited", { code: String(m.exitCode ?? "?") })}\x1b[0m\r\n`);
        }),
      );
      cleanups.push(live.subscribe(`pty:${deviceId}:${id}`, { type: "watch_pty", deviceId, id }, { type: "unwatch_pty", deviceId, id }));

      if (writable) {
        const sub = term.onData((data) => {
          live.send({ type: "pty_input", deviceId, id, data });
        });
        cleanups.push(() => {
          sub.dispose();
        });
      }

      let resizeTimer: ReturnType<typeof setTimeout> | undefined;
      const observer = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          fit.fit();
          if (writable) live.send({ type: "pty_resize", deviceId, id, cols: term.cols, rows: term.rows });
        }, 120);
      });
      observer.observe(element);
      cleanups.push(() => {
        observer.disconnect();
        clearTimeout(resizeTimer);
      });
      if (writable) live.send({ type: "pty_resize", deviceId, id, cols: term.cols, rows: term.rows });
      term.focus();
    })();

    return () => {
      lifecycle.disposed = true;
      for (const cleanup of cleanups.reverse()) cleanup();
    };
  }, [deviceId, id, writable, t]);

  return <div dir="ltr" ref={host} className="h-[60vh] min-h-72 w-full overflow-hidden rounded-xl border bg-[#0b0e12] p-2" />;
}

export function TerminalView({ device }: { device: Device }) {
  const t = useTranslations("device.terminal");
  const errorMessage = useErrorMessage();
  const client = useQueryClient();
  const writable = device.permissionLevel !== "view_only" && !device.killed;
  const sessionsKey = ["pty", device.id];
  const sessions = useQuery({
    queryKey: sessionsKey,
    queryFn: () => callTool(device.id, "pty_list", {}),
    enabled: device.online && device.capabilities?.pty === true,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const list = sessions.data?.sessions ?? [];
  const current = list.find((s) => s.id === selected) ?? list.find((s) => s.alive) ?? null;

  const open = useMutation({
    mutationFn: () => callTool(device.id, "pty_open", { cols: 100, rows: 30 }),
    onSuccess: async ({ id }) => {
      await client.invalidateQueries({ queryKey: sessionsKey });
      setSelected(id);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const close = useMutation({
    mutationFn: (id: string) => callTool(device.id, "pty_close", { id }),
    onSuccess: () => client.invalidateQueries({ queryKey: sessionsKey }),
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (device.capabilities?.pty !== true) {
    return <EmptyState icon={SquareTerminal} title={t("unsupported")} body="" />;
  }

  const newButton = (
    <Button size="sm" onClick={() => { open.mutate(); }} disabled={!writable || open.isPending}>
      <Plus />
      {t("new")}
    </Button>
  );

  if (!current) return <EmptyState icon={SquareTerminal} title={t("empty")} body={t("emptyBody")} action={newButton} />;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {list.map((s) => (
          <div
            key={s.id}
            className={cn(
              "flex items-center gap-1 rounded-lg border ps-3 text-sm",
              s.id === current.id ? "border-primary bg-primary/10" : "bg-card",
              !s.alive && "opacity-60",
            )}
          >
            <button type="button" className="py-1.5 font-mono text-xs" onClick={() => { setSelected(s.id); }}>
              {s.title} · {s.id}
            </button>
            {writable && (
              <Button variant="ghost" size="icon" className="size-7" aria-label={t("close")} onClick={() => { close.mutate(s.id); }}>
                <X />
              </Button>
            )}
          </div>
        ))}
        <div className="ms-auto">{newButton}</div>
      </div>
      <XtermPane key={current.id} deviceId={device.id} id={current.id} writable={writable && current.alive} />
    </div>
  );
}
