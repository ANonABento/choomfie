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
- [x] Configurable personality via core memory (key: "personality")
- [ ] Cross-session recall — auto-search archival when context seems relevant
- [ ] Vector embeddings for semantic archival search
- [ ] Memory decay — auto-archive stale core memories

## Phase 3: Tools & Integration (Done)

- [x] `set_reminder` / `list_reminders` / `cancel_reminder` — scheduled messages
- [x] `create_thread` — Discord threads for long conversations
- [x] `pin_message` / `unpin_message` — pin important messages
- [x] `check_github` — PRs, issues, notifications via gh CLI
- [x] Image support — download and read inbound attachments
- [x] DM mode — private conversations, is_dm flag in meta
- [x] `/ryuji:status` — config overview skill
- [ ] `browse_url` — fetch and summarize web pages
- [ ] `search_discord` — search channel history

## Phase 4: Personality & Character

- [x] Configurable personality via core memory
- [ ] Mood/tone adaptation based on conversation
- [ ] Custom system prompt templates
- [ ] Avatar/presence management

## Phase 5: More Channels

- [ ] Telegram channel (separate plugin or unified server)
- [ ] Slack channel
- [ ] Webhook channel (generic HTTP inbound)
- [ ] Web UI channel

## Phase 6: Voice

- [ ] Discord voice channel integration
- [ ] Speech-to-text (STT) for voice input
- [ ] Text-to-speech (TTS) for voice output
- [ ] Wake word detection
- [ ] Voice activity detection (VAD)

## Phase 7: Autonomy

- [ ] Background tasks — agent works while you're away
- [ ] Cron scheduling via Claude Code's `/schedule` feature
- [ ] Proactive messages — agent notices patterns and reaches out
- [ ] Learning loop — agent creates memories from repeated patterns

## Non-Goals (For Now)

- **Multi-user isolation** — Ryuji is a personal assistant
- **Custom model training** — use Claude as-is
- **Standalone mode** — Channels plugin is the path, not a separate bot
