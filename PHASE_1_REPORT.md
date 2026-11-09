# Phase 1 report — Foundation

**Done criterion: "my PC appears online after pairing" — met.** On this machine (Arch Linux, x64) the
**compiled** agent binary was paired through the dashboard flow, connected, showed **Online**, and
answered a hub-signed `system_info` command:

```
$ apps/agent/dist/operator-agent pair --hub http://localhost:4000 --code 311283 --name "Hussin-Arch (compiled)"
Paired as device fa6d2fc5-…  Identity saved to …/identity.json   (mode 600)
$ apps/agent/dist/operator-agent run
connecting → online
GET  /api/devices                → "online": true, "permissionLevel": "view_only"
POST /api/devices/:id/system-info → {"hostname":"Hussin-Arch","cpus":20,"release":"6.18.53-1-lts",…}
```

That round trip also proves Bun's compiled Ed25519 verifies signatures made by Node on the hub.

Also verified live:
- **Hub restart.** I killed the hub process and started a new one on the same Postgres while the compiled agent kept running. The agent went offline, reconnected on its own with backoff, and the next signed command still verified, so the hub signing key persists across restarts.
- **Pairing dialog, end to end in the browser.** I opened **Pair device** and read the code from the page, then paired and started a second binary. The dialog switched live to "Second agent is online", and the card went **Offline** when the agent stopped (`docs/screenshots/04b-pair-dialog-online.png`).

## What was built

