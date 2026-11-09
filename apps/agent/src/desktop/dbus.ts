import { Message, Variant, sessionBus, type MessageBus } from "@particle/dbus-next";

export { Variant };

const PORTAL = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";

export class PortalDeniedError extends Error {}

type Results = Record<string, Variant>;

function isResults(value: unknown): value is Results {
  return typeof value === "object" && value !== null && Object.values(value).every((v) => v instanceof Variant);
}

/**
 * Minimal xdg-desktop-portal client over the session bus. Portal methods reply with a Request
 * object path; the real answer arrives later as that object's Response signal, so we subscribe
 * to the predictable request path before calling.
 */
export class PortalBus {
  private counter = 0;

  private constructor(private readonly bus: MessageBus) {}

  static async connect(): Promise<PortalBus> {
    const bus = sessionBus();
    await new Promise<void>((resolve, reject) => {
      bus.once("connect", () => {
        resolve();
      });
      bus.once("error", (error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    return new PortalBus(bus);
  }

  /** The connection's unique bus name (":1.42"). Present at runtime once connected; missing from the library's typings. */
  get uniqueName(): string {
    const { name } = this.bus as MessageBus & { name: string | null };
    if (!name) throw new Error("D-Bus connection has no unique name yet");
    return name;
  }

  async call(target: { destination?: string; path?: string; iface: string }, member: string, signature: string, body: unknown[]): Promise<unknown[]> {
    const reply = await this.bus.call(
      new Message({
        destination: target.destination ?? PORTAL,
        path: target.path ?? PORTAL_PATH,
        interface: target.iface,
        member,
        signature,
        body,
      }),
    );
    const out: unknown[] = reply?.body ?? [];
    return out;
  }

  async getProperty(iface: string, name: string): Promise<unknown> {
    const [value] = await this.call({ iface: "org.freedesktop.DBus.Properties" }, "Get", "ss", [iface, name]);
    return value instanceof Variant ? (value.value as unknown) : undefined;
  }

  async addMatch(rule: string): Promise<void> {
    await this.call({ destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", iface: "org.freedesktop.DBus" }, "AddMatch", "s", [rule]);
  }

  /** Subscribe to signals matching path/interface/member. Returns an unsubscribe function. */
  onSignal(filter: { path?: string; iface: string; member: string }, handler: (body: unknown[], path: string) => void): () => void {
    const listener = (msg: Message): void => {
      if (msg.interface !== filter.iface || msg.member !== filter.member) return;
      if (filter.path !== undefined && msg.path !== filter.path) return;
      const body: unknown[] = msg.body;
      handler(body, msg.path);
    };
    this.bus.on("message", listener);
    return () => {
      this.bus.off("message", listener);
    };
  }

  /** Call a portal method that answers through org.freedesktop.portal.Request::Response. */
  async request(iface: string, member: string, signature: string, makeBody: (handleToken: Variant) => unknown[]): Promise<Results> {
    const token = `operator_${process.pid}_${++this.counter}`;
    const sender = this.uniqueName.slice(1).replace(/\./g, "_");
    const path = `/org/freedesktop/portal/desktop/request/${sender}/${token}`;
    await this.addMatch(`type='signal',interface='org.freedesktop.portal.Request',member='Response',path='${path}'`);
    const response = new Promise<unknown[]>((resolve) => {
      const off = this.onSignal({ path, iface: "org.freedesktop.portal.Request", member: "Response" }, (body) => {
        off();
        resolve(body);
      });
    });
    await this.call({ iface: `org.freedesktop.portal.${iface}` }, member, signature, makeBody(new Variant("s", token)));
    const [code, results] = await response;
    if (code !== 0) throw new PortalDeniedError(`${iface}.${member} was ${code === 1 ? "cancelled by the user" : "refused"}`);
    if (!isResults(results)) throw new Error(`${iface}.${member}: unexpected response`);
    return results;
  }

  close(): void {
    this.bus.disconnect();
  }
}
