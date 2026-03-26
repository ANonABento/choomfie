# Choomfie

Your personal AI assistant on Discord, powered by Claude Code.

Choomfie is a Claude Code plugin that gives you a Discord bot with persistent memory, reminders, GitHub integration, and the full power of Claude Code — using your Max plan, no API key needed.

## Why Choomfie?

- **No API key** — runs on your Claude Max subscription via the official plugin system
- **TOS compliant** — built on Anthropic's official plugin architecture, not a proxy hack
- **Remembers you** — persistent memory survives across sessions (Letta/MemGPT-inspired)
- **Full Claude Code power** — file editing, code execution, MCP servers, all from Discord

## Features

**Communication**
- Discord channels, DMs, and threads
- Image support (send/receive)
- Pin/unpin messages
- Permission relay (approve tool use from Discord DMs)

**Memory & Personas**
- Two-tier memory: core (always in context) + archival (searchable)
- Conversation summaries auto-archived
- Switchable personas — create and swap between different personalities
- Message search — find messages by user, keyword, or both

**Productivity**
- Reminders with natural language ("remind me in 30 minutes...")
- GitHub integration (PRs, issues, notifications)
- Full status/config dashboard from Discord
- Config stored in `config.json` — personas, rate limits, settings

**Security**
- Mention/reply trigger — only responds when `@mentioned` or replied to in servers (then stays in conversation for 2 min idle timeout)
- DMs always respond (private conversation)
- Rate limiting (5 second cooldown per user)
- Owner auto-detected from Discord app (zero config)
- Role-based access: owner (full) vs user (chat only)
- Pairing codes + allowlist for multi-user access
- Permission relay — approve tool use from Discord DMs

## Quick Start

### Prerequisites

- [Claude Code CLI](https://code.claude.com) with a Max plan
- [Bun](https://bun.sh) (`brew install oven-sh/bun/bun`)
- A Discord bot token ([setup guide](docs/discord-setup.md))

### Install & Run

```bash
git clone https://github.com/ANonABento/choomfie.git
cd choomfie
./install.sh    # installs deps, prompts for Discord token, adds 'choomfie' command
choomfie        # start!
```

For always-on (survives terminal close):

```bash
choomfie --tmux
```

### Manual Setup

If you prefer to set things up yourself:

```bash
bun install

# Save your Discord bot token
mkdir -p ~/.claude/plugins/data/choomfie-inline
echo "DISCORD_TOKEN=your_token_here" > ~/.claude/plugins/data/choomfie-inline/.env

# Run with --plugin-dir to load Choomfie as a local plugin
claude --plugin-dir /path/to/choomfie --dangerously-load-development-channels server:choomfie
```

> **Note:** The `--plugin-dir` flag loads Choomfie only for that session. The `--dangerously-load-development-channels` flag is required for Discord messages to reach Claude. Do NOT add it to global `~/.claude.json` mcpServers — that would start the Discord bot on every Claude session.

### Access & Pairing

The bot **auto-detects the owner** from your Discord application — whoever created the bot is automatically set as the owner with full access. No manual pairing needed. If auto-detection fails, set manually with `/choomfie:access owner <USER_ID>`.

To add other users:
1. They DM the bot `!pair` on Discord
2. Copy the 5-letter code
3. Run `/choomfie:access pair <code>` in Claude Code
4. Run `/choomfie:access policy allowlist` to lock down

Other users get chat, memory, and reminder access only (no system tools).

## Usage

### On Discord

In servers, `@mention` the bot or reply to its messages:

```
@Choomfie what files are in my project?
@Choomfie remember my name is Ben
@Choomfie remind me in 2 hours to check the deploy
@Choomfie what PRs need review?
```

In DMs, just talk naturally — no mention needed:

```
what's your status?
what do you know about me?
show me @Dave's last 10 messages
list personas
switch to choomfie
create a persona called pirate
```

### In Claude Code Terminal

| Skill | Description |
|-------|-------------|
| `/choomfie:configure <token>` | Set Discord bot token |
| `/choomfie:access` | Manage access (pair, list, add, remove, policy) |
| `/choomfie:memory` | View/manage memories |
| `/choomfie:status` | Full config overview |

## Tools (26)

| Category | Tools |
|----------|-------|
| **Discord** | reply, react, edit_message, fetch_messages, search_messages, create_thread, pin_message, unpin_message |
| **Memory** | save_memory, search_memory, list_memories, delete_memory, save_conversation_summary, memory_stats |
| **Personas** | switch_persona, save_persona, list_personas, delete_persona |
| **Reminders** | set_reminder, list_reminders, cancel_reminder |
| **GitHub** | check_github |
| **Status** | choomfie_status |

## Architecture

```
Discord ──> discord.js ──> MCP plugin server (server.ts)
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

Choomfie runs as an MCP subprocess inside Claude Code via the plugin system. Discord messages arrive as notifications, Claude processes them, and replies via MCP tools. Memory persists in SQLite at `~/.claude/plugins/data/choomfie-inline/choomfie.db`.

## Project Structure

```
choomfie/
├── server.ts                  # MCP plugin server
├── install.sh                 # Interactive installer
├── bin/choomfie               # Launcher script
├── lib/memory.ts              # SQLite memory store
├── lib/config.ts              # Config manager (personas, settings)
├── plugins/
│   ├── language-learning/     # Furigana, kana conversion, SRS tools
│   ├── socials/               # Reddit/YouTube provider-backed tools
│   └── voice/                 # Discord voice, STT/TTS integrations
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

- [x] **v0.4.0** — Discord bridge, memory, personas, reminders, threads, GitHub, images, DMs, message search
- [ ] Voice (Discord voice channels, STT/TTS)
- [ ] More channels (Telegram, Slack)
- [ ] Autonomous agent (background tasks, cron, proactive messages)
- [ ] Vector search for semantic memory recall

See [full roadmap](docs/roadmap.md).

## License

MIT
