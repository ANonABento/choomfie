# Choomfie — Interactive Bridge, Consolidation & Update Spec

**Status:** Draft for review · **Date:** 2026-07-02 · **Branch context:** follows `model-switcher-providers`

This spec answers four questions raised in planning:

1. Build the `:4142` **interactive** brain bridge so `choomfie model` can swap SDK ↔ interactive.
2. Does `choomfie claude` (Claude Code mode) become **redundant**? What cleanup follows?
3. What Hermes features are we **not** using that we should adopt?
4. Do we need a **better / automatic updater**?

---

## The end-state we want (plain language)

- I run **`choomfie`** → starts the Discord bot **and** the brain.
- I run **`choomfie model`** → pick between:
  - **SDK** (headless, metered credit pool), and
  - **Interactive** (flat-rate Claude plan).
- Eventually **`choomfie claude` goes away** — one runtime, not two.

That's the target. The rest of this doc is how close we are and what each step really costs.

---

## Where we actually are today

| Thing | State |
| --- | --- |
| `choomfie` starts bot + brain | ✅ Works. Gateway + `:4141` SDK sidecar both come up. |
| `choomfie model` picker shows SDK + Interactive | ✅ Both listed. |
| Interactive actually routes | ❌ **Dead config.** `:4142` server doesn't exist. Selecting it does nothing. |
| `choomfie claude` still needed | ✅ Yes — it's the **only** home for voice, tutor, socials, and reminder buttons (~30k LOC). |

So "one command" already mostly works for the **SDK** brain. The gaps are: (a) the interactive route isn't built, and (b) the second runtime can't be deleted yet.

---

## Part 1 — The Interactive bridge (`:4142`)

### How the brain plumbing works (so the design makes sense)

The brain is an **OpenAI-compatible HTTP server**: `packages/core/openai-server.ts`. Hermes's `choomfie` provider points at `http://127.0.0.1:4141/v1` and talks to it like it's OpenAI.

Inside, requests flow through a **`ChatBackend`** interface (`packages/core/lib/openai/chat.ts:36`) — `complete()` + optional `stream()`. The default implementation is `ClaudeAgentSDKChatBackend` (`packages/core/lib/openai/agent-sdk-adapter.ts`), which calls the headless `@anthropic-ai/claude-agent-sdk` `query()`.

**The port is config-driven, not hardcoded** (`CHOOMFIE_OPENAI_PORT`, default `4141` — `config.ts:44,163`). The backend is chosen in `createOpenAIEndpointHandler` (`openai-server.ts:143-147`) or injected via `options.chatBackend`.

### What building `:4142` mechanically requires

A second copy of the same server, on a different port, with a different backend:

1. **New backend** `InteractiveClaudeChatBackend implements ChatBackend` — mirrors `agent-sdk-adapter.ts`, but instead of `query()` it drives an **interactive `claude` session** (see the open question below).
2. **Second sidecar process**: launch `openai-server.ts` with `CHOOMFIE_OPENAI_PORT=4142`, a distinct config selecting the interactive backend, and its own PID/log (`interactive-endpoint.pid` / `.log`).
3. **Launcher wiring** in `bin/choomfie`: `start_openai_endpoint_sidecar` (`bin/choomfie:456`) gets a sibling for `:4142`; `stop`/`restart`/`status`/`doctor` learn about it.
4. **Config already exists**: `hermes-overlay/config.yaml:26-37` already registers the `choomfie-interactive` provider at `:4142`. Once the server is real, the picker just works.
5. **Tests**: reuse the `openai-server.test.ts` pattern (inject a fake `ChatBackend`, no network).

None of that is hard. **The hard part is step 1's "drive an interactive session."**

### ⚠️ The open question that gates everything (Phase 0 spike)

The **entire reason** for an interactive bridge is billing: as of **2026-06-15**, headless Agent-SDK usage draws from a **separate metered credit pool**, not the flat-rate Claude plan — even though `:4141` already logs in with the subscription (`bin/choomfie:472` strips `ANTHROPIC_API_KEY`).

