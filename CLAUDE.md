# Choomfie — Claude Code Instructions

## Project Overview

Choomfie is a Claude Code plugin — an MCP server that bridges Discord to Claude Code with persistent memory, switchable personas, reminders, Discord interactions (buttons/slash commands/modals), GitHub integration, and more. It runs as a subprocess inside Claude Code via `--plugin-dir`. Version is defined in root `package.json` and read via `packages/shared/version.ts`.

## Tech Stack

- **Runtime:** Bun
- **Language:** TypeScript
- **Protocol:** MCP (Model Context Protocol) over stdio
- **Database:** SQLite via bun:sqlite
- **Discord:** discord.js v14
- **Framework:** @modelcontextprotocol/sdk

## Project Structure

```
package.json                       # Root: bun workspaces, scripts, dev deps
packages/
  shared/                          # @choomfie/shared — types + utils
    package.json
    index.ts                       # Re-exports everything
    types.ts                       # Plugin, ToolDef, ToolResult, text(), err()
    plugin-context.ts              # PluginContext, PluginConfig (minimal subset of AppContext)
    time.ts                        # nowUTC, toSQLiteDatetime, dateToSQLite, parseNaturalTime
    paths.ts                       # findMonorepoRoot() — resilient project root resolution
    interactions.ts                # Registries + register functions ONLY (no dispatch)
    version.ts                     # VERSION
  core/                            # @choomfie/core — Discord bridge, memory, etc.
    package.json
    server.ts, supervisor.ts, worker.ts, daemon.ts
    daemon/                         # Agent SDK session runtime, handoffs, health checks
    lib/
      types.ts                     # AppContext (extends PluginContext), re-exports shared
      interactions.ts              # handleInteraction() + safeHandle() + re-exports shared registries
      config.ts, memory.ts, reminders.ts, discord.ts, context.ts, ...
      plugins.ts                   # Plugin loader (explicit workspace package map)
      tools/, handlers/
    test/
    scripts/, skills/, bin/
plugins/                           # Optional, enable/disable from Discord
  voice/                           # @choomfie/voice
    package.json
    index.ts                       # Plugin export (for Choomfie)
    manager.ts, tools.ts, vad.ts, ...
    providers/
  browser/                         # @choomfie/browser
    package.json
    index.ts                       # Plugin export
    session.ts, tools.ts
  tutor/                           # @choomfie/tutor
    package.json
    index.ts                       # Plugin export
    core/, tools/, modules/
  socials/                         # @choomfie/socials
    package.json
    index.ts                       # Plugin export
    tools/, providers/
docs/
.claude-plugin/
.mcp.json
CLAUDE.md, README.md, LICENSE
```

## Architecture

**Supervisor/Worker model** — see [docs/architecture.md](docs/architecture.md) and [docs/supervisor-architecture.md](docs/supervisor-architecture.md) for full details.

```
Claude Code ← MCP stdio → supervisor.ts (immortal)
                              ↕ Bun IPC
                          worker.ts (disposable)
```

- **Supervisor** owns MCP server + restart tool. Never restarts — MCP connection stays alive.
- **Worker** owns Discord + plugins + tools. Killed and respawned on restart (fresh code, clean state).
- IPC: tool calls routed supervisor → worker, notifications forwarded worker → supervisor → Claude.
- `McpProxy` in worker duck-types the MCP Server interface so discord.ts/permissions.ts/plugins work unchanged.

Shared state flows through a single `AppContext` object (defined in `packages/core/lib/types.ts`, extends `PluginContext` from `@choomfie/shared`).
Tools colocate their JSON schema definition + handler in one file as `ToolDef[]` arrays.

### Daemon Mode (`choomfie --daemon`)

Autonomous mode — see [docs/architecture.md](docs/architecture.md) and [docs/architecture-v2.md](docs/architecture-v2.md) for full design.

```
daemon.ts (always running)
  └→ Claude Session (Agent SDK, disposable)
       └→ supervisor.ts (MCP stdio) → worker.ts (Discord)
```

