# Choomfie + Hermes Integration Plan

Status: implementation baseline added. The repo now includes a Hermes overlay,
Hermes-first launcher, Claude Code mode launcher, memory export/import tooling,
launcher smoke tests, and a feature parity/deferred-work matrix. Live Discord
and voice parity still require manual E2E validation with a real Hermes install
and Discord bot token.

## Thesis

Choomfie should use Hermes as the runtime and Discord gateway substrate, while
Choomfie remains the product layer: personality, defaults, learning behavior,
voice taste, memory policy, workflows, and user-facing Discord experience.

```text
Hermes upstream
  owns: gateway, Discord connection, sessions, agent loop, provider routing,
        platform delivery, approvals, cron, skills/plugins, tool runtime

Choomfie overlay
  owns: personality, Choomfie defaults, tutor, memory policy, reminders UX,
        voice behavior, bento workflows, socials/browser opinions, docs/setup

Claude Code mode
  owns: direct Claude Code CLI runtime, Claude Code plan path, and sidecar
        features until each vertical slice is proven on Hermes
```

The boundary is simple: Hermes handles infrastructure; Choomfie handles product
behavior.

## Current Evidence

Choomfie currently provides a Discord-native personal agent as a Bun monorepo:

- Discord bridge through `discord.js`, including DMs, server mention/reply
  triggers, slash commands, modals, buttons, attachments, and owner/allowlist
  access control.
- MCP/Claude Code integration, supervisor/worker restarts, daemon mode, and
  local Ollama mode.
- Core tools for Discord, memory, personas, reminders, GitHub, status, and
  system restart.
- Optional plugins for voice, browser, tutor, and socials.
- Choomfie-specific tutor modules, voice behavior, reminders, persona switching,
  and Discord command UX.

Hermes currently provides a broader agent substrate:

- A long-running gateway with many platform adapters, including Discord.
- Unified platform message normalization, session keys, SQLite session storage,
  platform delivery, DM pairing, token locks, slash command dispatch, hooks,
  cron ticking, and background maintenance.
- Discord-specific support for threads, command sync state, safe allowed
  mentions, dedup after reconnects, typing loops, attachments/media caching,
  button approvals, model selection UI, and voice receive/playback paths.
- A shared `AIAgent` loop across CLI, gateway, cron, API server, and ACP.
- Provider/model routing, tools/toolsets, MCP, browser and web tools, terminal
  backends, profiles, skills, plugins, memory provider plugins, cron, subagent
  delegation, and self-improvement/curator behavior.

Sources checked:

- Choomfie `README.md`, `docs/architecture.md`, `docs/plugins.md`,
  `docs/local-mode.md`, `docs/voice-optimization-roadmap.md`,
  `packages/core/lib/discord.ts`, `packages/core/lib/commands.ts`, and plugin
  packages.
- Hermes upstream docs: `website/docs/developer-guide/architecture.md`,
  `website/docs/developer-guide/gateway-internals.md`,
  `website/docs/user-guide/profiles.md`, `RELEASE_v0.12.0.md`, and
  `gateway/platforms/discord.py`.

## Target Runtime Shape

```text
Discord
  -> Hermes DiscordAdapter
  -> Hermes GatewayRunner
  -> Hermes SessionStore
  -> Hermes AIAgent
  -> Choomfie profile/SOUL + skills/plugins/toolsets
  -> Hermes delivery back to Discord

Claude Code sidecar, only when needed:
  Hermes/Choomfie plugin or tool
    -> Claude Code mode service for unported voice/tutor/social behavior
    -> response/status back through Hermes gateway
```

Choomfie should not maintain a second Discord gateway long-term if Hermes can
own it. Claude Code mode should stay available because it covers the direct
Claude Code CLI/subscription path and mature Choomfie features.

## Implemented Baseline

- `hermes-overlay/` contains the Choomfie profile distribution files, isolated
  sync scripts, skills, hooks, and starter Hermes plugins for commands,
  reminders, and tutor workflows.
- `bin/choomfie` is Hermes-first and syncs the overlay into
  `~/.choomfie-hermes/profiles/choomfie` by default before launching Hermes.
- `bin/choomfie-claude-code`, `choomfie claude-code`, and `choomfie claude`
  expose the Claude Code-powered path.
- `packages/core/scripts/hermes-memory.ts` exports Claude Code mode memory into
  curated categories and renders a markdown import draft instead of raw-dumping
  rows.
- `docs/hermes-migration.md` and `hermes-overlay/docs/feature-parity.md`
  document setup, ownership, deferred items, and manual E2E checks.
- Automated coverage includes Hermes launcher smoke tests and memory migration
  categorization/export tests.

## Ownership Matrix

