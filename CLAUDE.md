# Choomfie — Claude Code Instructions

## Project Overview

Choomfie is a Claude Code plugin — an MCP server that bridges Discord to Claude Code with persistent memory, switchable personas, reminders, Discord interactions (buttons/slash commands/modals), GitHub integration, and more. It runs as a subprocess inside Claude Code via `--plugin-dir`. Version is defined in `package.json` and read via `lib/version.ts`.

## Tech Stack

- **Runtime:** Bun
- **Language:** TypeScript
- **Protocol:** MCP (Model Context Protocol) over stdio
- **Database:** SQLite via bun:sqlite
- **Discord:** discord.js v14
- **Framework:** @modelcontextprotocol/sdk

## Project Structure

```
server.ts                      # Entry point — thin wrapper, imports supervisor.ts
supervisor.ts                  # Immortal process: MCP server, IPC, restart tool, PID guard
worker.ts                      # Disposable process: Discord, plugins, tools, reminders
lib/
  ipc-types.ts                 # Shared IPC message types (supervisor ↔ worker)
  mcp-proxy.ts                 # Duck-type MCP Server for worker (notification + permission relay via IPC)
  types.ts                     # AppContext, ToolDef, text/err helpers
  context.ts                   # Env/config loading, creates AppContext
  mcp-server.ts                # buildInstructions() + createMcpServer() (worker + boot test)
  discord.ts                   # Discord client, Ready, MessageCreate, InteractionCreate
  interactions.ts              # Interaction router + handler registries
  commands.ts                  # Slash command definitions + handlers (self-registering)
  handlers/
    reminder-buttons.ts        # Reminder button builders + click handlers
    modals.ts                  # Modal builders + submit handlers
    shared.ts                  # Shared handler utils (auth helpers, createAndScheduleReminder)
    github.ts                  # Shared GitHub CLI helper (buildGhArgs, runGh)
  conversation.ts              # Channel activation, rate limiting
  permissions.ts               # Permission relay (tool approval via DM)
  reminders.ts                 # ReminderScheduler — timer-based (setTimeout per reminder)
  time.ts                      # Time constants, formatting, parsing, cron validation
  version.ts                   # VERSION constant (reads from package.json)
  memory.ts                    # SQLite memory store (core + archival + reminders)
  config.ts                    # Config manager (personas, rate limits, settings)
  tools/
    index.ts                   # Tool registry — aggregates all tool modules
    discord-tools.ts           # reply (embeds), react, edit, fetch, search, thread, poll, pin/unpin
    access-tools.ts            # allow/remove/list users (owner only)
    memory-tools.ts            # save/search/list/delete memory, summary, stats
    persona-tools.ts           # switch/save/list/delete persona
    reminder-tools.ts          # set/list/cancel/snooze/ack reminder
    github-tools.ts            # check_github
    status-tools.ts            # choomfie_status
    system-tools.ts            # (empty — restart moved to supervisor)
  plugins.ts                   # Plugin loader (discovers + loads from plugins/)
plugins/                       # Plugin directory (each plugin = subdirectory)
  voice/
    index.ts                   # Voice plugin entry — intents, init, tools, destroy
    manager.ts                 # VoiceManager — join/leave/speak, STT receive, interruption
    tools.ts                   # MCP tools: join_voice, leave_voice, speak
    vad.ts                     # SileroVAD (ONNX), SpeechDetector, downsampleForVAD
    sentence-splitter.ts       # splitSentences() for streaming TTS chunking
    providers/
      index.ts                 # Provider factory — auto-detect or config-select STT/TTS
      types.ts                 # STTProvider, TTSProvider, ProviderStatus interfaces
      audio.ts                 # DISCORD_PCM/STT_WAV constants, toDiscordPcm()
      detect.ts                # checkBinary(), checkPythonModule() helpers
      kokoro/tts.ts            # Kokoro TTS — local neural TTS via Python/ONNX
      edge-tts/tts.ts          # Edge TTS — free Microsoft API
      elevenlabs/              # ElevenLabs — paid API (STT + TTS)
      groq/stt.ts              # Groq — free cloud STT API
      whisper/stt.ts           # whisper-cpp — local STT via CLI
scripts/
  deploy-commands.ts           # Deploy slash commands to Discord
.claude-plugin/plugin.json     # Plugin metadata
.mcp.json                      # How Claude Code spawns the server
test/
  boot.test.ts                 # Smoke test — verifies server boots without crashing
skills/
├── configure/SKILL.md         # /choomfie:configure — set Discord token
├── access/SKILL.md            # /choomfie:access — manage allowlist
├── memory/SKILL.md            # /choomfie:memory — view/manage memories
└── status/SKILL.md            # /choomfie:status — config overview
```

