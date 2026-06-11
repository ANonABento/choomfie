# Choomfie (Claude stack) vs Hermes — feature-by-feature comparison

> Written to support the "one source of truth" rebuild decision. Two runtimes
> currently both answer to the name "Choomfie":
>
> - **Claude stack** — `bin/choomfie-claude-code` → `packages/core` (supervisor/worker
>   MCP, daemon). Brain = Claude. State in `~/.claude/plugins/data/choomfie-inline/`.
> - **Hermes** — `bin/choomfie` (default) → `hermes -p choomfie gateway`. Brain was
>   `gpt-5.3-codex-spark`. State in `~/.choomfie-hermes/profiles/choomfie/`.
>
> The newest piece, `packages/core/openai-server.ts`, is an OpenAI-compatible HTTP
> endpoint that exposes Claude (Agent SDK) + Choomfie tools/memory/notify. It is the
> keystone for Option B: Hermes can use it as its `model.base_url`, making Claude the
> Hermes brain with no LiteLLM proxy in between.

## Scorecard

"Winner" = which runtime has the stronger/more mature implementation today. For
Option B (Hermes is source of truth), every row where **Choomfie wins** is something
you must port into a Hermes plugin/skill, or accept losing.

| Category | Choomfie (Claude stack) | Hermes | Winner |
|---|---|---|---|
| Brain / model routing | Claude only; Ollama fallback in daemon | 15+ providers, fallback chains, aliases, **custom OpenAI endpoint** | **Hermes** |
| Gateway / runtime | supervisor/worker, crash recovery, Discord-only | production daemon, systemd, multi-user, agent LRU cache | **Hermes** |
| Platforms | Discord only | 20+ (Discord, Telegram, Slack, WhatsApp, email, Matrix…) | **Hermes** |
| Sessions / context | daemon cycles @120k tok / 80 turns + handoff summary | compression-on-read (no history loss), FTS5, freshness gates | **Hermes** |
| Cost tracking | daemon tracks tokens/cost | per-session token + USD accounting, per-model pricing | **Hermes** |
| Cron / scheduling | none (reminders only) | full `cronjob` tool + scheduler + delivery + auto-approval | **Hermes** |
| Sandboxes / code exec | none (relies on Claude Code's Bash) | local/SSH/Docker/Modal/Vercel/Daytona/Singularity | **Hermes** |
| Generic web/browser | Playwright plugin, 7 tools | 12+ browser tools w/ stealth, CDP, vision; web_search/extract | **Hermes** |
| Distribution packaging | none (it's an app) | `distribution.yaml`, overlay, sync, `distribution_owned` | **Hermes** |
| Personality / personas | config.json personas, switch = worker restart | SOUL.md + personalities, **per-session**, prefix-cached | **Hermes** |
| Memory | SQLite core KV + archival w/ embeddings, auto-archive | MEMORY.md/USER.md entries, injection scanning, session_search | ~ tie |
| Approvals / policy | owner-DM permission relay, allowlist, owner/user roles | approval tool, guardrails, slash access, path/injection scan | ~ tie |
| **Reminders** | native setTimeout scheduler, buttons, nag, snooze, tz, recurring, modal edit | `choomfie_reminders` plugin (partial) + cron | **Choomfie** |
| **Voice** | full-duplex VAD/STT/TTS pipeline, barge-in, multi-speaker | TTS tool + voice receiver; no full-duplex pipeline | **Choomfie** |
| **Tutor** | FSRS SRS engine, lessons, modules, JLPT N5 deck, button-driven | `choomfie_tutor` orchestration plugin + skill (no SRS engine) | **Choomfie** |
| **Socials** | YouTube/Reddit/LinkedIn/Twitter deep OAuth integrations | generic web/browser + `socials-browser` skill (opinions only) | **Choomfie** |
| Interactions | purpose-built buttons/modals, bypass-Claude instant | per-platform button/slash support (generic) | **Choomfie** |
| Birthdays / polls / translate | native tools + daily birthday scheduler | would need porting | **Choomfie** |

## Category deep-dives

### 1. Brain / model routing — Hermes wins, and it unblocks B
- **Choomfie:** single provider (Claude). Daemon mode adds an Ollama fallback after 3
  consecutive Anthropic failures. No routing, no aliases.
- **Hermes:** Anthropic, OpenAI, OpenAI-Codex, OpenRouter, Ollama, Gemini, Kimi, GLM,
  X.ai, Bedrock, Copilot, custom OpenAI-compatible, etc. Auxiliary-task routing
  (compression/search/vision can use a cheaper model), model aliases (`heavy`),
  402-fallback chains, per-model temperature contracts.
- **Keystone:** `model.provider: custom` + `model.base_url: <openai-server.ts>` makes
  Hermes call Claude through the endpoint you already built. This is why B "feels like
  Claude" — same brain — while keeping all of Hermes's infra. It also retires the
  `gpt-5.3-codex-spark` provider that was 400ing.

### 2. Gateway / runtime / platforms — Hermes wins
- **Choomfie:** supervisor (immortal, owns MCP) + worker (disposable, owns Discord).
  Crash recovery w/ exponential backoff. Daemon mode for autonomy. **Discord only.**
- **Hermes:** long-lived gateway daemon, systemd lifecycle, multi-user concurrent
  sessions, per-session `AIAgent` LRU cache (128, 1h idle TTL), auto-continue on
  interruption. 20+ platform adapters behind `BasePlatformAdapter`.
- For a Discord-only personal agent, Choomfie's model is perfectly adequate. Hermes's
  reach only matters if you want other platforms or harder uptime guarantees.

### 3. Sessions / context / cost — Hermes more sophisticated
- **Choomfie (daemon):** cycles the whole session at ~120k tokens or 80 turns, captures
  a handoff summary into `meta/handoffs.json`, starts fresh with it injected. In MCP
  mode, Claude Code manages its own budget.
- **Hermes:** compression-on-read — protects first/last N messages, summarizes the
  middle into a child session (`parent_session_id`), **never drops history**. FTS5 +
  trigram search over everything. Freshness gates stop stale auto-resume. Full token +
  USD accounting per session.

### 4. Memory — roughly even, different philosophy (migration friction)
- **Choomfie:** SQLite (`choomfie.db`). Core = KV pairs always in prompt (capped 20,
  oldest auto-archived). Archival = embedded text w/ cosine search (optional Ollama).
- **Hermes:** `MEMORY.md` + `USER.md`, entry-based, character-capped, snapshot frozen
  into the prompt at session start (mid-session writes persist but don't bust prefix
  cache). Prompt-injection / exfil scanning on writes. `session_search` for history.
- **Friction:** these are two unrelated stores. For B you'd migrate `choomfie.db`
  memories into Hermes's `MEMORY.md`/`USER.md` (one-time script) and retire the DB, or
  expose the DB to Hermes via the `memory` endpoint on `openai-server.ts`.

### 5. Tools — Hermes broader generic; Choomfie owns the opinionated ones
- **Choomfie:** 34 core MCP tools + plugin tools. Strength is *purpose-built* surface
  (reminder buttons, tutor SRS, socials, voice).
- **Hermes:** 70+ built-ins — web_search/extract, terminal, file ops, vision, image
  gen, code exec, delegation/subagents, todo/kanban, cronjob, messaging, HomeAssistant,
  computer_use. Per-platform tool gating to control cost.

### 6. Reminders — Choomfie wins (real port work for B)
- **Choomfie:** dedicated `ReminderScheduler` with one `setTimeout` per reminder (no
  polling), recurring (`hourly`/`daily`/`every Xh`), timezone-aware calendar math, nag
  loop until ack, snooze, categories, history, and **interactive Discord buttons +
  modal editing** that bypass Claude for <100ms response.
- **Hermes:** `choomfie_reminders` overlay plugin (partial port) plus the generic
  `cronjob` tool. Cron can fire scheduled prompts but doesn't replicate the button/nag/
  snooze UX. SOUL.md already admits parity gaps and tells users to fall back to
  `choomfie claude-code`.

### 7. Voice — Choomfie wins big (largest port for B)
- **Choomfie:** full-duplex pipeline — per-speaker Silero VAD, whisper-cpp STT,
  pipelined Kokoro TTS, barge-in/interruption, multi-speaker (4), filler phrases. Deep,
  Discord-specific work in `plugins/voice`.
- **Hermes:** has a `text_to_speech` tool and a Discord voice receiver, but **not** the
  full-duplex conversational pipeline. Porting this is the single biggest lift in B.

### 8. Tutor — Choomfie wins (SRS engine is real work)
- **Choomfie:** FSRS spaced-repetition engine, structured lessons/units, language
  modules (JA/ZH/KO), JLPT N5 deck auto-import (718 words), button-driven lessons,
  progress tracking — all in `plugins/tutor`.
- **Hermes:** `choomfie_tutor` plugin is orchestration (quiz→correct→retry→grade) + a
  `tutor` skill for guidance. No SRS engine or lesson DB.

### 9. Socials — Choomfie wins (real integrations vs opinions)
- **Choomfie:** working YouTube (yt-dlp + Data API), Reddit (read + OAuth write),
  LinkedIn (full OAuth: post/poll/schedule/analytics/monitor), Twitter (rettiwt-api).
- **Hermes:** generic web/browser tools + a `socials-browser` skill that's *guidance*
  about platform quirks, not credentialed integrations.

### 10. Cron, sandboxes, distribution — Hermes wins (free infra in B)
- **Cron:** Hermes has a real scheduler (`cronjob` tool, 60s tick, delivery targets,
  auto-approval, lock file). Choomfie has nothing beyond reminders.
- **Sandboxes:** Hermes runs `terminal`/`code` in local/SSH/Docker/Modal/Vercel/
  Daytona/Singularity. Choomfie leans on Claude Code's own Bash.
- **Distribution:** Choomfie is *already* a Hermes distribution (the `hermes-overlay/`
  dir with `distribution.yaml`, SOUL.md, plugins, skills, cron). Adopting B means
  leaning into this packaging instead of fighting it.

## What Option B concretely requires

1. **Brain swap (easy, ~1 day):** point Hermes `model.provider: custom`,
   `model.base_url` at `openai-server.ts` (`ClaudeAgentSDKChatBackend`). Verify
   streaming, tool-calls, and context limits flow correctly through the adapter. Drop
   the `gpt-5.3-codex-spark`/`openai-codex` config in `apply_profile_defaults`.
2. **Memory unification (medium):** one-time migrate `choomfie.db` core/archival into
   Hermes `MEMORY.md`/`USER.md`, OR have Hermes read the DB via the endpoint's
   `/v1/choomfie/memory`. Pick one store; retire the other.
3. **Personality unification (easy):** delete `config.json` personas; SOUL.md +
   `agent.personalities.choomfie` become the only personality source.
4. **Feature ports (the real cost):** reminders (buttons/nag/snooze scheduler), voice
   (full-duplex), tutor (SRS engine + lessons), socials (OAuth integrations),
   purpose-built interactions/modals, birthdays. Each becomes a Hermes plugin/skill.
   These are the rows where Choomfie wins the scorecard.
5. **Launcher cleanup:** `bin/choomfie` stays Hermes-first; `choomfie claude-code`
   becomes the *escape hatch* only for not-yet-ported features (which SOUL.md already
   documents). Once ports land, it can go away.

### Honest read
- B's headline ("feels like Claude, keeps Hermes infra") is achievable cheaply because
  the bridge already exists.
- The expensive part is re-homing the four deep features (reminders, voice, tutor,
  socials) that are the actual reason Choomfie feels rich. Until they're ported, B
  leaves you running both anyway.
- If you don't actually use voice/tutor/socials heavily, B is a clear win. If you do,
  weigh the port cost against Option A (Claude stack as source of truth, retire Hermes),
  where those features already work and you'd instead reimplement only the Hermes infra
  bits you use (cron, multi-provider) on the Claude side.
