# Remote access (phone, other networks)

Agents and browsers only ever make **outbound** connections to the hub, so you never open ports on
your PCs. To reach the dashboard from your phone, put the web app (`:3100`) and the hub's sockets
(`:4000/ws`) behind **one HTTPS origin**.

The routes that origin must serve:

| Path | Goes to | Used by |
| --- | --- | --- |
| `/api/*` | web app `:3100` (it proxies to the hub) | browser, agent pairing |
| `/ws/*` | hub `:4000` directly | browser live updates, agents |
| everything else | web app `:3100` | browser |

Then set in `.env` and restart the hub:

```
PUBLIC_WEB_URL=https://<your-origin>
PUBLIC_WS_URL=wss://<your-origin>
```

With `PUBLIC_WEB_URL` on https, session cookies become `Secure` automatically.

## Option A — Tailscale (recommended)

Private to your tailnet, automatic HTTPS certificates, nothing exposed to the internet.

1. Install Tailscale on the hub machine and on your phone; sign in to the same tailnet.
2. In the admin console enable **MagicDNS** and **HTTPS certificates**.
3. On the hub machine:
   ```sh
   tailscale serve --bg 3100
   tailscale serve --bg --set-path /ws http://127.0.0.1:4000/ws
   tailscale serve status        # shows https://<machine>.<tailnet>.ts.net
   ```
4. `.env`: `PUBLIC_WEB_URL=https://<machine>.<tailnet>.ts.net` and
   `PUBLIC_WS_URL=wss://<machine>.<tailnet>.ts.net`.
5. On the phone, open the URL, sign in, then **Share → Add to Home Screen** to install the PWA.
6. Agents on other tailnet PCs pair with `--hub https://<machine>.<tailnet>.ts.net`.

## Option B — Cloudflare Tunnel

Works without installing anything on the phone; protect it with Cloudflare Access.

`~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /home/<you>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: operator.example.com
    path: ^/ws/
    service: http://127.0.0.1:4000
  - hostname: operator.example.com
    service: http://127.0.0.1:3100
  - service: http_status:404
```

```sh
cloudflared tunnel route dns <tunnel-id> operator.example.com
cloudflared tunnel run <tunnel-id>
```

Then add a Cloudflare Access application for `operator.example.com` (email OTP or your IdP),
so only you can even reach the login page. Note: Access in front of `/ws/agent` would block agents
— add an Access **bypass** policy for the path `/ws/agent` and `/api/pair` (both are protected by
Operator's own device signatures and one-time codes), or use a service token.

## Local network only

For quick testing on your LAN, the agent refuses plain `http://` to anything but localhost by
design. Use one of the options above instead of exposing `:4000` on the LAN.
