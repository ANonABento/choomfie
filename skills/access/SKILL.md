---
name: access
description: Manage Choomfie Discord access — approve pairings, view/edit the allowlist.
user-invocable: true
argument-hint: <pair CODE | list | add USER_ID | remove USER_ID | policy allowlist|open>
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

Manage who can message Choomfie on Discord.

The access file is at `<data_dir>/access.json` (data dir = `CLAUDE_PLUGIN_DATA` env var, or `~/.claude/plugins/data/choomfie-inline/`). Format:
```json
{
  "policy": "allowlist",
  "owner": "discord_user_id_of_owner",
  "allowed": ["discord_user_id_1", "discord_user_id_2"]
}
```

The `owner` field designates which user has full control (can trigger dangerous tools like Bash, file operations, etc). All other allowlisted users can only chat, use memory, and set reminders — they cannot trigger system tools. The first user to pair automatically becomes the owner if no owner is set.

Handle $ARGUMENTS:

**`pair <CODE>`** — Approve a pending pairing. The user DMs the Discord bot `!pair`, gets a 5-letter code, then runs this command. Look up the code, add the user ID to the allowlist, and save. If no `owner` field exists yet, set this user as owner.

**`list`** — Show all allowed user IDs and indicate which is the owner.

**`add <USER_ID>`** — Add a Discord user ID to the allowlist.

**`remove <USER_ID>`** — Remove a Discord user ID from the allowlist. Cannot remove the owner.

**`owner <USER_ID>`** — Transfer ownership to another allowlisted user.

**`policy allowlist`** — Only allowlisted users can message (recommended).

**`policy open`** — Anyone can message (not recommended, prompt injection risk).

Always create the directory and file if they don't exist. After changes, tell the user to restart Claude Code for changes to take effect.
