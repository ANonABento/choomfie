# Daemon Mode

Autonomous mode (`choomfie --daemon`): the daemon runs the Discord worker
itself and keeps one Claude session per location — thread, channel, DM, group
DM — side by side.

```
daemon.ts → daemon/hub.ts (always running)
  ├→ WorkerHost → worker.ts (Discord, tools)            lib/worker-host.ts
  ├→ loopback MCP endpoint (every tool, token in RAM)   startLocalMcp in lib/remote-mcp.ts
  └→ SessionPool → ChatSession × N (Agent SDK)          daemon/pool.ts, daemon/chat-session.ts
          mcpServers: { choomfie: http → endpoint }
```

- **daemon.ts** is a thin CLI entry point (`--status`, `--stop`, `--verbose`); the runtime lives in `packages/core/daemon/`
- **The daemon runs the worker** with the same `WorkerHost` the foreground supervisor uses, so a session compacting never drops Discord and a worker restart never touches a session
- **Sessions load no plugin** — its supervisor would log in to Discord a second time. They reach every tool at the loopback endpoint, whose server instructions are the worker's (persona, security rules). Any supervisor started while the daemon runs (a project `.mcp.json`, a terminal `choomfie`) refuses to start
- **Inbound messages** arrive through `meta/incoming`, not the `claude/channel` MCP capability — see **Inbound Message Delivery**. Everything outbound (tool calls, `reply`) goes through MCP as normal
- Sessions always run on Anthropic. Authentication/billing errors stop a session's retry loop immediately; rate limits and overload retry with backoff (2s → 60s)
- **`remoteMcp`** (if enabled) is started by the daemon, since there is no supervisor

### Chats and sessions

- **The worker owns the chat records** (`chats` / `chat_bindings` in SQLite). Before a message goes to `meta/incoming`, `forwardToClaude` binds (or creates, titled from the message) the chat at its location and tags the message with `location_id` — routing only; `formatChannelPrompt` drops it. It's needed because `/choomfie`'s `chat_id` is an `ask:` relay, not a location
- `/clear` starts a new chat at the location (with `cwd:` if given) and `/resume` rebinds an earlier one. Only that location changes, so neither asks for confirmation; both then send a control request so the old session closes right away
- **Where a session runs:** a chat's cwd, or by default the empty chat home (`<data dir>/home`, `chatHomeDir`). Sessions load **project settings only** (`settingSources: ["project"]`): not the owner's own Claude Code skills, plugins or global CLAUDE.md, and in the chat home no project CLAUDE.md either. Measured at startup: 21.7k → 13.4k tokens, before Choomfie's ~4.6k of tools and persona. Every new session writes that context to the prompt cache, so this is paid once per chat. A coding chat opts in with `/clear cwd:` and gets that project's CLAUDE.md. The cwd is recorded on the chat with its first SDK session id, since a resume must come back to the same directory
- **The pool reconciles** (`SessionPool.deliver`): if the chat bound at the location isn't the one its session holds, that session closes and the bound chat's opens — resumed from its `backendRef` in its own cwd (the SDK finds transcripts by cwd), with the summary its session started with. A chat is live in one place: opening it closes it elsewhere, so one transcript never has two writers
- The daemon writes each new SDK session id onto the chat (`chats.setBackendRef`). Both processes use the database: WAL mode, `busy_timeout` 5s on each side
- **Limits:** `daemon.maxSessions` (default 3). At the cap the least recently active idle session closes; if all are mid-turn it goes over rather than cut one off. Idle sessions close after 20 minutes and resume on the next message
- **Failures:** a stream failure reopens the same SDK session with backoff; auth/billing failures and 5 failures in a row mark the session dead, and the next message replaces it

### Compacting

Each session checks its own context every minute (`ChatSession.checkContext`). Compacting captures a handoff summary, then starts a fresh SDK session **on the same chat** with the summary in its system prompt. The summary is also kept as the chat's seed (`meta/claude-seeds.json`, newest 30): resuming that session later gets its transcript back from the SDK, but not its system prompt.