## Architecture

**Supervisor/Worker model** — see [docs/supervisor-architecture.md](docs/supervisor-architecture.md) for full details.

```
Claude Code ← MCP stdio → supervisor.ts (immortal)
                              ↕ Bun IPC
                          worker.ts (disposable)
```

- **Supervisor** owns MCP server + restart tool. Never restarts — MCP connection stays alive.
- **Worker** owns Discord + plugins + tools. Killed and respawned on restart (fresh code, clean state).
- IPC: tool calls routed supervisor → worker, notifications forwarded worker → supervisor → Claude.
- `McpProxy` in worker duck-types the MCP Server interface so discord.ts/permissions.ts/plugins work unchanged.

Shared state flows through a single `AppContext` object (defined in `lib/types.ts`).
Tools colocate their JSON schema definition + handler in one file as `ToolDef[]` arrays.

### Plugin System

Plugins live in `plugins/<name>/index.ts` and export a `Plugin` interface:
- `tools` — ToolDef[] (auto-registered into MCP)
- `instructions` — string[] (appended to system prompt)
- `intents` — extra Discord gateway intents
- `init(ctx)` — called after Discord ready
- `onMessage(msg, ctx)` — hook into every message
- `onInteraction(interaction, ctx)` — hook into every interaction (buttons/commands/modals)
- `destroy()` — cleanup on shutdown

Enable plugins via `/plugins` command from Discord, or in `config.json`: `"plugins": ["voice", "socials"]`

## How It Works

1. Claude Code loads Choomfie via `--plugin-dir` and `--dangerously-load-development-channels server:choomfie`, then spawns `bun server.ts` as an MCP subprocess
2. `server.ts` → `supervisor.ts`: acquires PID file (single-instance guard), spawns `worker.ts` via `Bun.spawn({ ipc })`
3. Worker creates AppContext, loads plugins, connects to Discord, waits for full initialization
4. Worker sends `{ type: "ready", tools, instructions }` to supervisor via IPC
5. Supervisor creates MCP server with real instructions + tools, connects stdio transport
6. Claude Code calls `initialize` → gets correct persona, security rules, and full tool list
7. Incoming Discord messages → worker → IPC notification → supervisor → MCP → Claude Code
8. Claude calls MCP tools → supervisor → IPC tool_call → worker → handler → IPC tool_result → supervisor → Claude
9. Restart: supervisor sends shutdown to worker → worker cleans up + exits → supervisor spawns fresh worker → sends `tools/list_changed` notification
10. Crash recovery: supervisor detects non-zero worker exit → auto-respawns with exponential backoff (max 5 crashes/60s)
11. On shutdown (SIGINT/SIGTERM/stdin close): supervisor tells worker to shutdown → cleans up PID file → exits

### Interaction System

Discord interactions (buttons, slash commands, modals) are handled by `lib/interactions.ts`:
- **InteractionCreate** event registered in `lib/discord.ts`, routes to `handleInteraction()`
- Plugin hook: `onInteraction?(interaction, ctx)` in the Plugin interface
- Button customId format: `prefix:action:data` (e.g. `reminder:ack:42`, `reminder:snooze:42:1h`)
- Handlers self-register via `registerButtonHandler()`, `registerModalHandler()`, `registerCommand()`
- Error handling via `safeHandle()` wrapper — catches errors + replies gracefully
- All interactions bypass Claude — handled directly for instant response (<100ms vs ~5s)
- Key constraint: Discord requires response within 3 seconds; use `deferReply()` for async work
- Slash command definitions in `lib/commands.ts`, deployed via `bun scripts/deploy-commands.ts`
- Access control: `/persona switch`, `/newpersona`, `/savememory` are owner-only via `requireOwner()`

