# Architecture V2: Daemon Mode

## Status: Partially implemented — Last Updated 2026-09-19

> **Correction (2026-09-19):** the "MCP becomes unnecessary" design below was
> never shipped. Daemon mode wraps the *same* supervisor → worker MCP stack as
> foreground mode rather than reimplementing Discord and tool handling a second
> time; the Agent SDK session it spawns loads Choomfie as a local plugin. The
> "Key Insight" section is kept for historical context but does not describe the
> running system. See [architecture.md](architecture.md) for shipped reality.

## TL;DR

```
Daemon (daemon.ts) — always running, manages everything
  ├→ Claude Session (Agent SDK) — the brain, cycled when context heavy
  └→ Discord Worker (worker.ts) — hands and feet, talks to Discord
```

## Role Matrix

| Layer | Process | Lifecycle | Responsibilities | Owns |
|-------|---------|-----------|-----------------|------|
| **Daemon** | `daemon.ts` (Bun) | Immortal (systemd/launchd) | Spawn + cycle Claude sessions. Spawn + restart Discord worker. Route messages between Claude ↔ Worker. Monitor context usage. Handoff summaries. PID guard. Health checks. | Session lifecycle, worker lifecycle, message routing, state persistence |
| **Claude Session** | Agent SDK subprocess | Disposable (cycled every ~120K tokens) | Process messages. Reason about what to do. Decide which tools to call. Generate responses. Maintain conversation context. Follow persona. | LLM reasoning, tool selection, conversation memory (ephemeral) |
| **Discord Worker** | `worker.ts` (Bun) | Disposable (restartable) | Discord client connection. Plugin runtime (voice, browser, socials, language-learning). Execute tool calls (reply, react, browse, speak, etc.). Handle interactions (buttons, slash commands, modals). Reminders. | Discord connection, plugin state, tool execution, real-time features |

## What Each Layer Does NOT Do

| Layer | Does NOT |
|-------|----------|
| **Daemon** | Does NOT reason about messages. Does NOT call tools directly. Does NOT talk to Discord. |
| **Claude Session** | Does NOT persist across restarts. Does NOT manage Discord. Does NOT survive context overflow. |
| **Discord Worker** | Does NOT decide what to say. Does NOT manage Claude. Does NOT handle context/sessions. |

## Current Architecture (V1)

```
Claude Code (terminal session, manages context)
  └→ Supervisor (packages/core/server.ts — immortal, MCP stdio, PID guard)
       └→ Worker (packages/core/worker.ts — disposable, Discord + plugins + tools)
```

**Why 3 layers exist:**
- Claude Code: hosts the LLM, manages conversation
- Supervisor: keeps MCP pipe alive through worker restarts
- Worker: disposable, can be killed/respawned for code reload

**Problem:** Claude Code is unmanaged. Context grows until it degrades. No automatic cycling.

## Proposed Architecture (V2)

```
Daemon (packages/core/daemon.ts — immortal, always running)
  ├→ Claude Session (Agent SDK — managed, cycled when context heavy)
  │    └→ Choomfie tools registered via plugin or direct
  └→ Discord Worker (packages/core/worker.ts — disposable, Discord + plugins)
       └→ IPC back to Daemon
```

### Key Insight (not shipped — see the correction at the top)

The original proposal argued: the supervisor's ONLY job is keeping the MCP pipe
alive, so if the daemon manages Claude sessions via the Agent SDK there is no
MCP pipe to keep alive and the MCP layer becomes unnecessary.

In practice MCP stayed mandatory for every attachment mode. Foreground mode
requires it structurally (that is how Claude Code CLI plugins work), and daemon
mode gets Discord, plugins, and all 95 worker tools for free by reusing the same
path instead of growing a parallel implementation.

### What Each Layer Does

