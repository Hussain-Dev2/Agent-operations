import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Monitor, MouseButton } from "@operator/shared";
import { PortalBus, Variant } from "./dbus.js";
import { detectGstreamer, startPipewireMjpeg } from "./gst.js";
import type { Desktop, Frame, FrameStream, StreamOptions } from "./types.js";

const DEVICE_KEYBOARD = 1;
const DEVICE_POINTER = 2;
const SOURCE_MONITOR = 1;
const CURSOR_EMBEDDED = 2;
const PERSIST_UNTIL_REVOKED = 2;
const BUTTON_CODES: Record<MouseButton, number> = { left: 0x110, right: 0x111, middle: 0x112 };

/**
 * Units per wheel notch for NotifyPointerAxisDiscrete. The portal spec means "steps" (notches) and
 * GNOME implements it that way, but KDE's portal forwards the value as raw scroll units, where
 * one notch is 15 (measured: 3 "steps" scrolled ~1/5 of a notch on Plasma 6.7).
 */
function unitsPerNotch(): number {
  return (process.env.XDG_CURRENT_DESKTOP ?? "").toUpperCase().split(":").includes("KDE") ? 15 : 1;
}

interface PortalStream {
  node: number;
  monitor: Monitor;
}

interface Session {
  handle: string;
  streams: PortalStream[];
  closed: boolean;
}

function asPair(value: unknown): [number, number] | null {
  return Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number" ? [value[0], value[1]] : null;
}

function parseStreams(value: unknown): PortalStream[] {
  if (!Array.isArray(value)) throw new Error("Portal returned no screen streams");
  const raw = value.flatMap((entry: unknown) => {
    if (!Array.isArray(entry) || typeof entry[0] !== "number") return [];
    const props = (entry[1] ?? {}) as Record<string, unknown>;
    const pick = (k: string): unknown => (props[k] instanceof Variant ? (props[k].value as unknown) : undefined);
    const position = asPair(pick("position")) ?? [0, 0];
    const size = asPair(pick("size"));
    if (!size) return [];
    return [{ node: entry[0], position, size }];
  });
  raw.sort((a, b) => a.position[0] - b.position[0] || a.position[1] - b.position[1]);
  return raw.map((s, i) => ({
    node: s.node,
    monitor: {
      id: `m${i}`,
      name: `Monitor ${i + 1}`,
      x: s.position[0],
      y: s.position[1],
      width: s.size[0],
      height: s.size[1],
      primary: s.position[0] === 0 && s.position[1] === 0,
    },
  }));
}

/**
 * Wayland backend via xdg-desktop-portal RemoteDesktop + ScreenCast. The user approves one
 * system dialog the first time; the restore token saved next to the identity makes later
 * sessions start silently until the user revokes it in system settings.
 */
export class PortalDesktop implements Desktop {
  readonly kind = "portal";
  private session: Promise<Session> | null = null;
  private readonly streams = new Set<FrameStream>();

  private constructor(
    private readonly bus: PortalBus,
    private readonly encoder: "jpegenc" | "avenc_mjpeg",
    private readonly tokenFile: string,
  ) {}

  /** Returns a backend, or the reason this session cannot be controlled through the portal. */
  static async detect(configDir: string): Promise<PortalDesktop | { reason: string }> {
    if (process.platform !== "linux" || !process.env.WAYLAND_DISPLAY) return { reason: "Not a Wayland session" };
    const gst = await detectGstreamer();
    if ("missing" in gst) return { reason: gst.missing };
    let bus: PortalBus;
    try {
      bus = await PortalBus.connect();
    } catch {
      return { reason: "Cannot reach the D-Bus session bus" };
    }
    try {
      const remote = await bus.getProperty("org.freedesktop.portal.RemoteDesktop", "version");
      const cast = await bus.getProperty("org.freedesktop.portal.ScreenCast", "version");
      if (typeof remote !== "number" || remote < 2 || typeof cast !== "number") {
        bus.close();
        return { reason: "The desktop portal does not offer RemoteDesktop v2 + ScreenCast" };
      }
    } catch {
      bus.close();
      return { reason: "No xdg-desktop-portal with RemoteDesktop support is running" };
    }
    return new PortalDesktop(bus, gst.encoder, join(configDir, "portal-restore-token"));
  }

  async monitors(): Promise<Monitor[]> {
    return (await this.ensureSession()).streams.map((s) => s.monitor);
  }

  async stream(monitorId: string | undefined, options: StreamOptions, onFrame: (frame: Frame) => void): Promise<FrameStream> {
    const target = this.pick(await this.ensureSession(), monitorId);
    const stream = startPipewireMjpeg(target.node, this.encoder, target.monitor, target.monitor.id, options, onFrame);
    this.streams.add(stream);
    void stream.ended.finally(() => this.streams.delete(stream));
    return stream;
  }

