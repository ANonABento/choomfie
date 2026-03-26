# Roadmap

## Phase 1: Foundation (Done)

- [x] MCP plugin server (server.ts)
- [x] Discord bridge via discord.js
- [x] Persistent memory (SQLite — core + archival)
- [x] Memory MCP tools (save, search, list, delete)
- [x] Permission relay (approve/deny from Discord DMs)
- [x] Access control (pairing codes + allowlist)
- [x] Plugin skills (/choomfie:configure, /choomfie:access, /choomfie:memory)
- [x] Plugin packaging (.claude-plugin, .mcp.json)
- [x] Documentation
- [x] Install dependencies and test locally
- [x] Test with real Discord bot + Claude Code plugin system

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
- [x] `/choomfie:status` — config overview skill
- [ ] `browse_url` — fetch and summarize web pages
- [x] `search_messages` — search by user, keyword, with pagination
- [x] Mention/reply trigger — only responds when @mentioned or replied to
- [x] Conversation mode — channel-wide engagement with 2 min idle timeout after @mention
- [x] Rate limiting — configurable per-user cooldown
- [x] @mention stripping from forwarded messages
- [x] Installer script (`install.sh`) + `choomfie` launcher command

## Phase 4: Personality & Character (Done)

- [x] Switchable personas with presets (config.json)
- [x] Create/save/delete/switch personas from Discord
- [x] Config manager (lib/config.ts)
- [ ] Mood/tone adaptation based on conversation
- [ ] Avatar/presence management

## Phase 5: MCP Integrations

> See [mcp-integrations.md](mcp-integrations.md) for full research

- [ ] Image generation — generate images from text prompts, send as Discord attachments
  - [ ] MCPollinations (zero config, free) — quick win
  - [ ] Together AI Flux (free tier, higher quality) — recommended
  - [ ] OpenAI GPT Image (premium quality, paid)
- [ ] YouTube — search, transcripts, audio extraction
  - [ ] yt-dlp MCP (search + transcripts + audio download, no API key)
  - [ ] YouTube Data API server (richer metadata, free API key)
- [ ] Google Workspace — calendar, gmail, drive, docs via gogcli
  - [ ] Install gogcli (`brew install gogcli`)
  - [ ] OAuth setup + multi-account
  - [ ] CLAUDE.md skill reference for command syntax
- [ ] Weather — current conditions + forecasts
  - [ ] Open-Meteo MCP (free, no API key) — quick win
- [ ] Notion — page/database management
  - [ ] Official Notion MCP server or remote MCP

## Phase 6: More Channels

- [ ] Telegram channel (separate plugin or unified server)
- [ ] Slack channel
- [ ] Webhook channel (generic HTTP inbound)
- [ ] Web UI channel

## Phase 7: Voice

> See [voice-implementation.md](voice-implementation.md) for full implementation guide
> See [mcp-integrations.md](mcp-integrations.md) § Voice for MCP server options

- [ ] Discord voice channel integration (`@discordjs/voice` + `@discordjs/opus` + `ffmpeg`)
- [ ] Text-to-speech (TTS) for voice output
  - [ ] OpenAI TTS MCP (recommended — $15/1M chars)
  - [ ] Kokoro local TTS (free, 54 voices)
  - [ ] ElevenLabs MCP (premium — voice cloning)
- [ ] Discord voice messages (OGG/Opus, flags: 8192)
- [ ] Speech-to-text (STT) for voice input
  - [ ] local-stt-mcp (whisper.cpp, free, Apple Silicon optimized)
  - [ ] OpenAI Whisper API ($0.006/min)
- [ ] Wake word detection
- [ ] Voice activity detection (VAD)

## Phase 8: Autonomy

- [ ] Background tasks — agent works while you're away
- [ ] Cron scheduling via Claude Code's `/schedule` feature
- [ ] Proactive messages — agent notices patterns and reaches out
- [ ] Learning loop — agent creates memories from repeated patterns

## Phase 9: Language Learning (Japanese Tutor)

> See [language-learning.md](language-learning.md) for full feature plan

- [ ] Text tutor — AI conversation with structured corrections (grammar, particles, formality)
- [ ] Dictionary lookup — Jisho API integration (`/jisho <word>`)
- [ ] JLPT level setting — adjusts all content difficulty
- [ ] Kana/kanji quizzes — daily drills with Discord buttons
- [ ] Immersion mode — bot only responds in Japanese
- [ ] SRS vocabulary — SM-2 algorithm, pre-built JLPT N5-N1 decks, daily review DMs
- [ ] Progress tracking — streaks, accuracy, JLPT readiness stats
- [ ] Voice conversation — speak Japanese in VC, bot transcribes + responds via VOICEVOX
- [ ] Pronunciation scoring — Azure Pronunciation Assessment or DIY
- [ ] Listening comprehension — bot speaks, user transcribes
- [ ] Shadowing practice — repeat after bot, compare
- [ ] Pitch accent drills — F0 contour analysis (stretch goal)
- [ ] WaniKani sync — import existing SRS progress

## Phase 10: Simulation (Dead Internet Theory)

- [ ] choomfie-sim — individual persona bots that simulate real people
  - [ ] Each clone is a separate Discord bot with its own Choomfie instance
  - [ ] Persona prompts scraped/reverse-engineered from real chat history
  - [ ] Per-clone memory context (key facts, relationships, opinions from their real messages)
  - [ ] Bot-to-bot interaction — clones react to each other's messages, not just the user
  - [ ] Conversation triggering — clones initiate topics based on time of day, shared interests
- [ ] Message scraping pipeline — automated extraction of speech patterns from Discord history
  - [ ] Vocabulary frequency analysis
  - [ ] Typo pattern detection
  - [ ] Response timing/length profiling
  - [ ] Topic/interest extraction
- [ ] Simulation modes
  - [ ] Passive — clones chat among themselves, user observes
  - [ ] Active — user participates alongside clones
  - [ ] Scenario — seed a topic and watch clones react

## Testing & CI (v0.5 / v1.0)

> See [testing.md](testing.md) for full strategy

- [ ] E2E tests — spawn server, verify startup/shutdown/PID lifecycle
- [ ] E2E tests — MCP tool round-trips over stdio
- [ ] E2E tests — Discord message flow (test bot + test server)
- [ ] Unit tests — reminders, memory, conversation, time, config
- [ ] Plugin tests — voice, language-learning, socials
- [ ] CI pipeline — run tests + type-check + lint on PRs
- [ ] Merge gates — block PR on test/lint failure

## Non-Goals (For Now)

- **Multi-user isolation** — Choomfie is a personal assistant
- **Custom model training** — use Claude as-is
- **Standalone mode** — Plugin system is the path, not a separate bot
