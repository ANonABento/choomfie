# Skills

Skills are slash commands you run in the Claude Code terminal.

## Built-in Skills

### `/choomfie:configure <token>`

Set your Discord bot token. Saves to the plugin data directory (`.env` file).

### `/choomfie:access <command>`

Manage who can message Choomfie on Discord.

```
/choomfie:access pair <code>          # Approve a pairing code
/choomfie:access list                 # Show allowed users
/choomfie:access add <user_id>       # Add user by Discord ID
/choomfie:access remove <user_id>    # Remove user
/choomfie:access policy allowlist    # Only allow paired users
/choomfie:access policy open         # Allow anyone (not recommended)
```

### `/choomfie:memory [command]`

View and manage persistent memories.

```
/choomfie:memory                      # List core memories (default)
/choomfie:memory list                 # Same
/choomfie:memory search <query>       # Search archival memory
/choomfie:memory set <key>=<value>    # Set a core memory
/choomfie:memory delete <key>         # Delete a core memory
/choomfie:memory export               # Export all memories as JSON
/choomfie:memory clear                # Clear all (asks for confirmation)
```

### `/choomfie:status`

Full config overview — memory stats, personality, access policy, all features, how to change everything. This reads the actual database and config files.

## Creating Custom Skills

Add a folder under `skills/` with a `SKILL.md`:

```
skills/
└── my-skill/
    └── SKILL.md
```

```markdown
---
name: my-skill
description: Does something cool.
user-invocable: true
argument-hint: <arg>
allowed-tools:
  - Read
  - Bash(echo *)
---

Instructions for Claude. $ARGUMENTS contains user input.
```

## Skills vs MCP Tools

- **Skills** = terminal slash commands (run by user in Claude Code)
- **MCP Tools** = functions Claude calls during conversations (reply, save_memory, etc.)

Most things are available as both — ask on Discord or use the skill in terminal.
