# Discord Setup

How to create a Discord bot and connect it to Choomfie.

## 1. Create a Discord Application

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application**
3. Name it "Choomfie" (or whatever you want)
4. Go to **Bot** tab in the sidebar

## 2. Configure the Bot

1. Click **Reset Token** to generate a bot token
2. Copy the token — you'll need it next
3. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent** (required)

## 3. Generate an Invite Link

1. Go to **OAuth2 > URL Generator** in the sidebar
2. Select scopes: `bot`
3. Select permissions:
   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Read Message History
   - Attach Files
   - Add Reactions
4. Copy the generated URL and open it in your browser
5. Select your server and authorize

## 4. Configure Choomfie

In Claude Code:
```bash
/choomfie:configure <your_bot_token>
```

This saves the token to `~/.claude/channels/choomfie/.env`.

## 5. Start with Choomfie Channel

```bash
claude --channels plugin:choomfie
```

You should see in stderr:
```
Choomfie Discord: logged in as Choomfie#1234
```

## 6. Pair Your Discord Account

1. DM the bot `!pair` on Discord
2. You'll get a 5-letter pairing code
3. In Claude Code: `/choomfie:access pair <code>`
4. Lock down: `/choomfie:access policy allowlist`

## 7. Test

In your Discord server (`@mention` required in servers):
```
@Mahiro hey, what's up?
@Mahiro remember my name is Ben
@Mahiro what do you know about me?
```

In DMs (no mention needed):
```
hey, what's up?
what's your status?
```

## Always-On Setup (tmux)

Since Channels requires Claude Code to be running:

```bash
# Start a tmux session
tmux new -s choomfie

# Run Claude Code with Choomfie
claude --channels plugin:choomfie

# Detach: Ctrl+B, then D
# Reattach later: tmux attach -t choomfie
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Bot doesn't respond | Check Message Content Intent is enabled |
| "No DISCORD_TOKEN" | Run `/choomfie:configure <token>` |
| Not receiving messages | Check allowlist with `/choomfie:access list` |
| Permission prompts block | Reply to the DM with `yes <code>` or `no <code>` |
| Bot is slow | Normal — Claude Code processes sequentially |