### Slash Commands

Defined in `lib/commands.ts`, deployed via `scripts/deploy-commands.ts`:
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
- `/help` — show all commands and capabilities

Commands auto-deploy on startup when definitions change (hash-based check). Manual: `bun scripts/deploy-commands.ts` or `--global` for global deploy.

### Modals

Modal forms triggered from slash commands, defined in `lib/handlers/modals.ts`:
- Reminder modal: message, time, recurring fields
- Persona modal: key, name, personality fields (owner only)
- Memory modal: key, value fields (owner only)
- Modal submissions handled via `registerModalHandler(prefix, handler)` with customId prefix routing
- Key constraint: `showModal()` must be the first response to an interaction (cannot defer first)

### Shared Utilities

- `lib/time.ts` — `MS_PER_MIN/HOUR/DAY` constants, `parseNaturalTime()`, `formatDuration()`, `relativeTime()`, `isValidCron()`, SQLite datetime formatting
- `lib/handlers/shared.ts` — `createAndScheduleReminder()` (used by /remind + modal), `requireOwner()`, `isOwner()`, `isAllowed()`
- `lib/handlers/github.ts` — `buildGhArgs()` + `runGh()` (used by MCP tool + slash command)
- `lib/version.ts` — `VERSION` constant from package.json (used by mcp-server, commands, status-tools)

## Tools (27)

Discord: reply (with embeds), react, edit_message, fetch_messages, search_messages, create_thread, create_poll, pin_message, unpin_message
Memory: save_memory, search_memory, list_memories, delete_memory, save_conversation_summary, memory_stats
Personas: switch_persona, save_persona, list_personas, delete_persona
Reminders: set_reminder, list_reminders, cancel_reminder, snooze_reminder, ack_reminder
Access: allow_user, remove_user, list_allowed_users (owner only)
GitHub: check_github
Status: choomfie_status
System: restart (owner only, supervisor-owned — kills worker, spawns fresh one, reloads all code)

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
- `ReminderScheduler` class in `lib/reminders.ts` manages all timers
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
- **Buttons:** reminder notifications include interactive buttons (Done, Snooze 30m/1h/Tomorrow) — no Claude roundtrip needed, handled directly by `lib/interactions.ts`

**Datetime format:** All dates stored in SQLite use space-separated format (`YYYY-MM-DD HH:MM:SS`), never ISO 8601 with `T`/`Z`. Use `lib/time.ts` utilities (`toSQLiteDatetime`, `dateToSQLite`, `nowUTC`) for all conversions.

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
- Console output goes to stderr (stdout is MCP stdio transport)
- DMs require Partials.Channel + Partials.Message in discord.js
- All attachments downloaded to `~/.claude/plugins/data/choomfie-inline/inbox/` (file_path = first, file_paths = all semicolon-separated)
- GitHub integration shells out to `gh` CLI via shared `lib/handlers/github.ts` (15s timeout)
- Servers: only responds when @mentioned or replied to (not every message)
- DMs: always responds
- Rate limit: configurable via config.json (default 5s)
- Conversation timeout: configurable via config.json `convoTimeoutMs` (default 5 min)
- Typing indicator: state machine in `lib/typing.ts` (IDLE ↔ TYPING). Shows typing while Claude thinks, stops on reply. Use `keep_typing: true` on the reply tool to keep typing active between multi-message workflows. Safety timeout: 2 min. Skipped for conversation_mode.
- Allowlist: loaded at startup from access.json. Use `allow_user`/`remove_user` tools to modify in-memory + persist to file (no restart needed). Manual file edits require restart.
- @mentions stripped from message before forwarding to Claude
- Personas stored in config.json, switchable from Discord
- search_messages paginates up to 1000 messages for user/keyword filtering

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
