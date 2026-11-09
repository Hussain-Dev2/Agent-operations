import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceList, PairingCodeResponse, SystemInfoResult } from "@operator/shared";
import { startTestHub, type TestHub } from "@operator/hub/testing";
import { FatalAgentError, runAgent } from "./connection.js";
import { assertSecureHubUrl, loadIdentity, saveIdentity, type Identity } from "./identity.js";
import { pair } from "./pair.js";
import { createRuntime } from "./runtime.js";
import type { Runtime } from "./tools.js";

let t: TestHub;
let dir: string;
/** Every agent started by a test; aborted in afterEach so a failing test cannot leak a reconnect loop. */
const running: { controller: AbortController; runtime: Runtime }[] = [];

beforeEach(async () => {
  t = await startTestHub();
  dir = await mkdtemp(join(tmpdir(), "operator-agent-"));
});
afterEach(async () => {
  for (const r of running.splice(0)) {
    r.controller.abort();
    r.runtime.shutdown();
  }
  await t.close();
  await rm(dir, { recursive: true, force: true });
});

async function api<T>(path: string, method = "GET", body: unknown = {}): Promise<T> {
  const res = await fetch(t.url + path, {
    method,
    headers: { cookie: t.cookie, ...(method !== "GET" && { "content-type": "application/json" }) },
    ...(method !== "GET" && { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const tool = <T>(deviceId: string, name: string, args: unknown = {}): Promise<T> => api<T>(`/api/devices/${deviceId}/tools/${name}`, "POST", { args });

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function pairedIdentity(): Promise<Identity> {
  const { code } = await api<PairingCodeResponse>("/api/devices/pairing-codes", "POST");
  const identity = await pair(t.url, code, "E2E PC");
  await saveIdentity(dir, identity);
  return identity;
}

/**
 * Starts an agent. `outcome` settles when it stops: null on a clean stop, otherwise the error.
 * Capturing it immediately keeps an expected rejection from counting as unhandled.
 */
async function startAgent(identity: Identity): Promise<{ outcome: Promise<unknown>; controller: AbortController; runtime: Runtime }> {
  const controller = new AbortController();
  const runtime = await createRuntime(dir, { desktopIntegration: false });
  running.push({ controller, runtime });
  const outcome = runAgent(identity, runtime, controller.signal).then(
    () => null,
    (error: unknown) => error,
  );
  await waitFor(() => t.hub.agents.isOnline(identity.deviceId));
  return { outcome, controller, runtime };
}

async function rejections(deviceId: string): Promise<string[]> {
  const rows = await t.hub.db.query.auditLog.findMany({
    where: (a, { and, eq }) => and(eq(a.deviceId, deviceId), eq(a.action, "agent.command_rejected")),
  });
  return rows.map((r) => String(r.details.reason));
}

describe("agent ↔ hub end to end", () => {
  it("pairs, comes online with its capabilities, answers signed commands, and goes offline when stopped", async () => {
    const identity = await pairedIdentity();
    expect(await loadIdentity(dir)).toEqual(identity);
    if (process.platform !== "win32") expect((await stat(join(dir, "identity.json"))).mode & 0o777).toBe(0o600);

    const agent = await startAgent(identity);
    const list = await api<DeviceList>("/api/devices");
    expect(list.devices).toMatchObject([{ id: identity.deviceId, name: "E2E PC", online: true, capabilities: { desktop: null, pty: true } }]);

    const info = await tool<SystemInfoResult>(identity.deviceId, "system_info");
    expect(info.cpus).toBeGreaterThan(0);

    agent.controller.abort();
    expect(await agent.outcome).toBeNull();
    await waitFor(async () => (await api<DeviceList>("/api/devices")).devices[0]?.online === false);
  });

  it("rejects replayed and tampered commands", async () => {
    const identity = await pairedIdentity();
    const agent = await startAgent(identity);

    const { message } = t.hub.agents.sign(identity.deviceId, { name: "system_info", args: {} });
    if (message.type !== "command") throw new Error("expected command");
    t.hub.agents.send(identity.deviceId, message);
    t.hub.agents.send(identity.deviceId, message); // replay
    t.hub.agents.send(identity.deviceId, { ...message, payload: message.payload.replace(identity.deviceId, crypto.randomUUID()) });

    await waitFor(async () => (await rejections(identity.deviceId)).length === 2);
    expect((await rejections(identity.deviceId)).sort()).toEqual(["bad_signature", "replay"]);
    agent.controller.abort();
    expect(await agent.outcome).toBeNull();
  });

  it("runs terminals, commands and file round trips once the device allows control", async () => {
    const identity = await pairedIdentity();
    await api(`/api/devices/${identity.deviceId}`, "PATCH", { permissionLevel: "assisted" });
    await startAgent(identity);

    const { id } = await tool<{ id: string }>(identity.deviceId, "pty_open", { cwd: dir, cols: 80, rows: 24 });
    await tool(identity.deviceId, "pty_write", { id, data: "echo pty-$((6*7))\r" });
    await waitFor(async () => (await tool<{ data: string }>(identity.deviceId, "pty_read", { id })).data.includes("pty-42"));

    const run = await tool<{ stdout: string; exitCode: number }>(identity.deviceId, "run_command", { command: "printf hello", cwd: dir });
    expect(run).toMatchObject({ stdout: "hello", exitCode: 0 });

    // Upload 2.5 MiB (three signed chunks), then download it again through the hub.
    const payload = Buffer.alloc(2.5 * 1024 * 1024, 7);
    payload.write("operator", 0);
    const target = join(dir, "upload.bin");
    const up = await fetch(`${t.url}/api/devices/${identity.deviceId}/files/upload?path=${encodeURIComponent(target)}`, {
      method: "PUT",
      headers: { cookie: t.cookie, "content-type": "application/octet-stream" },
      body: payload,
    });
    expect(up.status).toBe(200);
    expect(Buffer.compare(await readFile(target), payload)).toBe(0);
    const down = await fetch(`${t.url}/api/devices/${identity.deviceId}/files/download?path=${encodeURIComponent(target)}`, { headers: { cookie: t.cookie } });
    expect(Buffer.compare(Buffer.from(await down.arrayBuffer()), payload)).toBe(0);

    await writeFile(join(dir, "note.txt"), "hi");
    const listing = await tool<{ entries: { name: string; kind: string }[] }>(identity.deviceId, "file_list", { path: dir });
    expect(listing.entries.map((e) => e.name)).toContain("note.txt");
  });

  it("blocks actions after a kill and allows them again after resume", async () => {
    const identity = await pairedIdentity();
    await api(`/api/devices/${identity.deviceId}`, "PATCH", { permissionLevel: "assisted" });
    const agent = await startAgent(identity);
    await tool(identity.deviceId, "kill");
    await waitFor(() => t.hub.agents.state(identity.deviceId)?.killed === true);
    expect(agent.runtime.control.killed).toBe(true);
    const blocked = await tool(identity.deviceId, "run_command", { command: "true" }).then(
      () => "ran",
      (error: unknown) => String(error),
    );
    expect(blocked).toMatch(/409/);
    await tool(identity.deviceId, "resume");
    await waitFor(() => t.hub.agents.state(identity.deviceId)?.killed === false);
    expect(await tool<{ exitCode: number }>(identity.deviceId, "run_command", { command: "true" })).toMatchObject({ exitCode: 0 });
  });

  it("stops retrying once the device is removed", async () => {
    const identity = await pairedIdentity();
    const agent = await startAgent(identity);
    await api(`/api/devices/${identity.deviceId}`, "DELETE");
    expect(await agent.outcome).toBeInstanceOf(FatalAgentError);
  });

  it("refuses plain-HTTP hubs that are not loopback", () => {
    expect(() => assertSecureHubUrl("http://hub.example.com")).toThrow(/insecure/);
    expect(assertSecureHubUrl("https://hub.example.com").protocol).toBe("https:");
    expect(assertSecureHubUrl("http://localhost:4000").hostname).toBe("localhost");
  });
});
