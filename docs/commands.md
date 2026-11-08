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
- `/brain [name] [threads]` — who answers in this channel/thread (owner only). No name: what answers here, for whom, and which brains are loaded. A name (`claude`, `waymond`, …) switches; `claude` clears the override. `threads:false|true` turns auto-thread off/on for this server text channel (config `inlineChannels`). Brain output is posted with mentions disabled, so it can never ping `@everyone`, a role or a user. A brain's quick replies arrive as `brain:choice:<n>` buttons (in-memory, so a restart expires them); clicking one sends that option, gated like typing to the brain. Approval requests arrive as `brain:approval:yes|no` buttons and are **owner-only** whatever `brainAccess` says, since approving acts as the owner's account. Routing lives in `lib/brain-router.ts`; brains register via `registerBrain` and post late results via `pushBrainReply`, both from `@choomfie/shared`
- `/stop` — interrupt the reply in progress in this channel (owner only). Other brains stop through `Brain.stop`. Claude stops only in daemon mode: the worker writes a `stop` control request, and the daemon calls the Agent SDK's `interrupt()` on the turn in flight, keeping the session (like Esc). Stop requests go stale after 20s, so a leftover one can't cut off a later turn. It also closes that chat's unanswered `/choomfie` placeholders with "⏹️ Stopped." In foreground it says to press Esc in the terminal
- `/compact` — free up this chat's context, keeping a handoff summary (owner only, daemon mode). In a channel answered by another brain it explains that the brain manages its own context
- `/clear [cwd]` — start a new chat here with whichever brain answers here; `/resume` brings the old one back (owner only, no confirm — only this location changes). Claude: daemon mode only, optionally in another project (`cwd`, one of config `chatRoots`). Other brains: any mode
- `/resume [chat]` — no argument: the chat live here, recent ones with Resume buttons, and a Rename button (modal). `chat:` (autocomplete, titles across all brains) resumes it directly. Owner only; works in group DMs. See **Chats** below
- `/plugins [action] [name]` — list, enable, or disable plugins (owner only, restart needed)
- `/config [setting] [value]` — list settings with current values, or change one (owner only, ephemeral). `value` autocompletes from the selected setting's suggestions
- `/mode [name]` — put this chat in one of its brain's modes, or list them (owner only, autocompletes). Modes belong to web brains: A chat with no mode runs in its brain's default mode — Waymond's is `auto`: it researches first, then answers a question, runs a one-mode job straight away (the chat switches to that mode, with a "→ cad mode" note), or writes a plan whose tasks come back as buttons, plus **▶ Run all** (in order, stops at a failure). `/mode` overrides it; `/mode off` goes back to the default. Waymond has `code` (edits a GitHub repo in its sandbox, runs the tests, hands back a patch), `debug` (reproduce with a failing test, root cause, fix), `plan` (talks it through, writes requirements + design + tasks), `cad` (OpenSCAD → STL + previews + checks) and `3d` (Blender). A plan's task list is posted as buttons (owner only): each opens a thread in the plan's server channel, set to that task's mode, and runs the task there; the button becomes a link to the thread (⏳ → ✅/❌). A code/debug task whose line names a repo (`— in owner/name: …`) works on one branch per plan: on the first such task the Mac clones the repo (or creates it, private) and starts `plan/<name>-<id>`; each task gets that branch attached as a git bundle (Waymond's sandbox can't clone a private repo), and the patch it hands back is committed and pushed there — the first commit opens one draft PR for the whole plan. A patch that doesn't apply, or no patch, fails the task (Run all stops). Nothing from a patch runs on the Mac (`git apply`, hooks off). Clones live in `<data dir>/plans/`; GitHub's branch is the truth — the clone is reset to it before each bundle and commit (a push you made elsewhere is picked up; a failed push leaves nothing behind), git work on a clone runs one at a time, a missing clone is re-cloned, a big repo goes as a snapshot of its files, and a repo you can't push to is refused up front. CAD and 3D tasks in a plan with a repo work on the same branch: every file they link is committed to `cad/` or `models/` (renders in `renders/`, same name replaces, the repo's `.gitignore` respected), and they get the bundle too in case they need earlier files. Boards are saved in `meta/task-boards.json` (30 days), so their buttons survive a restart; a task a restart cut off shows as failed. A failed task's button retries it, and Run all becomes "Run the remaining N". A patch sent later in a task's thread (after you reply "continue") gets a **Commit to the plan's branch** button instead of a PR button. Clones no saved board uses are deleted at startup (they're only a cache of the branch). The PR button creates a repo that doesn't exist yet (private, patch as first commit). The mode's instructions ride along on every message; `off` goes back to plain chat. `/clear mode:` starts a new chat in a mode. A reply with a `.patch` file and a `repo: owner/name` line gets an **Open draft PR** button (owner only): a temp shallow clone, `git apply`, push to a new `waymond/…` branch, `gh pr create --draft` — nothing from the patch runs on the Mac
- `/model [model] [everywhere]` — view or change the model (owner only, autocompletes). In a Claude chat in daemon mode it sets **this chat's** model (stored on the chat; `default` clears it) and the session reopens on it at the next message, history kept. `everywhere:true` — and foreground mode, or a channel answered by another brain — changes the default instead. `/clear model:` starts a new chat on a model
- `/voice` — voice provider setup wizard with auto-detection and interactive buttons (owner only)
- `/lesson` — start or continue a structured lesson (button-driven, no Claude roundtrip)
- `/progress` — show learning progress with unit bars and completion stats (ephemeral)
- `/help` — show all commands and capabilities
- `/choomfie <prompt> [file] [private]` and the **Ask Choomfie** message menu (right-click → Apps) — see below

