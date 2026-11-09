import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { FileEntry, ToolArgs, ToolResult } from "@operator/shared";

const OUTPUT_LIMIT = 64 * 1024;

function absolute(path: string | undefined): string {
  if (!path) return homedir();
  const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
  if (!isAbsolute(expanded)) throw new Error(`Path must be absolute: ${path}`);
  return resolve(expanded);
}

// ---------- files ----------

export async function fileList(args: ToolArgs<"file_list">): Promise<ToolResult<"file_list">> {
  const path = absolute(args.path);
  const dirents = await readdir(path, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.map(async (d): Promise<FileEntry> => {
      const kind = d.isDirectory() ? "dir" : d.isFile() ? "file" : d.isSymbolicLink() ? "link" : "other";
      const info = await stat(join(path, d.name)).catch(() => null);
      return {
        name: d.name,
        kind: kind === "link" && info?.isDirectory() ? "dir" : kind,
        size: info?.isFile() ? info.size : 0,
        mtime: info ? info.mtime.toISOString() : null,
      };
    }),
  );
  entries.sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name));
  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, entries };
}

export async function fileRead(args: ToolArgs<"file_read">): Promise<ToolResult<"file_read">> {
  const path = absolute(args.path);
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.max(0, Math.min(args.length, size - args.offset));
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, args.offset);
    return { data: buffer.toString("base64"), size, eof: args.offset + length >= size };
  } finally {
    await handle.close();
  }
}

export async function fileWrite(args: ToolArgs<"file_write">): Promise<ToolResult<"file_write">> {
  const path = absolute(args.path);
  const handle = await open(path, args.offset === 0 ? "w" : "r+");
  try {
    await handle.write(Buffer.from(args.data, "base64"), 0, undefined, args.offset);
    return { size: (await handle.stat()).size };
  } finally {
    await handle.close();
  }
}

// ---------- commands ----------

async function readCapped(stream: ReadableStream<Uint8Array>): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total < OUTPUT_LIMIT) chunks.push(value.subarray(0, OUTPUT_LIMIT - total));
    else truncated = true;
    total += value.length;
    if (total > OUTPUT_LIMIT) truncated = true;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

function shellArgv(command: string): string[] {
  return process.platform === "win32" ? ["powershell.exe", "-NoProfile", "-Command", command] : [process.env.SHELL ?? "sh", "-lc", command];
}

export async function runCommand(args: ToolArgs<"run_command">): Promise<ToolResult<"run_command">> {
  const proc = Bun.spawn(shellArgv(args.command), { cwd: absolute(args.cwd), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timeout = { hit: false };
  const timer = setTimeout(() => {
    timeout.hit = true;
    proc.kill();
  }, args.timeoutMs);
  const [out, err, exitCode] = await Promise.all([readCapped(proc.stdout), readCapped(proc.stderr), proc.exited]);
  clearTimeout(timer);
  return { stdout: out.text, stderr: err.text, exitCode: timeout.hit ? null : exitCode, timedOut: timeout.hit, truncated: out.truncated || err.truncated };
}

// ---------- clipboard ----------

function clipboardCommands(): { get: string[]; set: string[] } | null {
  switch (process.platform) {
    case "darwin":
      return { get: ["pbpaste"], set: ["pbcopy"] };
    case "win32":
      return { get: ["powershell.exe", "-NoProfile", "-Command", "Get-Clipboard -Raw"], set: ["powershell.exe", "-NoProfile", "-Command", "$input | Set-Clipboard"] };
    default:
      if (process.env.WAYLAND_DISPLAY && Bun.which("wl-paste") && Bun.which("wl-copy")) return { get: ["wl-paste", "--no-newline"], set: ["wl-copy"] };
      if (process.env.DISPLAY && Bun.which("xclip")) return { get: ["xclip", "-selection", "clipboard", "-o"], set: ["xclip", "-selection", "clipboard"] };
      return null;
  }
}

export function clipboardSupported(): boolean {
  return clipboardCommands() !== null;
}

export async function clipboardGet(): Promise<string> {
  const cmds = clipboardCommands();
  if (!cmds) throw new Error("No clipboard tool available (install wl-clipboard or xclip)");
  const proc = Bun.spawn(cmds.get, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text;
}

export async function clipboardSet(text: string): Promise<void> {
  const cmds = clipboardCommands();
  if (!cmds) throw new Error("No clipboard tool available (install wl-clipboard or xclip)");
  const proc = Bun.spawn(cmds.set, { stdin: new TextEncoder().encode(text), stdout: "ignore", stderr: "ignore" });
  // wl-copy forks a server that owns the selection; the client exits right away.
  const code = await proc.exited;
  if (code !== 0) throw new Error(`Clipboard write failed (${code})`);
}

// ---------- apps ----------

async function findDesktopEntry(name: string): Promise<{ id: string; exec: string } | null> {
  const dirs = [
    ...(process.env.XDG_DATA_HOME ? [process.env.XDG_DATA_HOME] : [join(homedir(), ".local/share")]),
    ...(process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":"),
  ].map((d) => join(d, "applications"));
  const wanted = name.toLowerCase();
  let fuzzy: { id: string; exec: string } | null = null;
  for (const dir of dirs) {
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const file of files.filter((f) => f.endsWith(".desktop"))) {
      const text = await readFile(join(dir, file), "utf8").catch(() => "");
      const section = text.split(/^\[/m).find((s) => s.startsWith("Desktop Entry]")) ?? "";
      const field = (key: string): string | undefined => new RegExp(`^${key}=(.*)$`, "m").exec(section)?.[1]?.trim();
      const exec = field("Exec");
      if (!exec || field("NoDisplay") === "true" || field("Hidden") === "true") continue;
      const id = file.replace(/\.desktop$/, "");
      const display = (field("Name") ?? "").toLowerCase();
      if (id.toLowerCase() === wanted || display === wanted) return { id, exec };
      if (!fuzzy && (display.includes(wanted) || id.toLowerCase().includes(wanted))) fuzzy = { id, exec };
    }
  }
  return fuzzy;
}

/** Split an Exec line (desktop-entry quoting rules, field codes removed). */
function execArgv(exec: string): string[] {
  const args: string[] = [];
  for (const m of exec.matchAll(/"((?:\\.|[^"\\])*)"|(\S+)/g)) {
    const arg = m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? "");
    if (!/^%[a-zA-Z]$/.test(arg)) args.push(arg);
  }
  return args;
}

export async function openApp(name: string): Promise<string> {
  let argv: string[];
  let label = name;
  if (process.platform === "darwin") argv = ["open", "-a", name];
  else if (process.platform === "win32") argv = ["cmd.exe", "/c", "start", "", name];
  else {
    const entry = await findDesktopEntry(name);
    if (!entry) throw new Error(`No installed application matches "${name}"`);
    argv = execArgv(entry.exec);
    label = entry.id;
  }
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", cwd: homedir() });
  proc.unref();
  return label;
}