It used to run the moment a threshold was crossed, which replaced sessions halfway through multi-step work. The handoff was worse than useless: `waitForResult` takes the *next* result, so the summary request got back the in-flight turn's own result. One handoff read, in full, "Reading the mockup and the gripper memory before I build the real symmetric version."

- Crossing `tokenThreshold` (120k) or `turnThreshold` (80) only sets `pendingCycleReason`
- The pending compact runs once `isIdleForCycle` holds: no turn in flight and `CYCLE_IDLE_DEBOUNCE_MS` (45s) since the last prompt or stream message
- `turnInFlight` is set by every push onto the prompt queue and by any assistant output, and cleared by every `result`, error results included, so a failed turn cannot block compacting forever
- **Hard ceiling:** at `hardCeiling()` the compact is forced even mid-task (`token_ceiling`). That is 1.5× `tokenThreshold` (180k by default), capped at 90% of the model's reported window and never below the threshold
- `/compact` compacts on demand and the new session announces itself in the channel. Before asking for the summary, a compact waits for an in-flight turn (up to `HANDOFF_TURN_DRAIN_TIMEOUT`, 2 min)

### Worker health

The worker's heartbeat (`meta/worker-health.json`, rewritten every 10s) is checked every 30s; unhealthy = stale beat (>45s) or Discord gateway not ready. 3 consecutive failures restart the **worker** — sessions are untouched. With no heartbeat yet (still booting) it counts as healthy while the process is up. States a restart can't fix (no `DISCORD_TOKEN` configured) are reported and not restarted — otherwise the worker would respawn forever over a config problem. Separately, `WorkerHost` respawns a crashed worker with backoff and gives up after 5 crashes in 60s.

### State file

