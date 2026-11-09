# Operator — Task checklist

Legend: `[x]` done · `[ ]` todo · `[?]` needs owner decision

## Phase 1 — Foundation
Done when: my PC appears online after pairing.
- [x] ARCHITECTURE.md, TASKS.md
- [x] Monorepo: pnpm workspaces, Turborepo, strict TS, ESLint (no `any`), Vitest, `.env.example`, `.nvmrc`
- [x] `packages/shared`: Zod REST schemas, WS protocol (agent + dashboard), command envelope, signing helpers, risky-action list, permission levels
- [x] Hub: config (Zod-validated env), Drizzle schema + migrations, Postgres via docker compose
- [x] Hub: AES-256-GCM secret box, persistent hub Ed25519 key
- [x] Hub: owner setup (password + TOTP enrolment), login, logout, sessions, rate limits
- [x] Hub: pairing codes (6-digit, hashed, single-use, TTL, rate-limited exchange)
- [x] Hub: agent WS gateway (challenge-response auth, heartbeats, presence), signed commands with nonce + timestamp
- [x] Hub: dashboard WS (ticket auth) with live presence
- [x] Hub: device list / rename / permission level / delete; audit log
- [x] Agent: `pair` and `run` commands, identity file (0600), reconnect with backoff, signature + replay verification, `system_info` command
- [x] Agent: `bun build --compile` binary verified on Linux
- [x] Web: Next.js 15 shell, dark default, i18n en/ar with RTL, setup/login with TOTP, Home, Devices + pairing dialog, live online badges, placeholder screens, Ctrl+K palette, PWA manifest
- [x] Integration tests: pair → connect → online → offline; replayed + tampered commands rejected
- [?] SQLite option: dual Drizzle schema vs. embedded Postgres (PGlite) as zero-setup mode — awaiting owner decision (see PHASE_1_REPORT.md)
- [x] PHASE_1_REPORT.md

