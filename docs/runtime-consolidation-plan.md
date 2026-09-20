# Runtime Consolidation Plan

**Status:** Executed 2026-09-19 — see the CHANGELOG entry for what shipped
**Author:** Kevin Jiang (design), Claude (investigation + drafting)
**Date:** 2026-09-19

## How execution diverged from this draft

The problem statement and the locked-in decisions below all held up. Four things
changed once the code was actually mapped:

1. **Phase 0's file list was incomplete.** It missed `background-worker.ts`,
   `discord-handler.ts`, and `model-router.ts`. All three turned out to be
   local-only, so the whole `lib/orchestrator/` directory went rather than the
   six files named below.
2. **Deleted instead of archived.** `archive/local-mode/` would have needed a new
   `eslint.config.js` ignore and a `bunfig.toml` test exclusion (there is no
   bunfig, so `bun test` globs `*.test.ts` repo-wide). Matching the Hermes
   precedent — straight `git rm`, git history as the archive — avoided both.
   **Revival point: `c72db0b`.**
3. **Phase 3 was not mechanical.** The two `OllamaEmbeddingProvider`s have
   incompatible contracts — `lib/memory.ts` is sync/nullable/single-text on a sync
   call chain, `lib/openai/embeddings.ts` is async/batch/throwing. Only the
   endpoint-and-model resolution and the response parsing were extracted, into
   `lib/openai/ollama-embeddings.ts`; each side keeps its own transport adapter.
   Converting memory to `fetch` (security-audit F-SHELL-2) stays deferred, since
   it would make `searchArchival()` async and serialize a per-row loop.
4. **Three adjacent issues were folded in**: `isAnthropicError` was kept (and
   narrowed to `isUnrecoverableAnthropicError`) so auth/billing failures abort the
   retry loop instead of burning ten backoff rounds; `resolveDataDir()` in
   `@choomfie/shared` replaced the data-dir path hardcoded in seven places across
   two env var names; and the launchd plist now pins `PATH` to the resolved
   `claude` binary and sets `HOME`, without which the repointed service would
   start and immediately fail.

Also deferred, deliberately: `packages/core/daemon/constants.ts` still holds
`CONTEXT_CHECK_INTERVAL`, backoff bounds, and worker-health tuning as constants.
Only the two cycling thresholds moved to `config.json` — those are the ones worth
tuning per machine.

The original draft follows unchanged.

---

## Problem

Choomfie currently ships 4 launchable code paths that look like a deliberate
multi-runtime design but are not — they're organic sprawl:

1. **Normal mode** (`bin/choomfie`) — `claude` CLI → `supervisor.ts` → `worker.ts` (MCP stdio)
2. **Daemon mode** (`bin/choomfie --daemon`) — Agent SDK session that *itself* spawns
   the same `claude` CLI → `supervisor.ts` → `worker.ts` stack underneath, wrapped in
   auto-cycling/crash-recovery. Also carries dead-weight Anthropic→Ollama fallback logic.
3. **Local mode** (`bin/choomfie-local` / `--local`) — a fully separate single-process
   stack that bypasses supervisor/worker/MCP entirely via a `LocalMcpStub`, talks to
   Ollama directly, and — as a direct consequence of bypassing MCP — cannot do tool
   calls at all (`docs/local-mode.md:112`).
4. **OpenAI-endpoint sidecar** — an optional HTTP process spawned by the supervisor,
   orthogonal to the above three (kept as-is, not in scope here).

Concrete costs of this today:
- **Two config systems**: `ConfigManager`/`config.json` (modes 1 & 3) vs. hardcoded
  env-var constants in `daemon/constants.ts` (mode 2) — no single source of truth.
- **Two nearly-identical bash launchers** (`bin/choomfie`, `packages/core/bin/choomfie-local`)
  with duplicated tmux/caffeinate logic.
- **Two separate `OllamaEmbeddingProvider` implementations** (`lib/memory.ts`,
  `lib/openai/embeddings.ts`).
- **`install-launchd.sh` only wires up mode 3** (local/Ollama) for boot-persistence —
  the runtime people actually use (normal/daemon, on a real Claude Code plan) has no
  launchd story at all.
- **`architecture-v2.md` documents an MCP-less daemon design that was never actually
  shipped** — the code still nests the full MCP stack underneath the daemon.

## Decisions locked in for this plan

- **Drop Ollama/local-model chat entirely for now.** No hardware to run useful local
  models. The whole local-runtime stack (chat orchestration, model discovery, the
  MCP-bypass shim) gets **archived**, not ported forward.
