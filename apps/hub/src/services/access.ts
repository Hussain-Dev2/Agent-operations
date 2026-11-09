import { isActTool, type ToolName } from "@operator/shared";
import type { Hub } from "../context.js";
import { HttpError } from "../http.js";

/**
 * The single gate in front of every device command, whoever asks (dashboard REST, live input,
 * later the AI loop). Permission levels are owner-controlled; nothing a device or model sends
 * can change them.
 *   - view_only devices accept observe tools only;
 *   - while the device's kill switch is engaged, only observe tools other than streaming run,
 *     plus `resume`.
 */
export async function authorizeTool(hub: Hub, deviceId: string, name: ToolName): Promise<void> {
  const row = await hub.devices.get(deviceId);
  if (!row) throw new HttpError(404, "not_found", "Device not found");
  const state = hub.agents.state(deviceId);
  if (!state) throw new HttpError(409, "offline", "Device is offline");
  if (isActTool(name) && row.permissionLevel === "view_only") {
    throw new HttpError(403, "view_only", "This device is View only. Raise its permission level to control it.");
  }
  if (state.killed && name !== "resume" && (isActTool(name) || name === "stream_start" || name === "screenshot")) {
    throw new HttpError(409, "killed", "Operator was stopped on the device. Resume it to continue.");
  }
}
