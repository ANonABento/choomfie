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
- [x] Vector embeddings for semantic archival search — `OllamaEmbeddingProvider` + cosine similarity in `lib/memory.ts`, on by default (`CHOOMFIE_EMBEDDINGS=off` to disable). Dormant unless Ollama is installed; falls back to keyword search
- [ ] Memory decay — auto-archive stale core memories

## Phase 3: Tools & Integration (Done)

- [x] `set_reminder` / `list_reminders` / `cancel_reminder` — scheduled messages
- [x] `create_thread` — Discord threads for long conversations
- [x] `pin_message` / `unpin_message` — pin important messages
- [x] `check_github` — PRs, issues, notifications via gh CLI
- [x] Image support — download and read inbound attachments
- [x] DM mode — private conversations, is_dm flag in meta
- [x] `/choomfie:status` — config overview skill
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

## Phase 4.5: Polish & Command Gaps (Done)

- [x] `/reminders` — embed format (consistency with /status)
- [x] `/memory` — search/list memories from Discord
- [x] `/cancel <id>` — quick cancel reminder from slash command
- [x] `/help` — show all commands + chat capabilities
- [x] Fix 5-hour reminder offset bug (SQLite UTC dates parsed as local time)
- [x] `/remind` — consolidated into modal form (removed /quickremind)
- [x] `/status` — rich embed format
- [x] Time parser — lenient input (no "in" required, seconds support)

## Phase 5: Supervisor Architecture (Done)

- [x] Supervisor/worker split — immortal MCP server + disposable worker
- [x] IPC messaging (tool calls, notifications, restart)
- [x] Hot-reload via worker restart (persona, plugin, voice config changes)
- [x] Crash recovery with exponential backoff (max 5 crashes/60s)
- [x] PID guard (single-instance)
- [x] Restart confirmation feedback to Discord

## Phase 6: Voice Plugin (Done)

- [x] Discord voice channel integration (`@discordjs/voice` + `@discordjs/opus`)
- [x] Kokoro TTS — local neural TTS via Python/ONNX (53 voices, 8 languages)
- [x] Edge TTS — free Microsoft API fallback
- [x] ElevenLabs TTS/STT — paid API option
- [x] whisper-cpp STT — local speech-to-text
- [x] Groq STT — free cloud STT fallback
- [x] Silero VAD — neural voice activity detection with adaptive endpointing
- [x] Streaming TTS — sentence splitting + one-ahead pipelining
- [x] Interruption handling — barge-in detection, generation ID invalidation
- [x] Multi-speaker support — per-speaker VAD pipelines (max 4 concurrent)
- [x] `/voice` setup wizard with auto-detection and interactive buttons
- [x] Provider auto-detection (best available STT/TTS)

## Phase 7: Browser Plugin (Done)

- [x] Playwright integration — headless browsing
- [x] Persistent sessions (named, multi-tab)
- [x] MCP tools: browse, click, type, screenshot, eval, key, close
- [x] Accessibility tree navigation with element refs

## Phase 8: Tutor Plugin (Done)

- [x] Modular teaching harness (TutorModule interface)
- [x] Japanese module — JLPT N5-N1 levels
- [x] Dictionary lookup (Jisho API)
- [x] Romaji ↔ kana conversion (wanakana)
- [x] Auto-furigana for kanji (kuroshiro)
- [x] Quiz generation
- [x] FSRS spaced repetition engine (SQLite)
- [x] 718 JLPT N5 vocabulary cards (auto-import)
- [x] SRS tools: review, rate, stats
- [x] Per-user module/level session tracking
- [x] Structured lessons with exercises (`/lesson`, `/progress`)

## Phase 9: Socials Plugin (Done)

- [x] YouTube — search, info, transcript (via yt-dlp)
- [x] YouTube — OAuth commenting (YouTube Data API v3)
- [x] Reddit — search, posts, comments (JSON scraper + OAuth API)
- [x] Reddit — post, comment (OAuth write)
- [x] LinkedIn — OAuth 2.0 (standard 3-legged, no PKCE)
- [x] LinkedIn — Posts API (`/rest/posts`, version 202603)
- [x] LinkedIn — text, image, multi-image, link/article, poll posts
- [x] LinkedIn — edit, delete, repost
- [x] LinkedIn — comments (read/write), reactions
- [x] LinkedIn — post scheduling with queue + first-comment automation
- [x] LinkedIn — comment monitor (auto-poll every 5 min → Discord)
- [x] LinkedIn — engagement analytics (likes, comments, top posts)
- [x] LinkedIn — 17 MCP tools total

