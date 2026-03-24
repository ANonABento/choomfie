# Ryuji

Personal AI agent plugin for Claude Code Channels. Discord bridge with persistent memory, skills, and personality.

Uses your Max plan — no API key needed. Fully TOS-compliant.

## What is this?

Ryuji is a **Claude Code Channels plugin** that turns Claude Code into your personal Discord bot with persistent memory. It runs as an MCP server inside Claude Code, bridging Discord messages to your session while adding memory tools that survive across restarts.

Built on top of Anthropic's official [Channels](https://code.claude.com/docs/en/channels) system — no proxies, no hacks.

## Features

- **Discord bridge** — chat with Claude Code from Discord
- **Persistent memory** — Letta-inspired two-tier memory (core + archival) in SQLite
- **Self-editing memory** — Claude proactively saves user preferences and context
- **Conversation summaries** — auto-archive conversation context to archival memory
- **Reminders** — "remind me in 30 minutes to check the deploy"
- **Thread creation** — auto-create Discord threads for long conversations
- **Configurable personality** — "be more sarcastic" changes behavior via memory
- **Image support** — send/receive images on Discord
- **DM mode** — private conversations without any prefix
- **GitHub integration** — check PRs, issues, notifications via `gh` CLI
- **Pin messages** — pin/unpin important messages
- **Permission relay** — approve/deny tool use from Discord DMs
- **Access control** — pairing codes + allowlist for security
- **Plugin skills** — `/ryuji:configure`, `/ryuji:access`, `/ryuji:memory`, `/ryuji:status`

## Prerequisites

- [Claude Code CLI](https://code.claude.com) with Max plan
- [Bun](https://bun.sh) runtime
- A Discord bot token ([setup guide](docs/discord-setup.md))

## Quick Start

```bash
# 1. Install the plugin
/plugin install ryuji   # or for development:
claude --plugin-dir ./ryuji

# 2. Configure your Discord bot token
/ryuji:configure <your-discord-bot-token>

# 3. Start Claude Code with Ryuji channel
claude --channels plugin:ryuji

# 4. Pair your Discord account
#    DM the bot "!pair" on Discord, then:
/ryuji:access pair <code>

# 5. Lock down access
/ryuji:access policy allowlist
```

## Usage

### From Discord

Just message in any channel the bot is in (or DM it — no prefix needed):

```
hey ryuji, what's in my project directory?
remember that I prefer TypeScript
what do you know about me?
remind me in 30 minutes to check the deploy
be more sarcastic (changes personality)
what PRs need review?
pin that
```

Send images too — Ryuji downloads and reads them.

### Skills (in Claude Code terminal)

| Skill | Description |
|-------|-------------|
| `/ryuji:configure <token>` | Set Discord bot token |
| `/ryuji:access pair <code>` | Approve a Discord user pairing |
| `/ryuji:access list` | Show allowed users |
| `/ryuji:access add <user_id>` | Add user to allowlist |
| `/ryuji:access policy allowlist` | Restrict to allowlisted users |
| `/ryuji:memory list` | Show core memories |
| `/ryuji:memory search <query>` | Search archival memory |
| `/ryuji:status` | Show full config overview and stats |

### Memory Tools (used by Claude automatically)

Claude can call these during any session:

| Tool | Description |
|------|-------------|
| `save_memory` | Save facts to core or archival memory |
| `search_memory` | Search archival memory |
| `list_memories` | List all core memories |
| `delete_memory` | Remove a core memory |
| `save_conversation_summary` | Archive a conversation summary |
| `memory_stats` | Memory counts and stats |
| `set_reminder` | Schedule a reminder message |
| `list_reminders` | Show active reminders |
| `cancel_reminder` | Cancel a reminder by ID |
| `create_thread` | Create a Discord thread |
| `pin_message` / `unpin_message` | Pin/unpin Discord messages |
| `check_github` | Check PRs, issues, notifications via `gh` CLI |

### Permission Relay

When Claude needs to run a tool (file edit, bash command, etc.), you'll get a DM:

```
Permission request `abcde`
Bash: Run npm install
`npm install --save discord.js`

Reply "yes abcde" to allow or "no abcde" to deny.
```

## Architecture

```
Discord ──► Discord.js client ──► MCP channel server (server.ts)
                                       │
                              ┌────────┼────────┐
                              │        │        │
                          Channel   Memory   Permission
                          events    tools    relay
                              │        │        │
                              └────────┼────────┘
                                       │
                                  Claude Code
                                  (your session)
```

See [docs/](docs/) for detailed documentation:

- [Architecture](docs/architecture.md) — system design and data flow
- [Memory System](docs/memory.md) — how persistent memory works
- [Skills](docs/skills.md) — plugin skills reference
- [Discord Setup](docs/discord-setup.md) — creating a Discord bot
- [Roadmap](docs/roadmap.md) — planned features
- [Research](docs/research.md) — prior art and design decisions

## Project Structure

```
ryuji/
├── .claude-plugin/
│   └── plugin.json          # Plugin metadata
├── .mcp.json                # MCP server config
├── server.ts                # MCP channel server (Discord + memory + tools)
├── lib/
│   └── memory.ts            # SQLite memory store
├── skills/
│   ├── configure/SKILL.md   # /ryuji:configure
│   ├── access/SKILL.md      # /ryuji:access
│   └── memory/SKILL.md      # /ryuji:memory
└── docs/
```

## License

MIT