**Daemon (daemon.ts):**
- Always running (spawned by systemd, launchd, or a shell script)
- Spawns + manages Claude sessions via Agent SDK
- Spawns + manages Discord worker via Bun.spawn + IPC
- Routes Discord messages → Claude session
- Routes Claude tool calls → Worker for execution
- Monitors context usage, cycles sessions when needed
- Handles handoff summaries between sessions
- PID guard (single instance)

**Discord Worker (worker.ts):**
- Owns Discord client, plugins, interactions
- Executes tool calls (reply, react, browse, voice, etc.)
- Reports events (messages, voice transcripts) back to daemon via IPC
- Disposable — daemon can kill and respawn for code reload
- Same as current worker, but IPC goes to daemon instead of MCP supervisor

### What Changed (Phase 3 — current implementation)

Daemon wraps the existing supervisor/worker stack via the Agent SDK's plugin system. Nothing was removed — the supervisor and worker run inside the Claude session as an MCP plugin, same as interactive mode. The daemon adds session lifecycle management on top.

```
daemon.ts (Agent SDK) → Claude Session → supervisor.ts (MCP plugin) → worker.ts (Discord)
```

### What Would Change (Phase 4 — future sibling architecture)

- `packages/core/supervisor.ts` — removed. Daemon handles both Claude and worker lifecycle.
- MCP stdio transport — replaced by Agent SDK's programmatic interface.
- Worker becomes a direct child of daemon, survives session cycles.

## Communication

| From → To | Channel | Data |
|-----------|---------|------|
| Worker → Daemon | IPC (Bun.spawn) | Discord messages, voice transcripts, interaction events |
| Daemon → Claude | Agent SDK (stdin stream) | User messages, tool results, system prompts |
| Claude → Daemon | Agent SDK (stdout stream) | Responses, tool calls, token usage |
| Daemon → Worker | IPC (Bun.spawn) | Tool calls to execute (reply, browse, etc.) |
| Worker → Daemon | IPC | Tool results (message sent, screenshot path, etc.) |

## Lifecycle Events

| Event | Who Handles | What Happens |
|-------|-------------|--------------|
| Bot startup | Daemon | Spawns Claude session + Discord worker |
| Discord message | Worker → Meta → Claude | Routed to Claude for processing |
| Tool call | Claude → Meta → Worker | Worker executes, returns result |
| Context full (~120K) | Daemon | Drains, generates summary, cycles Claude session |
| Worker crash | Daemon | Respawns worker, Claude session unaffected |
| Claude session error | Daemon | Respawns session with last handoff summary |
| Code update / restart | Daemon | Kills worker, spawns fresh one. Optionally cycles Claude session. |
| Shutdown | Daemon | Graceful shutdown of Claude session + worker |

## Flow Comparison

### V1: Discord Message → Claude Response

```
Discord message
  → Worker receives via discord.js
  → Worker sends IPC notification to Supervisor
  → Supervisor forwards as MCP notification to Claude Code
  → Claude Code processes, decides to call reply tool
  → Claude Code sends MCP tool call to Supervisor
  → Supervisor forwards IPC tool_call to Worker
  → Worker executes reply via discord.js
  → Worker sends IPC tool_result to Supervisor
  → Supervisor forwards result to Claude Code
```
**Hops: 8**

### V2: Discord Message → Claude Response

```
Discord message
  → Worker receives via discord.js
  → Worker sends IPC to Daemon
  → Daemon feeds message to Claude session (Agent SDK)
  → Claude processes, returns tool call in stream
  → Daemon sends IPC tool_call to Worker
  → Worker executes reply via discord.js
  → Worker sends IPC tool_result to Daemon
  → Daemon feeds result back to Claude session
```
**Hops: 6** (eliminates MCP protocol overhead)

## Tool Registration in V2

### Option A: Plugin directory (simplest)

Agent SDK supports `--plugin-dir`. Tools are still registered via MCP, but the SDK manages the MCP connection internally. This means we could keep the current supervisor as the MCP server inside the plugin, or...

### Option B: Direct tool registration

The Agent SDK's `allowedTools` option controls which tools Claude can use. We could register tools directly:

