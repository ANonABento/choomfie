# Supervisor Architecture

> Subprocess-based architecture for Choomfie.

## Architecture

```
Claude Code ← MCP stdio → supervisor.ts (immortal, ~200 lines)
                              ↕ Bun IPC
                          worker.ts (disposable)
```

**Supervisor** (`supervisor.ts`): MCP server, IPC routing, restart tool, PID guard, crash recovery. Never restarts.
**Worker** (`worker.ts`): Discord client, plugins, reminders, voice, tools, memory. Disposable — killed and respawned on restart.

## How It Works

1. `server.ts` (thin wrapper) imports `supervisor.ts`
2. Supervisor acquires PID file, spawns worker via `Bun.spawn(["bun", "worker.ts"], { ipc })`
3. Worker creates AppContext, loads plugins, creates Discord client, builds tool list
4. Worker waits for Discord to be fully initialized (plugins, reminders, slash commands)
5. Worker sends `{ type: "ready", tools, instructions }` to supervisor via IPC
6. Supervisor creates MCP server with real instructions + tools, connects stdio transport
7. Claude Code calls `initialize` → gets correct persona, security rules, tool list

**Tool call flow:** Claude → MCP → supervisor → IPC → worker → handler → IPC → supervisor → MCP → Claude

**Notification flow:** Discord message → worker → IPC notification → supervisor → MCP → Claude

**Restart:** Supervisor sends `{ type: "shutdown" }` → worker cleans up + exits → supervisor spawns new worker → waits for ready → sends `tools/list_changed` notification → Claude re-fetches tools. MCP connection never interrupted.

## File Layout

| File | Role |
|---|---|
| `server.ts` | Thin wrapper: `import "./supervisor.ts"` |
| `supervisor.ts` | Immortal process: MCP, IPC, restart, PID |
| `worker.ts` | Disposable process: Discord, plugins, tools |
| `lib/ipc-types.ts` | Shared IPC message types |
| `lib/mcp-proxy.ts` | Duck-type MCP Server for worker (`notification()` + `setNotificationHandler()`) |
| `lib/mcp-server.ts` | `buildInstructions()` + `createMcpServer()` (used by worker + boot test) |
| `lib/tools/system-tools.ts` | Empty (restart moved to supervisor) |

## IPC Protocol

```typescript
// Supervisor → Worker
{ type: "tool_call", id: string, name: string, args: object }
{ type: "permission_request", method: string, params: object }
{ type: "shutdown" }

// Worker → Supervisor
{ type: "ready", tools: IpcToolDef[], instructions: string }
{ type: "tool_result", id: string, result: ToolResult }
{ type: "notification", method: string, params: object }
{ type: "log", level: string, message: string }
```

## Key Design Decisions

### IPC: Bun built-in
`Bun.spawn({ ipc })` — zero setup, JSON built-in. Worker must be child process (fine for now). Swap to unix socket later if multi-brain needs many-to-many.

### Memory: shared SQLite (WAL mode)
SQLite file in data directory. Worker opens it for tool calls. Supervisor can open it later for compaction. WAL checkpoint on close prevents lock contention during restart.

### MCP Proxy pattern
Worker assigns `McpProxy` to `ctx.mcp`. It duck-types the MCP Server interface — `notification()` forwards via IPC, `setNotificationHandler()` stores handlers for permission relay. This means `discord.ts`, `permissions.ts`, and all plugins work **unchanged**.

### Supervisor-owned tools
Supervisor handles `restart` directly — never proxied to worker. Future: `compact` and `status` tools.

### Worker ready signal
Worker sends `ready` only after Discord login + `ClientReady` handler completes (plugins initialized, reminders loaded, slash commands deployed). 15s timeout on Discord ready to prevent indefinite hang.

### Crash recovery
Supervisor detects non-zero worker exit → auto-respawns with exponential backoff (1s, 2s, 4s, 8s, 15s cap). Gives up after 5 crashes within 60s to prevent infinite crash loops. Manual restart via tool resets the crash counter. Intentional restarts suppress auto-respawn to prevent race conditions (old worker exit handler spawning a duplicate).

### Startup ordering
Supervisor waits for worker `ready` before creating the MCP server. This ensures the `initialize` handshake serves real instructions (persona, security rules, plugin instructions) instead of stale fallback text. If the worker times out (30s), MCP connects with fallback instructions — the worker may still come up later and trigger `tools/list_changed`.

### Tool list synchronization
When the worker sends `ready` (initial or after restart), supervisor sends a `notifications/tools/list_changed` notification to Claude Code, which re-fetches the tool list. Also patches `_instructions` on the MCP Server instance for any future re-initialization.

## Error Handling

- All `worker.send()` calls in supervisor wrapped in try-catch
- All `process.send()` calls in worker use optional chaining + try-catch
- Tool calls have 2min timeout — rejected if worker dies or hangs
- Pending tool calls rejected on worker exit (with proper cleanup of old-worker-only state)
- MCP proxy guards against missing IPC channel (worker run outside supervisor)
- Restart tool returns success-with-warning on timeout instead of throwing (worker may still come up)

## Timeouts

| What | Duration |
|---|---|
| Worker ready | 30s |
| Discord ready (in worker) | 15s |
| Tool call | 2min |
| Graceful shutdown wait | 5s |

---

## Future Phases

### Phase 2: Voice Auto-Rejoin
- Supervisor tracks active voice channels (join_voice / leave_voice via IPC)
- On worker respawn, send saved voice state → worker auto-joins

### Phase 3: Restart Handoff (basic compaction)
- Supervisor tracks last 10 messages (user full, bot truncated to ~500 chars)
- On restart: save handoff to memory/file
- On new session: inject handoff as context

### Phase 4: Idle Compaction (LLM-powered)
- Track message count since last compaction
- On idle (5 min + 50+ messages): ask Claude to triage via MCP notification
- 3 buckets: store to memory / compact to summary / toss

### Phase 5: Graceful Shutdown with Compaction
- Supervisor detects stdin close → sends compact request → timeout (10s) → skip if slow
- Cancel on new session (PID guard kills old supervisor)

### Phase 6: Multi-Bot (choomfie-sim)
- Supervisor manages worker pool (one per bot/persona)
- Each worker = different Discord token
- Claude sees messages from all bots, tagged with source

### Phase 7: Multi-Brain
- One bot, multiple Claude connections
- Route by channel, topic, or load
