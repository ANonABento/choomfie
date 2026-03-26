# Session Handoff — 2026-03-24

## What Was Done This Session

### 1. MCP Integrations Research
- Created `docs/mcp-integrations.md` — full research on external MCP servers/tools
- Covers: Image Gen (Flux, MCPollinations, OpenAI, SD), YouTube (yt-dlp, YouTube API), Voice (TTS/STT), Google Workspace (gogcli CLI), Notion, Weather
- Each section has: recommended options, alternatives, repo links, setup, costs, security table
- General security principles section at top (access tiers, API key handling, rate limits, content filtering)

### 2. Voice Implementation Research
- Created `docs/voice-implementation.md` — deep implementation guide
- DAVE E2EE fix: MUST use `@discordjs/voice@0.19.2+` (March 17, 2026)
- Architecture: Discord Opus → PCM → VAD → STT → LLM → TTS → Opus → Discord
- 4 tiers: Quick Start ($5/mo), Production ($10-20/mo), Premium ($30-50/mo), Free/Local ($0)
- STT: Deepgram (streaming, recommended), Groq Whisper (free), whisper.cpp (local)
- TTS: OpenAI (native Opus), ElevenLabs (websocket streaming), Edge TTS (free), Kokoro (local)
- Japanese voices added: VOICEVOX (recommended for JP), Style-Bert-VITS2, anime-tts, Tsukasa-Speech, GPT-SoVITS
- VAD: Silero VAD (recommended) vs built-in AfterSilence
- Code snippets for full pipeline, echo prevention, cooldowns, chunked TTS
- 7 reference GitHub projects analyzed

### 3. Language Learning Feature
- Created `docs/language-learning.md` — Japanese tutor mode feature plan
- 4 phases: Text tutor → SRS → Voice → Advanced
- AI tutor with structured JSON corrections (grammar, particles, formality)
- SRS: SM-2 algorithm, pre-built JLPT N5-N1 decks, daily DM reviews
- Voice: Whisper STT → Claude → VOICEVOX pipeline
- Tools: Jisho API, WanaKana, kuroshiro, Kanjium pitch accent data, WaniKani sync
- Cost: ~$1.80-3.30/user/mo or $0.50-2 with free alternatives

### 4. Roadmap Updated
- Updated `docs/roadmap.md` with new phases:
  - Phase 5: MCP Integrations (image gen, youtube, google workspace, weather, notion)
  - Phase 7: Voice (expanded with specific MCP/tool options + costs)
  - Phase 9: Language Learning (Japanese Tutor)
  - Phase 10: Simulation (Dead Internet Theory)

### 5. Persona Work
- Updated **tonxu** persona — rebuilt from ~400 real messages (Feb-Mar 2026), hardened guardrails (dumber, no markdown, no filler, actual typo patterns)
- Created **olwl0** persona — lazy bro energy, one-word reactions, raccoon beer gif, "brah"
- Created **somebodi** persona — practical/direct, dry humor, gets heated about money, responsible friend who swears
- Total personas: choomfie, tonxu, takagi, olwl0, somebodi

---

## Next Steps (What To Do Next Session)

### Priority 1: Audit & Cleanup Current Code
- Read through all current code (`server.ts`, `lib/memory.ts`, `lib/config.ts`)
- Check for: DRY violations, dead code, unused imports, stale references
- Ensure file structure is clean and modular
- Remove anything unused

### Priority 2: Architecture Decision — Plugin System
- User wants: **barebones core + addable packages**
- Core choomfie = Discord bridge + memory + personas + basic tools
- Packages/plugins: voice, language-learning, image-gen, youtube, google workspace
- Design the plugin interface (how packages register tools, commands, handlers)
- Each package should be independently installable

### Priority 3: Plan Voice Pipeline ($0 Cost)
- Target: completely free voice pipeline
- **STT:** whisper.cpp (local, Apple Silicon) — need to verify setup
- **TTS:** VOICEVOX (local, free, cute JP voices) OR Edge TTS (free, unofficial)
- **VAD:** Silero VAD (free, open source)
- **LLM:** Claude (already available via plugin)
- User has ElevenLabs credits too (can use as premium option)
- Verify tool choices with user before implementing

### Priority 4: Shared Models Directory
- Create a shared location on the mac for ML models (whisper, etc.)
- e.g., `~/models/whisper/`, `~/models/voicevox/`
- All apps reference models from this shared path
- Check for any existing model files scattered on the PC
- ASK USER before cleaning/moving anything

---

## Key Files

```
docs/
├── mcp-integrations.md          # NEW — MCP server research + security
├── voice-implementation.md      # NEW — Voice pipeline implementation guide
├── language-learning.md         # NEW — Japanese tutor feature plan
├── roadmap.md                   # UPDATED — Phases 5, 7, 9, 10 added
├── research.md                  # Existing — Design decisions
├── architecture.md              # Existing
├── discord-setup.md             # Existing
├── memory.md                    # Existing
├── skills.md                    # Existing
└── session-handoff-2026-03-24.md  # THIS FILE
```

## User Preferences (From This Session)
- Doesn't use Spotify → swapped for YouTube in research
- Has ElevenLabs credits
- Wants $0 cost voice pipeline as primary, paid as upgrade option
- Prefers gogcli (CLI) over MCP for Google Workspace (token efficiency)
- Wants plugin/package architecture (not monolith)
- Shared model directory on mac for whisper etc.
- Ask before cleaning/moving any files on PC
