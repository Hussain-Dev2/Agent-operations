# Operator — Architecture

Operator is a self-hosted AI agent that sees and controls the owner's own computers. One **Hub**
(server) coordinates many **Host Agents** (one per computer) and serves a **Dashboard** (web/PWA).

```
             phone / desktop browser (PWA)
                        │  HTTPS (REST)  +  WSS (live updates)
                        ▼
  ┌──────────────── Hub (apps/hub) ────────────────┐
  │ Fastify REST · ws gateway · Drizzle/Postgres   │
  │ auth (password+TOTP) · pairing · audit log     │
  │ command signer (Ed25519) · agent loop (Ph. 3)  │
  └───────────────▲────────────────────────────────┘
                  │  WSS, opened OUTBOUND by each agent (no inbound ports on PCs)
     ┌────────────┴───────────┬────────────────────┐
  Host Agent (Windows)   Host Agent (macOS)    Host Agent (Linux)
  apps/agent, one binary per OS (bun build --compile)
```

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/hub` | Node 22+, Fastify 5, `@fastify/websocket` (ws), Drizzle ORM, PostgreSQL |
| `apps/agent` | Host Agent. TypeScript on the **Bun** runtime, compiled with `bun build --compile` per OS |
| `apps/web` | Next.js 15 App Router, Tailwind 4, shadcn/ui, TanStack Query, Zustand, next-intl, next-themes |
| `packages/shared` | Zod schemas: REST payloads, WebSocket protocol, tool definitions, risky-action list, crypto helpers |
| `packages/brain` | (Phase 3) `BrainProvider` adapters + agent loop |
| `packages/voice` | (Phase 6) wake word / STT / TTS adapters |

Tooling: pnpm workspaces, Turborepo, TypeScript 6 strict (`noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`), ESLint 9 + typescript-eslint (no `any`), Vitest.
TypeScript is pinned to 6.0 because typescript-eslint does not yet support TS 7.

## Trust model and keys

| Key | Holder | Purpose |
| --- | --- | --- |
| Hub signing key (Ed25519) | Hub. Generated on first boot, stored in DB encrypted with `MASTER_KEY` | Signs every command sent to agents |
| Device key (Ed25519) | Each agent. Generated locally at pairing; private key never leaves the device (file mode 0600) | Answers the hub's login challenge |
| `MASTER_KEY` (32 bytes, env) | Hub | AES-256-GCM encryption at rest: hub private key, TOTP secrets, later provider API keys |
| Session token | Browser, httpOnly cookie; DB stores SHA-256 only | Dashboard auth |

### Pairing
1. Owner clicks **Pair device** in the dashboard → hub creates a 6-digit code (single use, 10 min
   TTL, stored as SHA-256; audit-logged) and returns it with the `hubUrl` agents should use.
2. User runs `operator-agent pair --hub https://hub --code 123456`.
3. Agent generates an Ed25519 keypair and `POST /api/pair { code, publicKey, name, os, ... }`.
   Endpoint is rate-limited (5/min/IP) plus a hub-wide cap of 20 failed exchanges per 10 min, and
   codes are burned on use.
4. Hub returns `{ deviceId, hubPublicKey }`. Agent stores identity in the OS config
   dir (`%APPDATA%\operator-agent`, `~/Library/Application Support/operator-agent`,
   `$XDG_CONFIG_HOME/operator-agent`) with mode 0600.

### Agent connection (agent → hub, outbound WSS)
1. Agent opens `wss://hub/ws/agent`. Hub sends `{ type: "challenge", nonce }`.
2. Agent replies `{ type: "auth", deviceId, signature }` where the signature covers the UTF-8
   string `operator-agent-auth:v1:<deviceId>:<nonce>`.
3. Hub verifies with the stored device public key → device is **online**; presence is pushed to
   dashboards. Heartbeats every 15 s; missed heartbeats (45 s) or socket close → **offline**.
4. Agent reconnects with exponential backoff + jitter (1 s → 30 s).
5. The agent refuses `ws://` / `http://` hubs unless the host is loopback (TLS required remotely).