So the interactive bridge only has value **if a programmatically-driven session actually bills at the flat rate.** That is **unverified and uncertain**:

- `claude -p` (print/headless) and the Agent SDK are both "programmatic" → almost certainly **metered**, same as `:4141`. Building on these buys us nothing.
- A **PTY-driven interactive session** (automate a real TTY) *might* bill flat-rate — but it's fragile (parse TUI/ANSI output, no clean API), and the billing behavior could change or run against the plan's terms.

**Recommendation:** Do a **1-day spike first** — drive a session both ways, run a few requests, and check the usage dashboard to see which pool gets charged. **Go/no-go gate:**

- ✅ If a drivable session bills flat-rate → build `:4142` (Phase 1).
- ❌ If everything programmatic is metered → **don't build it.** The honest answer becomes: `:4141` (SDK) is your metered brain, and `choomfie claude` stays as the flat-rate path. We'd then invest in cleanup + updater instead.

**Do not build the bridge before the spike passes.** It's cheap to build and worthless if billing doesn't cooperate.

---

## Part 2 — Does `choomfie claude` become redundant?

**No — not from the interactive bridge alone.** This is the key correction to the original plan.

The interactive bridge is a **model-routing / cost** change. It does **not** carry the feature stack. Everything rich about Claude Code mode lives in ~30k LOC that Hermes mode doesn't have:

| Feature | LOC | In Hermes mode? |
| --- | --- | --- |
| tutor (FSRS SRS engine) | ~9,975 | scaffold only |
| socials (YouTube/Reddit/LinkedIn/Twitter OAuth) | ~7,833 | guidance skill only |
| voice (full-duplex VAD/STT/TTS/barge-in) | ~2,245 | deferred |
| reminder **buttons/nag/snooze** (<100ms, no LLM) | in `lib/tools` | text-only in Hermes |
| persona CRUD (`/newpersona`, modals) | `persona-tools.ts` | native `/personality` only |

`choomfie claude` is today's **escape hatch** for all of the above (this rule is written into `hermes-overlay/SOUL.md:15-17`). It only becomes deletable **after** those features are ported to Hermes plugins/skills — a separate, much larger track.

**So the roadmap is:**
- **Interactive bridge** = solves *cost* (maybe — pending spike). Ships first.
- **Feature porting** = solves *redundancy*. Long-term. Only then can `choomfie claude` and ~30k LOC be deleted.

### What eventually gets deleted (once features are ported)
`bin/choomfie-claude-code`, `supervisor.ts`, `worker.ts`, `server.ts`, `daemon.ts` + `daemon/`, `local-server.ts`, `lib/discord.ts`, `lib/mcp-*.ts`, `lib/handlers/`, `lib/orchestrator/`, most of `lib/tools/`, and `plugins/`.

### What MUST stay no matter what
`packages/core/openai-server.ts` + `lib/openai/**` + `lib/config.ts` + `lib/version.ts` — this **is** Hermes's brain. The interactive bridge *adds* to this layer.

---

## Part 3 — Cleanup we can do now (cheap, independent of the bridge)

The investigation surfaced real config debt worth fixing regardless of the bridge decision:

1. **Two sources of truth for tools.** `config.yaml` `tools.enabled` (`web, browser, github, memory, session_search, todo`) disagrees with what `apply_profile_defaults` actually sets (`bin/choomfie:253` enables `web terminal file skills todo memory session_search clarify cronjob messaging`, disables `browser code_execution vision image_gen tts delegation computer_use`). **Fix:** make `config.yaml` match reality, or drop the list from `config.yaml` and let the launcher own it — one source.
2. **`config.yaml` is seed-only** (`sync.sh` copies it only if absent); real state lives in Hermes's own mutated config. **Fix:** document this clearly, or stop shipping a misleading full `config.yaml`.
3. **`doctor` validates the seed, not live state** (`bin/choomfie:640`). **Fix:** point doctor at the live `hermes config get` output.
4. **`cron/` is referenced but missing** (`distribution.yaml:9`, `sync.sh:61` — no-op). **Fix:** create it or remove the reference.
5. **`choomfie-interactive` is dead config** until Part 1 ships. **Fix:** gate it behind a flag or add a "not yet routable" note so the picker doesn't mislead.

