# Choomfie — Claude Code Instructions

## Project Overview

Choomfie is a Claude Code Channels plugin (v0.4.0) — an MCP server that bridges Discord to Claude Code with persistent memory, switchable personas, reminders, GitHub integration, and more. It runs as a subprocess inside Claude Code.

## Tech Stack

- **Runtime:** Bun
- **Language:** TypeScript
- **Protocol:** MCP (Model Context Protocol) over stdio
- **Database:** SQLite via bun:sqlite
- **Discord:** discord.js v14
- **Framework:** @modelcontextprotocol/sdk

## Project Structure

```
server.ts                      # Entry point — wiring only (~40 lines)
lib/
  types.ts                     # AppContext, ToolDef, text/err helpers
  context.ts                   # Env/config loading, creates AppContext
  mcp-server.ts                # MCP Server creation, instructions, tool registration
  discord.ts                   # Discord client, Ready handler, MessageCreate
  conversation.ts              # Channel activation, rate limiting, uptime
  permissions.ts               # Permission relay (tool approval via DM)
  reminders.ts                 # Reminder checker interval
  memory.ts                    # SQLite memory store (core + archival + reminders)
  config.ts                    # Config manager (personas, rate limits, settings)
  tools/
    index.ts                   # Tool registry — aggregates all tool modules
    discord-tools.ts           # reply, react, edit, fetch, search, thread, pin/unpin
    memory-tools.ts            # save/search/list/delete memory, summary, stats
    persona-tools.ts           # switch/save/list/delete persona
    reminder-tools.ts          # set/list/cancel reminder
    github-tools.ts            # check_github
    status-tools.ts            # choomfie_status
  plugins.ts                   # Plugin loader (discovers + loads from plugins/)
plugins/                       # Plugin directory (each plugin = subdirectory)
.claude-plugin/plugin.json     # Plugin metadata
.mcp.json                      # How Claude Code spawns the server
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

1. Claude Code spawns `bun server.ts` as an MCP subprocess
2. server.ts connects to Discord via discord.js
3. Incoming messages → `notifications/claude/channel` → Claude Code
4. Claude calls MCP tools (reply, save_memory, etc.) → server.ts → Discord/SQLite
5. Reminders checked every 30 seconds via background timer

## Tools (20)

Discord: reply, react, edit_message, fetch_messages, search_messages, create_thread, pin_message, unpin_message
Memory: save_memory, search_memory, list_memories, delete_memory, save_conversation_summary, memory_stats
Personas: switch_persona, save_persona, list_personas, delete_persona
Reminders: set_reminder, list_reminders, cancel_reminder
GitHub: check_github
Status: choomfie_status

## Key Details

- Owner auto-detected from Discord app info: during `./install.sh` (primary) or startup fallback if missed
- Permission relay: owner receives tool approval requests via DM, replies `yes/no <code>` to approve/deny
- State lives in `~/.claude/channels/choomfie/` (token, access list, database, inbox)
- Personality loaded from core memory (key: "personality") at startup
- Console output goes to stderr (stdout is MCP stdio transport)
- DMs require Partials.Channel + Partials.Message in discord.js
- Images downloaded to `~/.claude/channels/choomfie/inbox/`
- GitHub integration shells out to `gh` CLI
- Servers: only responds when @mentioned or replied to (not every message)
- DMs: always responds
- Rate limit: configurable via config.json (default 5s)
- @mentions stripped from message before forwarding to Claude
- Personas stored in config.json, switchable from Discord
- search_messages paginates up to 1000 messages for user/keyword filtering
