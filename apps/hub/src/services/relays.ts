import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import { decodeFrame, encodeFrame, type HubToDashboard, type StreamQuality } from "@operator/shared";
import type { AgentRegistry } from "./agents.js";

/** Skip frames for a viewer while this much is still queued to it (slow phone link). */
const VIEWER_BACKPRESSURE_BYTES = 1024 * 1024;

function send(socket: WebSocket, message: HubToDashboard): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

interface ScreenState {
  viewers: Set<WebSocket>;
  monitor: string | undefined;
  quality: StreamQuality;
}

/**
 * One live stream per device, shared by all viewers. Started when the first viewer arrives,
 * reconfigured when a viewer picks another monitor/quality, stopped after the last one leaves.
 */
export class ScreenRelay {
  private readonly devices = new Map<string, ScreenState>();

  constructor(
    private readonly agents: AgentRegistry,
    private readonly log: FastifyBaseLogger,
  ) {}

  async watch(deviceId: string, socket: WebSocket, monitor: string | undefined, quality: StreamQuality): Promise<void> {
    const state = this.devices.get(deviceId) ?? { viewers: new Set<WebSocket>(), monitor, quality };
    state.viewers.add(socket);
    state.monitor = monitor;
    state.quality = quality;
    this.devices.set(deviceId, state);
    await this.start(deviceId);
  }

  unwatch(deviceId: string, socket: WebSocket): void {
    const state = this.devices.get(deviceId);
    if (!state?.viewers.delete(socket) || state.viewers.size > 0) return;
    this.devices.delete(deviceId);
    if (this.agents.isOnline(deviceId)) {
      this.agents.invoke(deviceId, "stream_stop", {}).catch((error: unknown) => {
        this.log.debug({ err: error, deviceId }, "stream_stop failed");
      });
    }
  }

  dropSocket(socket: WebSocket): void {
    for (const deviceId of [...this.devices.keys()]) this.unwatch(deviceId, socket);
  }

  /** Relay one binary frame from an agent, tagged with the device id. */
  frame(deviceId: string, data: Buffer): void {
    const state = this.devices.get(deviceId);
    if (!state) return;
    const decoded = decodeFrame(data);
    if (!decoded) return;
    const tagged = encodeFrame({ ...decoded.header, deviceId }, decoded.jpeg);
    for (const viewer of state.viewers) {
      if (viewer.readyState === viewer.OPEN && viewer.bufferedAmount < VIEWER_BACKPRESSURE_BYTES) viewer.send(tagged);
    }
  }

  /** Stream ended on the device (pipeline died, kill switch, device offline). */
  ended(deviceId: string, reason: string): void {
    for (const viewer of this.devices.get(deviceId)?.viewers ?? []) send(viewer, { type: "screen_ended", deviceId, reason });
  }

  /** Device (re)connected or resumed: restart the stream if anyone is watching. */
  async resume(deviceId: string): Promise<void> {
    if (this.devices.has(deviceId)) await this.start(deviceId);
  }

  private async start(deviceId: string): Promise<void> {
    const state = this.devices.get(deviceId);
    if (!state) return;
    try {
      // Generous timeout: the first stream on a machine waits for the user's consent dialog.
      const started = await this.agents.invoke(
        deviceId,
        "stream_start",
        { ...(state.monitor !== undefined && { monitor: state.monitor }), quality: state.quality },
        120_000,
      );
      for (const viewer of state.viewers) send(viewer, { type: "screen_started", deviceId, streamId: started.streamId, monitor: started.monitor });
    } catch (error) {
      this.ended(deviceId, error instanceof Error ? error.message : "Could not start the screen stream");
    }
  }
}

/** Fan-out of terminal output to the dashboards attached to each session. */
export class TerminalRelay {
  private readonly watchers = new Map<string, Set<WebSocket>>();

  private key(deviceId: string, id: string): string {
    return `${deviceId}/${id}`;
  }

  watch(deviceId: string, id: string, socket: WebSocket): void {
    const key = this.key(deviceId, id);
    const set = this.watchers.get(key) ?? new Set<WebSocket>();
    set.add(socket);
    this.watchers.set(key, set);
  }

  unwatch(deviceId: string, id: string, socket: WebSocket): void {
    const key = this.key(deviceId, id);
    const set = this.watchers.get(key);
    set?.delete(socket);
    if (set?.size === 0) this.watchers.delete(key);
  }

  dropSocket(socket: WebSocket): void {
    for (const [key, set] of this.watchers) {
      set.delete(socket);
      if (set.size === 0) this.watchers.delete(key);
    }
  }

  publish(deviceId: string, message: Extract<HubToDashboard, { type: "pty_data" | "pty_exit" }>): void {
    for (const socket of this.watchers.get(this.key(deviceId, message.id)) ?? []) send(socket, message);
  }
}