| Area | Contents |
| --- | --- |
| Monorepo | pnpm workspaces + Turborepo, TypeScript 6 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` in Node packages), ESLint `strictTypeChecked` + `no-explicit-any`, react-hooks rules, Vitest, `.env.example`, `.nvmrc`, `docker-compose.yml` (Postgres 17) |
| `packages/shared` | Zod schemas for every REST payload and WS message (agent + dashboard channels), signed command envelope, tool registry with JSON-schema export (`system_info` for now), risky-action classifier for shell commands, permission levels, Ed25519 helpers |
| `apps/hub` | Fastify 5 + `@fastify/websocket` (ws) + Drizzle/Postgres with auto-migrations. Owner setup (setup token → password → TOTP QR → verify), login with password + TOTP (code reuse blocked), httpOnly/SameSite=Strict sessions, rate limits on auth and pairing, AES-256-GCM secret box (`MASTER_KEY`), persistent hub signing key, pairing codes (6 digits, hashed, single use, 10 min, global failure cap), agent gateway (challenge-response, heartbeats, presence, replaced/revoked handling), signed commands with nonce + timestamp, dashboard WS with single-use tickets, device list/rename/permission level/remove, audit log for every auth, pairing, permission and connection event, optional TLS |
| `apps/agent` | CLI `pair` / `run` / `status`, identity in the OS config dir (0600, atomic write), refuses non-TLS hubs except localhost, reconnect with backoff + jitter, stops on revoke, verifies every command (signature over exact bytes → device id → ±60 s → nonce replay cache), reports rejections, compiled with `bun build --compile` (80 MB single binary, `build:all` for 5 targets) |
| `apps/web` | Next.js 15.5 App Router, Tailwind 4, shadcn/ui (Radix, RTL-aware), TanStack Query, Zustand, next-intl (English + Arabic with RTL and IBM Plex Sans Arabic), dark by default, server-side auth gate. Screens: Setup (2 steps), Login, Home (command box placeholder, device cards, recent tasks empty state), Devices (cards with live status, permission level, rename, remove, ping; pairing dialog with code, countdown, copyable commands and live "paired → online" confirmation), Settings (theme, language, sign out), placeholders for Runs / Supervisor / Approvals / Providers / Voice / Audit. Ctrl+K command palette, toasts, skeletons, empty states, mobile bottom tab bar + "More" sheet, PWA manifest and icons, live updates over WebSocket |
| Docs | `README.md`, `ARCHITECTURE.md`, `TASKS.md`, `docs/remote-access.md` (Tailscale + Cloudflare Tunnel), screenshots in `docs/screenshots/` |

## How to run

```sh
pnpm install
# .env already exists on this machine (with its MASTER_KEY) — don't overwrite it. On a fresh clone:
# [ -f .env ] || { cp .env.example .env && sed -i "s|^MASTER_KEY=$|MASTER_KEY=$(openssl rand -base64 32)|" .env; }
docker compose up -d
pnpm --filter @operator/shared build
pnpm dev                       # hub on :4000, web on :3000
```
Open http://localhost:3000 → enter the setup token from the hub log → create the owner + scan the QR
→ **Devices → Pair device** → run the two commands shown:

```sh
pnpm --filter @operator/agent build
./apps/agent/dist/operator-agent pair --hub http://localhost:4000 --code <code>
./apps/agent/dist/operator-agent run
```

## How to test

```sh
pnpm check     # lint + typecheck + tests in all packages (13 turbo tasks)
pnpm build     # shared, web production build, agent binary
```

Results at the end of this phase: **all green**. 36 tests:
- `shared` (13): sign/verify/tamper/wrong key, risky-command classification, protocol rejection.
- `hub` (11, real HTTP + WebSockets on embedded Postgres/PGlite): setup closes after first owner;
  login needs password + TOTP and refuses a reused code; protected routes; logout; pairing codes are
  single use; pair → connect → online → disconnect → offline with live dashboard events; wrong-key
  agent rejected (4001); signed command round trip; removing a device disconnects it (4003);
  dashboard socket without ticket rejected.
- `agent` (12): verifier accepts fresh commands and rejects replay, tampering, other key, other
  device, stale/future timestamps, schema-invalid payloads; nonce window; plus end-to-end against a
  real hub: pair → identity file 0600 → online → `system_info` → offline on stop, **replayed and
  tampered commands rejected and audit-logged**, agent stops retrying after removal, insecure hub URLs
  refused.

Manual run: the compiled binary flow above, plus the UI driven in headless Chromium (login with TOTP,
Home, Devices, pairing dialog, command palette, Arabic RTL, mobile 390 px) with **zero console
errors**. Screenshots: `docs/screenshots/01…08`.

Issues found and fixed during that manual run:
- The command palette crashed on open, because this shadcn `CommandDialog` needs an explicit `<Command>` root.
- Arabic fell back to a system serif font. The font variables were scoped to `<body>`, not `<html>`.
- The permission select's trigger showed the hint text, not just the label.
- Latin device names truncated from the wrong side in RTL.
- The hub closed a socket with 4001 ("pair again", fatal for the agent) on an auth *timeout* or a database error during auth, too. A Postgres blip could have permanently stopped an unattended agent. Those cases now use 4006 / 1011, which the agent retries; 4001 is only for a bad signature or unknown device.
- One intermittent e2e timeout under heavy parallel load. Fixed by giving the e2e generous budgets and always aborting agents in `afterEach`. It then passed 3 consecutive uncached runs.

## Decisions to approve

1. **SQLite option — not built yet.** Phase 1 is PostgreSQL only. Real SQLite support with Drizzle
   means a second schema + migrations per dialect. Alternative: offer **embedded Postgres (PGlite)**
   as the zero-setup mode (same schema; the test suite already runs on it). Which do you want?
2. **Setup token.** I added a one-time token, printed in the hub log, that is required to create the
   owner account. Without it, anyone who reached the hub first could claim it.
3. **Passkeys deferred** to Phase 6. Phase 1 uses password + TOTP (the spec allowed either).
4. **TypeScript 6.0**, not 7, because typescript-eslint doesn't support TS 7 yet.
5. **New devices start at "View only"**. You raise the level per device in the dashboard. Nothing
   coming from a device can change it.
6. Dashboard live sockets go **directly to the hub** with a short-lived ticket. Next.js rewrites
   can't reliably proxy WebSockets. For remote use, both go behind one origin (`docs/remote-access.md`).

## Known limitations / notes

- During testing, port 3000 was in use by another project's Next 16 dev server, so I ran this
  dashboard on :3100 and left that server alone. It has since stopped. If :3000 is busy again, use
  `pnpm --filter @operator/web exec next dev -p 3100`.
- **I reset the dev database at the end** (`docker compose down -v && up -d`). It only held my test
  data (a demo owner whose TOTP secret existed only in my scratch space), so your first `pnpm dev`
  starts at Setup with a fresh setup token in the hub log. Your `.env` and `MASTER_KEY` are untouched.
- Don't run `pnpm build` while `pnpm dev` is running. Both write `apps/web/.next`.
- `pnpm install` will show pnpm's build-script approval. `esbuild` is allowed. `@swc/core` and
  `@parcel/watcher` (pulled in by next-intl's tooling) are denied, since they ship prebuilt binaries.
- Hub error messages are localized in the UI by error code; hub logs stay English.
- The agent binary is ~80 MB because it embeds the Bun runtime.

## Top risk going into Phase 2
Native addons (`@nut-tree-fork/nut-js`, `node-pty`) inside `bun build --compile`. Phase 2 starts with
a spike on Linux, Windows and macOS. The fallback is the binary plus a sidecar `native/` folder.
