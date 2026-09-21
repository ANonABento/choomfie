# Choomfie — Claude Code Instructions

## Project Overview

Choomfie is a Claude Code plugin — an MCP server that bridges Discord to Claude Code with persistent memory, switchable personas, reminders, Discord interactions (buttons/slash commands/modals), GitHub integration, and more. It runs as a subprocess inside Claude Code via `--plugin-dir`. Version is defined in root `package.json` and read via `packages/shared/version.ts`.

**Runtime:** Bun · **Language:** TypeScript · **Protocol:** MCP over stdio · **DB:** SQLite via bun:sqlite · **Discord:** discord.js v14 · **Framework:** @modelcontextprotocol/sdk

## Reference Docs

This file holds the architecture and the rules that constrain changes. Inventories and walkthroughs live in `docs/` — read them when you need them rather than assuming:

| Doc | What's in it |
|---|---|
| [docs/tools.md](docs/tools.md) | Every MCP tool by name; embeds, polls, reminder system |
| [docs/commands.md](docs/commands.md) | Slash commands, modals, interaction dispatch, shared handler utils |
| [docs/configuration.md](docs/configuration.md) | `config.json` shape, every adjustable setting, `/config` and `/model` |
| [docs/daemon.md](docs/daemon.md) | Daemon mode, `/usage` reporting, the control channel |
| [docs/architecture.md](docs/architecture.md), [docs/supervisor-architecture.md](docs/supervisor-architecture.md) | Full supervisor/worker design |
| [docs/voice-plugin.md](docs/voice-plugin.md) | Voice providers, audio pipeline, setup |
| [docs/plugin-api.md](docs/plugin-api.md), [docs/plugins.md](docs/plugins.md) | Writing plugins |
| [docs/testing.md](docs/testing.md), [docs/roadmap.md](docs/roadmap.md) | Test strategy, what's done and what isn't |

## Project Structure

```
packages/
  shared/      # @choomfie/shared — types, time utils, paths, atomic writes,
               #   interaction registries, worker-health + daemon-control contracts
  core/        # @choomfie/core — supervisor.ts, worker.ts, daemon.ts
    daemon/    #   Agent SDK session runtime, handoffs, rate limits, health checks
    lib/       #   types.ts (AppContext), config, memory, reminders, discord,
               #   interactions.ts (dispatch), register.ts (typed wrappers),
               #   plugins.ts (explicit workspace package map), tools/, handlers/
    test/, scripts/, skills/, bin/
plugins/       # voice, browser, tutor, socials — workspace packages, each an
               #   index.ts exporting a Plugin
docs/, .claude-plugin/, .mcp.json
```

## Architecture

**Supervisor/Worker model:**

```
Claude Code ← MCP stdio → supervisor.ts (immortal)
                              ↕ Bun IPC
                          worker.ts (disposable)
```

- **Supervisor** owns the MCP server + `restart` tool. Never restarts — the MCP connection stays alive.
- **Worker** owns Discord + plugins + tools. Killed and respawned on restart (fresh code, clean state).
- IPC: tool calls routed supervisor → worker; notifications forwarded worker → supervisor → Claude.
- `McpProxy` in the worker duck-types the MCP Server interface so discord.ts/permissions.ts/plugins work unchanged.

Shared state flows through a single `AppContext` (`packages/core/lib/types.ts`, extends `PluginContext` from `@choomfie/shared`). Tools colocate their JSON schema definition + handler in one file as `ToolDef[]` arrays.

**Boot:** Claude Code loads the plugin and spawns `supervisor.ts` → supervisor acquires the PID file and spawns `worker.ts` via `Bun.spawn({ ipc })` → worker builds AppContext, calls `registerAllHandlers()`, loads plugins, connects Discord, starts its heartbeat → worker sends `{ type: "ready", tools, instructions }` → supervisor creates the MCP server with real instructions + tools and connects stdio → Claude Code calls `initialize` and gets the correct persona, security rules and tool list.

**Steady state:** Discord message → worker → IPC notification → supervisor → MCP → Claude Code. Tool call → supervisor → IPC `tool_call` → worker → handler → IPC `tool_result` → supervisor → Claude.

**Restart:** supervisor sends shutdown to worker → worker cleans up and exits → supervisor spawns a fresh worker → sends `tools/list_changed`.