## Phase 10: Google Integration

> See [google-integration-spec.md](google-integration-spec.md) for full spec

### 10a: Birthday Index (Mostly done)
- [x] SQLite birthday table (name, MM-DD, optional year/notes) — `lib/memory.ts`
- [x] MCP tools: birthday_add, birthday_remove, birthday_list, birthday_upcoming
- [x] Daily birthday check → owner DM notification — `BirthdayScheduler` in `lib/birthdays.ts`, started from `lib/discord.ts` on ready
- [ ] `/birthdays` slash command with embed — tools ship, but no slash command is registered
- [ ] Google Sheets mirror (optional, needs 10b)

### 10b: Google Auth (gogcli)
- [ ] Install gogcli + OAuth setup
- [ ] `lib/google/auth.ts` — auth check, account helpers
- [ ] `lib/google/sheets.ts` — read/write via gogcli

### 10c: Memory Backup to Sheets
- [ ] Export core + archival memories to Google Sheet
- [ ] Debounced sync on memory changes (max once per 5 min)
- [ ] memory_sync + memory_backup_status tools

### 10d: Extended Google Services (Future)
- [ ] Calendar — daily briefing, birthday events, availability check
- [ ] Gmail — unread count, important email alerts
- [ ] Drive — nightly DB backup, file sharing
- [ ] Contacts — birthday import
- [ ] Tasks/Keep — todo sync

## Phase 11: Quality of Life

- [ ] Scheduled messages — "send X in channel Y at 3pm"
- [ ] Daily digest — morning summary of reminders, pending PRs, etc.
- [ ] Per-server personas — different personality per server
- [ ] Message bookmarks — react with bookmark to save to memory
- [ ] Todo lists — lightweight task tracking with Discord buttons
- [ ] Custom auto-reactions — react to specific keywords/users
- [ ] Quote database — save and recall funny quotes

## Phase 12: Extended GitHub

- [ ] Create issues from Discord
- [ ] Comment on PRs from Discord
- [ ] Merge PRs from Discord
- [ ] Webhook endpoint — external services push notifications through bot

## Phase 13: More Channels

- [ ] Telegram channel (separate plugin or unified server)
- [ ] Slack channel
- [ ] Webhook channel (generic HTTP inbound)
- [ ] Web UI channel

## Phase 14: Daemon Mode (Done)

> See [architecture-v2.md](architecture-v2.md) for full design

- [x] `daemon.ts` — Agent SDK entry point for autonomous operation
- [x] Session cycling — auto-cycle Claude sessions at ~120K tokens or 80 turns
- [x] Handoff summaries — capture and inject context across session cycles
- [x] Worker health monitoring — PID-based health checks, auto-recovery
- [x] Daemon state file — `/status` integration with PID staleness check
- [x] Discord notification on session cycle
- [x] Bounded error recovery — max 10 retries with exponential backoff
- [x] `choomfie --daemon` launcher flag (composable with `--tmux`, `--always-on`)
- [x] `--test-cycle`, `--benchmark`, `--verbose` flags
- [ ] Full sibling architecture — worker survives session cycles (Phase 4 in architecture-v2)

## Phase 15: Multi-Brain Daemon

> Single daemon process, multiple Claude sessions, intelligent message routing.

### 15a: Brain Pool (~4-6hr)
- [ ] `BrainPoolManager` class — spawn N independent Claude sessions
- [ ] Per-brain lifecycle — independent cycling, health monitoring, crash recovery
- [ ] Per-brain persona and system prompt injection
- [ ] Hot-swap brains — cycle one without affecting others (eliminates 12s gap)

### 15b: Message Router (~3-4hr)
- [ ] Config-driven routing: `server_id → brain`, `DM → brain`, fallback brain
- [ ] Route table in config.json: `{ "brains": [{ "id": "main", "servers": [...], "persona": "choomfie" }] }`
- [ ] Dedicated DM brain (always snappy, never bogged by server noise)

