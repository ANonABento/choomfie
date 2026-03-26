# Architecture

## Overview

Choomfie is a Claude Code plugin — an MCP server that Claude Code spawns as a subprocess via `--plugin-dir`. It bridges Discord messages to Claude Code and provides persistent memory, reminders, and GitHub integration.

```
┌──────────────────────────────────────────────────┐
│                  Claude Code                      │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │         MCP Subprocess (stdio)             │  │
│  │                                            │  │
│  │  ┌────────┐ ┌──────┐ ┌──────┐ ┌────────┐  │  │
│  │  │Discord │ │Memory│ │Remind│ │ GitHub │  │  │
│  │  │Client  │ │Store │ │Timer │ │  (gh)  │  │  │
│  │  └───┬────┘ └──┬───┘ └──┬───┘ └───┬────┘  │  │
│  │      └────┬────┴────┬───┘─────────┘        │  │
│  │           │         │                      │  │
│  │      server.ts (MCP plugin server)          │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  Claude sees: <channel source="choomfie" ...>       │
│  Claude calls: reply, save_memory, set_reminder  │
└──────────────────────────────────────────────────┘
         │                          ▲
         ▼                          │
    Discord API                Discord API
```

## Data Flow

### Inbound (Discord → Claude)

1. User sends message on Discord (channel or DM)
2. discord.js client receives it
3. **Trigger check:** DMs always pass; servers require `@mention`, reply to bot, or active conversation mode
4. **Allowlist check:** sender must be on allowlist (or bootstrap mode if empty)
5. **Rate limit check:** 5 second cooldown per user
6. `@mention` stripped from message text for clean forwarding
7. Attachments downloaded to `~/.claude/plugins/data/choomfie-inline/inbox/`
8. Server emits `notifications/claude/channel` with content + metadata
9. Claude Code receives it as a `<channel>` tag in context

### Outbound (Claude → Discord)

1. Claude calls an MCP tool (reply, react, pin_message, etc.)
2. server.ts handles the tool call via discord.js
3. Response sent to Discord
4. Tool returns confirmation to Claude

### Memory Flow

1. Claude calls `save_memory` during conversations
2. Written to SQLite at `~/.claude/plugins/data/choomfie-inline/choomfie.db`
3. On startup, core memories loaded into `instructions` string
4. Personality loaded from `personality` key in core memory

### Reminder Flow

1. Claude calls `set_reminder` with a due time
2. Stored in SQLite `reminders` table
3. Background timer checks every 30 seconds
4. When due, posts to the original Discord channel

### Permission Flow

1. Claude needs to run a tool (Bash, Write, etc.)
2. Claude Code sends permission request to the channel
3. server.ts DMs it to the owner only (or all allowlisted if no owner set)
4. Owner replies `yes xxxxx` or `no xxxxx`
5. Verdict forwarded back to Claude Code

### Owner Auto-Detection

**Primary (setup):** During `./install.sh`, after saving the token, curls the Discord API to fetch the app owner's user ID and writes it to `access.json`.

**Fallback (startup):** If no owner is set when the bot boots (e.g. setup was skipped or failed), fetches the app owner via `client.application.fetch()` and persists it.

Either way: whoever created the bot in the Discord dev portal = owner. Zero manual config needed.

## State Locations

| What | Where |
|------|-------|
| Discord token | `~/.claude/plugins/data/choomfie-inline/.env` |
| Access list | `~/.claude/plugins/data/choomfie-inline/access.json` |
| Memory database | `~/.claude/plugins/data/choomfie-inline/choomfie.db` |
| Downloaded attachments | `~/.claude/plugins/data/choomfie-inline/inbox/` |
| Plugin code | `~/choomfie/` (or wherever you cloned it) |
| MCP server config | `choomfie/.mcp.json` (loaded via `--plugin-dir`) |

## Conversation Mode

When a user `@mentions` the bot in a server channel, the bot enters **conversation mode** for that channel:

- **Channel-wide** — responds to all users in the channel, not just the one who tagged
- **2 minute idle timeout** — stays active as long as messages keep flowing; deactivates after 2 min of silence
- **Natural responses** — messages in conversation mode include `conversation_mode="true"` metadata; Claude can choose not to reply to every message, just like a human in a group chat
- **Re-engagement** — after timeout, goes back to `@mention` or reply-only mode

## Design Decisions

- **Plugin** over standalone bot — TOS compliant, full Claude Code power
- **bun:sqlite** over better-sqlite3 — native to Bun, zero dependencies
- **Single server.ts** — matches official plugin pattern, easy to understand
- **gh CLI** for GitHub — already installed and authenticated, no token management
- **Personality via memory** — changeable from Discord without editing code