**Crash recovery:** supervisor detects a non-zero worker exit and auto-respawns with exponential backoff, giving up after **5 crashes in 60s**.

**Shutdown** (SIGINT/SIGTERM/stdin close): supervisor tells the worker to shut down → cleans up the PID file → exits.

### Daemon Mode (`choomfie --daemon`)

```
daemon.ts (always running)
  └→ Claude Session (Agent SDK, disposable)
       └→ supervisor.ts (MCP stdio) → worker.ts (Discord)
```

`daemon.ts` is a thin CLI entry point; the runtime lives in `packages/core/daemon/`. Sessions are cycled when context gets heavy (~120k tokens or 80 turns), capturing a handoff summary first. Full detail in [docs/daemon.md](docs/daemon.md).

**Both launch paths must pass `--dangerously-load-development-channels server:choomfie`** — `extraArgs` in `createSession`, the flag itself in `bin/choomfie`. It puts the server on the session's channel allowlist. In foreground that is all it takes: without it every incoming Discord message is dropped and Choomfie never answers. In daemon mode it is necessary but not sufficient — see below.

### Inbound messages: two routes, one per process

**A daemon session can never register Claude Code's `claude/channel` capability**, so the MCP notification that carries a Discord message in foreground mode is dropped. That is why daemon mode was deaf for so long: bot online, typing indicator on, zero turns. The automatic registration runs only on the **interactive** MCP-connect path, and the SDK-facing `Query.enableChannel()` refuses anything that isn't marketplace-sourced, which `{ type: 'local', path }` can never be.

The capability was only a notification-to-prompt adapter, and the daemon already owns the prompt queue. So daemon-launched workers write each message to `meta/incoming/` and the daemon injects it itself (`packages/shared/daemon-incoming.ts` → `daemon/incoming.ts`). Full detail in [docs/daemon.md](docs/daemon.md).

- **Exactly one route per process**, chosen by `isDaemonOwnedProcess()`. A daemon-launched worker writes the file and sends **no** notification — that is what keeps the capability harmless if it ever starts registering.
- The injected prompt is byte-identical to Claude Code's `<channel …>` block, pinned by a test. Changing that shape changes how the persona behaves, invisibly.
- `enableChannelNotifications()` still runs and still fails; it is a tripwire, logged at `--verbose`. Do not remove it to quiet the log — silence is what made this take a day to find.

### Two launch paths, one behaviour

`packages/core/daemon/session-core.ts` (`createSession`) and `bin/choomfie` start the same bot two different ways, and **anything that decides how a session behaves has to be set in both.** This has now drifted three times — the channels flag, `daemon.model` vs top-level `model`, and permission mode — each time producing a bot that looked fine and quietly wouldn't do its job.

| | Daemon | Foreground |
|---|---|---|
| Channels flag | `extraArgs` in `createSession` | `--dangerously-load-development-channels` |
| Model | `models.model` from config.json | `--model` via `scripts/resolve-model.ts` |
| Permission mode | `bypassPermissions` | `--permission-mode auto` (override: `CHOOMFIE_PERMISSION_MODE`, or pass your own) |

Permission mode differs **deliberately**: a terminal session has a human in front of it who can still be asked about genuinely destructive things; a daemon answering Discord at 3am does not. Everything else in that table must match.

### Plugin System

Plugins live in `plugins/<name>/index.ts` as workspace packages and export a `Plugin`: `tools` (ToolDef[]), `instructions` (string[], appended to the system prompt), `intents`, `userTools`, `init(ctx)`, `onMessage(msg, ctx)`, `onInteraction(interaction, ctx)`, `destroy()`.

They import shared types from `@choomfie/shared`, never relative `../../lib/` paths. The loader (`packages/core/lib/plugins.ts`) uses an explicit workspace package map; `discoverPlugins()` returns the names from that map. Plugin tool names are collision-checked during load — a plugin with a duplicate name is skipped before registration.

Enable via `/plugins` from Discord, or `"plugins": ["voice", "socials"]` in config.json.

## Rules That Bite

Shapes and constraints that don't announce themselves. Getting one wrong compiles, or fails somewhere far away.

