"use client";

import { tools, type ToolInput, type ToolName, type ToolResult } from "@operator/shared";
import { api } from "./api";

/** Run a Host Agent tool through the hub; the result is validated with the tool's own schema. */
export function callTool<N extends ToolName>(deviceId: string, name: N, args: ToolInput<N>): Promise<ToolResult<N>> {
  return api(`/api/devices/${deviceId}/tools/${name}`, { method: "POST", body: { args }, schema: tools[name].result }) as Promise<ToolResult<N>>;
}
