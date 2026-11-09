"use client";

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { create } from "zustand";
import {
  DeviceList,
  HubToDashboard,
  WsTicketResponse,
  decodeFrame,
  type DashboardToHub,
  type FrameHeader,
} from "@operator/shared";
import { ApiRequestError, api } from "./api";

export type LiveStatus = "connecting" | "live" | "disconnected";

interface UiState {
  live: LiveStatus;
  paletteOpen: boolean;
  pairOpen: boolean;
  setLive: (live: LiveStatus) => void;
  setPaletteOpen: (open: boolean) => void;
  setPairOpen: (open: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  live: "connecting",
  paletteOpen: false,
  pairOpen: false,
  setLive: (live) => { set({ live }); },
  setPaletteOpen: (paletteOpen) => { set({ paletteOpen }); },
  setPairOpen: (pairOpen) => { set({ pairOpen }); },
}));

export const devicesKey = ["devices"] as const;

export function fetchDevices(): Promise<DeviceList> {
  return api("/api/devices", { schema: DeviceList });
}

type MessageListener = (message: HubToDashboard) => void;
type FrameListener = (header: FrameHeader, jpeg: Uint8Array) => void;

/**
 * The browser's single live channel to the hub. Components subscribe to screens/terminals
 * declaratively; subscriptions are re-sent after every reconnect, so callers never handle it.
 */
class LiveClient {
  private socket: WebSocket | null = null;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly frameListeners = new Set<FrameListener>();
  private readonly subscriptions = new Map<string, { watch: DashboardToHub; refs: number }>();

  attach(socket: WebSocket | null): void {
    this.socket = socket;
  }

  /** Called on the hub's hello: (re)send every active subscription. */
  resubscribe(): void {
    for (const { watch } of this.subscriptions.values()) this.send(watch);
  }

  dispatch(message: HubToDashboard): void {
    for (const listener of this.messageListeners) listener(message);
  }

  dispatchFrame(data: ArrayBuffer): void {
    const frame = decodeFrame(new Uint8Array(data));
    if (!frame) return;
    for (const listener of this.frameListeners) listener(frame.header, frame.jpeg);
  }

  /** Best effort: input while disconnected is dropped on purpose (never replay stale clicks). */
  send(message: DashboardToHub): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  /** Keep `watch` active until the returned function is called; `unwatch` is sent then. */
  subscribe(key: string, watch: DashboardToHub, unwatch: DashboardToHub): () => void {
    const existing = this.subscriptions.get(key);
    if (existing) {
      existing.watch = watch;
      existing.refs += 1;
    } else this.subscriptions.set(key, { watch, refs: 1 });
    this.send(watch);
    return () => {
      const entry = this.subscriptions.get(key);
      if (!entry) return;
      entry.refs -= 1;
      if (entry.refs > 0) return;
      this.subscriptions.delete(key);
      this.send(unwatch);
    };
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }
}

export const live = new LiveClient();

function apply(client: QueryClient, message: HubToDashboard): void {
  client.setQueryData<DeviceList>(devicesKey, (current) => {
    if (!current) return current;
    switch (message.type) {
      case "device_presence":
        return {
          devices: current.devices.map((d) =>
            d.id === message.deviceId
              ? { ...d, online: message.online, lastSeenAt: message.lastSeenAt, ...(!message.online && { capabilities: null, killed: false }) }
              : d,
          ),
        };
      case "device_updated": {
        const exists = current.devices.some((d) => d.id === message.device.id);
        return {
          devices: exists
            ? current.devices.map((d) => (d.id === message.device.id ? message.device : d))
            : [message.device, ...current.devices],
        };
      }
      case "device_removed":
        return { devices: current.devices.filter((d) => d.id !== message.deviceId) };
      default:
        return current;
    }
  });
}

/** Keeps one dashboard WebSocket open, feeding live events into the query cache and the live client. */
export function useLiveUpdates(): void {
  const client = useQueryClient();
  const setLive = useUi((s) => s.setLive);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;

    const schedule = (): void => {
      live.attach(null);
      if (stopped) return;
      setLive("disconnected");
      attempt += 1;
      retry = setTimeout(() => void connect(), Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2));
    };

    async function connect(): Promise<void> {
      setLive("connecting");
      let ticket: WsTicketResponse;
      try {
        ticket = await api("/api/ws-ticket", { method: "POST", body: {}, schema: WsTicketResponse });
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 401) {
          window.location.assign("/login");
          return;
        }
        schedule();
        return;
      }
      if (stopped) return;
      socket = new WebSocket(`${ticket.wsUrl}?ticket=${encodeURIComponent(ticket.ticket)}`);
      socket.binaryType = "arraybuffer";
      live.attach(socket);
      socket.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          live.dispatchFrame(event.data);
          return;
        }
        if (typeof event.data !== "string") return;
        const parsed = HubToDashboard.safeParse(JSON.parse(event.data));
        if (!parsed.success) return;
        if (parsed.data.type === "hello") {
          attempt = 0;
          setLive("live");
          // Resync anything missed while disconnected, and restore subscriptions.
          void client.invalidateQueries({ queryKey: devicesKey });
          live.resubscribe();
        }
        apply(client, parsed.data);
        live.dispatch(parsed.data);
      };
      socket.onclose = schedule;
    }

    void connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      live.attach(null);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [client, setLive]);
}