**Object shapes**
- `ToolDef` is `{ definition: { name, description, inputSchema }, handler }`. The name is at `t.definition.name`, **not** `t.name`.
- `CommandDef` is `{ data: RESTPostAPIChatInputApplicationCommandsJSONBody, handler, autocomplete? }`. The field is `data`, **not** `definition`.

**Interaction system** (full detail in [docs/commands.md](docs/commands.md))
- Registries (`registerButtonHandler`, `registerModalHandler`, `registerCommand`) live in `@choomfie/shared` so plugins can self-register without importing core.
- **AppContext-typed wrappers live in `packages/core/lib/register.ts` — handler modules import from there, never from `interactions.ts`.** Keeping them separate is what prevents the import cycle: handlers need `registerX` at import time, and the router needs the handlers.
- Dispatch (`handleInteraction`, `safeHandle`) lives in `lib/interactions.ts` and has no import side effects. Call `registerAllHandlers()` once at boot — done in `worker.ts` and `scripts/deploy-commands.ts`.
- **Autocomplete is the exception to `safeHandle()`.** An AutocompleteInteraction has no `reply()`/`editReply()`, only `respond()`, so routing it through `safeHandle` throws inside the error handler. Its own catch responds with an empty list. Suggesters get 3 seconds and one response: synchronous work over in-memory data, never a network call.
- Discord requires a response within 3 seconds — `deferReply()` for async work. `showModal()` must be the first response to an interaction (cannot defer first).

**Slash command deployment**
- Commands deploy **globally**. Guild-scoped deployment is deliberately not used: Discord keeps the two scopes as separate lists and a guild command *shadows* a global one of the same name, so a leftover guild copy silently pins that guild to a stale definition. Every global deploy therefore also calls `clearGuildCommands()`.
- Auto-deploys on startup when the definition hash changes (the hash is prefixed with the scope, so switching scope self-migrates). `--guild=<id>` is a dev-only escape hatch; it shadows global in that guild until you run `--clear-guilds`.
- Trade-off: a newly added or renamed global command can take up to an hour to appear. Edits to an existing command's description or options are usually immediate.

**State on disk**
- All JSON state (`config.json`, `access.json`, `meta/*.json`) is written atomically via `writeJsonAtomic` / `writeJsonAtomicSync` from `@choomfie/shared` — temp file + `rename(2)`. Never write these with a bare `writeFile`; a crash mid-write truncates them.
- **All SQLite datetimes use space-separated format (`YYYY-MM-DD HH:MM:SS`), never ISO 8601 with `T`/`Z`.** Use `@choomfie/shared` time utilities (`toSQLiteDatetime`, `dateToSQLite`, `nowUTC`).
- Single instance enforced via `choomfie.pid` (supervisor) and `meta/meta.pid` (daemon). Re-running `choomfie` replaces a stale foreground instance, but **refuses** when a daemon is supervising one — the daemon's own supervisor is exempt via `CHOOMFIE_DAEMON_PID`. Process identity comes from `@choomfie/shared`'s `pid-utils.ts`, not ad-hoc `ps` greps.
- `Config` carries a `[key: string]: unknown` index signature, so a removed key survives `...saved` unless actively stripped. `REMOVED_CONFIG_KEYS` in `lib/config.ts` does that, and `ConfigManager` rewrites the file once on load when it finds one.

**Process boundaries**
- **Console output goes to stderr — stdout is the MCP stdio transport.** Entry point is `packages/core/supervisor.ts`.
- **Hot-reload boundary:** worker code in `packages/core/` and all plugin packages are hot-reloadable via worker restart. Supervisor code (`supervisor.ts`, IPC types, MCP server) requires a full session restart (exit + re-run `choomfie`). `packages/shared/` changes require a worker restart at minimum.
- Auto-restart triggers: persona switch, plugin enable/disable, voice config change — all send `request_restart` IPC → supervisor restarts worker → confirmation to the Discord channel.
- The worker sits two processes below the daemon, so there is no IPC between them. `meta/worker-health.json` carries the heartbeat up; `meta/incoming/` carries inbound Discord messages up; `meta/control.json` carries `/compact` and `/clear` requests down; `meta/daemon-state.json` carries daemon state down (read by `/status`, `/usage`, and the rate-limit alerter).