| Capability | Choomfie Today | Hermes Today | Planned Owner | Do Not Duplicate |
| --- | --- | --- | --- | --- |
| Discord gateway connection | `discord.js` worker | `discord.py` adapter in unified gateway | Hermes | Do not rebuild gateway lifecycle, reconnect, token locking, or generic delivery in Choomfie. |
| Discord message sessions | Channel activity + in-memory local history; Claude/MCP notifications | Persistent session keys and SQLite session storage | Hermes | Do not keep a parallel Choomfie session DB except where Claude Code mode needs it. |
| Discord auth/pairing | Owner auto-detect, allowlist, `!pair` | Allowlists, role auth, DM pairing, default-deny, token locks | Hermes with Choomfie policy defaults | Do not port Choomfie's allowlist format directly unless needed for migration import. |
| Slash commands | `/remind`, `/memory`, `/persona`, `/plugins`, `/voice`, etc. | Gateway slash command dispatch and command registry | Shared: Hermes dispatch, Choomfie command behavior | Do not build a second command dispatcher; add Choomfie commands through Hermes extension points. |
| Discord buttons/modals | Choomfie-specific reminders/personas/voice setup | Approvals, confirm prompts, model picker, UI views | Shared | Reuse Hermes interaction primitives; only implement Choomfie-specific flows. |
| Typing / busy behavior | Typing indicator state machine | Typing loops, active-agent guards, queued interrupts | Hermes | Do not maintain Choomfie's local typing state once on Hermes gateway. |
| Attachments/media | Downloads attachments into Choomfie inbox | Media/document caching and multi-platform delivery | Hermes | Do not duplicate generic attachment caching. Choomfie may add domain-specific import behavior. |
| Agent loop | Claude Code/Agent SDK, local Ollama runtime | AIAgent used by CLI/gateway/cron/API/ACP | Shared by mode | Do not duplicate Hermes orchestration; keep Claude Code mode for direct Claude Code CLI usage. |
| Model/provider routing | Claude Code, Agent SDK, local Ollama/Hermes spike provider | Many providers, model catalogs, fallback, dashboard/model picker | Hermes | Do not maintain Choomfie's local model registry after migration. |
| Tool runtime | MCP tools plus plugin tools | Central tool registry, toolsets, terminal/browser/web/MCP tools | Hermes | Do not port generic browser/shell/web primitives unless Choomfie needs special policy. |
| Browser automation | Playwright plugin | Browser tool backends and web tools | Hermes by default | Keep Choomfie browser only if it has Discord-specific screenshot/upload UX Hermes lacks. |
| Memory storage | Core + archival SQLite memory, summary tools | Session DB, memory files/providers, memory manager, self-improvement | Hermes storage, Choomfie policy | Do not raw-dump Choomfie memory into Hermes. Curate categories and import intentionally. |
| Personas/personality | Switchable personas from Discord | Profile `SOUL.md`, profile-specific config/state | Choomfie overlay on Hermes profiles | Do not reimplement full persona system if Hermes profiles/SOUL cover it. Add lightweight switching only if needed. |
| Reminders | SQLite reminders, recurring cron, nag/snooze/ack buttons | Cron jobs with platform delivery | Choomfie plugin on Hermes cron | Do not duplicate scheduling. Implement Choomfie reminder semantics over Hermes cron. |
| Tutor | Rich modules, SRS, lessons, buttons, progress | Generic skills/plugins, no Choomfie tutor equivalent | Choomfie | This is distinctive; port as Choomfie skill first, then plugin. |
| Voice | Discord voice, local/cloud STT/TTS, VAD, fillers, barge-in, multi-speaker | Discord voice paths, TTS registry, Piper, CLI voice parity | Evaluate; likely Choomfie plugin/sidecar first | Do not assume Hermes voice matches Choomfie UX. Compare before replacing. |
| Socials | YouTube, Reddit, LinkedIn integrations | Tools/plugins ecosystem; some native integrations like Spotify/Meet | Case-by-case | Do not port generic integrations if Hermes already has equivalent tools. Keep Choomfie-specific workflows. |
| GitHub | PR/issues/notifications command via `gh` | Tool/MCP ecosystem may cover GitHub | Hermes tools plus Choomfie command UX | Avoid a separate GitHub stack unless Choomfie notification workflow needs it. |
| Bento/background work | Local background worker concept | Cron, subagents, delegate tool, gateway delivery | Choomfie workflow on Hermes primitives | Do not build another background orchestrator. Use Hermes cron/subagents. |
| Plugins | Bun workspace plugin API | Hermes plugins, skills, hooks, toolsets | Hermes extension model, with Claude Code mode support | Do not preserve Bun plugin API as the future Hermes API. Keep it where Claude Code mode needs mature features. |
| Install/update/profile | `install.sh`, Claude/Bun setup | Profiles, profile distributions, profile-scoped services | Choomfie distribution over Hermes profile install | Do not invent a separate global state layout. Use isolated Choomfie Hermes home/profile. |

## Migration Phases

