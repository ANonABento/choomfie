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
server.ts                      # MCP channel server — all tools, Discord client, handlers
lib/memory.ts                  # SQLite memory store (core + archival + reminders)
lib/config.ts                  # Config manager (personas, rate limits, settings)
.claude-plugin/plugin.json     # Plugin metadata
.mcp.json                      # How Claude Code spawns the server
skills/
├── configure/SKILL.md         # /choomfie:configure — set Discord token
├── access/SKILL.md            # /choomfie:access — manage allowlist
├── memory/SKILL.md            # /choomfie:memory — view/manage memories
└── status/SKILL.md            # /choomfie:status — config overview
```

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

- Owner auto-detected from Discord app info: first during `/choomfie:configure` setup, with startup fallback if missed
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