- **daemon.ts** is a thin CLI entry point; the runtime lives in `packages/core/daemon/`
- Uses `@anthropic-ai/claude-agent-sdk` to spawn Claude Code sessions programmatically
- Sessions are cycled when context gets heavy (~120k tokens or 80 turns)
- Before cycling: captures a handoff summary from Claude, persists to `meta/handoffs.json`
- New session gets handoff context injected into system prompt
- Worker health monitored via `choomfie.pid` checks every 30s; 3 consecutive failures trigger a full session cycle
- Daemon state written to `meta/daemon-state.json` for `/status` integration
- Repeated Anthropic API failures switch new sessions to the Ollama-compatible fallback provider
- Crash recovery with exponential backoff (2s → 60s max)

### Plugin System

Plugins live in `plugins/<name>/index.ts` as workspace packages and export a `Plugin` interface:
- `tools` — ToolDef[] (auto-registered into MCP)
- `instructions` — string[] (appended to system prompt)
- `intents` — extra Discord gateway intents
- `userTools` — plugin tool names allowed for non-owner users
- `init(ctx)` — called after Discord ready
- `onMessage(msg, ctx)` — hook into every message
- `onInteraction(interaction, ctx)` — hook into every interaction (buttons/commands/modals)
- `destroy()` — cleanup on shutdown

Plugins are workspace packages (`@choomfie/voice`, `@choomfie/browser`, `@choomfie/tutor`, `@choomfie/socials`) that import shared types from `@choomfie/shared` instead of relative `../../lib/` paths. The plugin loader in `packages/core/lib/plugins.ts` uses an explicit workspace package map. `discoverPlugins()` currently also advertises `rss`, but there is no `plugins/rss` workspace package, so enabling it logs a load failure.

Enable plugins via `/plugins` command from Discord, or in `config.json`: `"plugins": ["voice", "socials"]`

## How It Works

1. Claude Code loads Choomfie via `--plugin-dir` and `--dangerously-load-development-channels server:choomfie`, then spawns `bun packages/core/server.ts` as an MCP subprocess
2. `server.ts` → `supervisor.ts`: acquires PID file (single-instance guard), spawns `worker.ts` via `Bun.spawn({ ipc })` (all in `packages/core/`)
3. Worker creates AppContext, loads enabled plugins (from `plugins/` workspace packages), connects to Discord, waits for full initialization
4. Worker sends `{ type: "ready", tools, instructions }` to supervisor via IPC
5. Supervisor creates MCP server with real instructions + tools, connects stdio transport
6. Claude Code calls `initialize` → gets correct persona, security rules, and full tool list
7. Incoming Discord messages → worker → IPC notification → supervisor → MCP → Claude Code
8. Claude calls MCP tools → supervisor → IPC tool_call → worker → handler → IPC tool_result → supervisor → Claude
9. Restart: supervisor sends shutdown to worker → worker cleans up + exits → supervisor spawns fresh worker → sends `tools/list_changed` notification
10. Crash recovery: supervisor detects non-zero worker exit → auto-respawns with exponential backoff (max 5 crashes/60s)
11. On shutdown (SIGINT/SIGTERM/stdin close): supervisor tells worker to shutdown → cleans up PID file → exits

### Interaction System

Discord interactions (buttons, slash commands, modals) use a split architecture:
- **Registries** (`registerButtonHandler()`, `registerModalHandler()`, `registerCommand()`) live in `@choomfie/shared` (`packages/shared/interactions.ts`) so plugins can self-register without importing core
- **Dispatch logic** (`handleInteraction()`, `safeHandle()`) lives in `packages/core/lib/interactions.ts`
- **InteractionCreate** event registered in `packages/core/lib/discord.ts`, routes to `handleInteraction()`
- Plugin hook: `onInteraction?(interaction, ctx)` in the Plugin interface
- Button customId format: `prefix:action:data` (e.g. `reminder:ack:42`, `reminder:snooze:42:1h`)
- Error handling via `safeHandle()` wrapper — catches errors + replies gracefully
- All interactions bypass Claude — handled directly for instant response (<100ms vs ~5s)
- Key constraint: Discord requires response within 3 seconds; use `deferReply()` for async work
- Slash command definitions in `packages/core/lib/commands.ts`, deployed via `bun packages/core/scripts/deploy-commands.ts`
- Access control: `/persona switch`, `/newpersona`, `/savememory` are owner-only via `requireOwner()`

### Slash Commands

