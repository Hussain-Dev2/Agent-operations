import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  CommandPayload,
  HubToAgent,
  HubToDashboard,
  agentAuthMessage,
  decodeFrame,
  encodeFrame,
  type DashboardToHub,
  type DeviceList,
  type PairResponse,
  type PairingCodeResponse,
} from "@operator/shared";
import { generateEd25519KeyPair, signMessage, verifyMessage, type Ed25519KeyPair } from "@operator/shared/crypto";
import { OWNER, startTestHub, totpCode, type TestHub } from "./testing.js";

let t: TestHub;

beforeEach(async () => {
  t = await startTestHub();
});
afterEach(async () => {
  await t.close();
});

function api(path: string, init: { method?: string; body?: unknown; cookie?: string | null } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const cookie = init.cookie === undefined ? t.cookie : init.cookie;
  if (cookie) headers.cookie = cookie;
  return fetch(t.url + path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
}

async function pairDevice(keys: Ed25519KeyPair = generateEd25519KeyPair()): Promise<{ deviceId: string; keys: Ed25519KeyPair; hubPublicKey: string }> {
  const { code } = (await (await api("/api/devices/pairing-codes", { body: {} })).json()) as PairingCodeResponse;
  const res = await api("/api/pair", {
    cookie: null,
    body: { code, publicKey: keys.publicKey, name: "Test PC", os: "linux", arch: "x64", hostname: "test", agentVersion: "0.1.0" },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as PairResponse;
  return { deviceId: body.deviceId, keys, hubPublicKey: body.hubPublicKey };
}

class Inbox<T> {
  private readonly items: T[] = [];
  private waiters: ((v: T) => void)[] = [];
  push(item: T): void {
    const w = this.waiters.shift();
    if (w) w(item);
    else this.items.push(item);
  }
  next(timeoutMs = 3000): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for message"));
      }, timeoutMs);
      this.waiters.push((v) => {
        clearTimeout(timer);
        resolve(v);
      });
    });
  }
}

async function connectAgent(deviceId: string, keys: Ed25519KeyPair): Promise<{ ws: WebSocket; inbox: Inbox<HubToAgent>; closed: Promise<number> }> {
  const ws = new WebSocket(t.url.replace("http", "ws") + "/ws/agent");
  const inbox = new Inbox<HubToAgent>();
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => { resolve(code); }));
  ws.on("message", (raw: Buffer) => {
    inbox.push(HubToAgent.parse(JSON.parse(raw.toString())));
  });
  const challenge = await inbox.next();
  if (challenge.type !== "challenge") throw new Error("expected challenge");
  ws.send(
    JSON.stringify({
      type: "auth",
      deviceId,
      signature: signMessage(keys, agentAuthMessage(deviceId, challenge.nonce)),
      agentVersion: "0.1.0",
      capabilities: { desktop: "portal", desktopUnavailableReason: null, pty: true, clipboard: true },
      killed: false,
    }),
  );
  return { ws, inbox, closed };
}

async function dashboard(): Promise<{ ws: WebSocket; inbox: Inbox<HubToDashboard>; frames: Inbox<Buffer>; send: (m: DashboardToHub) => void }> {
  const { ticket } = (await (await api("/api/ws-ticket", { body: {} })).json()) as { ticket: string };
  const ws = new WebSocket(`${t.url.replace("http", "ws")}/ws/dashboard?ticket=${ticket}`);
  const inbox = new Inbox<HubToDashboard>();
  const frames = new Inbox<Buffer>();
  ws.on("message", (raw: Buffer, isBinary: boolean) => {
    if (isBinary) frames.push(raw);
    else inbox.push(HubToDashboard.parse(JSON.parse(raw.toString())));
  });
  expect((await inbox.next()).type).toBe("hello");
  return { ws, inbox, frames, send: (m) => { ws.send(JSON.stringify(m)); } };
}

/** Answer the next signed command the agent receives, returning its payload. */
async function answer(agent: { ws: WebSocket; inbox: Inbox<HubToAgent> }, hubPublicKey: string, data: unknown): Promise<CommandPayload> {
  const command = await agent.inbox.next();
  if (command.type !== "command") throw new Error(`expected command, got ${command.type}`);
  expect(verifyMessage(hubPublicKey, command.payload, command.signature)).toBe(true);
  const payload = CommandPayload.parse(JSON.parse(command.payload));
  agent.ws.send(JSON.stringify({ type: "result", id: payload.id, ok: true, data }));
  return payload;
}

async function setPermission(deviceId: string, permissionLevel: string): Promise<void> {
  expect((await api(`/api/devices/${deviceId}`, { method: "PATCH", body: { permissionLevel } })).status).toBe(200);
}