### Signed commands (hub → agent)
Envelope: `{ type: "command", payload: "<JSON string>", signature: "<base64url>" }`.
The signature covers the **exact payload bytes**; the agent verifies before parsing, then Zod-parses
the payload `{ id, deviceId, nonce, issuedAt, command: { name, args } }`. The agent rejects:
- bad signature, or `deviceId` ≠ its own;
- `issuedAt` outside ±60 s of local time;
- a nonce already seen (cache kept for the 120 s window, so replays are impossible).

Agent → hub messages (results, heartbeats) ride the already-authenticated socket. A refused command
is reported back as `{ type: "rejected", reason }` and audit-logged. Close codes 4001 (auth failed)
and 4003 (device removed) are fatal for the agent: it stops and asks to be paired again.

### Authorization rules
- Per-device `permissionLevel`: `view_only | assisted | autonomous`. Writable **only** through
  authenticated dashboard REST routes. No agent message, tool or model output can change it.
- Risky-action list lives in `packages/shared` (deletes, deny-listed shell commands, sending
  messages/email, purchases, password fields, system settings, `git push`). From Phase 3 every
  matching action pauses for approval; voice can never approve.
- Prompt-injection rule (Phase 3 brain): screen text, web pages, files, terminal and coding-agent
  output are always passed to models as clearly delimited **data**, never as instructions.
- Audit log: every auth event, pairing, permission change and (later) every action with a
  screenshot reference.

### Dashboard auth
Single owner account. First run shows **Setup**, gated by a one-time **setup token** the hub prints
in its log (so nobody else on the network can claim the hub first): email + password (scrypt,
`node:crypto`) and TOTP enrolment (QR code); the account is active only after a correct TOTP code.
Each TOTP time step is accepted once (replayed codes are refused). Login requires password +
TOTP. Sessions: 32-byte random token, httpOnly + SameSite=Strict + Secure (when HTTPS) cookie, 30-day
sliding expiry. Rate limits on all auth routes. Passkeys are a later addition (Phase 6 polish).

## Browser ↔ Hub origin

The browser only ever talks to **one origin** (the web app).
- REST: Next.js rewrites `/api/*` → `HUB_URL/api/*`, so the session cookie is first-party.
- Live updates: the browser fetches `POST /api/ws-ticket` (cookie-authenticated, returns a
  single-use 30 s ticket) and opens `WSS <hubWsUrl>/ws/dashboard?ticket=…`. Next rewrites do not
  reliably proxy WebSocket upgrades, so the socket goes to the hub's public URL directly; the
  ticket makes cross-origin safe.
- Production / remote access: put both behind one TLS origin.
  - **Tailscale** (recommended for personal use): `tailscale serve --bg 3100` for the web app and
    `tailscale serve --bg --set-path /ws http://localhost:4000/ws` for sockets → everything is on
    `https://<machine>.<tailnet>.ts.net`, only reachable from your tailnet.
  - **Cloudflare Tunnel**: `cloudflared` ingress rules `path: ^/ws` → `http://localhost:4000`,
    everything else → `http://localhost:3100`, plus Cloudflare Access in front.
  See `docs/remote-access.md`.

## WebSocket protocol (packages/shared)

All messages are Zod discriminated unions on `type`.
- **Agent channel** (`/ws/agent`): `challenge`, `auth`, `auth_ok`, `heartbeat`, `command`,
  `result`, `rejected`, `error`. Later: `frame` (JPEG), `pty_data`, `event`.
- **Dashboard channel** (`/ws/dashboard`): `device_presence`, `device_updated`, later
  `run_step`, `approval_requested`, `supervisor_state`, `frame`.

## Data model (Phase 1)

`users`, `sessions`, `pairing_codes`, `devices`
(id, name, os, arch, hostname, public_key, permission_level, last_seen_at, created_at),
`hub_keys`, `audit_log` (id, at, actor, action, device_id, ip, details jsonb, screenshot_ref).
Dashboard WS tickets live in hub memory only (30 s, single use).
Migrations: drizzle-kit generated SQL in `apps/hub/drizzle`, applied automatically at boot.

