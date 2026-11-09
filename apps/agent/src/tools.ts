import { randomUUID } from "node:crypto";
import { arch, cpus, freemem, hostname, platform, release, totalmem, uptime } from "node:os";
import {
  STREAM_PRESETS,
  isActTool,
  type AgentEvent,
  type DeviceCapabilities,
  type FrameHeader,
  type InputEvent,
  type ToolArgs,
  type ToolCall,
  type ToolName,
  type ToolResult,
} from "@operator/shared";
import type { Control } from "./control.js";
import { charKeysym, keysym } from "./desktop/keys.js";
import type { Desktop, FrameStream } from "./desktop/types.js";
import { ptySupported, type PtyManager } from "./pty.js";
import { clipboardGet, clipboardSet, clipboardSupported, fileList, fileRead, fileWrite, openApp, runCommand } from "./system.js";
import { AGENT_VERSION } from "./version.js";

export interface Outbox {
  frame(header: FrameHeader, jpeg: Uint8Array): void;
  event(event: AgentEvent): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Long-lived device state shared by all hub connections (terminals and streams outlive reconnects). */
export class Runtime {
  private stream: { id: string; handle: FrameStream } | null = null;
  outbox: Outbox | null = null;

  constructor(
    readonly desktop: Desktop | null,
    readonly desktopReason: string | null,
    readonly pty: PtyManager,
    readonly control: Control,
  ) {}

  capabilities(): DeviceCapabilities {
    return {
      desktop: this.desktop?.kind ?? null,
      desktopUnavailableReason: this.desktop ? null : this.desktopReason,
      pty: ptySupported(),
      clipboard: clipboardSupported(),
    };
  }

  /** Execute a verified tool call. */
  async execute(call: ToolCall): Promise<unknown> {
    if (isActTool(call.name) && call.name !== "resume") this.control.beginAction();
    return dispatch(this, call.name, call.args);
  }

  stopStream(): void {
    this.stream?.handle.stop();
    this.stream = null;
  }

  shutdown(): void {
    this.stopStream();
    this.pty.closeAll();
    this.desktop?.close();
    this.control.close();
  }

  requireDesktop(): Desktop {
    if (!this.desktop) throw new Error(`Desktop control is unavailable: ${this.desktopReason ?? "unsupported"}`);
    return this.desktop;
  }

  async startStream(args: ToolArgs<"stream_start">): Promise<ToolResult<"stream_start">> {
    const desktop = this.requireDesktop();
    this.stopStream();
    const id = randomUUID().slice(0, 8);
    let seq = 0;
    const handle = await desktop.stream(args.monitor, STREAM_PRESETS[args.quality], (frame) => {
      this.outbox?.frame({ streamId: id, monitor: handle.monitor, seq: seq++, width: frame.width, height: frame.height, capturedAt: frame.capturedAt }, frame.jpeg);
    });
    this.stream = { id, handle };
    void handle.ended.then((reason) => {
      if (this.stream?.id === id) this.stream = null;
      if (reason !== "stopped") this.outbox?.event({ event: "stream_ended", streamId: id, reason });
    });
    return { streamId: id, monitor: handle.monitor };
  }

  async applyInput(events: InputEvent[]): Promise<void> {
    const desktop = this.requireDesktop();
    for (const e of events) {
      switch (e.kind) {
        case "move":
          await desktop.move(e.monitor, e.x, e.y);
          break;
        case "button":
          await desktop.button(e.button, e.down);
          break;
        case "scroll":
          await desktop.scroll(e.dx, e.dy);
          break;
        case "key":
          await desktop.key(keysym(e.key), e.down);
          break;
        case "text":
          for (const char of e.text) {
            const sym = charKeysym(char);
            await desktop.key(sym, true);
            await desktop.key(sym, false);
          }
          break;
      }
    }
  }

