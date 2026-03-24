---
name: configure
description: Configure Choomfie with your Discord bot token and auto-detect owner.
user-invocable: true
argument-hint: <discord-bot-token>
allowed-tools:
  - Write
  - Bash(mkdir *)
  - Bash(curl *)
---

Save the user's Discord bot token and auto-detect the bot owner from Discord.

The token should be saved to `~/.claude/channels/choomfie/.env` in the format:
```
DISCORD_TOKEN=<token>
```

Steps:
1. Take the token from $ARGUMENTS
2. Create the directory `~/.claude/channels/choomfie/` if it doesn't exist
3. Write the token to `~/.claude/channels/choomfie/.env`
4. Auto-detect owner: run `curl -s -H "Authorization: Bot <token>" https://discord.com/api/v10/oauth2/applications/@me` and extract the `owner.id` field from the JSON response
5. Write `~/.claude/channels/choomfie/access.json` with:
   ```json
   {
     "policy": "allowlist",
     "owner": "<detected_owner_id>",
     "allowed": ["<detected_owner_id>"]
   }
   ```
6. Tell the user:
   - Token saved
   - Owner auto-detected: `<detected_owner_id>`
   - Restart Claude Code with `claude --channels plugin:choomfie` for changes to take effect
7. If the curl fails or owner can't be detected, still save the token and tell the user they can set the owner manually with `/choomfie:access owner <USER_ID>`
