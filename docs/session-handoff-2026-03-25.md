# Session Handoff — 2026-03-25

## What Was Done This Session

### 1. Code Audit + Modularization
- Split `server.ts` (1264 lines) into 17 modules under `lib/`
- server.ts is now 57 lines of wiring
- Tools colocate definition + handler in `lib/tools/*.ts`
- Shared state via `AppContext` object
- Switch statement replaced with Map lookup

### 2. Plugin System
- `Plugin` interface in `lib/types.ts` (tools, instructions, intents, init, onMessage, destroy)
- Plugin loader `lib/plugins.ts` — auto-discovers from `plugins/<name>/index.ts`
- Config: `"plugins": ["voice"]` in config.json
- Graceful shutdown calls destroy hooks
- Plugin intents merged into Discord client

### 3. Voice Plugin
- `plugins/voice/` with swappable STT/TTS providers
- Provider architecture: `providers/types.ts` defines `STTProvider` + `TTSProvider` interfaces
- Providers: `groq/` (free Whisper STT) + `elevenlabs/` (TTS + Scribe STT)
- Config selects backend: `"voice": { "stt": "groq", "tts": "elevenlabs" }`
- Tools: `join_voice`, `leave_voice`, `speak`
- Auto-listen: subscribes to speaking users → transcribe → forward to Claude
- Deps installed: `@discordjs/voice@0.19.2`, `@discordjs/opus`, `prism-media`, `sodium-native`

### 4. Language Learning Plugin
- `plugins/language-learning/` with modular language support
- Language module interface: `LanguageModule` (dictionary, tutorPrompt, quiz)
- Japanese module: Jisho API, kana tables (hiragana + katakana), N5 vocab, grammar quizzes
- Tools: `tutor_prompt`, `dictionary_lookup`, `quiz`, `set_language_level`, `set_study_language`, `list_languages`
- Session manager: per-user language + level tracking
- Default: Japanese N5 (complete beginner)

### 5. Fixes
- Deleted stale `ryuji.db` (old Mahiro bot leftover)
- Auto-cleanup inbox attachments older than 24h
- Updated status tool refs to new file paths
- Generic .env loader (all vars set on process.env)

### 6. Research & Docs
- `docs/plugins.md` — plugin system guide
- `docs/voice-plugin.md` — voice setup, providers, troubleshooting
- `docs/language-learning-tools.md` — tool stack research + decisions
- Researched anime community JP learning tools, GitHub projects, teaching methods

---

## Next Steps (What To Do Next Session)

### Priority 1: Upgrade Language Learning Plugin

Integrate the researched tools into the existing plugin. Keep everything modular.

**New dependencies to install:**
```bash
bun add unofficial-jisho-api wanakana ts-fsrs kuroshiro @sglkc/kuroshiro-analyzer-kuromoji
```

**Changes to make:**

1. **Replace dictionary** — swap raw Jisho fetch in `languages/japanese/dictionary.ts` → `unofficial-jisho-api` npm package (better wrapper, kanji strokes, examples)

2. **Add furigana engine** — new `lib/` or `utils/` module using `kuroshiro` + `@sglkc/kuroshiro-analyzer-kuromoji`. Auto-add furigana to all JP text the bot outputs. Needs init (async, loads dictionary). Make it a shared utility, not JP-specific.

3. **Add romaji support** — use `wanakana` in the JP language module. Accept romaji input from beginners, auto-convert to kana. Detect if user input is romaji vs kana vs kanji.

4. **Add SRS system** — use `ts-fsrs` for spaced repetition scheduling. Store card state in SQLite (extend `lib/memory.ts` or create new `plugins/language-learning/srs.ts`). Import Bluskyo JLPT N5 vocab JSON as starter deck. Daily review flow via Discord DMs.

5. **Add pitch accent** — use `hatsuon` npm package for SVG pitch diagrams. Add to dictionary lookup results.

6. **Upgrade quizzes** — replace spoiler-tagged answers with Discord ActionRow + ButtonBuilder for interactive quizzes. Track quiz scores in session.

**Architecture for modularity:**
```
plugins/language-learning/
  index.ts                    — plugin entry
  tools.ts                    — MCP tools
  session.ts                  — per-user state
  srs.ts                      — NEW: FSRS card scheduling + SQLite
  furigana.ts                 — NEW: kuroshiro wrapper (shared)
  languages/
    types.ts                  — LanguageModule interface
    index.ts                  — language registry
    japanese/
      index.ts                — JP module
      dictionary.ts           — UPGRADE: unofficial-jisho-api
      data/
        n5-vocab.json         — NEW: Bluskyo JLPT N5 deck
```

### Priority 2: Voice Plugin Testing
- Grab Groq API key (console.groq.com, free)
- Grab ElevenLabs API key
- Add to `~/.claude/plugins/data/choomfie-inline/.env`
- Enable voice plugin in config.json
- Test join/leave/speak in a real VC
- Pick ElevenLabs voices for EN + JP

### Priority 3: Shared Models Directory
- Create `~/models/` for whisper, voicevox (when local fallbacks are added)
- Check for scattered model files on PC
- ASK USER before moving/deleting anything

---

## Key Files

```
server.ts                              # Entry point + lifecycle (~95 lines)
lib/
├── types.ts                           # AppContext, Plugin, ToolDef
├── context.ts                         # Env/config loading
├── mcp-server.ts                      # MCP server + instructions
├── discord.ts                         # Discord client + handlers
├── plugins.ts                         # Plugin loader
├── config.ts                          # Config manager (personas, plugins, voice)
├── memory.ts                          # SQLite memory store
├── conversation.ts                    # Channel mode, rate limiting
├── permissions.ts                     # Permission relay
├── reminders.ts                       # Reminder checker
└── tools/                             # Core tool modules
    ├── index.ts                       # Tool registry
    ├── discord-tools.ts
    ├── memory-tools.ts
    ├── persona-tools.ts
    ├── reminder-tools.ts
    ├── github-tools.ts
    └── status-tools.ts
plugins/
├── voice/                             # Voice plugin
│   ├── index.ts
│   ├── tools.ts
│   ├── manager.ts
│   └── providers/
│       ├── types.ts                   # STTProvider + TTSProvider
│       ├── index.ts                   # Provider factory
│       ├── groq/                      # Free Whisper STT
│       └── elevenlabs/                # TTS + Scribe STT
└── language-learning/                 # Language learning plugin
    ├── index.ts
    ├── tools.ts
    ├── session.ts
    └── languages/
        ├── types.ts                   # LanguageModule interface
        ├── index.ts                   # Language registry
        └── japanese/
            ├── index.ts               # JP module
            └── dictionary.ts          # Jisho API
docs/
├── plugins.md                         # Plugin system guide
├── voice-plugin.md                    # Voice setup + providers
├── voice-implementation.md            # Voice research (from prev session)
├── language-learning.md               # Feature plan (from prev session)
├── language-learning-tools.md         # Tool stack research + decisions
├── mcp-integrations.md                # MCP research
├── roadmap.md                         # Project roadmap
└── session-handoff-2026-03-25.md      # THIS FILE
```

## User Preferences Confirmed This Session
- ElevenLabs TTS first (has credits), local TTS as later phase
- Both EN + JP voice support
- Plugin architecture (same repo, modular, splittable later)
- Complete beginner at Japanese (N5 start)
- Modular language support (JP first, CN later)
- No plan mode from Discord — send plans via reply
- Always bypass permissions when working from Discord
- Discord doesn't support markdown tables — use code blocks
