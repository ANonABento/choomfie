# Daemon Mode

Autonomous mode (`choomfie --daemon`) — session cycling, usage reporting, and
the control channel Discord uses to reach a daemon two processes above it.

See [architecture.md](architecture.md) and [architecture-v2.md](architecture-v2.md)
for the full design.

### Daemon Mode (`choomfie --daemon`)

Autonomous mode — see [docs/architecture.md](docs/architecture.md) and [docs/architecture-v2.md](docs/architecture-v2.md) for full design.

```
daemon.ts (always running)
  └→ Claude Session (Agent SDK, disposable)
       └→ supervisor.ts (MCP stdio) → worker.ts (Discord)
```

- **daemon.ts** is a thin CLI entry point; the runtime lives in `packages/core/daemon/`
- Uses `@anthropic-ai/claude-agent-sdk` to spawn Claude Code sessions programmatically
- Inbound Discord messages arrive through `meta/incoming`, **not** the `claude/channel` MCP capability — see **Inbound Message Delivery** below. Everything outbound (tool calls, `reply`) still goes through MCP as normal
- **`createSession` must pass `extraArgs: { "dangerously-load-development-channels": "server:choomfie" }`.** Claude Code gates the experimental `claude/channel` capability behind an explicit opt-in list. Necessary but not sufficient here (the flag only puts the server on the allowlist; something still has to enable it, and nothing can on the SDK path), and kept so both launch paths ask for the same thing. Foreground mode passes the same flag in `bin/choomfie`, where it *is* sufficient
- Sessions are cycled when context gets heavy (~120k tokens or 80 turns)
- Before cycling: captures a handoff summary from Claude, persists to `meta/handoffs.json`
- New session gets handoff context injected into system prompt
- `/compact` and `/clear` in Discord cycle on demand — see **Daemon Control Channel** below
- Worker health monitored via the worker's heartbeat file (`meta/worker-health.json`, rewritten every 10s) every 30s; unhealthy = stale beat (>45s) or Discord gateway not ready. 3 consecutive failures trigger a full session cycle. Falls back to a `choomfie.pid` process check when no heartbeat exists yet (worker still booting)
- States a restart can't fix (no `DISCORD_TOKEN` configured) report as DEGRADED and are explicitly **not** cycled — otherwise the daemon would respawn sessions forever over a config problem
- Daemon state written to `meta/daemon-state.json` for `/status` integration. `context` reports the live `getContextUsage()` reading — the number cycling is actually compared against — alongside its threshold; `cumulativeInputTokens` is the separate ever-growing total. These were once one field named `tokens.current`, which reported the cumulative figure against the context threshold and so could never reach it
- Sessions always run on Anthropic. Authentication/billing errors abort the retry loop immediately; rate limits and overload still retry with backoff
- Crash recovery with exponential backoff (2s → 60s max)

### Usage Reporting (`/usage`)

Plan limits come from the SDK's `rate_limit_event`, normalised in `packages/core/daemon/rate-limit.ts` and persisted to `meta/daemon-state.json` as `rateLimit`.

