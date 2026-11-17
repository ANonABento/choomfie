# Choomfie Activity

Her VRM avatar in a Discord voice call, in a small room. Audio stays on the bot (voice plugin); the Activity is only the face and the room. Code: `plugins/activity/` (`server/` bus + token exchange, `web/` Vite client).

## Run it

```bash
brew install cloudflared                       # once
bun run --cwd plugins/activity web:build       # builds web/dist (needs VITE_DISCORD_CLIENT_ID in plugins/activity/web/.env)
DISCORD_CLIENT_ID=… DISCORD_CLIENT_SECRET=… ACTIVITY_ALLOWLIST=<your user id> \
ACTIVITY_VRM=~/avatar.vrm bun run activity:dev
```

`activity:dev` starts the Activity server on `ACTIVITY_BUS_PORT` (default 3001) and a cloudflared quick tunnel to it, then prints the line to paste into URL Mappings. It serves `web/dist`, `/avatar.vrm` (from `ACTIVITY_VRM`), `POST /api/token` and the avatar bus at `/bus`. Run standalone it has no voice pipeline: the avatar idles and room events are printed, not sent to a brain.

A quick tunnel gets a new `*.trycloudflare.com` host every start, so update the URL Mapping target each time (or use a named cloudflared tunnel for a fixed host).

| Env | What |
|-----|------|
| `DISCORD_CLIENT_ID` | OAuth2 Client ID (same value as `VITE_DISCORD_CLIENT_ID` for the web build) |
| `DISCORD_CLIENT_SECRET` | OAuth2 Client Secret; stays on the server |
| `ACTIVITY_ALLOWLIST` | Comma-separated Discord user IDs allowed to launch the Activity and drive the avatar; anyone else gets 403 |
| `ACTIVITY_BUS_PORT` | Local port (default 3001; the Vite dev proxy uses the same variable) |
| `ACTIVITY_VRM` | Path to your VRM (VRoid export) |

## Developer Portal fields

On [discord.com/developers/applications](https://discord.com/developers/applications), in the bot's application:

| Page | Field | Value |
|------|-------|-------|
| Activities → Settings | **Enable Activities** | On |
| Activities → URL Mappings | **Prefix** | `/` |
| Activities → URL Mappings | **Target** | The tunnel host `activity:dev` prints, without `https://` (e.g. `quiet-fox-12.trycloudflare.com`) |
| OAuth2 | **Client ID** | Copy to `DISCORD_CLIENT_ID` and `VITE_DISCORD_CLIENT_ID` |
| OAuth2 | **Client Secret** | Copy to `DISCORD_CLIENT_SECRET` (reset it if lost; never put it in the web build) |
| OAuth2 → Redirects | **Redirects** | At least one entry is required for the authorize flow; `https://127.0.0.1` works, the Activity never navigates to it |
| Installation | **Installation Contexts** | Guild Install (the bot can only join guild voice channels) |
| — | Scopes | The client asks for `identify` and `applications.commands` at runtime; the install link should include `applications.commands` |
| — | Allowlist | Not a portal field: `ACTIVITY_ALLOWLIST` on the server (solo by default) |

The Activity only talks to its own origin (URL Mappings) and `discord.com/api/`; everything else is blocked by Discord's CSP.

## Launch

Join a guild voice channel, open the Activities launcher (rocket icon) and pick the app. The client refuses to start outside a guild voice channel. If WebGL is off it shows a hint to turn on hardware acceleration.