### Chats (`/resume`, `/clear`)

A **location** is a thread, channel, DM or group DM (its `channelId`). A **chat** is one conversation with one brain, with that backend's own id (`backendRef`: a Waymond conversation, a Claude SDK session). `chat_bindings` says which chat is live at each (location, brain) — keyed by brain too, so `/brain` away and back finds the old chat. A chat is live in at most one location; resuming it elsewhere moves it. Tables and queries in `lib/chats/store.ts` (same SQLite DB, own tables); plugins get it as `ctx.chats` (`ChatsApi` in `@choomfie/shared`). Routing only — never consulted for access.

- `/resume` lists the brain answering here, most recent first, with up to 5 `chat:resume:<id>` buttons and `chat:rename:<id>` (opens a modal; renames the thread too for a web brain's chat in a thread)
- `/resume chat:` searches titles across all brains; resuming a chat of another brain also points this channel at that brain
- `/clear` is the only way to start a chat on purpose; otherwise a chat starts with the first message. A thread is its own location, so it gets its own chat automatically and inherits the channel's brain
- **Auto-thread** (`lib/chats/auto-thread.ts`): an explicit `@mention` in a server text channel opens a thread off that message (named from it) and answers there, so each mention becomes its own chat. Inside a thread the bot started, every allowlisted message is answered with no mention needed. Replies to the bot, ambient follow-ups, threads, forum posts, announcement channels and DMs never open one, and the parent channel isn't put into conversation mode. Without **Create Public Threads** it answers inline and says so once per channel. Off per channel with `/brain threads:false`. In daemon mode each of those threads (and each DM) is its own Claude session

**Claude chats are per location too.** In daemon mode each location has its own session ([daemon.md](daemon.md#chats-and-sessions)); the worker binds the chat (`ChatStore.current`, titled from the first message) before the message reaches the daemon, and the daemon records each chat's SDK session id. Foreground mode can't swap the terminal's session: `/resume` says so and shows the session id for `claude --resume`.

`cwd` must resolve (symlinks included) to `chatRoots` from config.json or below — a bypassPermissions session can reach whatever its cwd is, so the list is edited by hand, not from Discord. A cwd outside the plugin dir loads that project's CLAUDE.md instead of this one; the persona and tools still come from the plugin.

### Group DMs and other chats the bot isn't in (`/choomfie`)

A bot can't join a group DM, but a **user-installed** app can be used there. Setup, once, in the Developer Portal: your app → **Installation** → tick **User Install**, add the `applications.commands` scope under its default install settings, then open the install link and choose **Add to My Apps**.

Only `/choomfie`, the **Ask Choomfie** menu, `/access`, `/brain`, `/resume`, `/stop`, `/clear` and `/mode` are user-installable (`ANYWHERE` in `@choomfie/shared`). Every other command is deployed with explicit `integration_types: [GuildInstall]` / `contexts: [Guild, BotDM]` (`GUILD_INSTALL_ONLY`, applied in `getCommandDefs`) — left unset, Discord would fall back to the app's install types and enabling User Install would make every owner command usable from any chat.

There, Choomfie sees only the command text or the one right-clicked message (plus its attachments) — never the chat — and can only answer through the interaction, which Discord keeps open for **15 minutes**. `lib/ask-relay.ts` wraps the interaction as a `SendableChannel` (first send replaces the "thinking…" reply, the rest are follow-ups), so brain replies, quick-reply buttons and approval cards work unchanged. Claude gets a synthetic `ask:<interaction id>` chat id: `reply` answers through the relay, every other Discord tool returns a clear "only `reply` works here". Same gates as a typed message — allowlist, rate limit, then the chat's brain under `brainAccess` — and `/brain` works per group DM. A brain's late background results post there only while the 15 minutes last; after that they stay in the brain's own app.

A normal reply can't reach Choomfie there, so the conversation continues through interactions:
- **💬 Reply** (`ask:reply`) sits under every answer that has no buttons of its own. Its text box also takes up to 10 files (a modal `FileUpload` field), and so does the Ask Choomfie box. It's stateless, so it survives restarts and works on older answers too. It opens a text box, and the follow-up quotes a 500-character excerpt of the answer it replies to, so it makes sense even after the Claude session cycles.
- **Ask Choomfie** opens a text box for an optional instruction ("summarize this") before sending the right-clicked message. The target is held in memory for the few seconds the box is open.
- **The question is quoted above the answer** (`> **user:** …`, mentions disabled), because nobody else in the chat can see a modal's text or which message was right-clicked.
- **A placeholder nobody answers** is changed to "⌛ No answer this time" just before the window closes, rather than turning into Discord's "did not respond".
- **Reminders set from an `ask:` chat go to the user's DM** (`set_reminder` swaps the chat id), since the chat can't receive them later.
- **`/clear` works there** and follows the chat's brain: a Waymond group DM gets a fresh Waymond chat.
- **Anyone else in the chat** can read the answers, but 💬 Reply and the menu refuse them unless they're allowlisted (and Waymond answers per `brainAccess`).
- **Brains get `BrainMessage.progress`**, which updates the "thinking…" placeholder. Waymond uses it for its status line and approval notice. It's ordered with the sends, so a late status line never overwrites the answer.

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