Defined in `packages/core/lib/commands.ts`, deployed via `packages/core/scripts/deploy-commands.ts`:
- `/remind` — opens a modal form to set a reminder (message, time, recurring, nag)
- `/reminders` — list active reminders with embed (ephemeral)
- `/cancel <id>` — cancel a reminder by ID
- `/memory [search]` — list core memories or search all memories (ephemeral)
- `/savememory` — opens a modal form to save a memory (key, value)
- `/github <check> [repo]` — check PRs, issues, notifications
- `/status` — bot status embed with uptime, persona, stats, plugins (ephemeral)
- `/persona [switch]` — list or switch personas
- `/newpersona` — opens a modal form to create a persona (key, name, personality)
- `/plugins [action] [name]` — list, enable, or disable plugins (owner only, restart needed)
- `/voice` — voice provider setup wizard with auto-detection and interactive buttons (owner only)
- `/lesson` — start or continue a structured lesson (button-driven, no Claude roundtrip)
- `/progress` — show learning progress with unit bars and completion stats (ephemeral)
- `/help` — show all commands and capabilities

Commands auto-deploy on startup when definitions change (hash-based check). Manual: `bun packages/core/scripts/deploy-commands.ts` or `--global` for global deploy.

### Modals

Modal forms triggered from slash commands, defined in `packages/core/lib/handlers/modals.ts`:
- Reminder modal: message, time, recurring fields
- Persona modal: key, name, personality fields (owner only)
- Memory modal: key, value fields (owner only)
- Modal submissions handled via `registerModalHandler(prefix, handler)` with customId prefix routing
- Key constraint: `showModal()` must be the first response to an interaction (cannot defer first)

### Shared Utilities

- `packages/shared/time.ts` — `MS_PER_MIN/HOUR/DAY` constants, `parseNaturalTime()`, `formatDuration()`, `relativeTime()`, `isValidCron()`, SQLite datetime formatting (re-exported via `@choomfie/shared`)
- `packages/core/lib/handlers/shared.ts` — `createAndScheduleReminder()` (used by /remind + modal), `requireOwner()`, `isOwner()`, `isAllowed()`
- `packages/core/lib/handlers/github.ts` — `buildGhArgs()` + `runGh()` (used by MCP tool + slash command)
- `packages/shared/version.ts` — `VERSION` constant from package.json (used by mcp-server, commands, status-tools)

## Tools (96 max)

Tool lists are dynamic: the supervisor always exposes `restart`, the worker exposes 34 core tools, and enabled plugins add their own tools. With all shipped plugins enabled, Choomfie exposes 96 MCP tools total: 95 worker tools plus the supervisor-owned `restart` tool.

Core Discord: reply (with embeds), react, edit_message, fetch_messages, search_messages, create_thread, create_poll, pin_message, unpin_message
Core Memory: save_memory, search_memory, list_memories, delete_memory, save_conversation_summary, memory_stats
Core Personas: switch_persona, save_persona, list_personas, delete_persona
Core Reminders: set_reminder, list_reminders, cancel_reminder, snooze_reminder, ack_reminder
Core Birthdays: birthday_add, birthday_remove, birthday_list, birthday_upcoming
Core Access: allow_user, remove_user, list_allowed_users (owner only)
Core GitHub: check_github
Core Status: choomfie_status
Core Translation: translate
System: restart (owner only, supervisor-owned — kills worker, spawns fresh one, reloads all code)

Browser plugin: browse, browser_click, browser_type, browser_screenshot, browser_eval, browser_press_key, browser_close
Voice plugin: join_voice, leave_voice, speak
Tutor plugin: tutor_prompt, dictionary_lookup, quiz, set_level, list_modules, switch_module, srs_review, srs_rate, srs_stats, srs_reminders, lesson_status, random_word, convert_kana, kanji_stroke_info, convert_pinyin, stroke_info, convert_hanzi
Socials plugin: youtube_search, youtube_info, youtube_transcript, youtube_auth, youtube_comment, reddit_search, reddit_posts, reddit_comments, reddit_auth, reddit_post, reddit_comment, linkedin_auth, linkedin_post, linkedin_post_image, linkedin_post_images, linkedin_post_link, linkedin_edit, linkedin_poll, linkedin_repost, linkedin_delete, linkedin_comments, linkedin_comment, linkedin_react, linkedin_schedule, linkedin_queue, linkedin_monitor, linkedin_analytics, linkedin_status, twitter_auth, twitter_post, twitter_post_image, twitter_thread, twitter_status