- **The payload does not match the SDK's own types.** `SDKRateLimitInfo` declares a single flat window (`utilization`, `resetsAt`, `rateLimitType`); some builds instead send an undeclared `unifiedWindows` object holding *every* window at once, with the flat fields describing only the tightest. Observed both shapes from the same CLI build — a bare `query()` sent `unifiedWindows`, the daemon's session sent only the flat fields. `parseRateLimitInfo` prefers `unifiedWindows` and falls back, and `/usage` labels the result "binding window only" when just one arrived, so a single bar is never passed off as the whole picture
- A payload with a utilization but no `rateLimitType` and no `unifiedWindows` is **dropped**: an unlabelled percentage can't be attributed to a limit
- `state.rateLimit` is account-level and deliberately **not** reset by `startSession` — `/usage` still answers right after a cycle. `state.modelUsage` is per-session and is reset
- `modelUsage` and `total_cost_usd` on a result are **session-cumulative** (verified: a model's `inputTokens` climbs across results), so they are assigned, not accumulated. `usage.input_tokens` is per-turn and *is* accumulated. Getting these backwards silently double-counts
- Set `--verbose` to dump each raw `rate_limit_event`; it is the only way to see which fields a given CLI build actually sends

### Daemon Control Channel

The worker sits two processes below the daemon (daemon → Agent SDK → claude CLI → supervisor → worker), so there is no IPC between them. `meta/worker-health.json` carries the worker's heartbeat up; `meta/control.json` carries requests down. Contract in `packages/shared/daemon-control.ts` (writer: core, reader: daemon), mirroring `worker-health.ts`.

- `/compact` and `/clear` write a request; the daemon polls every 2s (`CONTROL_POLL_INTERVAL_MS`) and cycles
- **Consume-once**: `consumeControlRequest` deletes the file *before* cycling, so a crash mid-cycle can't replay the request against the session that replaces it. Malformed and stale files are deleted too — left in place, an unparseable one would be re-read every poll forever
- Requests older than `CONTROL_REQUEST_STALE_MS` (2 min) are discarded. Without it, a `/compact` issued while the daemon was down would cycle the *next* session seconds after it started
- `/clear` is `cycleSession(..., { skipHandoff: true })` — no summary is captured, so no turn is spent on one. `handoffs.json` still records the cycle, because a session missing context you expected is exactly when you want that entry
- The confirmation comes from the *new* session (`announceTo`), not a reply — the session that would have replied is the one being replaced

### Inbound Message Delivery

The third leg of the same file channel, running upward: `meta/incoming/`, one JSON file per message. Contract in `packages/shared/daemon-incoming.ts`, writer in `lib/daemon-status.ts` (`deliverInboundMessage`), reader and formatter in `daemon/incoming.ts`.

**Why it exists.** In foreground mode a Discord message travels as a `notifications/claude/channel` MCP notification and Claude Code converts it to a prompt. That conversion sits behind the experimental `claude/channel` capability, and a session driven through the Agent SDK can never register it:

- The automatic path runs only on Claude Code's **interactive** MCP-connect hook. Daemon sessions log neither `Channel notifications registered` nor `Channel notifications skipped: <reason>`, which means the gate is never reached. That gate itself would pass — a `server:` entry with `dev` set (what `--dangerously-load-development-channels` does) needs no marketplace
- The only SDK-facing path, `Query.enableChannel(serverName)`, is real but undeclared in the SDK's `.d.ts`, and refuses with `server choomfie is not plugin-sourced; channel_enable requires a marketplace plugin`. It resolves `config.pluginSource` to a `name@marketplace` pair before considering anything else, and `SdkPluginConfig` only offers `{ type: 'local', path }`. Unlike the automatic path it has no `dev` bypass

So every daemon session was deaf: bot online, typing indicator on, zero turns. The capability was only ever a notification-to-prompt adapter, and the daemon already owns the session's prompt queue — so the worker writes the message to the incoming queue and the daemon injects it itself.

- **One route per process**, chosen by `isDaemonOwnedProcess()` (is `CHOOMFIE_DAEMON_PID` in the env). A daemon-launched worker writes to the incoming queue and sends no notification, so nothing double-delivers if the capability ever starts registering
- **The prompt is byte-identical** to Claude Code's: `<channel source="choomfie" k="v">\n{body}\n</channel>`, meta keys filtered to `/^[a-zA-Z_][a-zA-Z0-9_]*$/`, values escaped (`& < > " '`), body raw. Pinned by a test — the persona and tool instructions were written against this shape in foreground mode
- Swept every 1s (`INCOMING_POLL_INTERVAL_MS`) while the session is ACTIVE, oldest first. Polling rather than `fs.watch`: a `readdir` of a usually-empty directory costs nothing and carries no watcher lifecycle across session cycles
- **Consume-once**, like control requests: each file is deleted before it is prompted. Malformed and stale files are deleted too. Only `.json` files are swept, so a `writeJsonAtomic` temp file is never read half-written
- Messages older than `INCOMING_MESSAGE_STALE_MS` (3 min) are discarded — answering something said hours ago, in a conversation that has moved on, reads as a malfunction
- The worker caps the directory at `INCOMING_MAX_PENDING` (50), dropping oldest first. Nothing consumes the incoming queue while the daemon is down and the worker cannot tell the difference
- **Messages sent during a session cycle are no longer lost.** The sweep skips while the state is not ACTIVE, so they stay on disk and the replacement session delivers them
- `enableChannelNotifications()` is still called at session start and still fails. It is a tripwire, logged at `--verbose`: the day it succeeds is the day daemon sessions could use the foreground path. Do not remove it to quiet the log
