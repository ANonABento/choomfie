---
name: status
description: Show Choomfie's current configuration, memory stats, features, and what you can change.
user-invocable: true
allowed-tools:
  - Read
  - Bash(sqlite3 *)
  - Bash(cat *)
  - Bash(ls *)
  - Bash(wc *)
---

Show the user a complete overview of Choomfie's current state and configuration.

Read and display the following information:

## 1. Connection Status
- Read `~/.claude/plugins/data/choomfie-inline/.env` — is a Discord token configured?
- Read `~/.claude/plugins/data/choomfie-inline/access.json` — who's on the allowlist? What's the policy?

## 2. Memory Stats
Run: `sqlite3 ~/.claude/plugins/data/choomfie-inline/choomfie.db "SELECT COUNT(*) FROM core_memory; SELECT COUNT(*) FROM archival_memory; SELECT COUNT(*) FROM reminders WHERE fired = 0;"`

Show counts for core memories, archival memories, and active reminders.

## 3. Core Memories
Run: `sqlite3 ~/.claude/plugins/data/choomfie-inline/choomfie.db "SELECT key, value FROM core_memory ORDER BY updated_at DESC;"`

List all core memories.

## 4. Active Reminders
Run: `sqlite3 ~/.claude/plugins/data/choomfie-inline/choomfie.db "SELECT id, message, due_at FROM reminders WHERE fired = 0 ORDER BY due_at ASC;"`

## 5. Personality
Read the `instructions` array in `~/choomfie/lib/mcp-server.ts` and show the current personality line (first line of instructions).

## 6. Available Features & How to Configure

Display this table:

| Feature | Status | How to Change |
|---------|--------|---------------|
| **Personality** | (show first line of instructions) | Edit `instructions` array in `~/choomfie/lib/mcp-server.ts` |
| **Discord token** | (configured/not configured) | `/choomfie:configure <token>` |
| **Access policy** | (show policy) | `/choomfie:access policy allowlist\|open` |
| **Allowlisted users** | (count) | `/choomfie:access add <id>` or `/choomfie:access remove <id>` |
| **Core memories** | (count) | Discord: "remember X" / Terminal: `/choomfie:memory set key=value` |
| **Archival memories** | (count) | Auto-saved from conversations |
| **Reminders** | (active count) | Discord: "remind me to X in Y minutes" |
| **Conversation summaries** | Auto | Claude saves after meaningful conversations |
| **Thread creation** | Available | Claude can create threads for long conversations |
| **Permission relay** | Enabled | Approve/deny tool use from Discord DMs |

## 7. Skills Available
List all skills in `~/choomfie/skills/` by reading the directory:
- `/choomfie:configure` — Set Discord bot token
- `/choomfie:access` — Manage allowlist
- `/choomfie:memory` — View/manage memories
- `/choomfie:status` — This overview

## 8. Quick Tips
- To change personality: ask Claude to "edit the personality in choomfie's server.ts"
- To add a memory: tell Choomfie on Discord "remember that I like TypeScript"
- To set a reminder: tell Choomfie "remind me in 30 minutes to check the deploy"
- To see memories: tell Choomfie "what do you know about me?"
- To start a thread: Choomfie will auto-create threads for long conversations
- To run always-on: `choomfie --tmux` or `tmux new -s choomfie` then `choomfie`

Format everything nicely with markdown headers and tables.
