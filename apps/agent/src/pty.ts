import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { PtySession } from "@operator/shared";

const SCROLLBACK_BYTES = 256 * 1024;

interface Entry {
  info: PtySession;
  terminal: Bun.Terminal;
  proc: Bun.Subprocess;
  scrollback: string;
}

export function ptySupported(): boolean {
  return process.platform !== "win32" && typeof Bun !== "undefined" && typeof Bun.Terminal === "function";
}

function defaultShell(): string {
  return process.env.SHELL ?? (Bun.which("bash") ? "bash" : "sh");
}

/**
 * Interactive terminals on Bun's native PTY. Output is decoded as UTF-8 (streaming, so split
 * multi-byte characters are kept intact), kept as a bounded scrollback and pushed to the hub.
 */
export class PtyManager {
  private readonly sessions = new Map<string, Entry>();

  constructor(
    private readonly onData: (id: string, data: string) => void,
    private readonly onExit: (id: string, exitCode: number | null) => void,
  ) {}

  open(options: { cwd?: string | undefined; cols: number; rows: number }): string {
    if (!ptySupported()) throw new Error("Terminals are not supported on this platform yet");
    const id = randomUUID().slice(0, 8);
    const cwd = options.cwd ?? homedir();
    const decoder = new TextDecoder();
    const shell = defaultShell();
    // Inline terminal options (not a pre-built Bun.Terminal) make the shell a session leader with
    // the PTY as its controlling terminal, so job control, Ctrl+C and Ctrl+Z work.
    const proc = Bun.spawn([shell, "-l"], {
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      terminal: {
        cols: options.cols,
        rows: options.rows,
        name: "xterm-256color",
        data: (_term, bytes) => {
          const entry = this.sessions.get(id);
          const text = decoder.decode(bytes, { stream: true });
          if (!entry || !text) return;
          entry.scrollback = (entry.scrollback + text).slice(-SCROLLBACK_BYTES);
          this.onData(id, text);
        },
      },
    });
    const terminal = proc.terminal;
    if (!terminal) throw new Error("PTY could not be created");
    const info: PtySession = { id, title: basename(shell), cwd, cols: options.cols, rows: options.rows, createdAt: new Date().toISOString(), alive: true };
    this.sessions.set(id, { info, terminal, proc, scrollback: "" });
    void proc.exited.then((code) => {
      info.alive = false;
      terminal.close();
      this.onExit(id, code);
    });
    return id;
  }

  write(id: string, data: string): void {
    const entry = this.get(id);
    if (!entry.info.alive) throw new Error(`Terminal ${id} has exited`);
    entry.terminal.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.get(id);
    entry.info.cols = cols;
    entry.info.rows = rows;
    if (entry.info.alive) entry.terminal.resize(cols, rows);
  }

  read(id: string, maxBytes: number): string {
    return this.get(id).scrollback.slice(-maxBytes);
  }

  list(): PtySession[] {
    return [...this.sessions.values()].map((e) => ({ ...e.info }));
  }

  close(id: string): void {
    const entry = this.get(id);
    entry.proc.kill();
    entry.terminal.close();
    this.sessions.delete(id);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  private get(id: string): Entry {
    const entry = this.sessions.get(id);
    if (!entry) throw new Error(`No terminal "${id}"`);
    return entry;
  }
}