**Settings**
- `model` / `fallbackModel` are **top level, not under `daemon`** — they are not daemon-specific. Both the daemon (via the Agent SDK) and foreground/`--tmux` (via `bin/choomfie` → `scripts/resolve-model.ts`) read the same value. They used to live at `daemon.model`, which meant `/model` silently did nothing in foreground mode; `mergeConfig` migrates the old key forward and drops it.
- Settings are declared once in `packages/core/lib/settings.ts` with their parser, bounds, suggestions and when the change takes effect. Add one there and `/config` picks it up automatically. `suggestions` are hints, not an allowlist.
- **Do not add a `ConfigManager` setter without a caller.** `setRateLimitMs`, `setConvoTimeoutMs` and `setDaemonConfig` sat uncalled for a long time while this file claimed settings were adjustable, and they weren't. Likewise `autoSummarize` exists in `Config`, is read by nothing, and is deliberately absent from `/config` — a switch that does nothing is worse than no switch.

**Rate limits and usage**
- The SDK's `rate_limit_event` payload **does not match the SDK's own types.** `SDKRateLimitInfo` declares one flat window; some builds instead send an undeclared `unifiedWindows` object holding every window, with the flat fields describing only the tightest. `parseRateLimitInfo` prefers `unifiedWindows` and falls back; `/usage` labels a lone window "binding window only".
- **The snapshot only updates on a turn.** An idle session's figures stop moving and go stale — observed 10.9h old, still rendering a window that had reset hours earlier. `isRateLimitStale` / `viewRateLimitWindows` in `lib/daemon-status.ts` are the single source of truth for "is this still true"; both `/usage` and the alerter go through them.
- `modelUsage` and `total_cost_usd` on a result are **session-cumulative** (verified: a model's `inputTokens` climbs across results), so they are assigned, not accumulated. `usage.input_tokens` is per-turn and *is* accumulated. Getting these backwards silently double-counts.
- `state.rateLimit` is account-level and deliberately **not** reset by `startSession`. `state.modelUsage` is per-session and is reset.

## Key Details

- Owner auto-detected from Discord app info: during `./install.sh` (primary) or startup fallback if missed
- Permission relay: owner receives tool approval requests via DM, replies `yes/no <code>`
- State lives in `~/.claude/plugins/data/choomfie-inline/` (token, access list, database, inbox)
- Personality loaded from core memory (key: `personality`) at startup
- Memory auto-compactor: core memories capped at 20; oldest auto-archived with `[auto-archived]` prefix and `auto-archived,core-memory` tags
- DMs require `Partials.Channel` + `Partials.Message` in discord.js
- Attachments downloaded to `…/choomfie-inline/inbox/` (`file_path` = first, `file_paths` = all, semicolon-separated)
- GitHub integration shells out to `gh` via `lib/handlers/github.ts` (15s timeout)
- Servers: only responds when @mentioned or replied to. DMs: always responds. @mentions stripped before forwarding
- Rate limit + conversation timeout configurable in config.json (`rateLimitMs` default 5s, `convoTimeoutMs` default 5 min)
- Typing indicator: state machine in `lib/typing.ts`. `keep_typing: true` on `reply` holds it between multi-message workflows. Safety timeout 2 min; skipped for conversation_mode
- Allowlist loaded at startup from access.json; `allow_user`/`remove_user` update in-memory + persist (no restart). Manual file edits require a restart
- Personas stored in config.json, switchable from Discord (auto-restarts worker)
- `search_messages` paginates up to 1000 messages for user/keyword filtering
- Owner-only: `/persona switch`, `/newpersona`, `/savememory`, `/plugins`, `/config`, `/model`, `/allow`, `/revoke`, `/compact`, `/clear`, `/voice`, and the birthday tools

## Token Budget

This file is loaded into every daemon session's context and re-read from cache on every turn, as is `docs/` content you open. Measured: at 31.7KB it was ~7,900 tokens — roughly a quarter of the session's entire resident context, for documentation a Discord persona never needs. Keep it to rules and architecture; put inventories, walkthroughs and examples in `docs/`.

The same applies to plugins: their tool schemas and instructions are resident too (voice ~511, browser ~844, tutor ~2,211, socials ~4,232 tokens). Enable only what's in use.
