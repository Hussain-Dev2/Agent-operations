import { Control } from "./control.js";
import { PortalDesktop } from "./desktop/portal.js";
import type { Desktop } from "./desktop/types.js";
import { PtyManager } from "./pty.js";
import { Runtime } from "./tools.js";

export interface RuntimeOptions {
  /** Desktop capture/input, notifications and the global hotkey. Off in tests and headless use. */
  desktopIntegration: boolean;
}

async function detectDesktop(configDir: string, options: RuntimeOptions): Promise<{ desktop: Desktop | null; reason: string | null }> {
  if (!options.desktopIntegration) return { desktop: null, reason: "Desktop integration disabled" };
  if (process.platform === "linux" && process.env.WAYLAND_DISPLAY) {
    const portal = await PortalDesktop.detect(configDir);
    return portal instanceof PortalDesktop ? { desktop: portal, reason: null } : { desktop: null, reason: portal.reason };
  }
  // Windows, macOS and Linux/X11 backends (nut-js) are tracked in TASKS.md; untested code is not shipped.
  return { desktop: null, reason: `Desktop control is not available for ${process.platform}${process.platform === "linux" ? "/X11" : ""} yet` };
}

/** Builds the long-lived device runtime. Terminal output and kill-switch changes go to whichever hub connection is live. */
export async function createRuntime(configDir: string, options: RuntimeOptions): Promise<Runtime> {
  const { desktop, reason } = await detectDesktop(configDir, options);
  let runtime: Runtime | null = null;
  const pty = new PtyManager(
    (id, data) => runtime?.outbox?.event({ event: "pty_data", id, data }),
    (id, exitCode) => runtime?.outbox?.event({ event: "pty_exit", id, exitCode }),
  );
  const control = await Control.create(configDir, options.desktopIntegration, (killed, source) => {
    if (killed) runtime?.stopStream();
    runtime?.outbox?.event({ event: "control", killed, source });
  });
  runtime = new Runtime(desktop, reason, pty, control);
  return runtime;
}
