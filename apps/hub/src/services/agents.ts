import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  CloseCode,
  tools,
  type CommandPayload,
  type DeviceCapabilities,
  type HubToAgent,
  type ToolCall,
  type ToolInput,
  type ToolName,
  type ToolResult,
} from "@operator/shared";
import { randomToken, signMessage, type Ed25519KeyPair } from "@operator/shared/crypto";

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Connection {
  socket: WebSocket;
  pending: Map<string, Pending>;
  capabilities: DeviceCapabilities;
  killed: boolean;
}

export class AgentOfflineError extends Error {
  constructor(deviceId: string) {
    super(`Device ${deviceId} is offline`);
  }
}

export class ToolError extends Error {}
/** The caller sent arguments that don't match the tool's schema; nothing was signed or sent. */
export class InvalidArgsError extends Error {}

/** Live agent sockets keyed by device id, plus signed command dispatch. */
export class AgentRegistry {
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly signingKey: Ed25519KeyPair) {}

  isOnline(deviceId: string): boolean {
    return this.connections.has(deviceId);
  }

  state(deviceId: string): { capabilities: DeviceCapabilities; killed: boolean } | null {
    const c = this.connections.get(deviceId);
    return c ? { capabilities: c.capabilities, killed: c.killed } : null;
  }

  setKilled(deviceId: string, killed: boolean): void {
    const c = this.connections.get(deviceId);
    if (c) c.killed = killed;
  }

  /** Register an authenticated socket. An older socket for the same device is closed. */
  attach(deviceId: string, socket: WebSocket, state: { capabilities: DeviceCapabilities; killed: boolean }): void {
    const previous = this.connections.get(deviceId);
    if (previous) this.drop(deviceId, previous.socket, CloseCode.replaced, "Replaced by a newer connection");
    this.connections.set(deviceId, { socket, pending: new Map(), ...state });
  }

  /** Remove the socket if it is still the current one. Returns true if the device went offline. */
  detach(deviceId: string, socket: WebSocket): boolean {
    const current = this.connections.get(deviceId);
    if (current?.socket !== socket) return false;
    for (const p of current.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new AgentOfflineError(deviceId));
    }
    this.connections.delete(deviceId);
    return true;
  }

  disconnect(deviceId: string, code: number, reason: string): void {
    const current = this.connections.get(deviceId);
    if (current) this.drop(deviceId, current.socket, code, reason);
  }

  settle(deviceId: string, id: string, ok: boolean, data: unknown, error: string | undefined): void {
    const connection = this.connections.get(deviceId);
    const pending = connection?.pending.get(id);
    if (!connection || !pending) return;
    clearTimeout(pending.timer);
    connection.pending.delete(id);
    if (ok) pending.resolve(data);
    else pending.reject(new ToolError(error ?? "Command failed"));
  }

  /** Send a raw protocol message to a connected agent. Returns false when offline. */
  send(deviceId: string, message: HubToAgent): boolean {
    const connection = this.connections.get(deviceId);
    connection?.socket.send(JSON.stringify(message));
    return connection !== undefined;
  }

  /** Validate args against the tool schema (applying defaults), then build the signed envelope. */
  sign(deviceId: string, call: ToolCall): { id: string; message: HubToAgent } {
    const payload: CommandPayload = { id: randomUUID(), deviceId, nonce: randomToken(18), issuedAt: Date.now(), call };
    const json = JSON.stringify(payload);
    return { id: payload.id, message: { type: "command", payload: json, signature: signMessage(this.signingKey, json) } };
  }

  private prepare<N extends ToolName>(name: N, args: ToolInput<N>): ToolCall {
    const parsed = tools[name].args.safeParse(args);
    if (!parsed.success) throw new InvalidArgsError(`Invalid arguments for ${name}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    return { name, args: parsed.data } as ToolCall;
  }

  /** Send a signed command and await its validated result. */
  async invoke<N extends ToolName>(deviceId: string, name: N, args: ToolInput<N>, timeoutMs = 30_000): Promise<ToolResult<N>> {
    const connection = this.connections.get(deviceId);
    if (!connection) throw new AgentOfflineError(deviceId);
    const { id, message } = this.sign(deviceId, this.prepare(name, args));
    const data = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id);
        reject(new ToolError(`${name} timed out`));
      }, timeoutMs);
      connection.pending.set(id, { resolve, reject, timer });
      this.send(deviceId, message);
    });
    const result = tools[name].result.safeParse(data);
    if (!result.success) throw new ToolError(`Agent returned an invalid ${name} result`);
    return result.data as ToolResult<N>;
  }

  /** Send a signed command without waiting for its result (high-rate input). */
  fire<N extends ToolName>(deviceId: string, name: N, args: ToolInput<N>): void {
    if (!this.connections.has(deviceId)) throw new AgentOfflineError(deviceId);
    this.send(deviceId, this.sign(deviceId, this.prepare(name, args)).message);
  }

  closeAll(): void {
    for (const [deviceId, c] of this.connections) this.drop(deviceId, c.socket, 1001, "Hub shutting down");
  }

  private drop(deviceId: string, socket: WebSocket, code: number, reason: string): void {
    this.detach(deviceId, socket);
    socket.close(code, reason);
  }
}