  async click(monitor: string, x: number, y: number, button: "left" | "right" | "middle", count: number): Promise<void> {
    await this.applyInput([{ kind: "move", monitor, x, y }]);
    for (let i = 0; i < count; i++) {
      if (i > 0) await sleep(60);
      await this.applyInput([
        { kind: "button", button, down: true },
        { kind: "button", button, down: false },
      ]);
    }
  }
}

type Handlers = { [N in ToolName]: (rt: Runtime, args: ToolArgs<N>) => Promise<ToolResult<N>> | ToolResult<N> };

const ok = { ok: true } as const;

const handlers: Handlers = {
  system_info: () => ({
    hostname: hostname(),
    os: platform(),
    release: release(),
    arch: arch(),
    uptimeSec: Math.round(uptime()),
    cpus: cpus().length,
    totalMemBytes: totalmem(),
    freeMemBytes: freemem(),
    agentVersion: AGENT_VERSION,
  }),
  list_monitors: async (rt) => ({ monitors: await rt.requireDesktop().monitors() }),
  screenshot: async (rt, args) => {
    const shot = await rt.requireDesktop().screenshot(args.monitor, { maxWidth: args.maxWidth, quality: args.quality });
    return { monitor: shot.monitor, width: shot.width, height: shot.height, mime: "image/jpeg", data: Buffer.from(shot.jpeg).toString("base64") };
  },
  stream_start: (rt, args) => rt.startStream(args),
  stream_stop: (rt) => {
    rt.stopStream();
    return ok;
  },

  input: async (rt, args) => {
    await rt.applyInput(args.events);
    return ok;
  },
  click: async (rt, a) => {
    await rt.click(a.monitor, a.x, a.y, a.button, 1);
    return ok;
  },
  double_click: async (rt, a) => {
    await rt.click(a.monitor, a.x, a.y, "left", 2);
    return ok;
  },
  right_click: async (rt, a) => {
    await rt.click(a.monitor, a.x, a.y, "right", 1);
    return ok;
  },
  drag: async (rt, a) => {
    await rt.applyInput([{ kind: "move", monitor: a.monitor, ...a.from }, { kind: "button", button: "left", down: true }]);
    for (let i = 1; i <= 10; i++) {
      await sleep(16);
      const t = i / 10;
      await rt.applyInput([{ kind: "move", monitor: a.monitor, x: a.from.x + (a.to.x - a.from.x) * t, y: a.from.y + (a.to.y - a.from.y) * t }]);
    }
    await rt.applyInput([{ kind: "button", button: "left", down: false }]);
    return ok;
  },
  scroll: async (rt, a) => {
    if (a.monitor !== undefined && a.x !== undefined && a.y !== undefined) await rt.applyInput([{ kind: "move", monitor: a.monitor, x: a.x, y: a.y }]);
    await rt.applyInput([{ kind: "scroll", dx: a.dx, dy: a.dy }]);
    return ok;
  },
  type_text: async (rt, a) => {
    await rt.applyInput([{ kind: "text", text: a.text }]);
    return ok;
  },
  press_keys: async (rt, a) => {
    await rt.applyInput(a.keys.map((key) => ({ kind: "key" as const, key, down: true })));
    await rt.applyInput([...a.keys].reverse().map((key) => ({ kind: "key" as const, key, down: false })));
    return ok;
  },
  open_app: async (_rt, a) => ({ launched: await openApp(a.name) }),
  run_command: (_rt, a) => runCommand(a),

  pty_open: (rt, a) => ({ id: rt.pty.open(a) }),
  pty_write: (rt, a) => {
    rt.pty.write(a.id, a.data);
    return ok;
  },
  pty_resize: (rt, a) => {
    rt.pty.resize(a.id, a.cols, a.rows);
    return ok;
  },
  pty_close: (rt, a) => {
    rt.pty.close(a.id);
    return ok;
  },
  pty_list: (rt) => ({ sessions: rt.pty.list() }),
  pty_read: (rt, a) => ({ data: rt.pty.read(a.id, a.maxBytes) }),

  file_list: (_rt, a) => fileList(a),
  file_read: (_rt, a) => fileRead(a),
  file_write: (_rt, a) => fileWrite(a),

  clipboard_get: async () => ({ text: await clipboardGet() }),
  clipboard_set: async (_rt, a) => {
    await clipboardSet(a.text);
    return ok;
  },

  kill: async (rt) => {
    rt.stopStream();
    await rt.control.kill("remote");
    return ok;
  },
  resume: async (rt) => {
    await rt.control.resume();
    return ok;
  },
};

function dispatch<N extends ToolName>(rt: Runtime, name: N, args: ToolArgs<N>): Promise<ToolResult<N>> | ToolResult<N> {
  return handlers[name](rt, args);
}
