# Roadmap

## Phase 1: Foundation (Done)

- [x] MCP channel server (server.ts)
- [x] Discord bridge via discord.js
- [x] Persistent memory (SQLite — core + archival)
- [x] Memory MCP tools (save, search, list, delete)
- [x] Permission relay (approve/deny from Discord DMs)
- [x] Access control (pairing codes + allowlist)
- [x] Plugin skills (/ryuji:configure, /ryuji:access, /ryuji:memory)
- [x] Plugin packaging (.claude-plugin, .mcp.json)
- [x] Documentation
- [x] Install dependencies and test locally
- [x] Test with real Discord bot + Claude Code Channels

## Phase 2: Smart Memory (Done)

- [x] Conversation summarization → auto-archive to archival memory
- [x] Memory stats tool (count, size, oldest/newest)
- [ ] Cross-session recall — auto-search archival when context seems relevant
- [ ] Vector embeddings for semantic archival search
- [ ] Memory decay — auto-archive stale core memories

## Phase 3: More Tools (Partial)

- [x] `set_reminder` — schedule a message for later (with background checker)
- [x] `list_reminders` / `cancel_reminder` — manage reminders
- [x] `create_thread` — create Discord threads for long conversations
- [x] `/ryuji:status` — config overview skill
- [ ] `browse_url` — fetch and summarize web pages
- [ ] `pin_message` — pin important messages
- [ ] `search_discord` — search channel history

## Phase 4: Personality & Character

- [ ] Configurable personality via core memory
- [ ] Mood/tone adaptation based on conversation
- [ ] Custom system prompt templates
- [ ] Avatar/presence management

## Phase 5: More Channels

- [ ] Telegram channel (separate plugin or unified server)
- [ ] Slack channel
- [ ] Webhook channel (generic HTTP inbound)
- [ ] Web UI channel

## Phase 6: Autonomy

- [ ] Background tasks — agent works while you're away
- [ ] Cron scheduling via Claude Code's `/schedule` feature
- [ ] Proactive messages — agent notices patterns and reaches out
- [ ] Learning loop — agent creates memories from repeated patterns

## Non-Goals (For Now)

- **Voice** — adds complexity, Discord voice API is different
- **Multi-user isolation** — Ryuji is a personal assistant
- **Custom model training** — use Claude as-is
- **Standalone mode** — Channels plugin is the path, not a separate bot
