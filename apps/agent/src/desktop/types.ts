import type { Monitor, MouseButton } from "@operator/shared";

export interface Frame {
  jpeg: Uint8Array;
  width: number;
  height: number;
  capturedAt: number;
}

export interface StreamOptions {
  fps: number;
  maxWidth: number;
  /** 1–100, higher is better. */
  quality: number;
}

export interface FrameStream {
  readonly monitor: string;
  stop(): void;
  /** Resolves when the stream ends for any reason (stopped, pipeline died, session closed). */
  readonly ended: Promise<string>;
}

/** One desktop backend: screen capture plus pointer/keyboard injection for the current session. */
export interface Desktop {
  readonly kind: "portal" | "nut";
  monitors(): Promise<Monitor[]>;
  stream(monitorId: string | undefined, options: StreamOptions, onFrame: (frame: Frame) => void): Promise<FrameStream>;
  screenshot(monitorId: string | undefined, options: Omit<StreamOptions, "fps">): Promise<Frame & { monitor: string }>;
  /** x, y normalized to the monitor. */
  move(monitorId: string, x: number, y: number): Promise<void>;
  button(button: MouseButton, down: boolean): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
  key(keysym: number, down: boolean): Promise<void>;
  close(): void;
}
