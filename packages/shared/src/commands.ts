import { z } from "zod";

/**
 * Host Agent tool registry. Every tool has Zod args/result schemas (JSON schema for models is
 * derived with `z.toJSONSchema`) and an access class:
 *   - observe: reads state. Allowed at every permission level.
 *   - act: changes something on the device. Refused by the hub for "view_only" devices and while
 *     the device's kill switch is engaged.
 *
 * Coordinates are always normalized to the target monitor: x and y in [0, 1]. That makes them
 * independent of DPI scaling and of the resolution the viewer/model saw.
 */

const Unit = z.number().min(0).max(1);
const MonitorId = z.string().min(1).max(64);
const KeyName = z.string().min(1).max(32);
const Base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
const AbsPath = z.string().min(1).max(4096);
const Ok = z.object({ ok: z.literal(true) });

export const Monitor = z.object({
  id: MonitorId,
  name: z.string(),
  /** Logical (DPI-independent) desktop coordinates. */
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  primary: z.boolean(),
});
export type Monitor = z.infer<typeof Monitor>;

export const MouseButton = z.enum(["left", "right", "middle"]);
export type MouseButton = z.infer<typeof MouseButton>;

export const InputEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("move"), monitor: MonitorId, x: Unit, y: Unit }),
  z.object({ kind: z.literal("button"), button: MouseButton, down: z.boolean() }),
  /** Wheel steps. Positive dy scrolls down, positive dx scrolls right. */
  z.object({ kind: z.literal("scroll"), dx: z.number().int().min(-50).max(50), dy: z.number().int().min(-50).max(50) }),
  z.object({ kind: z.literal("key"), key: KeyName, down: z.boolean() }),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(2000) }),
]);
export type InputEvent = z.infer<typeof InputEvent>;

export const StreamQuality = z.enum(["low", "medium", "high"]);
export type StreamQuality = z.infer<typeof StreamQuality>;

export const STREAM_PRESETS: Record<StreamQuality, { fps: number; maxWidth: number; quality: number }> = {
  low: { fps: 5, maxWidth: 960, quality: 40 },
  medium: { fps: 8, maxWidth: 1280, quality: 60 },
  high: { fps: 10, maxWidth: 1920, quality: 80 },
};

export const SystemInfoResult = z.object({
  hostname: z.string(),
  os: z.string(),
  release: z.string(),
  arch: z.string(),
  uptimeSec: z.number(),
  cpus: z.number().int(),
  totalMemBytes: z.number(),
  freeMemBytes: z.number(),
  agentVersion: z.string(),
});
export type SystemInfoResult = z.infer<typeof SystemInfoResult>;

export const PtySession = z.object({
  id: z.string(),
  title: z.string(),
  cwd: z.string(),
  cols: z.number().int(),
  rows: z.number().int(),
  createdAt: z.iso.datetime(),
  alive: z.boolean(),
});
export type PtySession = z.infer<typeof PtySession>;

export const FileEntry = z.object({
  name: z.string(),
  kind: z.enum(["file", "dir", "link", "other"]),
  size: z.number(),
  mtime: z.iso.datetime().nullable(),
});
export type FileEntry = z.infer<typeof FileEntry>;

const Point = z.object({ x: Unit, y: Unit });

function tool<A extends z.ZodType, R extends z.ZodType>(access: "observe" | "act", description: string, args: A, result: R) {
  return { access, description, args, result };
}

