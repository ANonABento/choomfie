# Choomfie — Claude Code Instructions

## Project Overview

Choomfie is a Claude Code plugin (v0.4.0) — an MCP server that bridges Discord to Claude Code with persistent memory, switchable personas, reminders, GitHub integration, and more. It runs as a subprocess inside Claude Code via `--plugin-dir`.

## Tech Stack

- **Runtime:** Bun
- **Language:** TypeScript
- **Protocol:** MCP (Model Context Protocol) over stdio
- **Database:** SQLite via bun:sqlite
- **Discord:** discord.js v14
- **Framework:** @modelcontextprotocol/sdk

## Project Structure

```
server.ts                      # Entry point — wiring + lifecycle (~95 lines)
lib/
  types.ts                     # AppContext, ToolDef, text/err helpers
  context.ts                   # Env/config loading, creates AppContext
  mcp-server.ts                # MCP Server creation, instructions, tool registration
  discord.ts                   # Discord client, Ready, MessageCreate, InteractionCreate
  interactions.ts              # Interaction router (buttons, slash commands, modals)
  commands.ts                  # Slash command definitions + handlers
  conversation.ts              # Channel activation, rate limiting, uptime
  permissions.ts               # Permission relay (tool approval via DM)
  reminders.ts                 # ReminderScheduler — timer-based (setTimeout per reminder)
  time.ts                      # Shared datetime utils (SQLite-compatible formatting)
  memory.ts                    # SQLite memory store (core + archival + reminders)
  config.ts                    # Config manager (personas, rate limits, settings)
  tools/
    index.ts                   # Tool registry — aggregates all tool modules
    discord-tools.ts           # reply (embeds), react, edit, fetch, search, thread, poll, pin/unpin
    access-tools.ts            # allow/remove/list users (owner only)
    memory-tools.ts            # save/search/list/delete memory, summary, stats
    persona-tools.ts           # switch/save/list/delete persona
    reminder-tools.ts          # set/list/cancel/snooze/ack reminder
    github-tools.ts            # check_github
    status-tools.ts            # choomfie_status
  plugins.ts                   # Plugin loader (discovers + loads from plugins/)
plugins/                       # Plugin directory (each plugin = subdirectory)
scripts/
  deploy-commands.ts           # Deploy slash commands to Discord
.claude-plugin/plugin.json     # Plugin metadata
.mcp.json                      # How Claude Code spawns the server
test/
  boot.test.ts                 # Smoke test — verifies server boots without crashing
skills/
├── configure/SKILL.md         # /choomfie:configure — set Discord token
├── access/SKILL.md            # /choomfie:access — manage allowlist
├── memory/SKILL.md            # /choomfie:memory — view/manage memories
└── status/SKILL.md            # /choomfie:status — config overview
```

## Architecture

Shared state flows through a single `AppContext` object (defined in `lib/types.ts`).
Tools colocate their JSON schema definition + handler in one file as `ToolDef[]` arrays.

### Plugin System

Plugins live in `plugins/<name>/index.ts` and export a `Plugin` interface:
- `tools` — ToolDef[] (auto-registered into MCP)
- `instructions` — string[] (appended to system prompt)
- `intents` — extra Discord gateway intents
- `init(ctx)` — called after Discord ready
- `onMessage(msg, ctx)` — hook into every message
- `destroy()` — cleanup on shutdown

Enable plugins in `config.json`: `"plugins": ["voice", "image-gen"]`

## How It Works

1. Claude Code loads Choomfie via `--plugin-dir` and `--dangerously-load-development-channels server:choomfie`, then spawns `bun server.ts` as an MCP subprocess
2. Single-instance guard: kills any stale process from a previous session via PID file (`choomfie.pid`)
3. server.ts connects to Discord via discord.js
4. Incoming messages → MCP notifications → Claude Code
5. Claude calls MCP tools (reply, save_memory, etc.) → server.ts → Discord/SQLite
6. Reminders use precise setTimeout timers — each reminder gets its own timer that fires exactly when due (zero polling overhead)
7. Discord interactions (buttons, slash commands, modals) are handled directly via `lib/interactions.ts` — no Claude roundtrip, instant response
8. On shutdown (SIGINT/SIGTERM/SIGHUP/stdin close): destroys Discord client, cleans up plugins/reminders/memory, removes PID file

### Interaction System

Discord interactions (buttons, slash commands, modals) are handled by `lib/interactions.ts`:
- **InteractionCreate** event registered in `lib/discord.ts`, routes to `handleInteraction()`
- Plugin hook: `onInteraction?(interaction, ctx)` in the Plugin interface
- Button customId format: `prefix:action:data` (e.g. `reminder:ack:42`, `reminder:snooze:42:1h`)
- Button handlers registered via `registerButtonHandler(prefix, handler)`
- All interactions bypass Claude — handled directly for instant response (<100ms vs ~5s)
- Key constraint: Discord requires response within 3 seconds; use `deferReply()` for async work
- Slash command definitions in `lib/commands.ts`, deployed via `bun scripts/deploy-commands.ts`

### Slash Commands

