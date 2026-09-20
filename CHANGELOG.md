# Changelog

## Unreleased — Single-Instance Guard

### Fixed

- **The supervisor's single-instance guard had silently become a no-op.** It identified a running instance by grepping the `ps` command line for `"choomfie"` or `"server.ts"`. Deleting `server.ts` in the runtime consolidation changed the supervisor's command to `bun packages/core/supervisor.ts`, which matches neither — so starting a second supervisor no longer stopped the first. Two supervisors meant two workers connecting the same bot token to the Discord gateway and both writing the same heartbeat file, leaving the daemon monitoring whichever wrote last rather than its own worker. Process identification now lives in `@choomfie/shared`'s `pid-utils.ts`, used by both the supervisor guard and the daemon's worker probe. Matching is on entry-point filenames only — a `"choomfie"` marker matched any command line mentioning the repo or data directory (an ordinary shell reading `meta/`, say), which with a recycled PID would mean signalling an unrelated process or refusing to start on its behalf.

### Changed

- **Running `choomfie` while a daemon is supervising an instance now refuses instead of killing it.** Taking over the PID file is correct when you re-run `choomfie` in a terminal — the old foreground instance is stale. It is wrong when launchd is supervising one: killing that supervisor makes the daemon restart its session and spawn a replacement, and the two ping-pong. The daemon's own supervisor is exempt via `CHOOMFIE_DAEMON_PID`, injected into its session env; anything else gets an actionable error naming `--stop` and `install:launchd --uninstall`.

### Added

- `bin/choomfie` makes the same check *before* launching the Claude CLI, so the message reaches your terminal instead of the MCP subprocess's stderr where Claude Code buries it. Skipped for `--daemon`, where taking over from a previous daemon is the intent.
- `packages/core/test/regression/pid-guard.test.ts` derives the expected supervisor and daemon command lines from `package.json`'s `start` and `daemon` scripts, so renaming or moving a long-lived entry point fails here rather than silently disarming the guard in production. One-shot scripts (`deploy-commands`, `reset`) are asserted *not* to match, since matching them risks signalling a script that holds no PID file.

## Unreleased — Boot Deadlock + Real Health Checks

### Fixed

- **Module-scope import deadlock that could hang worker boot.** `lib/interactions.ts` loaded its handler modules with top-level `await import()`, and those handlers imported `registerButtonHandler` back from `lib/interactions.ts` — a cycle. Whenever the cycle was entered from the handler side (`worker.ts` → `lib/context.ts` → `lib/reminders.ts` → `lib/handlers/reminder-buttons.ts` → `lib/interactions.ts` → `await import(reminder-buttons)`, still evaluating up the stack), the import never resolved. Observed effect: the worker never reached `ready` and the supervisor fell back after its 30s timeout; `bun test` never completed. The AppContext-typed register wrappers now live in `packages/core/lib/register.ts`, which nothing imports back, and the handler imports moved out of module scope into `registerAllHandlers()`, called explicitly by `worker.ts` and `scripts/deploy-commands.ts`. Importing `lib/interactions.ts` is now side-effect free. Worker boot went from timing out at 30s to ready in ~100ms; `bun test` went from hanging to 280 passing in ~2s, unblocking 5 test files (55 tests) that could not run at all.
- **`tokenUsageToday` was never incremented** — only `totalInputTokens` was, so `/status`'s "Token Usage Today" always reported 0. It now accumulates per turn, rolls over on date change, and deliberately survives session cycles (which reset the per-session counter).

### Added

- `install.sh` offers to set up auto-start at login (macOS). Opt-in prompt, skipped automatically on a non-interactive install, and presettable with `CHOOMFIE_AUTOSTART=y`. Deliberately an install-time question rather than a `config.json` setting: it writes a launchd agent and calls `launchctl`, so it is a system-level change the running process has no business making on its own.

### Changed

- **Worker health is a real heartbeat, not a PID check.** The worker writes `meta/worker-health.json` every 10s with `{pid, discordReady, wsPing, lastEventAt, updatedAt}`; the daemon treats a stale beat (>45s) or a disconnected Discord gateway as unhealthy. The previous check only asked whether a process existed, so a worker whose gateway had dropped or whose event loop was wedged passed indefinitely. Falls back to the old process check when no heartbeat exists yet, so a booting worker is never cycled. Contract is shared in `packages/shared/worker-health.ts` because the daemon sits outside the worker's process tree and has no IPC channel to it.
- Health states that a restart cannot fix are reported but never cycled. Without a configured `DISCORD_TOKEN` the gateway never connects, so the stricter check above would otherwise have cycled the session every ~90s indefinitely — each cycle spawning a fresh Claude Code session. The worker now publishes `discordConfigured`, and the daemon logs `DEGRADED` and holds instead. Same principle as the Anthropic auth-error change: don't spend restarts on problems restarts don't solve.