export const tools = {
  system_info: tool("observe", "Basic facts about the device: OS, CPU count, memory, uptime.", z.object({}).strict(), SystemInfoResult),
  list_monitors: tool("observe", "List monitors with their logical position and size.", z.object({}).strict(), z.object({ monitors: z.array(Monitor) })),
  screenshot: tool(
    "observe",
    "Capture one monitor as a JPEG.",
    z.object({ monitor: MonitorId.optional(), maxWidth: z.number().int().min(320).max(3840).default(1280), quality: z.number().int().min(10).max(95).default(70) }).strict(),
    z.object({ monitor: MonitorId, width: z.number().int(), height: z.number().int(), mime: z.literal("image/jpeg"), data: Base64 }),
  ),
  stream_start: tool(
    "observe",
    "Start (or reconfigure) the live screen stream of one monitor. Frames arrive as binary messages.",
    z.object({ monitor: MonitorId.optional(), quality: StreamQuality.default("medium") }).strict(),
    z.object({ streamId: z.string(), monitor: MonitorId }),
  ),
  stream_stop: tool("observe", "Stop the live screen stream.", z.object({}).strict(), Ok),

  input: tool("act", "Low-level input events (pointer, buttons, wheel, keys, text) applied in order.", z.object({ events: z.array(InputEvent).min(1).max(200) }).strict(), Ok),
  click: tool("act", "Click at a point on a monitor.", z.object({ monitor: MonitorId, x: Unit, y: Unit, button: MouseButton.default("left") }).strict(), Ok),
  double_click: tool("act", "Double-click at a point on a monitor.", z.object({ monitor: MonitorId, x: Unit, y: Unit }).strict(), Ok),
  right_click: tool("act", "Right-click at a point on a monitor.", z.object({ monitor: MonitorId, x: Unit, y: Unit }).strict(), Ok),
  drag: tool("act", "Press at one point, move to another, release.", z.object({ monitor: MonitorId, from: Point, to: Point }).strict(), Ok),
  scroll: tool(
    "act",
    "Scroll the wheel, optionally after moving to a point.",
    z.object({ monitor: MonitorId.optional(), x: Unit.optional(), y: Unit.optional(), dx: z.number().int().min(-50).max(50).default(0), dy: z.number().int().min(-50).max(50).default(0) }).strict(),
    Ok,
  ),
  type_text: tool("act", "Type text with the keyboard.", z.object({ text: z.string().min(1).max(2000) }).strict(), Ok),
  press_keys: tool("act", 'Press a key combination, e.g. ["ctrl","c"] or ["enter"].', z.object({ keys: z.array(KeyName).min(1).max(6) }).strict(), Ok),
  open_app: tool("act", "Launch an application by name.", z.object({ name: z.string().min(1).max(200) }).strict(), z.object({ launched: z.string() })),
  run_command: tool(
    "act",
    "Run a shell command and return its output.",
    z.object({ command: z.string().min(1).max(10_000), cwd: AbsPath.optional(), timeoutMs: z.number().int().min(1000).max(600_000).default(60_000) }).strict(),
    z.object({ stdout: z.string(), stderr: z.string(), exitCode: z.number().int().nullable(), timedOut: z.boolean(), truncated: z.boolean() }),
  ),

  pty_open: tool(
    "act",
    "Open an interactive terminal session.",
    z.object({ cwd: AbsPath.optional(), cols: z.number().int().min(10).max(500).default(100), rows: z.number().int().min(5).max(200).default(30) }).strict(),
    z.object({ id: z.string() }),
  ),
  pty_write: tool("act", "Send input to a terminal session.", z.object({ id: z.string(), data: z.string().min(1).max(100_000) }).strict(), Ok),
  pty_resize: tool("observe", "Resize a terminal session.", z.object({ id: z.string(), cols: z.number().int().min(10).max(500), rows: z.number().int().min(5).max(200) }).strict(), Ok),
  pty_close: tool("act", "Close a terminal session.", z.object({ id: z.string() }).strict(), Ok),
  pty_list: tool("observe", "List terminal sessions.", z.object({}).strict(), z.object({ sessions: z.array(PtySession) })),
  pty_read: tool(
    "observe",
    "Read the recent output (scrollback tail) of a terminal session.",
    z.object({ id: z.string(), maxBytes: z.number().int().min(1).max(1_000_000).default(65_536) }).strict(),
    z.object({ data: z.string() }),
  ),

  file_list: tool(
    "observe",
    "List a directory. Defaults to the user's home directory.",
    z.object({ path: AbsPath.optional() }).strict(),
    z.object({ path: z.string(), parent: z.string().nullable(), entries: z.array(FileEntry) }),
  ),
  file_read: tool(
    "observe",
    "Read part of a file (base64).",
    z.object({ path: AbsPath, offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(1_048_576).default(1_048_576) }).strict(),
    z.object({ data: Base64, size: z.number(), eof: z.boolean() }),
  ),
  file_write: tool(
    "act",
    "Write base64 data at an offset. offset 0 truncates the file first.",
    z.object({ path: AbsPath, data: Base64, offset: z.number().int().min(0).default(0) }).strict(),
    z.object({ size: z.number() }),
  ),

  clipboard_get: tool("observe", "Read the clipboard as text.", z.object({}).strict(), z.object({ text: z.string() })),
  clipboard_set: tool("act", "Replace the clipboard text.", z.object({ text: z.string().max(1_000_000) }).strict(), Ok),

  kill: tool("observe", "Engage the kill switch: stop and block all actions on the device.", z.object({}).strict(), Ok),
  resume: tool("act", "Release the kill switch.", z.object({}).strict(), Ok),
} as const;

export type Tools = typeof tools;
export type ToolName = keyof Tools;
export const TOOL_NAMES = Object.keys(tools) as ToolName[];
export const ToolName = z.enum(TOOL_NAMES as [ToolName, ...ToolName[]]);

/** Parsed (defaults applied) args — what the agent receives. */
export type ToolArgs<N extends ToolName> = z.output<Tools[N]["args"]>;
/** Args as callers may write them (defaults optional). */
export type ToolInput<N extends ToolName> = z.input<Tools[N]["args"]>;
export type ToolResult<N extends ToolName> = z.output<Tools[N]["result"]>;

export type ToolCall = { [N in ToolName]: { name: N; args: ToolArgs<N> } }[ToolName];

export const ToolCall = z.discriminatedUnion(
  "name",
  TOOL_NAMES.map((name) => z.object({ name: z.literal(name), args: tools[name].args })) as unknown as [
    z.ZodObject<{ name: z.ZodLiteral<ToolName>; args: z.ZodType }>,
    ...z.ZodObject<{ name: z.ZodLiteral<ToolName>; args: z.ZodType }>[],
  ],
) as unknown as z.ZodType<ToolCall>;

export function isActTool(name: ToolName): boolean {
  return tools[name].access === "act";
}

export function toolJsonSchemas(): { name: ToolName; description: string; inputSchema: unknown }[] {
  return TOOL_NAMES.map((name) => ({
    name,
    description: tools[name].description,
    inputSchema: z.toJSONSchema(tools[name].args, { io: "input" }),
  }));
}
