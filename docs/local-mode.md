# Choomfie Local Mode

Run Choomfie 24/7 on your own machine with no Anthropic / no Claude Code — just Discord + Ollama. Same persona, same memory, same tools the local runtime can serve. Cloud mode is unaffected; local mode is opt-in.

## What you get

- **Always-on Discord bot** powered by local LLMs (Ollama).
- **Multi-model orchestration**: a small fast model handles chat; a bigger coding model handles tool-y / pipeline work.
- **Background task execution**: when Discord is idle, the coding model picks up bento-ya pipeline tasks instead of sitting cold.
- **Resource management**: VRAM budget, GPU-busy detection, automatic fallback to a smaller model if your pick won't fit.
- **Voice still works** — whisper-cpp + kokoro are already local.

## Hardware tiers

| VRAM   | Chat model           | Coding model              | Notes                         |
|--------|----------------------|---------------------------|-------------------------------|
| 8 GB   | `llama3.1:8b` Q4     | `qwen2.5-coder:7b` Q4     | M1/M2 8GB, RTX 3050           |
| 16 GB  | `llama3.1:8b` Q4     | `qwen2.5-coder:14b` Q4    | M1 Pro, RTX 4060 Ti           |
| 24 GB  | `qwen2.5:7b` Q4      | `qwen2.5-coder:32b` Q4    | M2 Max, RTX 3090/4090         |
| 48 GB+ | `qwen2.5:14b` Q4     | `deepseek-coder-v2:33b`   | M2/M3 Ultra, dual-GPU rigs    |

The orchestrator estimates each model's VRAM cost from its parameter count and quantization. If your configured pick exceeds `local.resourceManagement.vramBudgetGB`, it auto-downgrades on startup.

## Install

1. **Install Ollama** — https://ollama.com — then `ollama serve` (or let the installer launch the menu-bar app).
2. **Pull your models**:
   ```bash
   ollama pull llama3.1:8b
   ollama pull qwen2.5-coder:32b   # or whichever fits your VRAM
   ```
3. **Configure Discord** as for normal Choomfie (`/choomfie:configure <token>` or `~/.claude/plugins/data/choomfie-inline/.env` with `DISCORD_TOKEN=...`).
4. **Enable local mode** in `~/.claude/plugins/data/choomfie-inline/config.json`:
   ```json
   {
     "local": {
       "enabled": true,
       "chatModel": "llama3.1:8b",
       "codingModel": "qwen2.5-coder:32b",
       "ollamaUrl": "http://localhost:11434",
       "backgroundTasks": {
         "enabled": true,
         "idleThresholdMs": 300000,
         "bentoyaApiUrl": "http://localhost:0/api"
       },
       "resourceManagement": {
         "vramBudgetGB": 24,
         "pauseWhenGpuBusy": true
       }
     }
   }
   ```
5. **Smoke test**: `packages/core/bin/choomfie-local --check`
6. **Run it**: `bun run start:local` (or `packages/core/bin/choomfie-local`).

## Auto-start on login (macOS)

```bash
bun run install:launchd
```

This drops a `~/Library/LaunchAgents/dev.choomfie.local.plist` and loads it via `launchctl`. The service auto-starts at login, restarts on crash (with a 10s throttle), and writes logs to `~/Library/Logs/choomfie-local/`.

```bash
packages/core/scripts/install-launchd.sh --status
packages/core/scripts/install-launchd.sh --uninstall
```

For Linux, write an equivalent systemd unit pointing at `bin/choomfie-local`.

## Discord slash commands

| Command                    | What it does                                                |
|----------------------------|-------------------------------------------------------------|
| `/model list`              | Show pulled Ollama models + active chat/coding selection.   |
| `/model swap chat <name>`  | Swap the chat model live (no restart).                      |
| `/model swap coding <name>`| Swap the coding model live (no restart).                    |
| `/model bench [name]`      | Quick TPS + TTFT benchmark for a single model.              |
| `/local status`            | Provider, models, idle state, background queue, VRAM budget.|

All four are owner-only.

## Routing rules (chat vs coding)

The router decides per message:

- Forced background tasks → **coding**.
- Code fence (` ``` `) in the message → **coding**.
- File path (`/foo/bar.ts`) in the message → **coding**.
- Long message with coding-keyword (`refactor`, `debug`, `traceback`, …) → **coding**.
- Coding-keyword in a medium-length message → **coding**.
- Otherwise → **chat**.

You can edit the heuristic in `packages/core/lib/orchestrator/model-router.ts`.

## Background task execution

When Discord has been idle for `local.backgroundTasks.idleThresholdMs` and system load is below 0.85 × CPU count, the background worker polls `bentoyaApiUrl + /tasks/next` for a task, runs it through the coding model, and POSTs the result to `/tasks/<id>/result`. If the user starts typing or the GPU gets hot, the worker pauses on the next tick.

The HTTP shape is intentionally minimal so bento-ya (or any other queue) can implement it without sharing a database:

```http
POST /tasks/next            { "worker": "choomfie-local" } → 200 { id, title, prompt, context } | 204
POST /tasks/<id>/result     { "status": "ok|error", "output": "..." }
```

## How it differs from cloud mode

- No supervisor → MCP → worker split. Local mode is one process.
- `ctx.mcp` is a no-op stub (`LocalMcpStub`) — anything that `notification(...)`s nobody just drops the message.
- Discord `MessageCreate` flows through `orchestrator/discord-handler.ts` instead of `ctx.mcp.notification(...)`.
- Tool calls are not yet round-tripped through Ollama. Slash commands and built-in interactions still work; chat replies are LLM text only. Tool-augmented chat is a future task.
- Voice plugin: STT/TTS still run locally and `/voice`/`speak` work, but transcribed user speech is not currently routed back through the LLM (the voice plugin pushes to `ctx.mcp.notification` which is a no-op in local mode). Wiring transcripts into `LocalRuntime.reply` is a follow-up.
- Background worker only polls when `bentoyaApiUrl` is a real endpoint. The shipped default `http://localhost:0/api` is a placeholder — the worker logs once and stays idle until you point it at a running bento-ya server.

## Files

- `packages/core/lib/orchestrator/chat-provider.ts` — `ChatProvider` interface + `OllamaProvider`.
- `packages/core/lib/orchestrator/model-registry.ts` — discovers + classifies models, manages active selection.
- `packages/core/lib/orchestrator/model-router.ts` — chat vs coding decision.
- `packages/core/lib/orchestrator/idle-monitor.ts` — Discord idleness + system load probe.
- `packages/core/lib/orchestrator/background-worker.ts` — bento-ya HTTP poller.
- `packages/core/lib/orchestrator/local-runtime.ts` — wires everything together.
- `packages/core/lib/orchestrator/discord-handler.ts` — Discord message → Ollama → reply.
- `packages/core/lib/orchestrator/mcp-stub.ts` — no-op transport for cloud-mode hooks.
- `packages/core/local-server.ts` — single-process entry point.
- `packages/core/bin/choomfie-local` — wrapper script (deps + Ollama health + tmux).
- `packages/core/scripts/install-launchd.sh` — macOS launchd installer.
