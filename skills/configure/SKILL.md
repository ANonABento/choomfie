---
name: configure
description: Configure Choomfie with your Discord bot token.
user-invocable: true
argument-hint: <discord-bot-token>
allowed-tools:
  - Write
  - Bash(mkdir *)
---

Save the user's Discord bot token so Choomfie can connect to Discord.

The token should be saved to the plugin data directory `.env` file in the format:
```
DISCORD_TOKEN=<token>
```

Steps:
1. Take the token from $ARGUMENTS
2. Determine the data directory: use `CLAUDE_PLUGIN_DATA` env var if set, otherwise `~/.claude/plugins/data/choomfie-inline/`
3. Create the directory if it doesn't exist
4. Write the token to `<data_dir>/.env`
5. Tell the user:
   - Token saved
   - Owner will be auto-detected on next startup (from Discord app info)
   - Restart Choomfie with `choomfie` for changes to take effect