**Open decision — SQLite option.** The spec asks for PostgreSQL with an SQLite option. Phase 1
ships PostgreSQL only (via `docker compose`). Supporting SQLite with Drizzle means a second
schema per dialect; this is tracked in TASKS.md and needs owner sign-off on the approach
(dual schema vs. embedded Postgres/PGlite as the zero-setup option). Tests use PGlite (embedded
Postgres) so they need no running database.

## Remote control (Phase 2)

### Desktop backends (agent)
`Desktop` interface: `monitors`, `stream`, `screenshot`, `move`, `button`, `scroll`, `key`.
- **Linux / Wayland: `PortalDesktop`** (implemented, verified on KDE Plasma 6). Uses xdg-desktop-portal
  **RemoteDesktop + ScreenCast** over D-Bus (`@particle/dbus-next`, pure JS). The user approves one
  system dialog; `persist_mode=2` + a restore token (saved 0600 next to the identity) makes every
  later session silent until revoked in system settings. Video: the PipeWire node is read by a
  `gst-launch-1.0` child (`pipewiresrc → videoscale → videorate → jpegenc | avenc_mjpeg → stdout`),
  split into JPEGs on EOI markers. Input: `NotifyPointerMotionAbsolute`, `NotifyPointerButton`
  (evdev codes), `NotifyPointerAxisDiscrete`, `NotifyKeyboardKeysym` (X keysyms).
  System packages: GStreamer + `gst-plugin-pipewire` + (`gst-plugins-good` or `gst-libav`),
  a portal backend (`xdg-desktop-portal-kde`/`-gnome`), `wl-clipboard` for clipboard tools.
- **Windows / macOS / Linux-X11: `nut-js` backend — not shipped yet.** It can't be tested on the
  development machine, so the agent reports `desktop: null` with a reason on those platforms and the
  dashboard shows it. Terminals/files/commands still work there (terminals: macOS yes, Windows no).
  Deviation from the spec: **screenshot-desktop is dropped** (it shells out to X11 tools and cannot
  capture Wayland); nut-js `screen.grab` crashes the process on Wayland (X11 `BadMatch`).
- Why Bun at runtime: the agent ships as a Bun binary anyway, and **Bun's native PTY**
  (`Bun.spawn({ terminal })`) replaces node-pty, so no native addon has to be embedded in the binary.
  Spawning with inline terminal options makes the shell a session leader with a controlling TTY
  (job control, Ctrl+C work). tmux (session adoption) moves to Phase 5 where Supervisor needs it.

### Coordinates
All pointer coordinates are **normalized to a monitor** (`x`, `y` ∈ [0, 1]). The dashboard converts
from canvas pixels accounting for letterboxing; the agent multiplies by the monitor's logical size.
This is independent of DPI scaling, stream resolution and the viewer's screen. Phase 3 converts model
pixel coordinates (in the screenshot it was given) the same way.

### Live screen
`stream_start` (signed command) → agent sends **binary WS frames**: `[u32 header length][JSON
header][JPEG]`. The hub relays one stream per device to all viewers (started on the first
`watch_screen`, stopped after the last viewer leaves), tagging frames with `deviceId`. Backpressure
on both hops: the agent skips frames while >2 MiB is queued to the hub; the hub skips a viewer while
>1 MiB is queued to it. Quality presets: Data saver 5 fps/960 px, Balanced 8 fps/1280 px, Sharp
10 fps/1920 px. Frames are produced only on screen change plus a 1 s keepalive. WebRTC later.

### Input, terminals, files
- Take-over input travels dashboard → hub (WS `input`, batched every 33 ms, moves coalesced) → **hub-signed
  `input` command** → agent. No unsigned fast path exists.
- Terminals: `pty_*` tools; output is pushed as agent events and relayed to attached dashboards
  (xterm.js); scrollback (256 KiB) replays on attach. Sessions outlive dashboard and hub reconnects.
