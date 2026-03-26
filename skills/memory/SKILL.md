---
name: memory
description: View and manage Choomfie's persistent memories.
user-invocable: true
argument-hint: [list | search QUERY | set KEY=VALUE | delete KEY | export | clear]
allowed-tools:
  - Read
  - Bash(ls *)
---

View and manage Choomfie's persistent memory stored in `<data_dir>/choomfie.db` (data dir = `CLAUDE_PLUGIN_DATA` env var, or `~/.claude/plugins/data/choomfie-inline/`).

Handle $ARGUMENTS:

**`list`** (default if no args) — Show all core memories.

**`search <QUERY>`** — Search archival memories.

**`set <KEY>=<VALUE>`** — Set a core memory.

**`delete <KEY>`** — Delete a core memory.

**`export`** — Export all memories as JSON.

**`clear`** — Clear all memories (ask for confirmation first!).

The database is SQLite with two tables:
- `core_memory` (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)
- `archival_memory` (id INTEGER PRIMARY KEY, content TEXT, tags TEXT, created_at TEXT)

Use the Bash tool with `sqlite3` to query the database directly.
