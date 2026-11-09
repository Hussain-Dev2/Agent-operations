"use client";

import { useQuery } from "@tanstack/react-query";
import { Expand, Hand, Keyboard, Loader2, MonitorX, RefreshCw, Shrink } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { StreamQuality, type Device, type InputEvent } from "@operator/shared";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { live } from "@/lib/live";
import { callTool } from "@/lib/tools";
import { cn } from "@/lib/utils";

type Status = { kind: "connecting" } | { kind: "live" } | { kind: "ended"; reason: string };
/** A status only applies to the subscription (monitor/quality/attempt) it was observed on. */
type KeyedStatus = Status & { key: string };

const FLUSH_MS = 33;
const LONG_PRESS_MS = 550;
const DRAG_THRESHOLD_PX = 8;
const WHEEL_STEP_PX = 100;
const TOUCH_SCROLL_STEP_PX = 40;
/** Browser key values that have no meaning on the remote machine. */
const IGNORED_KEYS = new Set(["Dead", "Unidentified", "Process", "Compose"]);
type Modifier = "Control" | "Alt" | "Meta";

/** Batches input events (coalescing pointer moves) and sends them over the live channel. */
function useInputSender(deviceId: string) {
  const queue = useRef<InputEvent[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = useCallback(() => {
    timer.current = undefined;
    while (queue.current.length > 0) live.send({ type: "input", deviceId, events: queue.current.splice(0, 200) });
  }, [deviceId]);

  const push = useCallback(
    (...events: InputEvent[]) => {
      for (const e of events) {
        const last = queue.current.at(-1);
        if (e.kind === "move" && last?.kind === "move") queue.current[queue.current.length - 1] = e;
        else queue.current.push(e);
      }
      timer.current ??= setTimeout(flush, FLUSH_MS);
    },
    [flush],
  );

  useEffect(() => () => {
    clearTimeout(timer.current);
    flush();
  }, [flush]);

  return push;
}

export function ScreenView({ device }: { device: Device }) {
  const t = useTranslations("device.screen");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keyboardRef = useRef<HTMLInputElement>(null);
  const [monitor, setMonitor] = useState<string | undefined>(undefined);
  const [quality, setQuality] = useState<StreamQuality>("medium");
  const [observed, setObserved] = useState<KeyedStatus>({ kind: "connecting", key: "" });
  const [fps, setFps] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [controlling, setControlling] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [sticky, setSticky] = useState<Set<Modifier>>(new Set());
  const [activeMonitor, setActiveMonitor] = useState<string | undefined>(undefined);
  const streamMonitor = useRef<string>("m0");
  const frameSize = useRef({ width: 1, height: 1 });
  const send = useInputSender(device.id);

  const desktop = device.capabilities?.desktop ?? null;
  const viewable = device.online && desktop !== null && !device.killed;
  const canControl = viewable && device.permissionLevel !== "view_only";
  const active = controlling && canControl;

  const subKey = `${monitor ?? ""}|${quality}|${attempt}`;
  const subKeyRef = useRef(subKey);
  useEffect(() => {
    subKeyRef.current = subKey;
  }, [subKey]);
  const status: Status = observed.key === subKey ? observed : { kind: "connecting" };

  const monitors = useQuery({
    queryKey: ["monitors", device.id],
    queryFn: () => callTool(device.id, "list_monitors", {}),
    enabled: viewable,
    staleTime: 60_000,
  });

  // Subscribe to the stream; the live client re-sends this after reconnects.
  useEffect(() => {
    if (!viewable) return;
    return live.subscribe(
      `screen:${device.id}`,
      { type: "watch_screen", deviceId: device.id, quality, ...(monitor !== undefined && { monitor }) },
      { type: "unwatch_screen", deviceId: device.id },
    );
  }, [device.id, viewable, monitor, quality, attempt]);

  // Status messages for this device.
  useEffect(
    () =>
      live.onMessage((m) => {
        if (m.type === "screen_started" && m.deviceId === device.id) {
          streamMonitor.current = m.monitor;
          setActiveMonitor(m.monitor);
        }
        if (m.type === "screen_ended" && m.deviceId === device.id) setObserved({ kind: "ended", reason: m.reason, key: subKeyRef.current });
      }),
    [device.id],
  );

  // Decode and paint frames; skip frames that arrive while one is still decoding.
  useEffect(() => {
    let decoding = false;
    let count = 0;
    const tick = setInterval(() => {
      setFps(count);
      count = 0;
    }, 1000);
    const off = live.onFrame((header, jpeg) => {
      if (header.deviceId !== device.id || decoding) return;
      decoding = true;
      streamMonitor.current = header.monitor;
      createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }))
        .then((bitmap) => {
          const canvas = canvasRef.current;
          const ctx = canvas?.getContext("2d");
          if (canvas && ctx) {
            if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
            }
            ctx.drawImage(bitmap, 0, 0);
            frameSize.current = { width: bitmap.width, height: bitmap.height };
          }
          bitmap.close();
          count += 1;
          const key = subKeyRef.current;
          setObserved((s) => (s.kind === "live" && s.key === key ? s : { kind: "live", key }));
        })
        .catch(() => undefined)
        .finally(() => {
          decoding = false;
        });
    });
    return () => {
      off();
      clearInterval(tick);
    };
  }, [device.id]);

  /** Client point → normalized monitor coordinates, accounting for letterboxing (object-contain). */
  const toRemote = useCallback((clientX: number, clientY: number): InputEvent & { kind: "move" } => {
    const rect = canvasRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 1, 1);
    const { width: fw, height: fh } = frameSize.current;
    const scale = Math.min(rect.width / fw, rect.height / fh);
    const dw = fw * scale;
    const dh = fh * scale;
    const x = (clientX - rect.left - (rect.width - dw) / 2) / dw;
    const y = (clientY - rect.top - (rect.height - dh) / 2) / dh;
    return { kind: "move", monitor: streamMonitor.current, x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }, []);

  // ---- mouse / pen ----
  const buttons = ["left", "middle", "right"] as const;

  // ---- touch gestures ----
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ startX: number; startY: number; dragging: boolean; consumed: boolean; timer?: ReturnType<typeof setTimeout>; scrollAcc: number } | null>(null);

  const withModifiers = useCallback(
    (events: InputEvent[]): InputEvent[] => {
      if (sticky.size === 0) return events;
      const mods = [...sticky];
      setSticky(new Set());
      return [...mods.map((key) => ({ kind: "key" as const, key, down: true })), ...events, ...mods.reverse().map((key) => ({ kind: "key" as const, key, down: false }))];
    },
    [sticky],
  );

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>): void => {
    if (!active) return;
    e.preventDefault();
    e.currentTarget.focus();
    if (e.pointerType === "touch") {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.current.size === 1) {
        const g: NonNullable<typeof gesture.current> = { startX: e.clientX, startY: e.clientY, dragging: false, consumed: false, scrollAcc: 0 };
        g.timer = setTimeout(() => {
          g.consumed = true;
          send(toRemote(g.startX, g.startY), { kind: "button", button: "right", down: true }, { kind: "button", button: "right", down: false });
        }, LONG_PRESS_MS);
        gesture.current = g;
      } else if (gesture.current) {
        clearTimeout(gesture.current.timer);
        if (gesture.current.dragging) send({ kind: "button", button: "left", down: false });
        gesture.current.consumed = true;
        gesture.current.dragging = false;
      }
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    send(toRemote(e.clientX, e.clientY), { kind: "button", button: buttons[e.button] ?? "left", down: true });
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>): void => {
    if (!active) return;
    if (e.pointerType !== "touch") {
      send(toRemote(e.clientX, e.clientY));
      return;
    }
    const previous = touches.current.get(e.pointerId);
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g || !previous) return;
    if (touches.current.size >= 2) {
      g.scrollAcc += previous.y - e.clientY;
      const steps = Math.trunc(g.scrollAcc / TOUCH_SCROLL_STEP_PX);
      if (steps !== 0) {
        g.scrollAcc -= steps * TOUCH_SCROLL_STEP_PX;
        send({ kind: "scroll", dx: 0, dy: steps });
      }
      return;
    }
    if (g.consumed) return;
    if (!g.dragging && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > DRAG_THRESHOLD_PX) {
      clearTimeout(g.timer);
      g.dragging = true;
      send(toRemote(g.startX, g.startY), { kind: "button", button: "left", down: true });
    }
    if (g.dragging) send(toRemote(e.clientX, e.clientY));
  };

  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>): void => {
    if (!active) return;
    if (e.pointerType !== "touch") {
      send(toRemote(e.clientX, e.clientY), { kind: "button", button: buttons[e.button] ?? "left", down: false });
      return;
    }
    touches.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g || touches.current.size > 0) return;
    clearTimeout(g.timer);
    if (g.dragging) send(toRemote(e.clientX, e.clientY), { kind: "button", button: "left", down: false });
    else if (!g.consumed) send(...withModifiers([toRemote(g.startX, g.startY), { kind: "button", button: "left", down: true }, { kind: "button", button: "left", down: false }]));
    gesture.current = null;
  };

  // Wheel needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;
    let acc = 0;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      acc += e.deltaMode === 0 ? e.deltaY : e.deltaY * WHEEL_STEP_PX;
      const steps = Math.trunc(acc / WHEEL_STEP_PX);
      if (steps === 0) return;
      acc -= steps * WHEEL_STEP_PX;
      send({ kind: "scroll", dx: 0, dy: steps });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [active, send]);

  const onKey = (e: KeyboardEvent<HTMLCanvasElement>, down: boolean): void => {
    if (!active || IGNORED_KEYS.has(e.key)) return;
    e.preventDefault();
    send({ kind: "key", key: e.key, down });
  };

  // Phone keyboard: a hidden input holding one sentinel space; shrinking means Backspace.
  const onPhoneInput = (el: HTMLInputElement): void => {
    const value = el.value;
    if (value.length === 0) send(...withModifiers([{ kind: "key", key: "Backspace", down: true }, { kind: "key", key: "Backspace", down: false }]));
    else if (value.length > 1) {
      const text = value.slice(1);
      send(...withModifiers(sticky.size > 0 ? Array.from(text).flatMap((key) => [{ kind: "key" as const, key, down: true }, { kind: "key" as const, key, down: false }]) : [{ kind: "text", text }]));
    }
    el.value = " ";
  };

  const tapKey = (key: string): void => {
    send(...withModifiers([{ kind: "key", key, down: true }, { kind: "key", key, down: false }]));
  };

  const toggleSticky = (mod: Modifier): void => {
    setSticky((s) => {
      const next = new Set(s);
      if (next.has(mod)) next.delete(mod);
      else next.add(mod);
      return next;
    });
  };

  if (!desktop) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-16 text-center">
        <MonitorX className="size-8 text-muted-foreground" />
        <p className="font-medium">{t("noDesktop")}</p>
        {device.capabilities?.desktopUnavailableReason && <p className="text-sm text-muted-foreground">{device.capabilities.desktopUnavailableReason}</p>}
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-3", expanded && "fixed inset-0 z-50 gap-0 bg-black")}>
      <div className={cn("flex flex-wrap items-center gap-2", expanded && "bg-background/90 px-3 py-2 backdrop-blur")}>
        {(monitors.data?.monitors.length ?? 0) > 1 && (
          <Select value={monitor ?? activeMonitor ?? "m0"} onValueChange={setMonitor}>
            <SelectTrigger size="sm" className="w-36" aria-label={t("monitor")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {monitors.data?.monitors.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={quality} onValueChange={(v) => { setQuality(StreamQuality.parse(v)); }}>
          <SelectTrigger size="sm" className="w-36" aria-label={t("quality")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {StreamQuality.options.map((q) => (
              <SelectItem key={q} value={q}>
                {t(`qualities.${q}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {status.kind === "live" && <span className="text-xs tabular-nums text-muted-foreground">{t("fps", { fps })}</span>}
        <div className="ms-auto flex gap-2">
          {canControl && (
            <Button size="sm" variant={active ? "destructive" : "default"} onClick={() => { setControlling(!active); }}>
              <Hand />
              {active ? t("release") : t("takeOver")}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => { setExpanded(!expanded); }} aria-label={expanded ? t("exitFullscreen") : t("fullscreen")}>
            {expanded ? <Shrink /> : <Expand />}
          </Button>
        </div>
      </div>

      <div className={cn("relative overflow-hidden rounded-xl border bg-black", active && "ring-2 ring-destructive", expanded && "flex-1 rounded-none border-0")}>
        {active && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-destructive/90 py-1 text-center text-xs font-medium text-white">{t("controlling")}</div>
        )}
        <canvas
          ref={canvasRef}
          width={1280}
          height={720}
          tabIndex={0}
          aria-label="Remote screen"
          className={cn("block aspect-video h-auto w-full object-contain outline-none", expanded && "aspect-auto h-full", active ? "cursor-crosshair touch-none" : "cursor-default")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(e) => { if (active) e.preventDefault(); }}
          onKeyDown={(e) => { onKey(e, true); }}
          onKeyUp={(e) => { onKey(e, false); }}
        />
        {status.kind !== "live" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-sm text-white">
            {status.kind === "connecting" ? (
              <>
                <Loader2 className="size-6 animate-spin" />
                {t("connecting")}
              </>
            ) : (
              <>
                <p className="font-medium">{t("ended")}</p>
                <p className="max-w-md px-4 text-center text-xs text-white/70">{status.reason}</p>
                <Button size="sm" variant="secondary" onClick={() => { setAttempt((a) => a + 1); }}>
                  <RefreshCw />
                  {t("retry")}
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {active && (
        <div className={cn("flex flex-wrap items-center gap-1.5", expanded && "bg-background/90 px-3 py-2")}>
          <Button size="sm" variant="secondary" onClick={() => keyboardRef.current?.focus()}>
            <Keyboard />
            {t("keyboard")}
          </Button>
          {(["Control", "Alt", "Meta"] as const).map((mod) => (
            <Button key={mod} size="sm" variant={sticky.has(mod) ? "default" : "outline"} onClick={() => { toggleSticky(mod); }}>
              {mod === "Control" ? "Ctrl" : mod === "Meta" ? "Super" : "Alt"}
            </Button>
          ))}
          {[
            ["Escape", "Esc"],
            ["Tab", "Tab"],
            ["ArrowLeft", "←"],
            ["ArrowUp", "↑"],
            ["ArrowDown", "↓"],
            ["ArrowRight", "→"],
            ["Backspace", "⌫"],
            ["Enter", "⏎"],
          ].map(([key, label]) => (
            <Button key={key} size="sm" variant="outline" className="min-w-10 font-mono" onClick={() => { tapKey(key ?? ""); }}>
              {label}
            </Button>
          ))}
          <p className="w-full text-xs text-muted-foreground md:hidden">{t("touchHint")}</p>
          <input
            ref={keyboardRef}
            aria-label={t("typeHere")}
            defaultValue=" "
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="pointer-events-none absolute size-px opacity-0"
            onInput={(e) => { onPhoneInput(e.currentTarget); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                tapKey("Enter");
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
