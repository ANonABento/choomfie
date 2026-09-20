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
- **`createSession` must pass `extraArgs: { "dangerously-load-development-channels": "server:choomfie" }`.** Claude Code gates the experimental `claude/channel` capability behind an explicit opt-in list; without the flag the session loads the MCP server and all its tools, the worker boots, and the bot shows online — but every incoming Discord message, forwarded as a `notifications/claude/channel` notification, is dropped and Choomfie never answers. Foreground mode passes the same flag in `bin/choomfie`; the two must stay in sync
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
