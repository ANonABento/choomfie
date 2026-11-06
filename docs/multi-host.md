# Running Choomfie on a second computer

One Discord bot per computer, each fully independent: its own token, data,
memories, chats and Claude sessions. Nothing is shared or synced — a second
host is just a second install that happens to belong to you.

## Why a separate bot

Discord delivers each message to every connection logged in with a token, so
two hosts on one token would both answer everything. A second application costs
nothing and gives each host its own name, avatar and slash commands.

## Setup on host 2

1. **New Discord application** — [discord.com/developers](https://discord.com/developers/applications) → New Application → Bot → copy the token. Turn on **Message Content Intent**. Invite it with the same permissions as the first ([discord-setup.md](discord-setup.md)), including **Create Public Threads** for auto-thread.
2. **Install** — clone the repo, then `./install.sh` and paste the *new* token. The owner (you) is detected from the new application on first start.
3. **Run it** — `choomfie --daemon`, or `bun run install:launchd` to start at login.
4. **Pair your access list** — host 2 starts with an empty allowlist. DM the new bot `!pair` and approve it from Claude Code on host 2 (`/choomfie:access pair <code>`), then `/choomfie:access policy allowlist`. Repeat for anyone else who should reach it.
5. **Give it a different persona name** (`/persona new`, `/persona switch`) so it's obvious which machine is answering.

Do **not** copy `~/.claude/plugins/data/choomfie-inline/` from host 1: it holds host 1's token, and a copied token means two hosts answering the same messages. Copy single files deliberately if you want them (e.g. personas from `config.json`).

## Living with two bots

- **Servers:** each bot answers only its own @mention, replies to its own messages, and its own threads. Mention one bot and that bot opens the thread; the other stays out unless mentioned there.
- **DMs:** separate per bot — DM the one on the machine you want.
- **Group DMs:** `/choomfie` and **Ask Choomfie** go to whichever app's command you pick (both show up; the app name tells them apart).
- **Usage limits:** if both hosts sign in to Claude with the same account, they share its plan limits; `/usage` on either shows the same windows.
- **Web brains:** each host logs in to a site on its own profile (`bun run webbrain login <id>` on that machine). Two hosts on one site account look like two devices to it.

## Optional: reading one host from another

Each host can expose a read-only slice of itself with `remoteMcp` (memories, reminders, status — [configuration.md](configuration.md#remote-mcp-endpoint-remotemcp)), reachable from the other over Tailscale. That's the only bridge, and it's opt-in per host; there is no shared memory.