- **Keep local embeddings.** `OllamaEmbeddingProvider` (semantic memory search) stays
  active — it's a tiny embedding model, unrelated to the "good hardware" constraint,
  and Anthropic has no embeddings API to replace it with. The two duplicate
  implementations get merged into one.
- **MCP stays mandatory for every attachment mode.** Foreground mode requires it
  structurally (that's how Claude Code CLI plugins work); daemon mode gets it for
  free by reusing the same plugin path instead of reimplementing Discord/tool
  handling a second time. `architecture-v2.md`'s "daemon doesn't need MCP" claim gets
  corrected, not chased.
- **Settings/config UI (webUI vs. file vs. CLI) is explicitly out of scope for this
  plan** — separate follow-up, see "Deferred" below.

## Target architecture

One process topology, two independent, orthogonal settings:

```
Claude Code CLI (foreground/tmux)  ─┐
                                      ├─→ supervisor.ts (immortal, MCP stdio) → worker.ts (Discord + plugins + tools)
Agent SDK session (--daemon)       ─┘
```

- **Attachment mode** — how you run it: `choomfie` (foreground), `choomfie --tmux`,
  `choomfie --always-on` (tmux + caffeinate), `choomfie --daemon` (headless,
  auto-cycling, crash recovery). Unchanged from today, single launcher script.
- **Provider** — collapses to "Anthropic only" for now. The `ModelProvider` /
  fallback abstraction in daemon mode is removed rather than left as unused
  scaffolding — it can come back later as a real feature if local hardware changes,
  but half-wired dead code is worse than nothing.

Single config source of truth, split by kind (this split already exists and works —
just needs to be applied consistently):
- **Secrets** → `$CLAUDE_DATA_DIR/.env` (`DISCORD_TOKEN`, `ANTHROPIC_API_KEY`,
  voice provider keys). Already loaded correctly by `lib/context.ts`.
- **Behavior/settings** → `config.json` via `ConfigManager`. Daemon's cycling
  thresholds (`TOKEN_THRESHOLD`, `TURN_THRESHOLD`) move here from
  `daemon/constants.ts` env vars, so *every* mode reads settings the same way.

## Execution phases

### Phase 0 — Archive the local/Ollama chat runtime

Move to `archive/local-mode/` (new top-level dir, **outside** the `packages/*` /
`plugins/*` bun workspace globs so it's inert — no build/test/type-check picks it up):

- `packages/core/local-server.ts`
- `packages/core/bin/choomfie-local`
- `packages/core/lib/orchestrator/local-runtime.ts`
- `packages/core/lib/orchestrator/chat-provider.ts` (Ollama chat REST client)
- `packages/core/lib/orchestrator/model-registry.ts` (Ollama model discovery)
- `packages/core/lib/orchestrator/idle-monitor.ts` (GPU-busy heuristic)
- `packages/core/lib/orchestrator/mcp-stub.ts` (`LocalMcpStub`)
- `packages/core/lib/local-commands.ts` (`/local`, `/model` Discord commands)
- `docs/local-mode.md`

Add `archive/README.md` explaining why these are here and what "reviving" would
require (re-wire into `server.ts`'s mode branch, restore `config.local`, re-add the
launcher).

Then, in the active tree:
- `packages/core/server.ts:7-24` — delete the `--local` / `CHOOMFIE_LOCAL=1` branch
  entirely. `server.ts` always goes to `supervisor.ts`.
- `packages/core/lib/orchestrator/index.ts` — delete (only re-exported `LocalRuntime`).
- `packages/core/lib/types.ts:64` — remove `localRuntime` field from `AppContext`.
- `packages/core/lib/discord.ts:316` — remove the `ctx.localRuntime` branch in message
  handling.
- `packages/core/lib/config.ts` — remove `LocalConfig`, `DEFAULT_LOCAL_CONFIG`,
  `getLocalConfig`/`setLocalConfig`/`isLocalEnabled`.
- `packages/shared/plugin-context.ts:26` — remove `ollamaUrl?` field if nothing else
  uses it after the above.
- `package.json` — remove `start:local` script.
- Confirm `bun test` no longer references any archived file (delete or archive
  matching test files, e.g. anything under `packages/core/test/` that imports
  `local-runtime.ts`/`chat-provider.ts`/`model-registry.ts`).

### Phase 1 — Remove daemon's dead Ollama-fallback logic

This is small and entangled in shared files — delete outright rather than archive
(fully recoverable from git history if ever needed):

- `packages/core/daemon/constants.ts` — remove `OLLAMA_BASE_URL`, `OLLAMA_MODEL`,
  `ANTHROPIC_FALLBACK_THRESHOLD`. Keep `TOKEN_THRESHOLD`, `TURN_THRESHOLD` (these move
  to `config.json` in Phase 2, see below).
- `packages/core/daemon/types.ts` — remove `ModelProvider` type and
  `activeProvider`/`anthropicFailureCount` from `MetaState` (or leave `MetaState`
  fields but stop populating them — prefer removing cleanly).
- `packages/core/daemon/session-core.ts` — remove `isAnthropicError`,
  `applyAnthropicFailure`, and the `provider === "ollama"` branch in `createSession()`.
  `createSession()` always builds a plain Anthropic session.
- `packages/core/daemon/runtime.ts:139` — remove the fallback-switch log line and any
  call sites of `applyAnthropicFailure`.
- `packages/core/daemon/cli.ts:203-285` — remove the fallback-simulating
  `testCycle`/benchmark code path.
- `packages/core/test/regression/daemon-fallback.test.ts` — remove (tests a feature
  that no longer exists).

### Phase 2 — Fold daemon config into `config.json`

- Add a `daemon` section to `ConfigManager`'s schema: `{ tokenThreshold, turnThreshold }`
  (defaults matching today's `TOKEN_THRESHOLD`/`TURN_THRESHOLD` constants).
- `daemon/runtime.ts` reads these from `ConfigManager` instead of
  `daemon/constants.ts` at session-cycle decision points.
- Result: `config.json` is the single settings source for every remaining mode.

### Phase 3 — De-duplicate the Ollama embedding provider

- Create one shared implementation (suggest `packages/core/lib/embeddings/ollama-embeddings.ts`
  or fold into `packages/shared/` if it needs to be usable from both `core` and the
  OpenAI endpoint without a circular import).
- `lib/memory.ts` and `lib/openai/embeddings.ts` both import it instead of each
  maintaining their own copy.
- No behavior change — purely mechanical de-duplication.

### Phase 4 — Single launcher, real launchd support

- Delete `packages/core/bin/choomfie-local` (already gone after Phase 0).
- `bin/choomfie` remains the *only* launcher script — nothing left to de-duplicate.
- Rewrite `packages/core/scripts/install-launchd.sh` to point at the real runtime
  (`bin/choomfie --daemon`) instead of the now-archived `choomfie-local`. This is
  also the direct fix for "I want this running even with the lid closed" from
  earlier — `RunAtLoad` + `KeepAlive` finally applies to the runtime people actually
  use.
- Update `install.sh`'s final instructions to mention `bun run install:launchd` as
  the boot-persistence option (currently invisible to a first-time installer).

### Phase 5 — Docs cleanup

- `docs/architecture-v2.md` — correct the "MCP becomes unnecessary" claim to match
  shipped reality (daemon wraps the same MCP stack); update "Status" header.
- `docs/architecture.md`, `docs/supervisor-architecture.md`, `README.md`,
  `CLAUDE.md` — remove any remaining local-mode/Ollama-chat mentions, point to
  `archive/README.md` if historical context is useful.
- `CHANGELOG.md` — new entry documenting the archival + consolidation, following the
  same style as the "Remove Hermes Runtime" entry.

## Out of scope / deferred

- **Settings management UI** (config file vs. TUI vs. webUI) — separate follow-up
  once this consolidation lands. Recommendation when we get there: keep it file/CLI
  based (extend the existing `/choomfie:configure`-style skill pattern) rather than
  a webUI — a personal single-owner Discord bot doesn't need a second authenticated
  HTTP surface to protect, and the existing skill pattern already covers "prompt for
  a value, write it to the right place."
- **Reviving local/Ollama chat** if hardware changes later — `archive/local-mode/`
  plus this doc's Phase 0 section is the map back.

## Verification checklist (for whoever executes this)

- [ ] `bun run type-check` clean
- [ ] `bun test` — no references to archived files remain in any non-archived test
- [ ] `grep -ri "ollama" packages/ --include="*.ts"` — only hits are the kept
      embedding provider and its call sites
- [ ] `grep -rn "CHOOMFIE_LOCAL\|--local\|choomfie-local"` — zero hits outside `archive/`
- [ ] `install-launchd.sh` install/status/uninstall all work against `bin/choomfie --daemon`
- [ ] `bin/choomfie`, `bin/choomfie --tmux`, `bin/choomfie --daemon` all still start cleanly
