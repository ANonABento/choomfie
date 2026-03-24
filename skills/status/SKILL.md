---
name: status
description: Show Ryuji's current configuration, memory stats, features, and what you can change.
user-invocable: true
allowed-tools:
  - Read
  - Bash(sqlite3 *)
  - Bash(cat *)
  - Bash(ls *)
  - Bash(wc *)
---

Show the user a complete overview of Ryuji's current state and configuration.

Read and display the following information:

## 1. Connection Status
- Read `~/.claude/channels/ryuji/.env` — is a Discord token configured?
- Read `~/.claude/channels/ryuji/access.json` — who's on the allowlist? What's the policy?

## 2. Memory Stats
Run: `sqlite3 ~/.claude/channels/ryuji/ryuji.db "SELECT COUNT(*) FROM core_memory; SELECT COUNT(*) FROM archival_memory; SELECT COUNT(*) FROM reminders WHERE fired = 0;"`

Show counts for core memories, archival memories, and active reminders.

## 3. Core Memories
Run: `sqlite3 ~/.claude/channels/ryuji/ryuji.db "SELECT key, value FROM core_memory ORDER BY updated_at DESC;"`

List all core memories.

## 4. Active Reminders
Run: `sqlite3 ~/.claude/channels/ryuji/ryuji.db "SELECT id, message, due_at FROM reminders WHERE fired = 0 ORDER BY due_at ASC;"`

## 5. Personality
Read the `instructions` array in `~/ryuji/server.ts` and show the current personality line (first line of instructions).

## 6. Available Features & How to Configure

Display this table:

| Feature | Status | How to Change |
|---------|--------|---------------|
| **Personality** | (show first line of instructions) | Edit `instructions` array in `~/ryuji/server.ts` |
| **Discord token** | (configured/not configured) | `/ryuji:configure <token>` |
| **Access policy** | (show policy) | `/ryuji:access policy allowlist\|open` |
| **Allowlisted users** | (count) | `/ryuji:access add <id>` or `/ryuji:access remove <id>` |
| **Core memories** | (count) | Discord: "remember X" / Terminal: `/ryuji:memory set key=value` |
| **Archival memories** | (count) | Auto-saved from conversations |
| **Reminders** | (active count) | Discord: "remind me to X in Y minutes" |
| **Conversation summaries** | Auto | Claude saves after meaningful conversations |
| **Thread creation** | Available | Claude can create threads for long conversations |
| **Permission relay** | Enabled | Approve/deny tool use from Discord DMs |

## 7. Skills Available
List all skills in `~/ryuji/skills/` by reading the directory:
- `/ryuji:configure` — Set Discord bot token
- `/ryuji:access` — Manage allowlist
- `/ryuji:memory` — View/manage memories
- `/ryuji:status` — This overview

## 8. Quick Tips
- To change personality: ask Claude to "edit the personality in ryuji's server.ts"
- To add a memory: tell Ryuji on Discord "remember that I like TypeScript"
- To set a reminder: tell Ryuji "remind me in 30 minutes to check the deploy"
- To see memories: tell Ryuji "what do you know about me?"
- To start a thread: Ryuji will auto-create threads for long conversations
- To run always-on: `tmux new -s ryuji` then start Claude Code with channels

Format everything nicely with markdown headers and tables.