## Unreleased — Runtime Consolidation

One process topology, one settings file, Anthropic only. See
[docs/runtime-consolidation-plan.md](docs/runtime-consolidation-plan.md) for the
full rationale.

### Removed

- Local/Ollama chat runtime. `packages/core/lib/orchestrator/` (chat provider, model registry, model router, idle monitor, background worker, Discord handler, MCP stub, local runtime), `packages/core/local-server.ts`, `packages/core/bin/choomfie-local`, and `packages/core/lib/local-commands.ts` (the `/model` and `/local` Discord commands). Dropped rather than kept as half-wired scaffolding — there is no hardware here to run useful local chat models, and local mode could never do tool calls because it bypassed MCP by design. **To revive it, check out `c72db0b`** (the commit before this one); Phase 0 of the consolidation plan is the map of what to re-wire.
- `--local` / `-l` / `CHOOMFIE_LOCAL=1` run mode, the `start:local` script, and `config.json`'s `local` section (`LocalConfig`, `getLocalConfig`, `setLocalConfig`, `isLocalEnabled`).
- `packages/core/server.ts`. It had become a pure passthrough once the `--local` branch went; `bun run start` and `@choomfie/core`'s `main`/`bin` now point straight at `packages/core/supervisor.ts`.
- Daemon Anthropic→Ollama fallback: `OLLAMA_BASE_URL` / `OLLAMA_MODEL` / `ANTHROPIC_FALLBACK_THRESHOLD`, the `ModelProvider` type, `activeProvider` / `anthropicFailureCount` state, `applyAnthropicFailure`, and the already-unreachable `--test-fallback` CLI path.
- `localFirst` / `localModel` / `ollamaUrl` from `ChoomfieConfig` (never read by anything) and the `choomfie-local` OpenAI-endpoint model alias (its `backend: "ollama"` was never dispatched on).
- `docs/local-mode.md`.

### Added

- `config.json` `daemon` section (`tokenThreshold`, `turnThreshold`), replacing hardcoded constants in `packages/core/daemon/constants.ts`. Resolved by `daemon.ts` at startup and threaded through daemon state, so `daemon/` still never imports `lib/`.
- `resolveDataDir()` in `@choomfie/shared` — one resolver honoring `CHOOMFIE_DATA_DIR` then `CLAUDE_PLUGIN_DATA` then the default, replacing the same path hardcoded in seven places across two env var names with inconsistent precedence. Previously, setting `CHOOMFIE_DATA_DIR` before `install.sh` wrote your Discord token to a directory the runtime never read.
- `packages/core/lib/openai/ollama-embeddings.ts` — shared endpoint/model resolution and response parsing for the two Ollama embedding call sites. Local embeddings stay: it is a small model, unrelated to the local-chat hardware constraint, and Anthropic has no embeddings API to replace it with.

### Changed

- `install-launchd.sh` now installs the real runtime (`bin/choomfie --daemon`, label `dev.choomfie.daemon`, logs in `~/Library/Logs/choomfie/`) instead of the Ollama-only local server. The plist pins `PATH` to include the resolved `claude` binary and sets `HOME`, both of which launchd's minimal environment otherwise lacks — without them the service starts and immediately fails. Installing or uninstalling also clears the superseded `dev.choomfie.local` plist.
- `install.sh` now advertises `bun run install:launchd` for boot persistence.
- Daemon retry: authentication and billing errors (401/402, `unauthorized`, `authentication_error`, billing/credit/quota) abort the retry loop immediately with a clear message instead of burning all 10 backoff rounds on an error retrying cannot fix. Rate limits and overload (429/529) still retry.
- `docs/architecture-v2.md` corrected — its "the MCP layer becomes unnecessary" design was never shipped; daemon mode wraps the same supervisor → worker MCP stack.

## Unreleased — Remove Hermes Runtime

### Removed