```typescript
query({
  prompt: messageGenerator,
  options: {
    allowedTools: [
      // Built-in Claude Code tools
      "Read", "Edit", "Bash",
      // Custom tools registered via... ?
    ]
  }
});
```

**Problem:** The Agent SDK doesn't have a direct "register custom tool" API. Tools come from MCP servers loaded via `--mcp-config` or plugins. So we'd still need SOME MCP server to expose our tools.

### Option C: Hybrid (Recommended)

Keep the current supervisor as an MCP server, but spawn it as a local MCP server config instead of the entry point:

```typescript
query({
  prompt: messageGenerator,
  options: {
    mcpServers: {
      choomfie: {
        command: "bun",
        args: ["server.ts"], // existing supervisor, but now spawned BY daemon
      }
    }
  }
});
```

This way:
- Meta-supervisor spawns Claude session
- Claude session spawns supervisor as MCP server
- Supervisor spawns worker as before
- But daemon controls session lifecycle

**Downside:** We're back to 4 layers. But session cycling is managed.

### Option D: Collapse supervisor into worker

Make the worker ALSO be the MCP server. Remove the supervisor entirely:

```typescript
// daemon.ts
query({
  prompt: messageGenerator,
  options: {
    mcpServers: {
      choomfie: {
        command: "bun",
        args: ["worker-mcp.ts"], // combined worker + MCP server
      }
    }
  }
});
```

`worker-mcp.ts` would:
- Run the MCP server (stdio transport to Claude via SDK)
- Run the Discord client
- Run all plugins
- Handle tool calls directly (no IPC routing)

**On restart:** Meta-supervisor cycles the Claude session (which restarts the MCP server, which restarts the worker). Fresh context + fresh code.

**Downside:** Worker restarts also restart the MCP connection and Claude session. But if daemon handles cycling anyway, this is fine — the whole point is that sessions are disposable.

## Design Decisions

### Worker is a sibling, not a child (Phase 4)
In the future sibling architecture, daemon would spawn BOTH Claude session and worker directly. They're siblings, not nested. This means cycling Claude would NOT kill the worker — Discord stays connected. Currently (Phase 3), worker runs inside the Claude session via the plugin system, so it dies on cycle.

```
Daemon
  ├→ Claude Session (can be cycled independently)
  └→ Worker (stays alive during session cycles)
```

### Message bus over direct IPC
Instead of point-to-point routing, use a simple event emitter inside daemon. Worker publishes events ("discord_message", "voice_transcript"), daemon subscribes and routes to Claude. Makes it easy to add consumers later (logging, analytics, parallel sessions).

### Model routing at the daemon level
Daemon sees every message before Claude. Could route simple messages (reactions, short replies) to Haiku and complex ones to Opus via SDK's `setModel()`. Not implemented yet, but the architecture supports it naturally.

### No fallback during session cycling
Session swap takes ~12s. During this time, Discord messages queue in daemon and replay when the new session is ready. No special "degradation mode" needed — the queue handles it.

### Keep supervisor in Phase 1
Don't refactor the current supervisor/worker system yet. Phase 1 wraps the existing architecture. Prove session cycling works first. Collapse later.

## Answered Questions

1. **Can the Agent SDK load plugins that register MCP tools?** Yes — `plugins: [{ type: "local", path: PLUGIN_DIR }]` works. This is the current implementation.
2. **What's the latency of Agent SDK tool calls vs MCP?** Benchmark shows ~7-10s per turn including tool calls. Acceptable for Discord chat, may need optimization for voice.
3. **Does the Discord bot stay connected during session cycling?** No — worker dies with the session (~12s reconnect). Accepted as a known limitation. Phase 4 would fix this.
4. **Do we need code reloading?** Session cycling gives free code reload — fresh `import()` on every cycle. The `restart` tool still works for worker-only restarts within a session.

## Recommended Path Forward