### Rich Embeds

The `reply` tool supports Discord embeds via the `embeds` parameter. Each embed takes:
- `title`, `description`, `color` (name: blue/green/yellow/orange/red/purple/pink/grey, or hex)
- `fields` array of `{name, value, inline?}`
- `footer`, `thumbnail`, `url`

Use for structured content (status, lists, summaries). Plain text for casual chat.

### Polls

`create_poll` creates Discord native polls:
- 2-10 options, 1-168 hour duration (default 24)
- Optional multi-select
- Uses Discord's built-in poll UI (not reaction-based)

### Reminder System

Reminders use precise `setTimeout` timers — each reminder gets its own timer that fires exactly when due. No polling, zero wasted compute.

Architecture:
- `ReminderScheduler` class in `packages/core/lib/reminders.ts` manages all timers
- On startup: loads pending reminders from DB, sets a timer for each
- On create/snooze: immediately schedules a new timer
- On cancel/ack: clears the timer
- Nag mode: after firing, schedules a repeating nag timer

Features:
- **Recurring:** `cron` param supports "hourly", "daily", "weekly", "monthly", "every Xm/h/d"
- **Nag mode:** `nag_interval` (minutes) re-pings until user acknowledges via `ack_reminder`
- **Snooze:** `snooze_reminder` reschedules a fired reminder (non-recurring only; recurring auto-acks)
- **Categories:** optional label for grouping (e.g. "work", "personal")
- **History:** `list_reminders` with `include_history=true` shows fired reminders
- **Buttons:** reminder notifications include interactive buttons (Done, Snooze 30m/1h/Tomorrow) — no Claude roundtrip needed, handled directly by `packages/core/lib/interactions.ts`

**Datetime format:** All dates stored in SQLite use space-separated format (`YYYY-MM-DD HH:MM:SS`), never ISO 8601 with `T`/`Z`. Use `@choomfie/shared` time utilities (`toSQLiteDatetime`, `dateToSQLite`, `nowUTC`) for all conversions.

DB schema (auto-migrated):
```sql
reminders: id, user_id, chat_id, message, due_at, fired, created_at,
           cron, nag_interval, category, ack, last_nag_at
```

## Key Details

- Owner auto-detected from Discord app info: during `./install.sh` (primary) or startup fallback if missed
- Permission relay: owner receives tool approval requests via DM, replies `yes/no <code>` to approve/deny
- State lives in `~/.claude/plugins/data/choomfie-inline/` (token, access list, database, inbox)
- Personality loaded from core memory (key: "personality") at startup
- Memory auto-compactor: core memories capped at 20. When exceeded, oldest are auto-archived to archival memory with `[auto-archived]` prefix and `auto-archived,core-memory` tags
- Console output goes to stderr (stdout is MCP stdio transport) — entry point is `packages/core/server.ts`
- DMs require Partials.Channel + Partials.Message in discord.js
- All attachments downloaded to `~/.claude/plugins/data/choomfie-inline/inbox/` (file_path = first, file_paths = all semicolon-separated)
- GitHub integration shells out to `gh` CLI via shared `packages/core/lib/handlers/github.ts` (15s timeout)
- Servers: only responds when @mentioned or replied to (not every message)
- DMs: always responds
- Rate limit: configurable via config.json (default 5s)
- Conversation timeout: configurable via config.json `convoTimeoutMs` (default 5 min)
- Typing indicator: state machine in `packages/core/lib/typing.ts` (IDLE ↔ TYPING). Shows typing while Claude thinks, stops on reply. Use `keep_typing: true` on the reply tool to keep typing active between multi-message workflows. Safety timeout: 2 min. Skipped for conversation_mode.
- Allowlist: loaded at startup from access.json. Use `allow_user`/`remove_user` tools to modify in-memory + persist to file (no restart needed). Manual file edits require restart.
- @mentions stripped from message before forwarding to Claude
- Personas stored in config.json, switchable from Discord (auto-restarts worker)
- search_messages paginates up to 1000 messages for user/keyword filtering
- Plugin tool names are collision-checked during load; a plugin with duplicate/conflicting tool names is skipped before registration
- Slash commands auto-deploy on Discord ready when the command definition hash changes
- **Hot-reload boundary:** Worker code in `packages/core/` (tools, Discord) and all plugin packages in `plugins/` (voice, browser, tutor, socials) are hot-reloadable via worker restart. Supervisor code (`packages/core/supervisor.ts`, IPC types, MCP server) requires full session restart (exit + re-run `choomfie`). Shared package (`packages/shared/`) changes require worker restart at minimum.
- Auto-restart triggers: persona switch, plugin enable/disable, voice config change — all send `request_restart` IPC → supervisor restarts worker → sends confirmation to Discord channel

