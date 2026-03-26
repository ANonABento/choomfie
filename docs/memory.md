# Memory System

Choomfie uses a two-tier memory system inspired by [Letta (MemGPT)](https://github.com/letta-ai/letta). Memory persists in SQLite across Claude Code sessions.

## Tiers

### Core Memory

Key-value pairs **injected into Claude's system prompt** every session. This is what Claude always knows about you.

Examples:
- `name: Ben`
- `role: software engineer`
- `preferences: concise answers, casual tone`

**Limit:** Keep under ~20 entries to avoid bloating the system prompt.

### Archival Memory

Timestamped entries with tags. **Searchable on demand** via the `search_memory` tool. Long-term storage for facts and context.

Examples:
- "User debugged a Next.js hydration issue on 2026-03-20" `[coding, nextjs]`
- "User prefers TypeScript over JavaScript" `[preferences]`

## How It Works

Core memories are loaded into the MCP server's `instructions` string at startup:

```
You are Choomfie, a personal AI assistant with persistent memory.
...
## Current Memories
- name: Ben
- role: software engineer
- preferences: concise, casual
```

Claude sees these memories from the very first message in every session.

## MCP Tools

Claude can call these tools during any session:

| Tool | Description |
|------|-------------|
| `save_memory` | Save to core (always in context) or archival (searchable) |
| `search_memory` | Search archival memory by keyword |
| `list_memories` | List all core memories |
| `delete_memory` | Remove a core memory by key |

Claude is instructed to proactively save useful information — it will remember things you tell it without being asked.

## Slash Command

```bash
/choomfie:memory list              # Show core memories
/choomfie:memory search ramen      # Search archival
/choomfie:memory set name=Ben      # Set core memory
/choomfie:memory delete name       # Delete core memory
```

## Storage

Database: `~/.claude/plugins/data/choomfie-inline/choomfie.db` (SQLite)

Tables:
- `core_memory` — key TEXT PRIMARY KEY, value TEXT, updated_at TEXT
- `archival_memory` — id INTEGER, content TEXT, tags TEXT, created_at TEXT

## Planned Improvements

- **Vector embeddings** for semantic archival search
- **Conversation summarization** → auto-archive into archival memory
- **Memory decay** — auto-archive stale core memories
- **Cross-session recall** — auto-search archival when context seems relevant