## Phase 2 — Remote control
Done when: I control my PC from my phone over Tailscale.
- [x] Spike: native addons under `bun build --compile` (fail via `bindings`), nut-js/screenshot-desktop on Wayland (crash / unusable), portal + PipeWire + GStreamer (works, 8 fps), restore token (silent restarts), Bun native PTY
- [x] Agent on Bun runtime; tests on `bun test`; binary runs from a directory without node_modules
- [x] Tool registry with access classes (observe/act), Zod args/results, normalized coordinates
- [x] Wayland desktop backend (xdg-desktop-portal RemoteDesktop + ScreenCast, persisted consent)
- [ ] Desktop backend for Windows, macOS and Linux/X11 (nut-js, `.node` loaded by literal path per target) — needs those machines to test
- [x] Live screen: binary JPEG frames, one shared stream per device, quality presets, backpressure on both hops
- [x] `screenshot`, `list_monitors`, `input`, `click`, `double_click`, `right_click`, `drag`, `scroll`, `type_text`, `press_keys`
- [x] Take-over from desktop (pointer, buttons, wheel, keyboard) and touch (tap, long-press, drag, two-finger scroll, phone keyboard, sticky modifiers, special keys)
- [x] Terminals: `pty_open/write/read/list/resize/close` on Bun PTY, xterm.js, scrollback replay, sessions survive reconnects
- [ ] tmux-backed sessions (adopt existing sessions) — moved to Phase 5 (Supervisor)
- [x] Files: `file_list/read/write`, streamed upload/download (1 MiB signed chunks), file browser with upload progress
- [x] `run_command`, `clipboard_get/set` (wl-clipboard/xclip/pbcopy/PowerShell), `open_app` (.desktop entries / `open -a` / `start`)
- [ ] `list_windows`, `focus_window` — Wayland has no client API for this; moved to Phase 4 with AT-SPI/UIA/AX
- [x] "Operator is controlling this PC" indicator (critical notification + KDE's portal indicator; no always-on-top windows on Wayland)
- [x] Kill switch: notification Stop, dashboard Stop; persisted; hub blocks actions until resume
- [x] Kill switch hotkey registered via the GlobalShortcuts portal (key assignment pending, see owner check)
- [ ] Stable app identity for the agent (so KDE files permissions under "Operator", not the launching terminal) — Phase 6 installer
- [ ] Kill switch: mouse to top-left corner — not possible on Wayland; with the nut-js backends
- [x] Access gate: View only = observe only; killed = no actions/streaming; one gate for REST + live input
- [x] Device view: Screen / Terminal / Files tabs, Stop/Resume, live status, mobile layout
- [ ] **Owner check:** install Tailscale, then control this PC from the phone (docs/remote-access.md); confirm scroll distance feels like a wheel
- [ ] **Owner check:** assign the "Stop Operator" key in KDE (registered, but KDE left it unassigned) and test it
- [x] PHASE_2_REPORT.md

## Phase 3 — AI brain
Done when: "Open Chrome, search X, save first result to notes.txt" works end to end.
- [ ] `packages/brain`: `BrainProvider` interface + event stream types
- [ ] Anthropic (`@anthropic-ai/sdk`: tool use, vision, streaming, prompt caching)
- [ ] OpenAI (`openai`), Gemini (`@google/genai`)
- [ ] OpenAI-compatible: DeepSeek, OpenRouter, Groq, custom base URL, Ollama, LM Studio
- [ ] Encrypted provider keys (AES-256-GCM), Providers screen
- [ ] Model roles (Planner/Operator/Supervisor/Fast) with fallback chains on rate-limit/error
- [ ] Agent loop: observe → think → act → verify, max steps, pause/stop/take over
- [ ] Prompt-injection guard: untrusted content wrapped as data
- [ ] Risky-action detection → Approvals (screenshot + exact action, approve/reject/edit)
- [ ] Run timeline UI (thought/action/screenshot/result), audit log with screenshot per action
- [ ] Audit log screen: search + export
- [ ] PHASE_3_REPORT.md

## Phase 4 — Browser + accessibility tools
Done when: web tasks run without screenshots.
- [ ] Playwright `connectOverCDP` to the user's real Chrome; `browser_*` tools
- [ ] `get_accessibility_tree` + `click(element_id)`: Windows UIA, macOS AX, Linux AT-SPI
- [ ] Planner prefers structured tools; screenshot fallback only
- [ ] PHASE_4_REPORT.md

## Phase 5 — Supervisor + subscription CLIs + Hermes
Done when: Operator keeps Claude Code working until tests pass, pinging me only for approvals.
- [ ] Subscription providers: Claude Agent SDK / `claude -p`, `codex exec --json`, Gemini CLI, Copilot CLI (install + login detection, usage display; never touch tokens)
- [ ] Supervisor: attach/launch PTY/tmux sessions; desktop IDEs via a11y; browser IDEs via Playwright
- [ ] Rolling 200-line buffer + periodic screenshot; heuristic state detector; Supervisor model
- [ ] Interventions: type + Enter, verify via tests/build, timeline
- [ ] Escalation: Web Push + optional Telegram; never auto-approve destructive actions
- [ ] Hermes: MCP server (stdio + streamable HTTP, token auth) + `HermesProvider`
- [ ] Supervisor screen
- [ ] PHASE_5_REPORT.md

## Phase 6 — Voice + polish
- [ ] `packages/voice`: openWakeWord (default) + Porcupine adapter, custom wake name
- [ ] STT: faster-whisper (default, ar + en), OpenAI, Deepgram, ElevenLabs
- [ ] TTS: ElevenLabs, OpenAI, Piper; short spoken summary, full text on screen
- [ ] Live mode: OpenAI Realtime / Gemini Live with barge-in
- [ ] Tray companion (agent) + PWA push-to-talk, listening indicator, mute
- [ ] Web Push actions for approvals (tap required; voice cannot approve)
- [ ] Passkeys
- [ ] Installers: Windows .exe/MSI, macOS .pkg (+ permission guide), Linux .deb/AppImage
- [ ] PHASE_6_REPORT.md
