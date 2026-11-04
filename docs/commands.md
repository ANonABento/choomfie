# Commands, Interactions and Modals

How Discord slash commands, buttons and modal forms are defined, registered and
dispatched — and the full list of what ships today.

See [CLAUDE.md](../CLAUDE.md) for the rules that constrain this (the registry
split that prevents an import cycle, and global-only command deployment).

### Interaction System

Discord interactions (buttons, slash commands, modals) use a split architecture:
- **Registries** (`registerButtonHandler()`, `registerModalHandler()`, `registerCommand()`) live in `@choomfie/shared` (`packages/shared/interactions.ts`) so plugins can self-register without importing core
- **AppContext-typed register wrappers** live in `packages/core/lib/register.ts` — handler modules import from here, never from `interactions.ts`. Keeping them separate is what prevents the import cycle (handlers need `registerX` at import time; the router needs the handlers)
- **Dispatch logic** (`handleInteraction()`, `safeHandle()`) lives in `packages/core/lib/interactions.ts`. Importing it has no side effects — call `registerAllHandlers()` once at boot (done in `worker.ts` and `scripts/deploy-commands.ts`) to load the built-in handlers, which self-register on import
- **InteractionCreate** event registered in `packages/core/lib/discord.ts`, routes to `handleInteraction()`
- Plugin hook: `onInteraction?(interaction, ctx)` in the Plugin interface
- Button customId format: `prefix:action:data` (e.g. `reminder:ack:42`, `reminder:snooze:42:1h`)
- Error handling via `safeHandle()` wrapper — catches errors + replies gracefully
- **Autocomplete is the exception to `safeHandle()`.** A `CommandDef` may carry an optional `autocomplete` handler, routed *before* the chat-input branch. An AutocompleteInteraction has no `reply()`/`editReply()`, only `respond()`, so putting it through `safeHandle()` would throw inside the error handler. Its own catch responds with an empty list instead — a suggester that throws silently must not leave the user on a spinner that never resolves. Suggesters get 3 seconds and one response, so they must be synchronous work over in-memory data, never a network call
- All interactions bypass Claude — handled directly for instant response (<100ms vs ~5s)
- Key constraint: Discord requires response within 3 seconds; use `deferReply()` for async work
- Slash command definitions in `packages/core/lib/commands.ts`, deployed via `bun packages/core/scripts/deploy-commands.ts`
- Access control: `/persona switch|new`, `/memory save|forget` are owner-only via `requireOwner()`
- **Fewer commands, verbs as subcommands.** Each area is one command (`/remind`, `/memory`, `/persona`, `/access`), and anything that depends on who answers a channel (`/brain`, `/stop`, `/clear`, `/compact`, `/status`) works the same whatever the brain — the handler resolves the channel's brain once. Discord can't show different commands per channel, so per-brain command lists aren't possible; per-brain *behaviour* is.

### Slash Commands

Defined in `packages/core/lib/commands.ts`, deployed via `packages/core/scripts/deploy-commands.ts`:
- `/remind add|list|cancel <id>` — set a reminder (modal: message, time, recurring, nag), list active ones (embed, ephemeral), or cancel one by ID
- `/memory list|search <query>|save|forget <key>` — list core memories, search all memories, save one (modal), or delete one by key (ephemeral). `save` and `forget` are owner-only; `forget` autocompletes from existing core memory keys
- `/persona list|switch <key>|new` — list, switch (owner only, restarts; autocompletes), or create a persona (modal, owner only)
- `/access list|allow <user>|revoke <user>` — the allowlist (owner only, ephemeral). Refuses to revoke the owner; warns when emptying the list re-opens bootstrap mode
- `/github <check> [repo]` — check PRs, issues, notifications
- `/status` — bot status embed with uptime, persona, stats, plugins, **the brain answering this channel**; plus session/context/cycles when a daemon is supervising (ephemeral)
- `/usage` — plan rate-limit windows, session cost, and a per-model token breakdown (daemon mode, ephemeral)
- `/brain [name]` — who answers in this channel/thread (owner only). No name: what answers here, for whom, and which brains are loaded. A name (`claude`, `waymond`, …) switches; `claude` clears the override. Brain output is posted with mentions disabled, so it can never ping `@everyone`, a role or a user. A brain's quick replies arrive as `brain:choice:<n>` buttons (in-memory, so a restart expires them); clicking one sends that option, gated like typing to the brain. Approval requests arrive as `brain:approval:yes|no` buttons and are **owner-only** whatever `brainAccess` says, since approving acts as the owner's account. Routing lives in `lib/brain-router.ts`; brains register via `registerBrain` and post late results via `pushBrainReply`, both from `@choomfie/shared`
- `/stop` — interrupt the reply in progress in this channel (owner only). Works for any brain that supports it; Claude can't be interrupted from Discord yet and says so
- `/compact` — free up daemon context, keeping a handoff summary (owner only, daemon mode). In a channel answered by another brain it explains that the brain manages its own context
- `/clear` — replace the daemon session with nothing carried over (owner only, daemon mode, confirm button). In a channel answered by another brain it instead starts a fresh conversation with that brain for this channel only — any mode, no confirm, Claude untouched
- `/plugins [action] [name]` — list, enable, or disable plugins (owner only, restart needed)
- `/config [setting] [value]` — list settings with current values, or change one (owner only, ephemeral). `value` autocompletes from the selected setting's suggestions
- `/model [model]` — view or change the model Choomfie runs on, in every mode (owner only, autocompletes)
- `/voice` — voice provider setup wizard with auto-detection and interactive buttons (owner only)
- `/lesson` — start or continue a structured lesson (button-driven, no Claude roundtrip)
- `/progress` — show learning progress with unit bars and completion stats (ephemeral)
- `/help` — show all commands and capabilities

Commands are deployed **globally** — one command list for every guild and for DMs. Guild-scoped deployment is deliberately not used: Discord keeps the two scopes as separate lists and a guild command *shadows* a global one of the same name, so a leftover guild copy silently pins that guild to a stale definition. Every global deploy therefore also clears guild-scoped commands (`clearGuildCommands`).

Commands auto-deploy on startup when definitions change (hash-based check; the hash is prefixed with the scope, so switching scope self-migrates). Manual: `bun packages/core/scripts/deploy-commands.ts`. `--guild=<id>` is a dev-only escape hatch for instant iteration — it shadows global in that guild until you run `--clear-guilds`.

Trade-off: a newly added or renamed global command can take up to an hour to appear. Edits to an existing command's description or options are usually immediate.

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