## Config (config.json)

Runtime-configurable settings — changes take effect immediately, no restart needed:

```json
{
  "activePersona": "takagi",
  "rateLimitMs": 5000,
  "convoTimeoutMs": 300000,
  "autoSummarize": true,
  "plugins": [],
  "personas": { ... },
  "voice": { "stt": "auto", "tts": "auto" }
}
```

Settings can be changed via tools (e.g. `setRateLimitMs`, `setConvoTimeoutMs`) or by editing the file directly.

## Voice Plugin

Full-duplex voice conversations in Discord voice channels. See [docs/voice-optimization-roadmap.md](docs/voice-optimization-roadmap.md) for optimization details.

### Architecture

```
User speaks → Discord Opus → per-speaker SileroVAD (adaptive endpointing)
  → Opus decode (@discordjs/opus) → ffmpeg resample (48kHz stereo → 16kHz mono)
  → whisper-cpp STT (segmented every ~3s) → MCP notification → Claude
  → speak tool → sentence splitter → pipelined kokoro TTS
  → 48kHz stereo PCM → AudioPlayer → Discord
```

### Key Features

- **Streaming TTS**: Long responses split into sentences, each synthesized and played independently with one-ahead pipelining (next sentence synthesizes while current plays)
- **Silero VAD**: Neural voice activity detection replacing fixed silence timeout. Adaptive endpointing: `threshold = min(1200ms, 400ms + utteranceDuration * 0.3)`
- **Interruption handling**: User speech stops bot playback after 300ms barge-in threshold. Generation IDs invalidate stale speak() calls. Tracks what was actually spoken for context.
- **Streaming STT**: Audio flushed to whisper every ~3s of continuous speech (MAX_SEGMENT_CHUNKS=150). Segments transcribe in parallel, combined on speech end.
- **Multi-speaker**: Per-speaker VAD pipelines (independent SileroVAD + SpeechDetector). Max 4 concurrent speakers with LRU eviction. Idle cleanup every 30s.
- **Silence priming**: Plays 0.5s silence on join to prime Discord's voice receive pipeline (required for Discord to send audio packets)
- **Speak queue**: Serialized via promise chain with generation ID checks. Prevents race conditions between concurrent speak() calls.

### Providers

Swappable via config. Auto-detection picks the best available:

| Type | Provider | Local | Free | Notes |
|------|----------|-------|------|-------|
| STT | whisper-cpp | Yes | Yes | Default. `brew install whisper-cpp`, model at `~/.cache/whisper-cpp/` |
| STT | groq | No | Yes | Needs GROQ_API_KEY |
| STT | elevenlabs | No | No | Paid API |
| TTS | kokoro | Yes | Yes | Default. `pip install kokoro-onnx soundfile`, 53 voices |
| TTS | edge-tts | No | Yes | Free Microsoft API |
| TTS | elevenlabs | No | No | Paid API |
| VAD | silero | Yes | Yes | Always on. Bundled via @ricky0123/vad-node |

### Voice Config

```json
"voice": {
  "stt": "whisper",     // or "groq", "elevenlabs", "auto"
  "tts": "kokoro",      // or "edge-tts", "elevenlabs", "auto"
  "ttsSpeed": 1.0       // 0.5-2.0, applied via ffmpeg atempo
}
```

Voice model: set `KOKORO_VOICE=af_nova` env var (default: `af_heart`). 53 voices available across 8 languages.