- Hermes-mode runtime and dual-runtime architecture. Choomfie is now Claude Code-only (foreground, `--tmux`, or `--daemon`).
- `hermes-overlay/` (SOUL.md, config.yaml, skills/plugins/hooks, sync tooling).
- `bin/choomfie` (Hermes-first launcher) — `bin/choomfie-claude-code` is now the single `bin/choomfie` launcher.
- `packages/core/lib/openai/hermes-adapter.ts` and the `"hermes"` OpenAI-endpoint routing mode; the endpoint now always routes through the Claude Agent SDK.
- `packages/core/scripts/hermes-memory.ts` (Hermes memory export/draft tooling).
- Hermes planning/handoff/migration docs (`docs/hermes-*.md`, `docs/choomfie-vs-hermes.md`, `docs/choomfie-handoff-codex.md`, `docs/choomfie-reminders-handoff.md`) and the `hermes:sync` / `hermes:doctor` package scripts.

## 0.6.0 — OpenAI-Compatible Endpoint (2026-05-16)

### Added

- Local OpenAI-compatible endpoint at `http://127.0.0.1:4141/v1`.
- API key issue/list/revoke commands with hash-only key storage.
- OpenAI-shaped models, chat completions, embeddings, files, and Responses subsets.
- Chat Completions streaming with data-only SSE and `[DONE]` termination.
- Choomfie extension routes for app-scoped memory, Discord notify, and skill invocation.
- Claude Code supervisor sidecar lifecycle and Hermes launcher sidecar lifecycle.
- Hermes routing support with standard-route pass-through and non-streaming CLI chat fallback.

## 0.5.0 — Monorepo (2026-04-02)

### Breaking Changes

- Restructured from flat layout to Bun monorepo with workspace packages
- Core infrastructure in `packages/` (shared, core), plugins in `plugins/` (voice, browser, tutor, socials)
- Old `lib/`, `server.ts`, `supervisor.ts`, `worker.ts` moved into `packages/core/`
- Old `skills/` moved to `packages/core/skills/`

### Added

- `@choomfie/shared` — shared types, utilities, time helpers, path resolution
- `@choomfie/core` — MCP server, Discord bridge, memory, reminders, tools
- `@choomfie/voice` — voice plugin (STT/TTS/VAD)
- `@choomfie/browser` — browser plugin (Playwright)
- `@choomfie/tutor` — tutor plugin (FSRS, lessons, Japanese module)
- `@choomfie/socials` — socials plugin (YouTube, Reddit, LinkedIn)
- `PluginContext` type in shared package — minimal context subset for plugins
- `findMonorepoRoot()` — resilient project root resolution
- Explicit workspace package map in plugin loader

### Changed

- Plugins import from `@choomfie/shared` instead of relative `../../lib/` paths
- Plugin interface (`Plugin`, `ToolDef`, `text()`, `err()`) defined in shared package
- Time utilities (`parseNaturalTime`, `formatDuration`, etc.) moved to shared package
- Interaction registries moved to shared package (dispatch stays in core)
- `VERSION` constant reads from root `package.json`
- Entry point is `packages/core/server.ts` (via `bun run start`)
- All docs updated with new `packages/` paths

### Removed

- `plugins/` directory (replaced by `packages/`)
- Duplicate type definitions across packages
- Dead `findMonorepoRoot` argument in boot test

## 0.4.0 — Socials Plugin (2026-03-28)

- LinkedIn integration (17 tools — posts, comments, reactions, scheduling, analytics)
- YouTube OAuth commenting
- Reddit read/write
- Interaction system (buttons, slash commands, modals)
- Structured lessons with `/lesson` and `/progress`

## 0.3.0 — Tutor Plugin (2026-03-26)

- Language learning with FSRS spaced repetition
- Japanese module (JLPT N5-N1, dictionary, kana, furigana)
- Quiz generation, SRS review tools
- 718 JLPT N5 vocabulary cards

## 0.2.0 — Voice & Browser (2026-03-25)

- Voice plugin (Silero VAD, streaming TTS, multi-speaker, interruption handling)
- Browser plugin (Playwright, persistent sessions)
- Supervisor/worker architecture
- Hot-reload via worker restart

## 0.1.0 — Initial Release (2026-03-20)

- Discord bridge via MCP
- Two-tier memory (core + archival)
- Reminders with cron, nag, snooze
- Switchable personas
- GitHub integration
- Permission relay
- Claude Code skills