- Files: `file_list/read/write`; the hub streams downloads and uploads in 1 MiB signed chunks
  (`GET …/files/download`, `PUT …/files/upload`, octet-stream, never buffered whole).
- Generic `POST /api/devices/:id/tools/:name` runs any tool: args validated against its Zod schema
  before signing, then the access gate, then audit.

### Access gate (hub, single place)
Every tool has an access class (`observe` | `act`).
- **View only**: observe only, including for the human owner (no take-over).
- **Kill switch engaged**: no `act` tools and no screen streaming/screenshots, until `resume`.
- The gate runs for REST, live WS input and (Phase 3) the AI loop alike.

### Kill switch and "controlling this PC" indicator
Wayland allows neither always-on-top windows nor global key grabs for normal clients, so:
- While actions run, the agent shows a **critical, persistent desktop notification** "Operator is
  controlling this PC" with a **Stop** button (closed again after 20 s idle). KDE additionally shows
  its own "Remote control session" indicator for the portal session.
- **Ctrl+Alt+Shift+Esc** via the **GlobalShortcuts portal** (one-time system confirmation).
- **Stop** in the dashboard (`kill` tool, allowed at every permission level).
- The killed state is persisted on the device (survives agent restarts) and reported to the hub;
  only a signed `resume` from the dashboard clears it.
- **Mouse-to-top-left-corner is not implemented**: Wayland gives no global pointer position to
  clients. It will come with the nut-js backends where the OS allows it.

## Agent loop (Phase 3, in the Hub)
observe (screenshot + accessibility tree + active window + terminal tail) → think (model with tool
calling, via `BrainProvider`) → act (exactly one signed tool call on a device) → verify (new
observation) → repeat until done / max steps / stop. Structured tools first (CDP, PTY,
accessibility); screenshot + coordinate click only as a fallback. Screenshots are scaled down for the
model; coordinates are mapped back per monitor using its origin + DPI scale factor.

## Brain providers (Phase 3/5)
`BrainProvider { id; kind: "api" | "local" | "subscription" | "hermes"; capabilities: { tools,
vision, streaming }; chat(messages, tools) → AsyncIterable<Event>; runTask?(goal, cwd) →
AsyncIterable<Event> }`. Official SDKs only (`@anthropic-ai/sdk`, `openai`, `@google/genai`);
OpenAI-compatible base URLs for DeepSeek / OpenRouter / Groq / Ollama / LM Studio / custom.
Subscription CLIs (`claude -p`, `codex exec --json`, Gemini CLI, Copilot CLI) are only *invoked*
on the device; their OAuth tokens are never read, copied or proxied. Model roles (Planner,
Operator, Supervisor, Fast) each = provider + model + fallback chain.

## Supervisor mode (Phase 5)
PTY/tmux sessions for terminal coding agents; window focus + accessibility for desktop IDEs;
Playwright for browser IDEs. Heuristic state detector first (prompt waiting, confirm prompts,
stack traces, test summaries, loops, idle), then the Supervisor model. Never auto-approves rm,
`git push --force`, migrations, deploys, payments. Interventions stored as a timeline.
Hermes bridge: Operator device tools exposed as an MCP server (stdio + streamable HTTP, token auth).

## Voice (Phase 6)
Local wake word (openWakeWord default, Porcupine adapter); nothing leaves the device before the wake
word. STT: faster-whisper (default), OpenAI, Deepgram, ElevenLabs. TTS: ElevenLabs, OpenAI, Piper.
Optional realtime mode with barge-in. Voice can never approve a risky action.

## Known risks
1. **Native addons under `bun build --compile`** — confirmed in the Phase 2 spike: the `bindings`
   loader fails inside the binary. Avoided on Linux by Bun's PTY + the portal (no addons at all).
   When the nut-js backends land, each `.node` must be `require`d by literal path per build target.
2. Wayland restricts global input injection and screen capture (portal consent required).
3. macOS requires Accessibility + Screen Recording permissions (guided in the installer, Phase 6).