**Phase 1: Daemon wrapper** ✅
- Built `daemon.ts` using Agent SDK
- Spawns current architecture as-is (supervisor as MCP plugin)
- Session monitoring + cycling via `getContextUsage()`
- Validated with `--test-cycle` smoke test

**Phase 2: Harden daemon** ✅
- Fixed handoff summary capture (proper result-based extraction)
- Typed state (removed `as any` hacks)
- Error recovery with exponential backoff
- `--test-cycle` flag for end-to-end cycling verification
- `--benchmark` flag for latency measurement
- `--verbose` flag for debug output
- Context check fallback (turn-based after 5 failures)

**Phase 3: Production hardening** ✅
- Worker health monitoring via PID file checks (30s interval, 3 failures → cycle)
- Daemon state file (`daemon-state.json`) for `/status` integration with PID staleness check
- Discord notification after session cycle
- Improved handoff summary prompt (structured sections: persona, users, voice, tasks, learnings, promises)
- Bounded error recovery (max 10 retries with exponential backoff, then fatal exit)
- Token tracking fix (cumulative API usage, context monitor uses `getContextUsage()`)
- `choomfie --daemon` launcher flag with tmux/always-on composition
- Worker restarts on cycle (~12s Discord reconnect, acceptable tradeoff)

**Phase 4 (future): Full sibling architecture**
- If 3s Discord reconnect on cycle is unacceptable:
  - Remove supervisor, spawn worker directly from daemon
  - Worker survives session cycles (Discord stays connected)
  - Custom MCP server in daemon exposes worker tools to Agent SDK

**Phase 5 (future): Multi-brain daemon**
- BrainPoolManager: spawn N independent Claude sessions
- Message router: server_id/DM → brain mapping, complexity-based model routing
- Per-brain persona, system prompt, model, and tool restrictions
- Independent cycling per brain (hot-swap without downtime)
- Brain-to-brain event bus (shared context without shared context windows)
- Background brain for silent automation (cron, monitoring, digest)
- Model ladder: reactions → no brain, simple → Haiku, normal → Sonnet, complex → Opus
- Bento-ya bridge: brains claim tasks from kanban, report progress to Discord
- See roadmap.md Phase 15 for detailed breakdown (~25-30hr total)

## Agent SDK Reference

```bash
bun add @anthropic-ai/claude-agent-sdk
```

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const session = query({
  prompt: messageGenerator, // AsyncGenerator yields messages on demand
  options: {
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    plugins: [{ type: "local", path: PLUGIN_DIR }],
    systemPrompt: { type: "preset", preset: "claude_code", append: handoffSummary },
    persistSession: true,
    includePartialMessages: false,
    settingSources: ["user", "project"],
    cwd: PLUGIN_DIR,
  }
});

// session is an AsyncGenerator<SDKMessage> with control methods:
// session.getContextUsage() — token breakdown by category
// session.close() — terminate session
// session.setModel() — change model mid-session
```

### Session Cycling Protocol

**State machine:** `ACTIVE` → `DRAINING` → `CYCLING` → `ACTIVE`

1. **ACTIVE:** Normal operation. Track tokens/turns from SDK messages.
2. **DRAINING:** Threshold reached (~120K tokens or 80 turns). Generate handoff summary from Claude, store in `meta/handoffs.json` (last 20 kept).
3. **CYCLING:** Close old session (`query.close()`), start new one with summary as system prompt.
4. **ACTIVE:** Replay queued messages, resume.

### CLI Flags

```bash
claude \
  --input-format stream-json \
  --output-format stream-json \
  --permission-mode bypassPermissions \
  --plugin-dir /path/to/choomfie \
  --session-id <uuid> \
  --append-system-prompt "Handoff context: ..."
```

### Caveats

- ~12s overhead per session cycle (new `query()` + Discord reconnect)
- Discord messages lost during the cycle gap (no buffer in current architecture)
- No programmatic `/compact` — must cycle sessions instead
- `getContextUsage()` can fail intermittently — daemon falls back to turn-count after 5 failures
