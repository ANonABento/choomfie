# Changelog

## Unreleased — Rate-Limit Alerts, Honest `/usage`, Lighter Context

### Added

- **A local classifier stage, and a way to measure classifiers.** Free first compares a message to example messages per bucket with a local embedding model (Ollama `nomic-embed-text`, ~10 ms, nothing sent anywhere, no quota); when it's sure (≥ 0.8) it answers alone, otherwise the zero-shot model decides, and if that call fails the embeddings guess beats the keyword rules. `bun run apibrain eval free` scores each stage on 73 labelled messages: keywords 36%, embeddings 77%, zero-shot 97%, the pipeline 97% with 37% fewer calls. `free.classifier.embeddings: false` turns it off.
- **Agents talking to agents.** Brains declare `capabilities` (`agentic`, `local`, `web-search`, `image-gen`, `music-gen`, `video-gen`, `vision`, `long-context`). Free routes media by what's asked (a song only to brains that make music; a picture to Gemini web, then Waymond), counts any capable brain as a member without a config line, and offers a **Hand this to …** button per capable brain (up to 3). `delegate` lists who can do what, takes `model` (`to: "free"` for cheap drafts and summaries), and is depth-limited. Web brains with local tools can ask another brain with an `#!ask <id>` block; its answer goes back to the site and its files to you. A long `/brain` handoff is summarized by free's models, the last three messages word for word.
- **Harnesses over ACP.** Antigravity and OpenCode now run through their ACP servers (`agy acp`, `opencode acp`): tool calls show on the status line during a long run, a permission request becomes an Allow / Deny card for the owner, and the chat's session is resumed with `session/load`. Print mode stays as `harnesses.<id>.acp: false`. The status line is shared now (`statusLine` in `@choomfie/shared`, used by web brains too).
- **Free remembers what a harness did.** A harness reply carries a `record` (files changed, commands run); free keeps it in the transcript, so after **Back to auto** the next model knows what changed. `file:///` links in harness replies become plain names.
- **Several accounts per web brain.** `bun run webbrain login <id> --profile 2` adds a spare account with its own browser and allowance. A chat stays on its account; when one is out (or out of one kind, like Gemini's music), the work moves to the next, in a fresh conversation with a note. Free only sees the site as out when every account is. `/brain status` shows which accounts are out.
- **A model that keeps failing ranks lower; OVHcloud off by default.** Each busy / 5xx / timeout in a row costs a model a point in ranking (up to three) until it answers again, so the classifier stops trying Gemini's gemma-4 first (30 of 32 calls "high demand") before Groq. OVHcloud's anonymous tier answered 1 call in 45: it's opt-in now (`free.providers.ovh.enabled: true`).
- **`/brain free`, no `name:` to type.** The name is required now, so Discord opens it straight away; `/brain status` (the first suggestion) shows what answers here, as a bare `/brain` did. `threads` goes with either: `/brain status threads:false`.
- **Out of one kind of media, not out altogether.** Gemini caps music, images and video separately ("I can create more music as soon as your limit resets"): `QuotaReachedError` carries a `scope`, and free benches only that kind (`mediaKindOf` reads it from the message), so pictures still go to Gemini while songs can't. The text model's answer says why ("-# Gemini web is out of its free music allowance for now — answered by …"). Waymond left the `media` bucket: it can't make a song or a picture, and a song request landed there silently. Gemini's quota check no longer matches a bare "try again later" (an error, not a limit), and the web brain turn log keeps the site's own words (`detail`).
- **Links for brain files that still don't fit Discord.** With `remoteMcp.publicUrl` set (the Tailscale Funnel address), a file ffmpeg can't shrink under 10 MB is saved to `<data>/shared-files/` and linked as `<publicUrl>/f/<token>/<name>`: served by the remote MCP endpoint without the bearer (the 24-byte token is the key), expiring after 7 days.
- **Brain files over Discord's 10 MB limit are shrunk, not refused.** `fitForDiscord` (`@choomfie/shared`, ffmpeg, no ffprobe needed) runs on every brain reply before posting: a song becomes audio-only .m4a (Gemini's 7.5 MB track → 3.1 MB), a video is re-encoded at a bitrate sized to fit and scaled down, a picture becomes a JPEG. A file that still can't fit (no ffmpeg, or too long to watch at that size) is left out with a `-#` note instead of Discord refusing the whole message.
- **Web brain turn log.** `<data>/webbrain/<id>/turns.jsonl` (`bun run webbrain log <id>`): each turn's start, end or error, commands asked / run / declined, and adapter notes (`t.log`). The rolling JSONL writer is shared (`JsonlLog` in `@choomfie/shared`; apibrain's `CallLog` uses it).
- **More look-only commands** for web brains' local tools: `sysctl` reads, `memory_pressure`, `pgrep`, `nettop -l 1`, `ioreg`.
- **Gemini as a web brain; web brains can check this Mac and commit.** New `webbrains` plugin: one adapter file per site in `sites/`, each registered once its profile is logged in (Waymond stays its own plugin). First site: Gemini, `/brain gemini-web` (`gemini` stays the API provider): attachments in, images back, `/stop`; free sends `media` and `research` to it first, Waymond after. **Local tools** in the web-brain kit (`localTools` per adapter, owner only): the site asks for a command in a code block starting `#!run`; look-only ones (`df`, `git status`, …) run at once and their output goes back to the site, anything else (commit, push, writes) waits for a Run / Don't run card. `webbrain doctor <id> --tools` checks a site asks the right way.
- **Out of quota is a state, not a failure; a `media` bucket; site terms on record.** A web brain or harness that says its free allowance is spent throws `QuotaReachedError` (shared, with the reset time read from its words by `parseResetAt`; harnesses match `RESOURCE_EXHAUSTED`, "quota exhausted", "usage limit", 429 …). Free benches that member until the reset instead of retrying or counting failures; a chat it held is offered to a member that does the same work (OpenCode when Antigravity is out) with no pointless Retry. New `media` bucket (make an image, music, a video, a voice clip) for the media sites to come, Waymond meanwhile; `agentic` is cloud work only. Adapters record what a site's terms say about bots (`terms`), shown by `webbrain sites`; `docs/webbrain.md` has the account rules.
- **`defaultBrain` (`/config`): who answers where `/brain` set nothing.** `free` makes every new channel, thread and DM start on the free brain; `/brain claude` still pins one back. Unloaded → Claude.
- **OpenCode harness; free hands work on this computer to a harness and takes it back.** `/brain opencode` (no account: Zen's free models). Free's new `local` bucket sends work that has to happen on this machine to Antigravity, then OpenCode, the way `agentic` goes to Waymond; a holding member's replies now carry **Hand back to free models**, which returns the chat to the API models with the member's replies in their history. Harness runs get `PWD` set to their folder (OpenCode wrote into Choomfie's checkout without it). `/config defaultBrain` autocompletes from the same live brain list as `/brain` (shared `brainChoices`, `brainLabel`, `isBrainId`).
- **Harness brains: coding-agent CLIs answer in Discord.** New kit `@choomfie/harness` and plugin `harnesses`: `/brain antigravity` runs Google's Antigravity CLI (`agy`, free on a weekly quota) once per message, resuming its own conversation per chat, in a folder per chat; attachments go in, files it makes come back, `/stop` kills the run. Anyone but the owner gets its read-only mode. Adding a CLI is one spec file. See `docs/harness.md`.
- **`/compact` for web brains.** The site is asked for a summary in its conversation; the next message opens a fresh site conversation that starts with it.
- **`bun run webbrain sites` and `webbrain setup`.** Every web brain, logged in or not (checked headless, nothing sent), then the login window for each one that isn't — the web-brain counterpart of `apibrain keys`.
- **`/brain free`: free API tiers and web brains behind one router.** New kit `@choomfie/apibrain` (OpenAI-compatible client, key pools, cooldowns, quota, model catalog, transcripts, classifier) and plugin `free` (OpenRouter, Groq, Gemini, NVIDIA NIM, SambaNova, Cloudflare, Ollama; one `/brain <provider>` each). API models float per message by a zero-shot classifier; a web brain (Waymond) takes a chat on its first message, through its modes, or by "Hand this to Waymond", then holds it until `/model auto`, and never loses it silently on a failure. See `docs/free-brain.md`, `docs/brains-plan.md`.
- **Free brain: no model ids in code; see what was sent.** Each provider's live `/models` gives the candidates (free chat models, newest of each family), ranked per need (fast, strong, vision, long, tiny) from size, tier, context, measured latency and scarce quotas; buckets name needs, config can still pin. Each listed model is tried once and the result kept (`meta/apibrain-models.json`), so Gemini's listed-but-not-free models (`limit: 0`) are skipped. Every request, reply and routing decision goes to `apibrain/calls.jsonl`; `bun run apibrain log [--full]` reads it. The doctor shows each bucket's routing now.
- **`bun run apibrain keys`** lists every free provider (key set or not, its allowance and catch), and `keys setup` / `keys add <provider>` open the key page, take the key hidden, check it and save it to the data dir's `.env`. **11 more providers:** Cerebras, Mistral, Cohere, Z.ai, Aion, AxForge, Gonka, Runcrate, and keyless Kilo, LLM7 and OVHcloud (on by default; `free.providers.<id>.enabled: false` turns one off).
- **Tables Discord can't render are rewritten** on the way out, for every brain: a narrow one as an aligned code block, a wide one as a bullet per row.
- **`/plugins list | enable | disable`**, with the plugin name autocompleted (enable offers what's off, disable what's on).
- **`/model` for every brain** (`Brain.models()`): a provider's free models, or free's `auto` / member / `member:model`, per chat. **`/compact`** works for any brain with `Brain.compact()`. **`/brain` carries the conversation** to the brain you switch to (`carry:false` to skip).
- **`/restart`** (owner only, daemon mode): restart Choomfie on the code on disk from Discord, without waiting for a merge's Restart button. Lists what it would cut off first and offers Restart anyway.
- **Plans merge themselves; a plan's tasks share one chat.** A plan's tasks now run in one brain chat, moved into each task's thread, so each builds on what the chat already knows instead of starting over (the plan's context is sent once; one task at a time; a fresh chat after 6 tasks or when a turn may still be running in the background) — far fewer Ambition chats per plan. When every task on a board has landed, CI runs (a failure comes back as a fix task) and a Merge button follows. **🔎 Review** on the board has the brain review the plan first, in its own `review` mode (Waymond, in a fresh chat: the bundle, the whole diff and the repo's rules attached; no Claude tokens); it is not automatic, to save cost. Its findings go back as a fix task on the same branch, and the same review chat checks again, at most twice. CI passing and posts a Merge button that merges exactly the reviewed commit; for Choomfie's own repo the running checkout is then updated and a Restart button lists what a restart would cut off (new `restart` control request). A new task list in a plan's chat now continues the plan's branch instead of cutting a new one from `main`. Waymond's code and debug modes read the repo's CLAUDE.md/AGENTS.md first, and plans no longer tell the user to merge. See `docs/commands.md`.
- **Pipelines: brains run local tools on this machine.** The `pipeline` tool (`run`, `status`, `stop`) runs a hand-configured command-line tool (`pipelines` in config.json; first use: lochara, a character builder) for a chat, with the same path for Claude and for Waymond over the remote endpoint. Arguments are a list with no shell, the first must be allowed, and paths stay in the tool's folder. Quick commands answer inline; long ones are background jobs, one at a time per pipeline, whose end and pictures are posted in the chat and noted on the chat's next message to its brain (`lib/chat-notes.ts`). Images posted in a chat are kept for 7 days so a tool can take "the last reply's pictures". Owner-only in code. It only exists when a pipeline is configured. `/pipeline <name>` puts a thread on one: its brain is told once per chat what it's for (`about`) and to use the tool, so a plain "make me a character" reaches lochara there, and no other chat pays for it. In such a thread a web brain's default mode frame is left off (Waymond's `auto` frame sent it to its own sandbox instead of the tool). Tools carry MCP hints: `pipeline` changes things but isn't destructive (Ambition asked twice for every call without them), the remote read tools are read-only. A remote caller's results are always posted in the chat (Waymond's turn ends at the approval, so it can't relay them). Calls to the remote endpoint are logged, one line each (`[remote-mcp] <tool>: ok|error|refused`), without their arguments. See `docs/tools.md` and `docs/configuration.md`.
- **`delegate`: Claude can hand a job to another brain and use the result.** Send a task and files to Waymond (or any registered brain) and get its text back plus the files it made, saved to disk with their paths. The first use is image generation for a local tool (lochara, a character pipeline): Claude asks Waymond for pictures, in the thread where the design was made (`conversation`), and feeds the files on. The call waits for the answer, including work the brain finishes in the background, so it gets its own worker timeout (50 min, against 2 for every other tool) and the daemon's loopback endpoint no longer drops a quiet request after Bun's 10 s idle limit. It shares the conversation's queue with Discord messages. The core is `delegate()` (`lib/delegate.ts`), for other callers later. (Named `ask_brain` before the free brain landed.) See `docs/tools.md`.
- **Tools know who called them.** Every tool call carries its caller (`ToolCaller`): a daemon session (each session's endpoint token is now bound to its chat, so a session can't call as another chat), the remote endpoint, or the supervisor. `callerIsOwner` (`lib/caller.ts`) checks that the latest message handed to Claude in the caller's chat came from the owner; `delegate` uses it, so it's owner-only in code and not only by the prompt's rules.

- **Choomfie now tells you when you're near a plan limit, instead of waiting to be asked.** A poller in the worker (`lib/rate-limit-alerts.ts`) reads the daemon's state file and DMs the owner on crossing 90%, and again when requests start being refused.

  It lives in the worker, not the daemon, and that is the point. The daemon's only route to Discord is to push a message into the Claude session and have it call the `reply` tool — the exact path that stops working when requests are being refused. The worker reads the state file directly and DMs through discord.js, so the "you are rate limited" message still goes out when the session is the thing that's broken.

  The alert record is persisted to `meta/rate-limit-alert.json` rather than held in memory, because the worker is respawned on every session cycle and an in-memory flag would mean a fresh "you're at 94%" DM after each one. Its key carries the window's reset time, so next week's 95% isn't deduped against last week's.

### Fixed

- **Gemini web: a picture-only answer hung for 15 minutes.** "Make me an image of a tabby cat" gets a picture and no text, and the wait only ended on text. `waitForSettledText` takes `hasContent`, and a reply can be files alone.
- **Gemini web: songs came through as "0:00 / 2:35".** A track (or video) is now attached as an .mp4, and the player's text is left out. One over Discord's 10 MB limit gets a line saying so.
- **"Hand back to free models" under Gemini web's reply.** Gemini web is free too: the button is **Back to auto** (as `/model auto`), and the failure button **Answer with another model**. A member's files are noted in free's transcript, so the next model knows a picture was sent.
- **Gemini web posted its first answer again after a Run.** Reopening a conversation, the adapter counted answers before Gemini had loaded the old ones, so the first old answer read as the new one (the same `#!run` request each time). It now waits for the history, marks what's there, and reads only the unmarked answer; a tab already on the conversation isn't reloaded.
- **Gemini's pictures never arrived.** The text settles before the picture loads, and its `blob:` URL can't be fetched once shown: the turn now waits for a generated picture and copies it off the page.
- **Raw `#!run` blocks in Discord.** The command already shows on the Run card and the "ran" line, so the block is left out of the posted answer; Gemini answers are read as markdown (fenced code, no "Bash" header line). The tool guide now says plainly that the bot runs commands, after Gemini answered "I don't have shell access".
- **A signed-out Waymond looked like a broken page.** Ambition's `/chat` now shows its public landing (a "Sign in" button) instead of redirecting, so a signed-out profile waited 30s and said "the message box never appeared", and `webbrain sites` called it logged in. Waymond now spots the landing in under a second and says to log in; `webbrain sites` asks the adapter (`loggedIn`).
- **Short follow-ups changed model mid-chat.** "5090 ones" after a `quality` answer was guessed `chat` by the short-message rule and went to a different model. A weak rule guess mid-chat now continues the last turn's bucket and model; a confident classification still moves.
- **Probes hammered a shared limit.** OVHcloud's anonymous tier is said to be per model but refuses fresh models together; a probe sweep now stops after two limit refusals in a row and leaves the rest for the next sweep.
- **API brains never saw core memories.** The free brain and provider brains now get the same "Current Memories" Claude does (capped at 2,000 characters) on answer calls. `/config` gains `free.providersOff` and `free.footer`.
- **A dead key cost a call after every restart.** Keys benched for "wants a card" (7 days) or "rejected" (6h) are saved by a fingerprint of the key (never the key) in `meta/apibrain-models.json` and stay benched across restarts; `apibrain doctor` re-checks them, and an answer clears the bench.
- **Free brain's classifier spent ~100 hidden reasoning tokens per one-line answer.** Models seen thinking first are remembered and ranked below plain ones for tiny jobs (the classifier moved from gpt-oss-20b to qwen3.8-27b: 13 tokens, ~200 ms); a known thinker on a one-line job gets `reasoning_effort: low`, dropped for providers that refuse it. A reply that was all thinking fails over instead of posting nothing; stray `<think>` fragments are stripped before a turn is stored; probes time out after 15s, not 30s.
- **OpenRouter's free models were all skipped.** Its `/models` now lists endpoints as paths (`/api/v1/chat/completions`), and the parser looked for the bare word `chat`.
- **Accounts that want a card, and paid models behind a free label.** SambaNova's 402 "payment method required" benches that key for a week (`no_credit`) instead of retrying every 6h; Z.ai's "insufficient balance" and Kilo's "sign in to use this model" mark just that model as not free. On a keyless provider an auth error is now about the model, so one paid model no longer benches all of Kilo. Z.ai's free GLM flash models, missing from its list, come from `unlistedModels`. `doctor` stops after a refused key instead of probing every model with it.
- **`/restart` no longer ends a daemon started from a terminal.** It exited expecting launchd to start it again; run from a terminal, `daemon.ts` now keeps the daemon as its child and starts it again.
- **`/status` and `/usage` with non-Claude brains.** `/status` shows the brain here reporting on itself (providers, health, quota for free), and labels the daemon's fields as Claude's. `/usage` adds the free/API brains' use today, in foreground mode too.
- **Free brain:** image requests count as work for a web brain (Waymond is offered) instead of a text model describing the image; a reply's leading speaker label (`**Mahiro**:`) is cut before it's posted or stored, instead of a rule in every prompt; when Waymond can't take tool work, the text model is told so for that turn and the reply says so; Gemini's daily counts reset at Pacific midnight, not UTC.
- **Research tasks in a plan no longer fail for not committing a report.** Research mode used to commit its files to `research/` on the plan's branch, so a reply that linked the report instead of attaching it (the usual case) failed the task, and a public repo got internal reports. Research now reads the branch (it still gets the bundle) and commits nothing: the task is done when it answers, and the report stays in Waymond's workspace. `BrainMode.readsRepo` marks such a mode.
- **Plan tasks run in parallel no longer fail to land when another lands first.** A task's patch is built on the bundle it was sent; when another task on the same plan branch landed meanwhile, `git apply` refused it ("patch does not apply") even when the two touched different lines. Landing now falls back to `git apply --3way`, merging the patch onto the new head from the files it was built against (every bundle comes from the same clone). Only a real overlap fails, with a message that says so.
- **A plan task written as a heading plus a bulleted list went out as just the heading.** The task-list parser read one line per task, so Waymond received "…opened as a PR against the default branch:" with none of the requirements under it, and guessed. Indented sub-lines, and bullets under a line ending in ":", now stay part of their task's spec.
- **Opening a draft PR from a patch is all or nothing.** A new repo is created only after the patch has applied and committed locally (a failed apply used to leave an empty private repo on GitHub), and a pushed branch is deleted again if `gh pr create` fails.

- **`/usage` reported a rate-limit window that had already reset as if it were live.** Found on the running daemon: it rendered `Weekly — 97% · resets 7 hours ago` in red, from a snapshot 11 hours old, for a window that had rolled over overnight.

  The cause is structural, not a typo: the daemon only learns its utilization from a `rate_limit_event`, which the SDK sends on a turn. An idle session takes no turns, so the numbers simply stop moving. A window whose reset has passed now renders as **reset** with an empty bar, the stale snapshot carries a "last updated" note explaining why the figures aren't moving, and a `rejected` status older than 30 minutes no longer claims you are rate limited right now. `isRateLimitStale` / `viewRateLimitWindows` in `lib/daemon-status.ts` are the shared source of truth, so the embed and the alerter cannot disagree about it.

### Removed

- `MetaState.messageQueue`, which was initialised and drained but never written to. It read as a feature — "messages sent while the session is down are replayed" — that could not fire, because Discord messages reach the session through MCP rather than through the daemon. Messages sent during a cycle are genuinely lost; the honest place to say so is the rate-limit DM.

### Changed

- **`CLAUDE.md` split: 31.7KB → 14.5KB**, with the reference material moved to `docs/tools.md`, `docs/commands.md`, `docs/configuration.md`, `docs/daemon.md` and the existing `docs/voice-plugin.md`.

  It is loaded into every daemon session and re-read from cache on every turn — measured at ~7,900 tokens, roughly a quarter of the session's entire resident context, for documentation a Discord persona never needs. What stayed is the architecture and the rules that bite: shapes that compile but fail elsewhere, the register/dispatch split that prevents an import cycle, global-command shadowing, atomic writes, the SQLite datetime format. What moved is inventories and walkthroughs. Two gotchas that cost real debugging time were *added* while doing it — `ToolDef` names live at `t.definition.name`, and `CommandDef` uses `data`, not `definition`.

## Unreleased — OpenAI Endpoint Removed

### Removed

- **The local OpenAI-compatible endpoint, in full** — `packages/core/openai-server.ts`, `packages/core/lib/openai/`, `packages/core/scripts/api-key.ts`, the three test files, the `openaiEndpoint` config block, the supervisor's sidecar lifecycle, and the four `openai_*` IPC message types. About 4,200 lines.

  It was built for one named consumer, "ExampleApp", which does not exist on any machine this repo runs on, and it shipped `enabled: false`. Two things then rotted underneath it. Its setup path stopped working: `docs/openai-endpoint.md` instructs you to run `choomfie api-key issue …` and `choomfie restart`, but the runtime consolidation reduced `bin/choomfie` to a flag-only launcher with no subcommand dispatch at all, and `api-key.ts` was wired to no npm script — so with `requireAuth: true` as the default there was no documented way to obtain a key, and an enabled endpoint would have rejected every request. And its central abstraction went vestigial: `OpenAIRoutingMode` was a union with exactly one member, because routing existed to choose between Hermes and Claude Code and Hermes was deleted in "Remove Hermes runtime, Choomfie is Claude Code-only".

  It was also the one subsystem CLAUDE.md never documented, which is the real cost — a large, undescribed surface that every future reader has to reverse-engineer before they can trust the architecture guide.

- The `openai` npm devDependency, which only the endpoint's SDK-compatibility tests used.

### Changed

- `packages/core/lib/openai/ollama-embeddings.ts` moves to `packages/core/lib/ollama-embeddings.ts`. It was only ever a memory concern that landed in the endpoint's folder because embeddings arrived with that spec; `lib/memory.ts` is its sole consumer. Semantic archival search is unaffected.
- `mergeConfig` now drops removed keys (`REMOVED_CONFIG_KEYS`) rather than letting `Config`'s index signature wave them back through `...saved`, and `ConfigManager` rewrites `config.json` once on load when it finds one. Without both halves an existing install would carry the whole dead `openaiEndpoint` block forever.

## Unreleased — Global Commands + Adjustable Settings

### Changed

- **Slash commands now deploy globally instead of per-guild.** Discord keeps guild-scoped and global commands as two separate lists, and a guild command *shadows* a global one with the same name. Choomfie deployed per-guild for the instant propagation, which meant the command list was per-guild state that had to be rewritten in every guild the bot joined, and never reached DMs where a global deploy is the only option. Now a single global `PUT` is the source of truth. The auto-deploy hash is prefixed with the scope (`global:`), so an existing install sees a changed hash on first boot and redeploys itself — no migration step.
- **Every global deploy also clears guild-scoped commands** (`clearGuildCommands`). Without this, the copies left over from the per-guild era would keep shadowing the global list in those exact guilds — the one place the change most needed to land. Idempotent, so it is simply always done.
- `deploy-commands.ts` defaults to global. `--guild=<id>` survives as a dev escape hatch for iterating without waiting on propagation, and now says out loud that it shadows global until `--clear-guilds`.
- Trade-off accepted: a newly added or renamed global command can take up to an hour to appear, where a guild deploy was instant. Edits to an existing command are usually immediate.

### Added

- **`daemon.model` and `daemon.fallbackModel` in `config.json`.** There was previously no way to choose a model at all — `createSession` passed no `model` option, so daemon sessions silently inherited Claude Code's default and the only way to change it was to change Claude Code's own configuration. Both are optional; omitted means exactly the previous behaviour (the option is left off the SDK call entirely, not passed as `undefined`). Reported in `--status` and in `meta/daemon-state.json`. Applies to `--daemon` only — foreground and `--tmux` run under the `claude` CLI, which takes its model from your Claude Code settings.
- **`/config` (owner only)** — lists every adjustable setting with its current value, and changes one with `/config setting:<key> value:<v>`. `value:default` restores the built-in. Values are validated and bounded before they are stored, durations accept `5s` / `2m` as well as raw milliseconds, and the reply says whether the change is live now or waits for the next daemon start. `value` autocompletes from the selected setting's suggestions.
- **`/model [model]`** — a shortcut for the setting that gets changed most, matching the pattern in comparable bots (llmcord's `/model`, claude-code-discord's `/quick-model` alongside its full `/settings`). Routes through the same `Setting` object as `/config`, so the two cannot disagree about validation or what `default` means.
- **Autocomplete support in the interaction router.** `CommandDef` takes an optional `autocomplete` handler, dispatched *before* the chat-input branch and deliberately outside `safeHandle()`: an AutocompleteInteraction has no `reply()`/`editReply()`, only `respond()`, so the generic error reply would itself throw. Its own catch responds with an empty list, because a suggester that fails silently leaves the user on a loading spinner that never resolves.
- `packages/core/lib/settings.ts` — one declarative registry of what is adjustable, with each setting's parser, bounds, and effect scope. `/config` renders from it, so adding a setting there is the whole change.
- `packages/core/test/regression/command-scope.test.ts` pins the deployment routes and asserts that a clear PUTs an empty body. `packages/core/test/settings.test.ts` asserts every setting round-trips to disk, that rejects leave the old value in place, and that **every suggestion a setting offers is one its own validator accepts** — a picker that lists a value the validator refuses is worse than no picker. `packages/core/test/regression/autocomplete-routing.test.ts` covers the router path, including a throwing suggester still producing a response.

### Fixed

- **`ConfigManager`'s setters had no callers.** `setRateLimitMs`, `setConvoTimeoutMs`, `setAutoSummarize` and `setDaemonConfig` existed and were reachable from nothing — no tool, no command. CLAUDE.md stated "settings can be changed via tools (e.g. `setRateLimitMs`, `setConvoTimeoutMs`)"; in practice the only way to change a rate limit was to hand-edit `config.json` and restart. `/config` is now a real caller for all of them except `setAutoSummarize`.

### Notes

- `autoSummarize` is read by nothing in the codebase — it is a config key and a pair of accessors with no behaviour behind them. Left in place (harmless, and removing it would silently drop a key from existing configs) but deliberately **not** exposed in `/config`: a switch that does nothing is worse than no switch. Worth either wiring up or removing.
- No message-level logging exists to decide what is worth fast-pathing (the open issue about messages that don't need a Claude round-trip). `ctx.messageStats` is three in-memory counters — `received`, `sent`, and a per-user `Map` — reset on every worker restart, with no record of what a message was, what it cost, or whether it used a tool. That question cannot be answered from what is currently recorded.

## Unreleased — Crash-Safe Writes

### Fixed

- **Every JSON file Choomfie owns was written non-atomically** — truncate the target, stream the new contents in. A crash, `kill -9`, full disk, or worker restart landing mid-write left a truncated or half-written file, and the next read either threw or silently fell back to defaults. `config.json` does this on *every* settings mutation, so the window was not rare; losing it means losing personas and settings, and losing `access.json` means losing the owner id and allowlist. Writes now go to a sibling temp file and `rename(2)` over the target, so a reader sees either the old file or the new one, never a partial one. Applied to `config.json`, `access.json`, `meta/handoffs.json`, `meta/daemon-state.json`, and `meta/worker-health.json` via `writeFileAtomic` / `writeJsonAtomic` in `@choomfie/shared` — generalizing the temp-and-rename that `openai/auth.ts` already did by hand for the API key store.

### Notes

- Deliberately **not** moved into SQLite. The earlier plan was to fold `meta/` into the existing database, but `packages/core/daemon/` may not import `packages/core/lib/` (enforced by `daemon-structure.test.ts`) and the daemon runs in a separate process from the worker that owns the DB. Atomic writes fix the actual defect — partial files — without pushing a cross-process SQLite dependency through that boundary. `config.json` and `.env` stay files regardless: hand-editable is a feature.

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