describe("auth", () => {
  it("closes setup once the owner exists", async () => {
    const res = await api("/api/auth/setup/start", { cookie: null, body: { setupToken: t.hub.auth.setupToken, ...OWNER } });
    expect(res.status).toBe(409);
    expect(await (await api("/api/auth/status", { cookie: null })).json()).toEqual({ setupRequired: false, user: null });
  });

  it("requires password and TOTP, and refuses a reused code", async () => {
    const wrong = await api("/api/auth/login", { cookie: null, body: { ...OWNER, password: "wrong password!!", code: totpCode(t.totpSecret, 1) } });
    expect(wrong.status).toBe(401);
    // The setup code's step is spent; the next step's code works exactly once.
    const code = totpCode(t.totpSecret, 1);
    const ok = await api("/api/auth/login", { cookie: null, body: { ...OWNER, code } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(/operator_session=.+HttpOnly/i);
    const replay = await api("/api/auth/login", { cookie: null, body: { ...OWNER, code } });
    expect(replay.status).toBe(401);
  });

  it("protects dashboard routes", async () => {
    expect((await api("/api/devices", { cookie: null })).status).toBe(401);
    expect((await api("/api/devices", { cookie: "operator_session=forged" })).status).toBe(401);
    expect((await api("/api/devices")).status).toBe(200);
  });

  it("logs out", async () => {
    expect((await api("/api/auth/logout", { body: {} })).status).toBe(200);
    expect((await api("/api/devices")).status).toBe(401);
  });
});

describe("pairing", () => {
  it("burns codes after one use and rejects unknown codes", async () => {
    const { code } = (await (await api("/api/devices/pairing-codes", { body: {} })).json()) as PairingCodeResponse;
    const body = { code, publicKey: generateEd25519KeyPair().publicKey, name: "A", os: "linux", arch: "x64", hostname: "a", agentVersion: "0.1.0" };
    expect((await api("/api/pair", { cookie: null, body })).status).toBe(200);
    expect((await api("/api/pair", { cookie: null, body: { ...body, publicKey: generateEd25519KeyPair().publicKey } })).status).toBe(400);
    const list = (await (await api("/api/devices")).json()) as DeviceList;
    expect(list.devices).toHaveLength(1);
    expect(list.devices[0]?.permissionLevel).toBe("view_only");
  });

  it("requires a session to create codes", async () => {
    expect((await api("/api/devices/pairing-codes", { cookie: null, body: {} })).status).toBe(401);
  });
});

describe("agent gateway", () => {
  it("pair → connect → online → disconnect → offline, with live dashboard presence", async () => {
    const live = await dashboard();
    const { deviceId, keys } = await pairDevice();
    expect((await live.inbox.next()).type).toBe("device_updated");

    const agent = await connectAgent(deviceId, keys);
    expect((await agent.inbox.next()).type).toBe("auth_ok");
    expect(await live.inbox.next()).toMatchObject({ type: "device_updated", device: { id: deviceId, online: true, capabilities: { desktop: "portal" } } });
    let list = (await (await api("/api/devices")).json()) as DeviceList;
    expect(list.devices[0]?.online).toBe(true);

    agent.ws.close();
    expect(await live.inbox.next()).toMatchObject({ type: "device_presence", deviceId, online: false });
    list = (await (await api("/api/devices")).json()) as DeviceList;
    expect(list.devices[0]?.online).toBe(false);
    live.ws.close();
  });

  it("rejects a signature from the wrong key", async () => {
    const { deviceId } = await pairDevice();
    const agent = await connectAgent(deviceId, generateEd25519KeyPair());
    expect(await agent.closed).toBe(4001);
    expect(t.hub.agents.isOnline(deviceId)).toBe(false);
  });

  it("sends hub-signed commands and returns validated results", async () => {
    const { deviceId, keys, hubPublicKey } = await pairDevice();
    const agent = await connectAgent(deviceId, keys);
    await agent.inbox.next(); // auth_ok
    const pending = api(`/api/devices/${deviceId}/tools/system_info`, { body: {} });
    const command = await agent.inbox.next();
    if (command.type !== "command") throw new Error("expected command");
    expect(verifyMessage(hubPublicKey, command.payload, command.signature)).toBe(true);
    const payload = CommandPayload.parse(JSON.parse(command.payload));
    expect(payload.deviceId).toBe(deviceId);
    const data = { hostname: "test", os: "linux", release: "6", arch: "x64", uptimeSec: 1, cpus: 4, totalMemBytes: 1, freeMemBytes: 1, agentVersion: "0.1.0" };
    agent.ws.send(JSON.stringify({ type: "result", id: payload.id, ok: true, data }));
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(data);
    agent.ws.close();
  });

  it("disconnects a device when it is removed", async () => {
    const { deviceId, keys } = await pairDevice();
    const agent = await connectAgent(deviceId, keys);
    await agent.inbox.next();
    expect((await api(`/api/devices/${deviceId}`, { method: "DELETE" })).status).toBe(200);
    expect(await agent.closed).toBe(4003);
  });

  it("rejects dashboard sockets without a valid ticket", async () => {
    const ws = new WebSocket(`${t.url.replace("http", "ws")}/ws/dashboard?ticket=nope`);
    const code = await new Promise<number>((resolve) => ws.on("close", (c) => { resolve(c); }));
    expect(code).toBe(4001);
  });

});

describe("remote control", () => {
  async function online(permission: string): Promise<{ deviceId: string; hubPublicKey: string; agent: Awaited<ReturnType<typeof connectAgent>> }> {
    const { deviceId, keys, hubPublicKey } = await pairDevice();
    if (permission !== "view_only") await setPermission(deviceId, permission);
    const agent = await connectAgent(deviceId, keys);
    expect((await agent.inbox.next()).type).toBe("auth_ok");
    return { deviceId, hubPublicKey, agent };
  }

  it("refuses actions on View only devices but allows observing", async () => {
    const { deviceId, hubPublicKey, agent } = await online("view_only");
    const act = await api(`/api/devices/${deviceId}/tools/run_command`, { body: { args: { command: "echo hi" } } });
    expect(act.status).toBe(403);
    expect(await act.json()).toMatchObject({ error: "view_only" });
    const pending = api(`/api/devices/${deviceId}/tools/list_monitors`, { body: {} });
    await answer(agent, hubPublicKey, { monitors: [] });
    expect((await pending).status).toBe(200);
    agent.ws.close();
  });

  it("validates tool arguments before anything is signed", async () => {
    const { deviceId, agent } = await online("assisted");
    const res = await api(`/api/devices/${deviceId}/tools/click`, { body: { args: { monitor: "m0", x: 2, y: 0.5 } } });
    expect(res.status).toBe(400);
    expect((await api(`/api/devices/${deviceId}/tools/not_a_tool`, { body: {} })).status).toBe(400);
    agent.ws.close();
  });

  it("blocks actions while the device kill switch is engaged, until resumed", async () => {
    const { deviceId, hubPublicKey, agent } = await online("assisted");
    agent.ws.send(JSON.stringify({ type: "event", payload: { event: "control", killed: true, source: "hotkey" } }));
    await expect.poll(() => t.hub.agents.state(deviceId)?.killed).toBe(true);
    expect((await api(`/api/devices/${deviceId}/tools/type_text`, { body: { args: { text: "x" } } })).status).toBe(409);

    const resumed = api(`/api/devices/${deviceId}/tools/resume`, { body: {} });
    const payload = await answer(agent, hubPublicKey, { ok: true });
    expect(payload.call.name).toBe("resume");
    expect((await resumed).status).toBe(200);
    agent.ws.close();
  });

  it("streams frames only to viewers and relays take-over input as signed commands", async () => {
    const { deviceId, hubPublicKey, agent } = await online("assisted");
    const live = await dashboard();
    live.send({ type: "watch_screen", deviceId, quality: "low" });
    const start = await answer(agent, hubPublicKey, { streamId: "s1", monitor: "m0" });
    expect(start.call).toEqual({ name: "stream_start", args: { quality: "low" } });
    let message = await live.inbox.next();
    while (message.type !== "screen_started") message = await live.inbox.next();

    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    agent.ws.send(encodeFrame({ streamId: "s1", monitor: "m0", seq: 0, width: 640, height: 360, capturedAt: Date.now() }, jpeg));
    const relayed = decodeFrame(await live.frames.next());
    expect(relayed?.header).toMatchObject({ deviceId, monitor: "m0", width: 640 });
    expect([...(relayed?.jpeg ?? [])]).toEqual([...jpeg]);

    live.send({ type: "input", deviceId, events: [{ kind: "move", monitor: "m0", x: 0.5, y: 0.25 }, { kind: "button", button: "left", down: true }] });
    const input = await answer(agent, hubPublicKey, { ok: true });
    expect(input.call).toEqual({ name: "input", args: { events: [{ kind: "move", monitor: "m0", x: 0.5, y: 0.25 }, { kind: "button", button: "left", down: true }] } });

    live.ws.close();
    const stop = await answer(agent, hubPublicKey, { ok: true });
    expect(stop.call.name).toBe("stream_stop");
    agent.ws.close();
  });

  it("refuses take-over input for View only devices", async () => {
    const { deviceId, agent } = await online("view_only");
    const live = await dashboard();
    live.send({ type: "input", deviceId, events: [{ kind: "text", text: "rm -rf /" }] });
    let message = await live.inbox.next();
    while (message.type !== "error") message = await live.inbox.next();
    expect(message).toMatchObject({ code: "view_only" });
    live.ws.close();
    agent.ws.close();
  });
});
