#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { PairingCode } from "@operator/shared";
import { FatalAgentError, runAgent } from "./connection.js";
import { defaultConfigDir, loadIdentity, saveIdentity } from "./identity.js";
import { pair } from "./pair.js";
import { createRuntime } from "./runtime.js";
import { AGENT_VERSION } from "./version.js";

const USAGE = `operator-agent ${AGENT_VERSION}

Usage:
  operator-agent pair --hub <url> --code <123456> [--name "My PC"]
  operator-agent run
  operator-agent status

Options:
  --config <dir>   Identity directory (default: ${defaultConfigDir()})
  --headless       No screen/input control, notifications or hotkey (terminals and files only)
`;

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      hub: { type: "string" },
      code: { type: "string" },
      name: { type: "string" },
      config: { type: "string" },
      headless: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const dir = values.config ?? defaultConfigDir();
  const command = positionals[0];

  if (values.help || command === undefined) {
    console.log(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }

  switch (command) {
    case "pair": {
      if (!values.hub || !values.code) {
        console.error("pair needs --hub and --code\n\n" + USAGE);
        return 1;
      }
      const code = PairingCode.parse(values.code.replace(/\s/g, ""));
      const identity = await pair(values.hub, code, values.name);
      await saveIdentity(dir, identity);
      log(`Paired as device ${identity.deviceId}. Identity saved to ${dir}`);
      log("Start the agent with: operator-agent run");
      return 0;
    }
    case "status": {
      const identity = await loadIdentity(dir);
      console.log(identity ? `Paired with ${identity.hubUrl} as ${identity.deviceId}` : "Not paired");
      return 0;
    }
    case "run": {
      const identity = await loadIdentity(dir);
      if (!identity) {
        console.error("Not paired yet. Run: operator-agent pair --hub <url> --code <code>");
        return 1;
      }
      const controller = new AbortController();
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { controller.abort(); });
      const runtime = await createRuntime(dir, { desktopIntegration: !values.headless });
      const caps = runtime.capabilities();
      log(`Desktop control: ${caps.desktop ?? `unavailable (${caps.desktopUnavailableReason ?? "unknown"})`} · terminals: ${caps.pty ? "yes" : "no"} · clipboard: ${caps.clipboard ? "yes" : "no"}`);
      if (runtime.control.killed) log("Kill switch is engaged: actions stay blocked until resumed from the dashboard.");
      log(`Connecting to ${identity.hubUrl} as ${identity.deviceId}`);
      try {
        await runAgent(identity, runtime, controller.signal, {
          onStatus: (status, detail) => {
            log(detail ? `${status} (${detail})` : status);
          },
        });
      } catch (error) {
        if (error instanceof FatalAgentError) {
          console.error(error.message);
          return 2;
        }
        throw error;
      } finally {
        runtime.shutdown();
      }
      return 0;
    }
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