These are small, safe, and make the whole thing less confusing.

---

## Part 4 — Hermes features we're not using

Hermes ships **70+ built-in tools**; Choomfie gates most **off for cost**. Available but unused:

`browser`, `code_execution`, `vision`, `image_gen`, `tts`, `delegation/subagents`, `computer_use`, `todo/kanban`, richer `messaging`, `HomeAssistant`, and a **native memory write path**.

**Worth considering (low effort, high value):**
- **`delegation`/subagents** — background/parallel work from within a session.
- **`todo`/kanban** — already partly on; could back reminders or task tracking.
- **`image_gen` / `vision`** — cheap wins for a Discord bot if cost is acceptable.

**Leave off (deliberate):** `code_execution`, `computer_use`, `browser` — cost/safety gated on purpose.

This is a menu, not a requirement. Recommendation: turn these on **one at a time**, behind the cost watcher (`scripts/token-budget.sh` already warns at 2M/day, hard-stops at 3M).

---

## Part 5 — Updates & an auto-updater

### Today
Fully **manual**, two axes:
- **Overlay** (our config): `choomfie sync` / `choomfie update` copy local files into the profile; applied on next `start`/`restart`. Never pulls git.
- **Engine** (upstream Hermes): pin-based via `hermes.pin` + `choomfie hermes-update [--check|--pin|--to-pin]`.

### Current drift (measured today)
- Installed Hermes: **v0.13.0**, pin **matches** (`271883447`) — we're on our known-good build. ✅
- Upstream `origin/main` is **6157 commits ahead**. That's a **huge** jump.

**Taking that update is a real decision, not routine.** 6157 commits could easily break the lean profile. **Recommended approach:**
1. `choomfie hermes-update --check` (done — confirms the drift).
2. Do it **in a throwaway checkout / off-hours**, not on the live bot.
3. `choomfie hermes-update` → `choomfie doctor` → smoke-test Discord → only then `--pin`.
4. If doctor/smoke fails: `choomfie hermes-update --to-pin` rolls back instantly.

### Proposed auto-updater (the primitives already exist)
Add `choomfie hermes-update --auto`:
```
fetch upstream → if drift → update → doctor
   ↳ doctor passes → re-pin, restart, notify "updated to <sha>"
   ↳ doctor fails  → --to-pin rollback, notify "update failed, rolled back"
```
Plus an optional **scheduled drift check** (Hermes `cronjob`, which reminders already use) that just **notifies** on drift — never auto-applies a 6000-commit jump silently. Human approves the actual pull.

Building blocks that already exist: `hermes_drift_status` (`bin/choomfie:95`), `--check`, doctor as a gate, `--to-pin` rollback. The updater is mostly **glue**, low risk.

---

## Suggested phasing

| Phase | Work | Gate |
| --- | --- | --- |
| **0** | Interactive **billing spike** — does a driven session bill flat-rate? | Go/no-go for Part 1 |
| **1** | Build `:4142` interactive bridge (only if Phase 0 passes) | — |
| **2** | Config cleanup (Part 3) — safe, do anytime | — |
| **3** | Update helper `--auto` + drift-check cron (Part 5) | — |
| **4** | Adopt 1–2 Hermes features behind cost watcher (Part 4) | — |
| **Long-term** | Port voice/tutor/socials/reminder-buttons → retire `choomfie claude` (Part 2) | Big track |

**Fastest path to "it just works":** Phase 0 → (1 if green) → 2 → 3. Redundancy/deletion is the long tail.

---

## Decisions I need from you

1. **Interactive billing spike** — OK to run the Phase 0 experiment before building anything? (Strongly recommended — it may kill the whole bridge idea cheaply.)
2. **Hermes update** — want me to attempt the 6157-commit jump now (carefully, with rollback ready), or hold until we've decided the bigger direction?
3. **Scope for this round** — just the interactive bridge, or bundle the cheap cleanup (Part 3) + updater (Part 5) too?
