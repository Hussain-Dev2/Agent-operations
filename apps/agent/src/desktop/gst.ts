import type { Frame, FrameStream, StreamOptions } from "./types.js";

type Encoder = "jpegenc" | "avenc_mjpeg";

async function hasElement(name: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["gst-inspect-1.0", "--exists", name], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** Which JPEG encoder this machine's GStreamer has (gst-plugins-good or gst-libav), or why none works. */
export async function detectGstreamer(): Promise<{ encoder: Encoder } | { missing: string }> {
  if (!Bun.which("gst-launch-1.0")) return { missing: "GStreamer (gst-launch-1.0) is not installed" };
  if (!(await hasElement("pipewiresrc"))) return { missing: "GStreamer PipeWire plugin (gst-plugin-pipewire) is not installed" };
  if (await hasElement("jpegenc")) return { encoder: "jpegenc" };
  if (await hasElement("avenc_mjpeg")) return { encoder: "avenc_mjpeg" };
  return { missing: "No GStreamer JPEG encoder: install gst-plugins-good or gst-libav" };
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

export function outputSize(source: { width: number; height: number }, maxWidth: number): { width: number; height: number } {
  const width = even(Math.min(maxWidth, source.width));
  return { width, height: even((width * source.height) / source.width) };
}

function encoderArgs(encoder: Encoder, quality: number): string[] {
  if (encoder === "jpegenc") return ["jpegenc", `quality=${quality}`];
  // MJPEG quantizer: 2 (best) … 31 (worst).
  const q = Math.round(31 - (Math.min(100, Math.max(1, quality)) / 100) * 29);
  return ["avenc_mjpeg", "pass=quant", `quantizer=${q}`];
}

const EOI = 0xd9;

/** Splits a byte stream of concatenated JPEGs at End-Of-Image markers (0xFF 0xD9). */
export class JpegSplitter {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    const frames: Uint8Array[] = [];
    let start = 0;
    for (let i = Math.max(1, this.buffer.length - 1); i < merged.length; i++) {
      if (merged[i] === EOI && merged[i - 1] === 0xff) {
        frames.push(merged.slice(start, i + 1));
        start = i + 1;
      }
    }
    this.buffer = merged.slice(start);
    return frames;
  }
}

/**
 * Runs `pipewiresrc → scale → rate-limit → JPEG → stdout` for one PipeWire node. Frames are only
 * produced when the screen changes, plus a keepalive frame every second.
 */
export function startPipewireMjpeg(
  node: number,
  encoder: Encoder,
  source: { width: number; height: number },
  monitor: string,
  options: StreamOptions,
  onFrame: (frame: Frame) => void,
): FrameStream {
  const { width, height } = outputSize(source, options.maxWidth);
  const fps = Math.min(30, Math.max(1, Math.round(options.fps)));
  const proc = Bun.spawn(
    [
      "gst-launch-1.0", "-q",
      "pipewiresrc", `path=${node}`, "keepalive-time=1000", "do-timestamp=true", "!",
      "videoconvert", "!", "videoscale", "!", `video/x-raw,width=${width},height=${height}`, "!",
      "videorate", "drop-only=true", "!", `video/x-raw,framerate=${fps}/1`, "!",
      ...encoderArgs(encoder, options.quality), "!",
      "fdsink", "fd=1",
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );

  const state = { stopped: false };
  const ended = (async (): Promise<string> => {
    const splitter = new JpegSplitter();
    const reader = proc.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const jpeg of splitter.push(value)) onFrame({ jpeg, width, height, capturedAt: Date.now() });
    }
    const code = await proc.exited;
    if (state.stopped) return "stopped";
    const stderr = (await new Response(proc.stderr).text()).trim().slice(0, 300);
    return `capture pipeline exited (${code})${stderr ? `: ${stderr}` : ""}`;
  })();

  return {
    monitor,
    ended,
    stop: () => {
      state.stopped = true;
      proc.kill();
    },
  };
}
