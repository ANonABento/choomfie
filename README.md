# Choomfie

Your personal AI assistant on Discord, powered by Claude Code.

Choomfie is a [Claude Code Channels](https://code.claude.com/docs/en/channels) plugin that gives you a Discord bot with persistent memory, reminders, GitHub integration, and the full power of Claude Code — using your Max plan, no API key needed.

## Why Choomfie?

- **No API key** — runs on your Claude Max subscription via the official Channels system
- **TOS compliant** — built on Anthropic's official plugin architecture, not a proxy hack
- **Remembers you** — persistent memory survives across sessions (Letta/MemGPT-inspired)
- **Full Claude Code power** — file editing, code execution, MCP servers, all from Discord

## Features

**Communication**
- Discord channels, DMs, and threads
- Image support (send/receive)
- Pin/unpin messages
- Permission relay (approve tool use from Discord DMs)

**Memory**
- Two-tier memory: core (always in context) + archival (searchable)
- Conversation summaries auto-archived
- Configurable personality ("be more sarcastic", "talk like a pirate")

**Productivity**
- Reminders with natural language ("remind me in 30 minutes...")
- GitHub integration (PRs, issues, notifications)
- Full status/config dashboard from Discord

**Security**
- Mention/reply trigger — only responds when `@mentioned` or replied to in servers
- DMs always respond (private conversation)
- Rate limiting (5 second cooldown per user)
- Pairing codes + allowlist for access control
- Permission relay for tool approvals

## Quick Start

### Prerequisites

- [Claude Code CLI](https://code.claude.com) with a Max plan
- [Bun](https://bun.sh) (`brew install oven-sh/bun/bun`)
- A Discord bot token ([setup guide](docs/discord-setup.md))

### Install

```bash
git clone https://github.com/ANonABento/choomfie.git
cd choomfie
bun install
```

### Configure

```bash
# Save your Discord bot token
mkdir -p ~/.claude/channels/choomfie
echo "DISCORD_TOKEN=your_token_here" > ~/.claude/channels/choomfie/.env
```

### Register MCP Server

Add to your `~/.claude.json` under `mcpServers`:

```json
{
  "choomfie": {
    "type": "stdio",
    "command": "bun",
    "args": ["run", "--cwd", "/path/to/choomfie", "server.ts"]
  }
}
```

### Run

```bash
claude --dangerously-load-development-channels server:choomfie
```

For always-on, use tmux:

```bash
tmux new -s choomfie
claude --dangerously-load-development-channels server:choomfie
# Ctrl+B, D to detach
```

### Pair Your Discord Account

1. DM the bot `!pair` on Discord
2. Copy the 5-letter code
3. Run `/choomfie:access pair <code>` in Claude Code
4. Run `/choomfie:access policy allowlist` to lock down

## Usage

### On Discord

In servers, `@mention` the bot or reply to its messages:

```
@Mahiro what files are in my project?
@Mahiro remember my name is Ben
@Mahiro remind me in 2 hours to check the deploy
@Mahiro what PRs need review?
```

In DMs, just talk naturally — no mention needed:

```
what's your status?
be more sarcastic
what do you know about me?
```

### In Claude Code Terminal

| Skill | Description |
|-------|-------------|
| `/choomfie:configure <token>` | Set Discord bot token |
| `/choomfie:access` | Manage access (pair, list, add, remove, policy) |
| `/choomfie:memory` | View/manage memories |
| `/choomfie:status` | Full config overview |

## Tools (20)

| Category | Tools |
|----------|-------|
| **Discord** | reply, react, edit_message, fetch_messages, create_thread, pin_message, unpin_message |
| **Memory** | save_memory, search_memory, list_memories, delete_memory, save_conversation_summary, memory_stats |
| **Reminders** | set_reminder, list_reminders, cancel_reminder |
| **GitHub** | check_github |
| **Status** | choomfie_status |

## Architecture

```
Discord ──> discord.js ──> MCP channel server (server.ts)
                                  |
                          +-------+-------+
                          |       |       |
                       Channel  Memory  Permission
                       events   tools   relay
                          |       |       |
                          +-------+-------+
                                  |
                             Claude Code
                            (your session)
```

Choomfie runs as an MCP subprocess inside Claude Code. Discord messages arrive as channel notifications, Claude processes them, and replies via MCP tools. Memory persists in SQLite at `~/.claude/channels/choomfie/choomfie.db`.

## Project Structure

```
choomfie/
├── server.ts                  # MCP channel server (924 lines)
├── lib/memory.ts              # SQLite memory store (220 lines)
├── .claude-plugin/plugin.json # Plugin metadata
├── .mcp.json                  # MCP server config
├── skills/
│   ├── configure/SKILL.md     # /choomfie:configure
│   ├── access/SKILL.md        # /choomfie:access
│   ├── memory/SKILL.md        # /choomfie:memory
│   └── status/SKILL.md        # /choomfie:status
├── docs/
│   ├── architecture.md
│   ├── memory.md
│   ├── skills.md
│   ├── discord-setup.md
│   ├── roadmap.md
│   └── research.md
├── CLAUDE.md                  # Claude Code project instructions
└── package.json
```

## Docs

- [Architecture](docs/architecture.md) — system design and data flow
- [Memory System](docs/memory.md) — two-tier persistent memory
- [Skills](docs/skills.md) — plugin skills reference
- [Discord Setup](docs/discord-setup.md) — creating a Discord bot
- [Roadmap](docs/roadmap.md) — planned features
- [Research](docs/research.md) — prior art and design decisions

## Roadmap

- [x] **v0.3.0** — Discord bridge, memory, reminders, threads, GitHub, images, DMs, personality
- [ ] Voice (Discord voice channels, STT/TTS)
- [ ] More channels (Telegram, Slack)
- [ ] Autonomous agent (background tasks, cron, proactive messages)
- [ ] Vector search for semantic memory recall

See [full roadmap](docs/roadmap.md).

## License

MIT
