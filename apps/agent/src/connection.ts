import {
  CloseCode,
  HEARTBEAT_INTERVAL_MS,
  HubToAgent,
  agentAuthMessage,
  encodeFrame,
  type AgentToHub,
} from "@operator/shared";
import { signMessage } from "@operator/shared/crypto";
import { agentSocketUrl, type Identity } from "./identity.js";
import type { Runtime } from "./tools.js";
import { CommandVerifier } from "./verifier.js";
import { AGENT_VERSION } from "./version.js";

export interface AgentEvents {
  onStatus?: (status: "connecting" | "online" | "offline", detail?: string) => void;
}

/** Close codes after which retrying is pointless: the hub no longer accepts this identity. */
const FATAL_CLOSE_CODES = new Set<number>([CloseCode.authFailed, CloseCode.revoked]);
/** Skip screen frames while this much is still queued on the socket (slow uplink). */
const FRAME_BACKPRESSURE_BYTES = 2 * 1024 * 1024;

export class FatalAgentError extends Error {}

/**
 * Keeps an outbound connection to the hub alive until `signal` aborts. Reconnects with
 * exponential backoff + jitter (1 s → 30 s). Rejects with FatalAgentError when the hub
 * refuses this device (revoked or unknown key), since re-pairing is then required.
 */
export async function runAgent(identity: Identity, runtime: Runtime, signal: AbortSignal, events: AgentEvents = {}): Promise<void> {
  const url = agentSocketUrl(identity.hubUrl);
  const verifier = new CommandVerifier(identity.hubPublicKey, identity.deviceId);
  let attempt = 0;

  while (!signal.aborted) {
    events.onStatus?.("connecting");
    const { code, reason, authenticated } = await connectOnce(url, identity, runtime, verifier, signal, events);
    if (isAborted(signal)) return;
    if (FATAL_CLOSE_CODES.has(code)) throw new FatalAgentError(`Hub refused this device (${code} ${reason}). Pair again.`);
    events.onStatus?.("offline", `${code} ${reason}`.trim());
    attempt = authenticated ? 0 : attempt + 1;
    const delay = Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
    await sleep(delay, signal);
  }
}

function connectOnce(
  url: string,
  identity: Identity,
  runtime: Runtime,
  verifier: CommandVerifier,
  signal: AbortSignal,
  events: AgentEvents,
): Promise<{ code: number; reason: string; authenticated: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    let authenticated = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const send = (message: AgentToHub): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    const onAbort = (): void => {
      ws.close(1000, "Agent stopping");
    };
    signal.addEventListener("abort", onAbort, { once: true });

    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let message: HubToAgent;
      try {
        message = HubToAgent.parse(JSON.parse(event.data));
      } catch {
        ws.close(CloseCode.protocol, "Malformed message");
        return;
      }
      switch (message.type) {
        case "challenge":
          send({
            type: "auth",
            deviceId: identity.deviceId,
            signature: signMessage(identity, agentAuthMessage(identity.deviceId, message.nonce)),
            agentVersion: AGENT_VERSION,
            capabilities: runtime.capabilities(),
            killed: runtime.control.killed,
          });
          return;
        case "auth_ok":
          authenticated = true;
          heartbeat = setInterval(() => {
            send({ type: "heartbeat" });
          }, HEARTBEAT_INTERVAL_MS);
          runtime.outbox = {
            frame: (header, jpeg) => {
              if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < FRAME_BACKPRESSURE_BYTES) ws.send(encodeFrame(header, jpeg));
            },
            event: (payload) => {
              send({ type: "event", payload });
            },
          };
          events.onStatus?.("online");
          return;
        case "command": {
          const verdict = verifier.verify(message.payload, message.signature);
          if (!verdict.ok) {
            send({ type: "rejected", reason: verdict.reason });
            return;
          }
          const { id, call } = verdict.command;
          runtime.execute(call).then(
            (data) => {
              send({ type: "result", id, ok: true, data });
            },
            (error: unknown) => {
              send({ type: "result", id, ok: false, error: error instanceof Error ? error.message : String(error) });
            },
          );
          return;
        }
        case "error":
          return;
      }
    });

    ws.addEventListener("close", (event) => {
      clearInterval(heartbeat);
      // The hub stops relaying when we drop; don't keep encoding frames for nobody.
      runtime.stopStream();
      runtime.outbox = null;
      signal.removeEventListener("abort", onAbort);
      resolve({ code: event.code, reason: event.reason, authenticated });
    });
  });
}

/** Read through a function so TS does not keep the loop-condition narrowing across awaits. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