### Phase 0: Product Contract

Define what Choomfie promises independent of implementation:

- Discord-native personal agent.
- Strong personality and memory continuity.
- High-quality learning/tutor workflows.
- Good voice conversations.
- Background bento/task execution.
- Owner-safe permissions.
- Local-first options where practical.

This prevents the migration from becoming "whatever Hermes supports today."

### Phase 1: Hermes Gateway Baseline

Goal: prove Hermes can own Discord for normal Choomfie chat.

Deliverables:

- `choomfie` launches Hermes gateway with a Choomfie profile/overlay.
- `choomfie claude-code` still launches the Claude Code-powered runtime.
- Choomfie uses isolated Hermes state, for example `~/.choomfie-hermes`.
- Discord DMs, server mentions, replies, sessions, and Choomfie personality work.
- Setup docs explain provider keys, Discord token, and profile state.

Success criteria:

- Run the Hermes-backed Choomfie for normal text chat for a day without needing
  the old Discord shell.

### Phase 2: Choomfie Discord UX

Goal: make Hermes Discord feel like Choomfie rather than generic Hermes.

Port or configure:

- Choomfie display name, status/help language, and response style.
- Mention/reply/free-channel behavior.
- Owner/allowlist defaults and migration.
- `/status`, `/memory`, `/persona`, `/lesson`, `/voice` surface commands.
- Approval and confirmation flows.
- Thread behavior and home-channel defaults.

Prefer Hermes config, hooks, skills, and plugins before patching upstream.

### Phase 3: Memory Migration

Goal: preserve useful Choomfie memory without polluting Hermes memory.

Export Choomfie memory into categories:

- profile facts
- preferences
- relationship context
- recurring workflows
- durable long-term notes

Import curated summaries into Hermes. Keep old SQLite read-only until there is
confidence the import is correct.

Rule: never blindly dump all Choomfie rows into Hermes.

### Phase 4: Tutor Vertical Slice

Goal: port the most distinctive bounded feature first.

Start skill-first:

- Start/resume Spanish, Japanese, French, or Chinese.
- Remember active module and level.
- Quiz, correct, retry, and track basic progress.

Promote to a plugin when needed:

- SRS scheduling.
- Discord buttons.
- Lesson catalog.
- Per-user concurrent sessions.
- Progress embeds and analytics.

### Phase 5: Reminders On Hermes Cron

Goal: replace Choomfie's scheduler with Hermes cron while preserving Choomfie UX.

Port:

- one-shot reminders
- recurring reminders
- original-channel/DM delivery
- snooze, ack, nag behavior

If Hermes cron lacks a reminder semantic, build a Choomfie reminder plugin on top
of cron rather than a new scheduler.

### Phase 6: Voice Evaluation

Goal: decide from behavior, not architecture preference.

Compare:

- Discord voice receive reliability.
- DAVE/E2EE handling.
- STT latency and accuracy.
- TTS quality and streaming.
- interruption/barge-in.
- multi-speaker behavior.
- Choomfie filler/persona behavior.

Likely interim shape:

- Hermes owns Discord text gateway.
- Choomfie voice remains a plugin or sidecar until Hermes voice matches the
  current Choomfie experience.

### Phase 7: Bento / Background Agents

Goal: use Hermes strengths instead of duplicating Choomfie's local worker.

Map Bento-ya to:

- Hermes cron.
- Hermes subagents/delegation.
- Choomfie task-claiming skill.
- Discord progress reports through Hermes delivery.

### Phase 8: Runtime Boundary Decision

After text, memory, tutor, reminders, and voice have real usage data, choose:

- retire the Bun/Claude Code runtime,
- keep Bun as a voice/specialty sidecar,
- split Claude Code mode into a separate repo,
- or keep hybrid indefinitely if the operational cost is justified.

## Extension Rule

Avoid hard forking Hermes.

Preference order:

1. Choomfie overlay config.
2. Choomfie Hermes skill.
3. Choomfie Hermes plugin.
4. Hermes gateway hook.
5. Upstream Hermes PR.
6. Temporary Choomfie patch.
7. Hard fork only if a proven Choomfie vertical slice cannot work otherwise.

## Open Questions

- Which Hermes extension point should own Choomfie slash commands: plugin, hook,
  or upstream command registry contribution?
- Can Hermes Discord mention/reply behavior be configured to match Choomfie
  without patching `DiscordAdapter`?
- How much of Choomfie's persona switching should become Hermes profile
  switching versus a lighter "style mode" inside one profile?
- Does Hermes voice handle Discord receive/playback well enough for Choomfie's
  existing barge-in and filler expectations?
- Which Choomfie social integrations are still unique after comparing Hermes'
  current tools and plugin ecosystem?
- Should Claude Code mode run as a sidecar service with a small RPC surface
  during the migration, or only as a manual `choomfie claude-code` runtime?