`meta/daemon-state.json` is read by `/status`, `/usage`, the `status` tool and the rate-limit alerter (`lib/daemon-status.ts`); it's built in one place, `buildDaemonState` in `daemon/state-file.ts`. Top level is daemon-wide: uptime, model settings, today's tokens, summed cost, compacts, rate limits (the account's — newest snapshot from any session), worker health, `maxSessions`. `turns`, `context`, `modelUsage` and the resolved model are the most recently active session's. `sessions[]` lists every live one (location, chat, title, cwd, turns, context, busy). It's rewritten after every turn and every 30s.

### Which Model a Session Actually Runs

Daemon sessions run the Claude Code build **bundled inside the Agent SDK**, not the `claude` on PATH that foreground mode uses. That bundled build resolves model aliases, so with `"model": "opus"` a stale SDK in `bun.lock` quietly pins the daemon to an older Opus while foreground gets the current one. This happened: the SDK was declared in both the root and `packages/core` manifests, only the root was bumped, and the daemon ran Opus 4.7.

- The SDK is declared **only** in `packages/core/package.json`; `test/regression/agent-sdk-single-copy.test.ts` fails on a second declaration or a second resolved version
- Each session's `system/init` message gives the resolved model and bundled Claude Code version. They are logged, written to `daemon-state.json` as `resolvedModel` / `claudeCodeVersion`, and shown by `/usage` as `opus → claude-…`
- If the bundled Claude Code is older than `claude --version`, the daemon logs a WARNING. Fix: `bun update @anthropic-ai/claude-agent-sdk` in `packages/core`, then restart the daemon
- To pin a model regardless of SDK version, set `model` to a full ID instead of an alias

### Usage Reporting (`/usage`)

Plan limits come from the SDK's `rate_limit_event`, normalised in `packages/core/daemon/rate-limit.ts` and persisted to `meta/daemon-state.json` as `rateLimit`.

- **The payload does not match the SDK's own types.** `SDKRateLimitInfo` declares a single flat window (`utilization`, `resetsAt`, `rateLimitType`); some builds instead send an undeclared `unifiedWindows` object holding *every* window at once, with the flat fields describing only the tightest. Observed both shapes from the same CLI build. `parseRateLimitInfo` prefers `unifiedWindows` and falls back, and `/usage` labels the result "binding window only" when just one arrived, so a single bar is never passed off as the whole picture
- A payload with a utilization but no `rateLimitType` and no `unifiedWindows` is **dropped**: an unlabelled percentage can't be attributed to a limit
- `state.rateLimit` is account-level and deliberately **not** reset by a compact — `/usage` still answers right after one. `state.modelUsage` is per-session and is reset
- `modelUsage` and `total_cost_usd` on a result are **session-cumulative** (verified: a model's `inputTokens` climbs across results), so they are assigned, not accumulated. `usage` (input + cache read + cache write — `input_tokens` alone is ~2 per call once cached) and the turn count (one per result; `num_turns` is round-trips within one prompt) are per-turn and *are* accumulated. Getting these backwards silently double-counts
- Set `--verbose` to dump each raw `rate_limit_event`; it is the only way to see which fields a given CLI build actually sends

### Daemon Control Channel

The worker is a child of the daemon, but control goes through files so the worker's Discord handlers stay identical in every mode. `meta/worker-health.json` carries the heartbeat up; `meta/control.json` carries requests down. Contract in `packages/shared/daemon-control.ts` (writer: core, reader: daemon), mirroring `worker-health.ts`.

- Every request names the `location` whose session it is about. `compact` compacts it, `stop` calls `interrupt()` on its turn in flight and keeps the session, `clear` / `resume` close it (the worker already bound the new chat). The daemon polls every 2s (`CONTROL_POLL_INTERVAL_MS`)
- **Consume-once**: `consumeControlRequest` deletes the file *before* acting, so a crash mid-compact can't replay the request. Malformed and stale files are deleted too — left in place, an unparseable one would be re-read every poll forever
- Requests older than `CONTROL_REQUEST_STALE_MS` (2 min) are discarded; `stop` goes stale after 20s (`STOP_REQUEST_STALE_MS`) so a leftover one never cuts off a later turn
- A compact's confirmation comes from the *new* session (`chatId` to announce in), not a reply — the session that would have replied is the one being replaced

### Inbound Message Delivery

The upward leg of the same file channel: `meta/incoming/`, one JSON file per message. Contract in `packages/shared/daemon-incoming.ts`, writer in `lib/daemon-status.ts` (`deliverInboundMessage`), reader and formatter in `daemon/incoming.ts`.

**Why it exists.** In foreground mode a Discord message travels as a `notifications/claude/channel` MCP notification and Claude Code converts it to a prompt. That conversion sits behind the experimental `claude/channel` capability, and a session driven through the Agent SDK can never register it: the automatic path runs only on Claude Code's interactive MCP-connect hook, and the only SDK-facing path, `Query.enableChannel()`, refuses anything that isn't a marketplace plugin. The capability was only ever a notification-to-prompt adapter, and the daemon owns each session's prompt queue — so the worker writes the message to the incoming queue and the daemon injects it into the right session.

- **One route per process**, chosen by `isDaemonOwnedProcess()` (is `CHOOMFIE_DAEMON_PID` in the env — the daemon sets it for its worker). A daemon-launched worker writes to the incoming queue and sends no notification
- **The prompt is byte-identical** to Claude Code's: `<channel source="choomfie" k="v">\n{body}\n</channel>`, meta keys filtered to `/^[a-zA-Z_][a-zA-Z0-9_]*$/`, values escaped (`& < > " '`), body raw. Pinned by a test — the persona and tool instructions were written against this shape in foreground mode
- Swept every 1s (`INCOMING_POLL_INTERVAL_MS`), oldest first. Polling rather than `fs.watch`: a `readdir` of a usually-empty directory costs nothing
- **Consume-once**, like control requests: each file is deleted before it is prompted. Malformed and stale files are deleted too. Only `.json` files are swept, so a `writeJsonAtomic` temp file is never read half-written
- Messages older than `INCOMING_MESSAGE_STALE_MS` (3 min) are discarded — answering something said hours ago, in a conversation that has moved on, reads as a malfunction
- The worker caps the directory at `INCOMING_MAX_PENDING` (50), dropping oldest first. Nothing consumes the queue while the daemon is down and the worker cannot tell the difference