Defined in `lib/commands.ts`, deployed via `scripts/deploy-commands.ts`:
- `/remind <message> <time> [recurring] [nag]` — set a reminder with natural time parsing
- `/reminders` — list active reminders (ephemeral)
- `/github <check> [repo]` — check PRs, issues, notifications
- `/status` — bot status and stats (ephemeral)
- `/persona [switch]` — list or switch personas

Deploy: `bun scripts/deploy-commands.ts` (guild, instant) or `--global` (up to 1hr propagation).

## Tools (26)

Discord: reply (with embeds), react, edit_message, fetch_messages, search_messages, create_thread, create_poll, pin_message, unpin_message
Memory: save_memory, search_memory, list_memories, delete_memory, save_conversation_summary, memory_stats
Personas: switch_persona, save_persona, list_personas, delete_persona
Reminders: set_reminder, list_reminders, cancel_reminder, snooze_reminder, ack_reminder
Access: allow_user, remove_user, list_allowed_users (owner only)
GitHub: check_github
Status: choomfie_status

### Rich Embeds

The `reply` tool supports Discord embeds via the `embeds` parameter. Each embed takes:
- `title`, `description`, `color` (name: blue/green/yellow/orange/red/purple/pink/grey, or hex)
- `fields` array of `{name, value, inline?}`
- `footer`, `thumbnail`, `url`

Use for structured content (status, lists, summaries). Plain text for casual chat.

### Polls

`create_poll` creates Discord native polls:
- 2-10 options, 1-168 hour duration (default 24)
- Optional multi-select
- Uses Discord's built-in poll UI (not reaction-based)

### Reminder System

Reminders use precise `setTimeout` timers — each reminder gets its own timer that fires exactly when due. No polling, zero wasted compute.

Architecture:
- `ReminderScheduler` class in `lib/reminders.ts` manages all timers
- On startup: loads pending reminders from DB, sets a timer for each
- On create/snooze: immediately schedules a new timer
- On cancel/ack: clears the timer
- Nag mode: after firing, schedules a repeating nag timer

Features:
- **Recurring:** `cron` param supports "hourly", "daily", "weekly", "monthly", "every Xm/h/d"
- **Nag mode:** `nag_interval` (minutes) re-pings until user acknowledges via `ack_reminder`
- **Snooze:** `snooze_reminder` reschedules a fired reminder (non-recurring only; recurring auto-acks)
- **Categories:** optional label for grouping (e.g. "work", "personal")
- **History:** `list_reminders` with `include_history=true` shows fired reminders
- **Buttons:** reminder notifications include interactive buttons (Done, Snooze 30m/1h/Tomorrow) — no Claude roundtrip needed, handled directly by `lib/interactions.ts`

**Datetime format:** All dates stored in SQLite use space-separated format (`YYYY-MM-DD HH:MM:SS`), never ISO 8601 with `T`/`Z`. Use `lib/time.ts` utilities (`toSQLiteDatetime`, `dateToSQLite`, `nowUTC`) for all conversions.

DB schema (auto-migrated):
```sql
reminders: id, user_id, chat_id, message, due_at, fired, created_at,
           cron, nag_interval, category, ack, last_nag_at
```

## Key Details

- Owner auto-detected from Discord app info: during `./install.sh` (primary) or startup fallback if missed
- Permission relay: owner receives tool approval requests via DM, replies `yes/no <code>` to approve/deny
- State lives in `~/.claude/plugins/data/choomfie-inline/` (token, access list, database, inbox)
- Personality loaded from core memory (key: "personality") at startup
- Memory auto-compactor: core memories capped at 20. When exceeded, oldest are auto-archived to archival memory with `[auto-archived]` prefix and `auto-archived,core-memory` tags
- Console output goes to stderr (stdout is MCP stdio transport)
- DMs require Partials.Channel + Partials.Message in discord.js
- All attachments downloaded to `~/.claude/plugins/data/choomfie-inline/inbox/` (file_path = first, file_paths = all semicolon-separated)
- GitHub integration shells out to `gh` CLI
- Servers: only responds when @mentioned or replied to (not every message)
- DMs: always responds
- Rate limit: configurable via config.json (default 5s)
- Conversation timeout: configurable via config.json `convoTimeoutMs` (default 5 min)
- Typing indicator: state machine in `lib/typing.ts` (IDLE ↔ TYPING). Shows typing while Claude thinks, stops on reply. Use `keep_typing: true` on the reply tool to keep typing active between multi-message workflows. Safety timeout: 2 min. Skipped for conversation_mode.
- Allowlist: loaded at startup from access.json. Use `allow_user`/`remove_user` tools to modify in-memory + persist to file (no restart needed). Manual file edits require restart.
- @mentions stripped from message before forwarding to Claude
- Personas stored in config.json, switchable from Discord
- search_messages paginates up to 1000 messages for user/keyword filtering

## Config (config.json)

Runtime-configurable settings — changes take effect immediately, no restart needed:

```json
{
  "activePersona": "takagi",
  "rateLimitMs": 5000,
  "convoTimeoutMs": 300000,
  "autoSummarize": true,
  "plugins": [],
  "personas": { ... },
  "voice": { "stt": "groq", "tts": "elevenlabs" }
}
```

Settings can be changed via tools (e.g. `setRateLimitMs`, `setConvoTimeoutMs`) or by editing the file directly.
