import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PortalBus, Variant } from "./desktop/dbus.js";

export type KillSource = "hotkey" | "notification" | "remote";

const NOTIFY = { destination: "org.freedesktop.Notifications", path: "/org/freedesktop/Notifications", iface: "org.freedesktop.Notifications" };
const SHORTCUT_ID = "operator-stop";
const IDLE_MS = 20_000;

export class KilledError extends Error {
  constructor() {
    super("Stopped on the device (kill switch). Resume it from the dashboard to continue.");
  }
}

/**
 * Kill switch + "Operator is controlling this PC" indicator.
 * - While actions run, a persistent critical notification with a Stop button is shown.
 * - Stop, the global hotkey (Ctrl+Alt+Shift+Esc via the GlobalShortcuts portal) or a remote kill
 *   blocks every action until a signed `resume` arrives. The state survives agent restarts.
 */
export class Control {
  private killedState = false;
  private notificationId: number | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  hotkey: "registered" | "unavailable" = "unavailable";

  private constructor(
    private readonly flagFile: string,
    private readonly bus: PortalBus | null,
    private readonly onChange: (killed: boolean, source: KillSource) => void,
  ) {}

  static async create(configDir: string, desktopIntegration: boolean, onChange: (killed: boolean, source: KillSource) => void): Promise<Control> {
    const bus = desktopIntegration && process.platform === "linux" ? await PortalBus.connect().catch(() => null) : null;
    const control = new Control(join(configDir, "killed"), bus, onChange);
    control.killedState = await readFile(control.flagFile).then(() => true, () => false);
    if (bus) {
      await control.watchNotifications(bus).catch(() => undefined);
      // May wait on a one-time system confirmation dialog: never block startup on it.
      void control.registerHotkey(bus).catch(() => undefined);
    }
    return control;
  }

  get killed(): boolean {
    return this.killedState;
  }

  /** Call before every action. Throws while killed; otherwise shows the indicator. */
  beginAction(): void {
    if (this.killedState) throw new KilledError();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.hideIndicator(), IDLE_MS);
    if (this.notificationId === null) void this.showIndicator();
  }

  async kill(source: KillSource): Promise<void> {
    if (this.killedState) return;
    this.killedState = true;
    await writeFile(this.flagFile, new Date().toISOString(), { mode: 0o600 }).catch(() => undefined);
    clearTimeout(this.idleTimer);
    await this.hideIndicator();
    await this.toast("Operator stopped", "All remote actions are blocked until you resume from the dashboard.");
    this.onChange(true, source);
  }

  async resume(): Promise<void> {
    if (!this.killedState) return;
    this.killedState = false;
    await rm(this.flagFile, { force: true });
    this.onChange(false, "remote");
  }

  close(): void {
    clearTimeout(this.idleTimer);
    void this.hideIndicator().finally(() => this.bus?.close());
  }

  private async showIndicator(): Promise<void> {
    if (!this.bus) return;
    this.notificationId = 0; // reserve while the call is in flight
    const [id] = await this.bus
      .call(NOTIFY, "Notify", "susssasa{sv}i", [
        "Operator",
        0,
        "dialog-warning",
        "Operator is controlling this PC",
        this.hotkey === "registered" ? "Press Ctrl+Alt+Shift+Esc or Stop to block all remote actions." : "Press Stop to block all remote actions.",
        ["stop", "Stop"],
        { urgency: new Variant("y", 2), resident: new Variant("b", true), "desktop-entry": new Variant("s", "operator-agent") },
        0,
      ])
      .catch(() => [null]);
    this.notificationId = typeof id === "number" ? id : null;
  }

  private async hideIndicator(): Promise<void> {
    const id = this.notificationId;
    this.notificationId = null;
    if (this.bus && id) await this.bus.call(NOTIFY, "CloseNotification", "u", [id]).catch(() => undefined);
  }

  private async toast(summary: string, body: string): Promise<void> {
    if (!this.bus) return;
    await this.bus.call(NOTIFY, "Notify", "susssasa{sv}i", ["Operator", 0, "process-stop", summary, body, [], {}, 8000]).catch(() => undefined);
  }

  private async watchNotifications(bus: PortalBus): Promise<void> {
    await bus.addMatch(`type='signal',interface='${NOTIFY.iface}',path='${NOTIFY.path}'`);
    bus.onSignal({ path: NOTIFY.path, iface: NOTIFY.iface, member: "ActionInvoked" }, ([id, action]) => {
      if (id === this.notificationId && action === "stop") void this.kill("notification");
    });
    bus.onSignal({ path: NOTIFY.path, iface: NOTIFY.iface, member: "NotificationClosed" }, ([id]) => {
      if (id === this.notificationId) this.notificationId = null;
    });
  }

  /** Ctrl+Alt+Shift+Esc through the GlobalShortcuts portal (the only global hotkey route on Wayland). */
  private async registerHotkey(bus: PortalBus): Promise<void> {
    const version = await bus.getProperty("org.freedesktop.portal.GlobalShortcuts", "version");
    if (typeof version !== "number") return;
    const created = await bus.request("GlobalShortcuts", "CreateSession", "a{sv}", (handleToken) => [
      { handle_token: handleToken, session_handle_token: new Variant("s", `operator_keys_${process.pid}`) },
    ]);
    const handle = created.session_handle?.value as unknown;
    if (typeof handle !== "string") return;
    await bus.addMatch(`type='signal',interface='org.freedesktop.portal.GlobalShortcuts',member='Activated'`);
    bus.onSignal({ iface: "org.freedesktop.portal.GlobalShortcuts", member: "Activated" }, ([session, shortcut]) => {
      if (session === handle && shortcut === SHORTCUT_ID) void this.kill("hotkey");
    });
    await bus.request("GlobalShortcuts", "BindShortcuts", "oa(sa{sv})sa{sv}", (handleToken) => [
      handle,
      [[SHORTCUT_ID, { description: new Variant("s", "Stop Operator (block all remote actions)"), preferred_trigger: new Variant("s", "CTRL+ALT+SHIFT+Escape") }]],
      "",
      { handle_token: handleToken },
    ]);
    this.hotkey = "registered";
  }
}
