# Operator

Self-hosted AI agent that sees and controls your own computers, from a web dashboard and your phone.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and [TASKS.md](TASKS.md) for progress.

## Requirements
- Hub + dashboard: Node 22+, pnpm 12, Docker (for Postgres).
- Agent: Bun 1.4+ (runtime and compiler). On Linux/Wayland for screen control: GStreamer with
  `gst-plugin-pipewire` and `gst-plugins-good` *or* `gst-libav`, an xdg-desktop-portal backend
  (KDE/GNOME), and `wl-clipboard` for clipboard tools.
  Arch: `sudo pacman -S gst-plugin-pipewire gst-plugins-good wl-clipboard`.

## Quick start (development)

```sh
pnpm install
# Create .env once. Never regenerate MASTER_KEY afterwards: it decrypts the stored secrets.
[ -f .env ] || { cp .env.example .env && sed -i "s|^MASTER_KEY=$|MASTER_KEY=$(openssl rand -base64 32)|" .env; }
docker compose up -d                                                    # Postgres
pnpm --filter @operator/shared build
pnpm dev                                                                # hub :4000 + web :3100
```

1. The hub log prints `Owner setup is open. Setup token: …`. Open http://localhost:3100, enter the
   token, your email and a password, then scan the QR code with an authenticator app.
2. **Devices → Pair device** shows a one-time code and the exact command.
3. On the PC to pair (here: the same machine):
   ```sh
   pnpm --filter @operator/agent build            # → apps/agent/dist/operator-agent
   ./apps/agent/dist/operator-agent pair --hub http://localhost:4000 --code 123456
   ./apps/agent/dist/operator-agent run
   ```
   Or without compiling: `pnpm --filter @operator/agent agent pair …` / `… agent run`.
4. The device turns **Online** in the dashboard within a second. New devices are **View only**:
   raise the permission level to **Assisted** on the device card to take over.
5. Open the device → **Screen**. The first time, your desktop asks to allow remote control and screen
   sharing (and to register the Ctrl+Alt+Shift+Esc stop shortcut): approve at the PC. Later starts
   are silent. Press Ctrl+Alt+Shift+Esc or the notification's **Stop** any time to block Operator.

Phone / remote access: [docs/remote-access.md](docs/remote-access.md).

## Commands

| | |
| --- | --- |
| `pnpm check` | lint + typecheck + tests in every package |
| `pnpm build` | build shared, web (Next.js), agent binary |
| `pnpm --filter @operator/agent build:all` | agent binaries for Linux/macOS/Windows (x64 + arm64) |
| `pnpm --filter @operator/hub db:generate` | new SQL migration after editing `apps/hub/src/db/schema.ts` |

Migrations run automatically when the hub starts.
# Agent-operations
