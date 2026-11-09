# Phase 2 report — Remote control

**Done criterion: "I control my PC from my phone over Tailscale".** Everything this needs is built
and verified on this PC (KDE Plasma 6.7, **Wayland**). Two parts are yours, because they need your
accounts and devices: installing Tailscale, and the phone test itself (checklist at the end).

## What was verified live on this PC

All checks used the **compiled agent binary**, run from a folder without `node_modules`. The
dashboard was driven in headless Chromium.

| Check | Result |
| --- | --- |
| Live screen | 8 fps at 1280×720 ("Balanced") of the real desktop, in the dashboard and in an iPhone-size viewport |
| Click | Clicked into a test text field; focus landed there |
| Typing | Submitted text matched **byte-for-byte**: `Operator Test 123 !? مرحباX`, covering uppercase, symbols and Arabic |
| Key combos | Ctrl+A replaced the earlier text; Backspace deleted one character; Enter submitted the dialog |
| Scroll | Direction correct. KDE's portal treats "steps" as raw units, so the agent now scales ×15 per notch on KDE (measured). **Magnitude after the fix still needs a check in your phone test** |
| Pointer | Moves from the browser moved your real pointer |
| `open_app` | Ran correctly; it reported that no app matched "kwrite", because KWrite isn't installed |
| "Operator is controlling this PC" | Critical notification with a **Stop** button appeared on the desktop during take-over |
| Terminal | Typed in the browser → real shell output (`hello-from-42`) |
| Files, through the Next.js proxy | 25 MB upload via the Files tab: byte-identical, 1.4 s. 25 MB download: byte-identical |
| Phone-like origin | Loaded from a `*.ts.net` hostname (mapped to loopback): the app hydrated, the OTP field took input, sign-in worked, no console errors or warnings |
| Kill switch (dashboard) | Stop → actions refused (409) → Resume → actions run; state persisted on the device |
| Restarts | The portal session reopens silently with the saved restore token, with no dialog |

## Problems found while verifying, and fixed

- **Uploads over 9 MiB were cut off by the Next.js proxy** (it rejects request bodies over ~10 MB with a 500).
  The browser now uploads in 4 MiB requests, each written at its byte offset. This also works under
  Cloudflare's per-request cap.
- **The first screen view on a machine timed out** while the KDE consent dialog was open, because of
  the hub's 30 s limit. Desktop tools now get 2 minutes.
- **Scroll was ~1/15 of the intended distance on KDE.** It is now scaled; see above.
- **Port 3000 belongs to another project on this PC.** Operator's dashboard now defaults to
  **127.0.0.1:3100**. It binds to loopback only, so the dev server is never exposed on your LAN;
  Tailscale/Cloudflare proxy from localhost.

## Known limits and honest notes

- **The hotkey is registered but has no key assigned.** KDE stored
  `operator-stop=none,Ctrl+Alt+Shift+Esc,…`: the suggested key was not activated. It also sits under
  **Konsole**, because KDE names the app after the terminal that launched the agent. Assign it once:
  System Settings → Keyboard → Shortcuts → Konsole → "Stop Operator". A proper app identity comes with
  the installer (Phase 6). Until then, the notification's **Stop** and the dashboard's **Stop** always work.
- **Mouse-to-corner kill and an always-on-top banner aren't possible on Wayland.** The critical
  notification plus KDE's own "remote control session" indicator replace the banner.
- **Desktop control on Windows/macOS/X11 isn't built** (nut-js backend). It can't be tested on this
  machine. Those agents connect and show why the screen is unavailable; terminals, files and
  commands still work (no terminals on Windows yet). All five binaries compile; only Linux x64 was run.
- `list_windows` / `focus_window` → Phase 4 (accessibility layer). tmux session adoption → Phase 5.
- Arabic typed through key injection works on this layout. Characters missing from the active
  keyboard layout may not type on every desktop; a clipboard-paste fallback is a small addition if
  you see it.

## Key decisions (recorded in ARCHITECTURE.md)

1. **Wayland control goes through the desktop portal (you approved this).** It uses RemoteDesktop +
   ScreenCast: PipeWire video via GStreamer as MJPEG, and input through the portal. Consent is given
   once and remembered.
2. **The spec's capture libraries don't work on Wayland.** nut-js capture crashes the process
   (X11 `BadMatch`) and screenshot-desktop needs X11. screenshot-desktop is dropped; nut-js stays
   planned for Windows/macOS/X11.
3. **The agent runs on Bun.** Bun's built-in PTY replaces node-pty, so the Linux binary contains
   **no native addons**. That sidesteps the `.node`-in-binary failure the spike confirmed.
4. **Coordinates are normalized per monitor (0–1):** correct across DPI, resolution and viewer size.
5. **One access gate in the hub.** View only = watch only, also for you. A kill blocks actions and
   streaming. Every input event is a hub-signed command.

## How to run

```sh
docker compose up -d
pnpm --filter @operator/shared build
pnpm dev                                   # hub 127.0.0.1:4000, dashboard 127.0.0.1:3100
pnpm --filter @operator/agent build        # → apps/agent/dist/operator-agent
./apps/agent/dist/operator-agent pair --hub http://localhost:4000 --code <code from dashboard>
./apps/agent/dist/operator-agent run       # --headless: terminals/files only, no desktop dialogs
```

## How to test

`pnpm check` runs lint, typecheck and tests (**43 tests**); `pnpm build` builds everything.

- **hub (16):** everything from Phase 1, plus:
  - View only refuses actions.
  - Arguments are validated before signing.
  - Kill blocks actions until resume.
  - Frames go only to viewers.
  - Take-over input arrives as signed commands.
  - View-only input is refused over the live socket.
- **agent (14, Bun):** everything from Phase 1, plus:
  - Capabilities are reported.
  - PTY round trip and `run_command`.
  - Chunked file round trip.
  - Kill/resume.

## Your checklist to close Phase 2

1. Install Tailscale on this PC and your phone, and sign in to both:
   `sudo pacman -S tailscale && sudo systemctl enable --now tailscaled && sudo tailscale up`.
2. Run `tailscale serve --bg 3100` and `tailscale serve --bg --set-path /ws http://127.0.0.1:4000/ws`.
   In `.env`, set `PUBLIC_WEB_URL=https://<machine>.<tailnet>.ts.net` and
   `PUBLIC_WS_URL=wss://<machine>.<tailnet>.ts.net` (details: `docs/remote-access.md`).
3. Run `pnpm dev`, complete Setup (the token is in the hub log), pair this PC, and set it to **Assisted**.
   On the first screen view, approve the KDE dialog at the PC.
4. On the phone, open the URL and add it to the Home Screen. Open the device and press
   **Take over**. Try a tap, a long-press, a two-finger scroll (check the scroll distance feels like
   a wheel), and the keyboard.
5. Assign the stop key (see Known limits), press it on the PC, and check that the phone shows
   "Stopped on this device". Then press Resume.

## State left behind

- **Your main database is untouched** (no users, Setup open). My live tests used a scratch database,
  which I dropped.
- **KDE now remembers the permissions from my test runs:** the remote-control/screen-sharing grant
  and the "Stop Operator" shortcut entry. To revoke them:
  - System Settings → Privacy & Security → Application Permissions (Remote desktop / Screen cast).
  - Keyboard → Shortcuts → Konsole.
- I left no test files on your disk. A 25 MB test upload in your home folder was deleted.
- Nothing is committed to git.