### 15c: Model Ladder (~2-3hr)
- [ ] Complexity classifier in daemon (simple → Haiku, normal → Sonnet, complex → Opus)
- [ ] Per-brain model override in config
- [ ] Reactions/emojis handled by worker directly (no brain needed)
- [ ] Voice → Haiku with streaming (latency-critical)

### 15d: Specialist Brains (~4hr)
- [ ] Background brain — silent, runs scheduled tasks (GitHub checks, LinkedIn posts, reminders, digest)
- [ ] Tutor brain — dedicated to language learning with tutor system prompt
- [ ] Code brain — Opus, full tool access, for complex reasoning
- [ ] Per-brain tool restrictions (background brain can't reply, tutor brain can't browse, etc.)

### 15e: Brain-to-Brain Communication (~3hr)
- [ ] Event bus in daemon — brains publish events, other brains subscribe
- [ ] Cross-brain context sharing (tutor brain: "user learned 50 kanji" → main brain: "congrats!")
- [ ] Shared memory layer — all brains read/write same SQLite DB (already WAL-compatible)

### 15f: Bento-ya Bridge (~8hr)
- [ ] Connect daemon brains to bento-ya task board via MCP
- [ ] Each brain claims a task from the kanban, works on it, reports progress
- [ ] Daemon monitors and load-balances across brains
- [ ] Discord progress reporting from each brain

## Phase 16: Extended Autonomy

- [ ] Cron scheduling via Claude Code's `/schedule` feature
- [ ] Proactive messages — agent notices patterns and reaches out
- [ ] Learning loop — agent creates memories from repeated patterns

## Phase 17: Simulation (Dead Internet Theory)

> Multi-bot simulation. Each sim is its own Discord bot + Choomfie brain.
> Can be implemented as additional bots in the multi-brain daemon pool,
> or as separate processes managed by bento-ya.

- [ ] choomfie-sim — individual persona bots that simulate real people
  - [ ] Each clone is a separate Discord bot (own token, own presence)
  - [ ] Can run as a brain in the multi-brain daemon OR as a standalone daemon
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
- [ ] Bento-ya orchestration — use bento-ya to manage sim bot development in parallel
  - [ ] Each sim bot as a task, agents build them concurrently
  - [ ] Pipeline: scrape → train persona → deploy bot → monitor

## Smart Memory (Ongoing)

- [ ] Cross-session recall — auto-search archival when context seems relevant
- [x] Vector embeddings for semantic archival search — `OllamaEmbeddingProvider` + cosine similarity in `lib/memory.ts`, on by default (`CHOOMFIE_EMBEDDINGS=off` to disable). Dormant unless Ollama is installed; falls back to keyword search
- [ ] Memory decay — auto-archive stale core memories

## Testing & CI

> See [testing.md](testing.md) for full strategy

Current: 345 tests across 45 files, all in-process — no test spawns a real
supervisor, worker, or Discord connection. That gap is what the E2E items below
are for.

- [ ] E2E tests — spawn server, verify startup/shutdown/PID lifecycle (`boot.test.ts` and `regression/pid-guard.test.ts` cover the logic in-process; neither spawns)
- [ ] E2E tests — MCP tool round-trips over stdio (`mcp-proxy.test.ts` duck-types the proxy; no stdio transport)
- [ ] E2E tests — Discord message flow (test bot + test server)
- [x] Unit tests — time (`time.test.ts`), config/settings (`settings.test.ts`), reminder timezones (`reminder-timezone.test.ts`)
- [ ] Unit tests — memory and conversation still uncovered
- [x] Plugin tests — tutor (12 files) and browser (`browser-url-validation.test.ts`)
- [ ] Plugin tests — voice and socials are covered only at load/registration level (`plugins.test.ts`, `regression/plugin-load.test.ts`, `regression/tools-register.test.ts`); no behavior tests
- [x] CI pipeline — run tests + type-check + lint on PRs (`.github/workflows/ci.yml`)
- [ ] Merge gates — block PR on test/lint failure. `main` has branch protection, but `required_status_checks.contexts` is empty, so CI runs without gating a merge

## Non-Goals (For Now)

- **Multi-user isolation** — Choomfie is a personal assistant
- **Custom model training** — use Claude as-is