  async screenshot(monitorId: string | undefined, options: Omit<StreamOptions, "fps">): Promise<Frame & { monitor: string }> {
    const target = this.pick(await this.ensureSession(), monitorId);
    return new Promise((resolve, reject) => {
      let done = false;
      const stream = startPipewireMjpeg(target.node, this.encoder, target.monitor, target.monitor.id, { ...options, fps: 10 }, (frame) => {
        if (done) return;
        done = true;
        stream.stop();
        resolve({ ...frame, monitor: target.monitor.id });
      });
      void stream.ended.then((reason) => {
        if (!done) reject(new Error(`Screenshot failed: ${reason}`));
      });
      setTimeout(() => {
        if (done) return;
        done = true;
        stream.stop();
        reject(new Error("Screenshot timed out"));
      }, 10_000);
    });
  }

  async move(monitorId: string, x: number, y: number): Promise<void> {
    const session = await this.ensureSession();
    const target = this.pick(session, monitorId);
    await this.notify("NotifyPointerMotionAbsolute", "oa{sv}udd", [session.handle, {}, target.node, x * target.monitor.width, y * target.monitor.height]);
  }

  async button(button: MouseButton, down: boolean): Promise<void> {
    const session = await this.ensureSession();
    await this.notify("NotifyPointerButton", "oa{sv}iu", [session.handle, {}, BUTTON_CODES[button], down ? 1 : 0]);
  }

  async scroll(dx: number, dy: number): Promise<void> {
    const session = await this.ensureSession();
    const scale = unitsPerNotch();
    if (dy !== 0) await this.notify("NotifyPointerAxisDiscrete", "oa{sv}ui", [session.handle, {}, 0, dy * scale]);
    if (dx !== 0) await this.notify("NotifyPointerAxisDiscrete", "oa{sv}ui", [session.handle, {}, 1, dx * scale]);
  }

  async key(keysym: number, down: boolean): Promise<void> {
    const session = await this.ensureSession();
    await this.notify("NotifyKeyboardKeysym", "oa{sv}iu", [session.handle, {}, keysym, down ? 1 : 0]);
  }

  close(): void {
    for (const s of this.streams) s.stop();
    void this.session?.then((s) => this.bus.call({ path: s.handle, iface: "org.freedesktop.portal.Session" }, "Close", "", [])).catch(() => undefined);
    this.bus.close();
  }

  private pick(session: Session, monitorId: string | undefined): PortalStream {
    const stream = monitorId === undefined ? (session.streams.find((s) => s.monitor.primary) ?? session.streams[0]) : session.streams.find((s) => s.monitor.id === monitorId);
    if (!stream) throw new Error(monitorId === undefined ? "No monitors available" : `Unknown monitor "${monitorId}"`);
    return stream;
  }

  private async notify(member: string, signature: string, body: unknown[]): Promise<void> {
    await this.bus.call({ iface: "org.freedesktop.portal.RemoteDesktop" }, member, signature, body);
  }

  private ensureSession(): Promise<Session> {
    if (!this.session) {
      this.session = this.openSession().catch((error: unknown) => {
        this.session = null;
        throw error;
      });
    }
    return this.session;
  }

  private async openSession(): Promise<Session> {
    const restoreToken = await readFile(this.tokenFile, "utf8").then((t) => t.trim(), () => "");
    const created = await this.bus.request("RemoteDesktop", "CreateSession", "a{sv}", (handleToken) => [
      { handle_token: handleToken, session_handle_token: new Variant("s", `operator_${process.pid}_${Date.now()}`) },
    ]);
    const handle = created.session_handle?.value as unknown;
    if (typeof handle !== "string") throw new Error("Portal did not return a session handle");

    await this.bus.request("RemoteDesktop", "SelectDevices", "oa{sv}", (handleToken) => [
      handle,
      {
        handle_token: handleToken,
        types: new Variant("u", DEVICE_KEYBOARD | DEVICE_POINTER),
        persist_mode: new Variant("u", PERSIST_UNTIL_REVOKED),
        ...(restoreToken && { restore_token: new Variant("s", restoreToken) }),
      },
    ]);
    await this.bus.request("ScreenCast", "SelectSources", "oa{sv}", (handleToken) => [
      handle,
      { handle_token: handleToken, types: new Variant("u", SOURCE_MONITOR), multiple: new Variant("b", true), cursor_mode: new Variant("u", CURSOR_EMBEDDED) },
    ]);
    const started = await this.bus.request("RemoteDesktop", "Start", "osa{sv}", (handleToken) => [handle, "", { handle_token: handleToken }]);
    const token = started.restore_token?.value as unknown;
    if (typeof token === "string") await writeFile(this.tokenFile, token, { mode: 0o600 });

    const session: Session = { handle, streams: parseStreams(started.streams?.value), closed: false };
    if (session.streams.length === 0) throw new Error("No screens were shared");

    await this.bus.addMatch(`type='signal',interface='org.freedesktop.portal.Session',member='Closed',path='${handle}'`);
    const off = this.bus.onSignal({ path: handle, iface: "org.freedesktop.portal.Session", member: "Closed" }, () => {
      off();
      session.closed = true;
      this.session = null;
      for (const s of this.streams) s.stop();
    });
    return session;
  }
}
