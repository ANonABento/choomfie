# Choomfie Architecture

This page summarizes the current runtime architecture. For deeper notes, see
`docs/supervisor-architecture.md`, `docs/architecture-v2.md`, and
`docs/voice-plugin.md`.

## Supervisor / Worker

The supervisor is the long-lived MCP process Claude Code talks to over stdio.
The worker is disposable and owns Discord, plugins, context, and tool handlers.

```mermaid
flowchart LR
  Claude[Claude Code] <-- "MCP stdio" --> Server[packages/core/server.ts]
  Server --> Supervisor[packages/core/supervisor.ts]

  subgraph SupervisorProcess[Supervisor process]
    Supervisor
    McpServer[MCP Server]
    RestartTool[restart tool]
    PidFile[choomfie.pid]
  end

  subgraph WorkerProcess[Worker child process]
    Worker[packages/core/worker.ts]
    Context[AppContext]
    Discord[discord.js client]
    Plugins[Enabled plugins]
    ToolHandlers[Core + plugin tool handlers]
    McpProxy[McpProxy]
  end

  Supervisor <-- "Bun IPC: ready, tool_call, tool_result, notification, request_restart" --> Worker
  Worker --> Context
  Worker --> Discord
  Worker --> Plugins
  Worker --> ToolHandlers
  Worker --> McpProxy
  McpProxy -- "notifications/claude/channel" --> Supervisor
  Supervisor -- "MCP notifications" --> Claude
  Claude -- "tool calls" --> McpServer
  McpServer --> RestartTool
  McpServer -- "worker tools" --> Supervisor
  Supervisor --> PidFile
```

Startup sequence:

1. Claude Code launches `bun packages/core/server.ts`.
2. `server.ts` imports `supervisor.ts`.
3. The supervisor acquires `choomfie.pid`, spawns `worker.ts` with `Bun.spawn({ ipc })`, and waits for worker readiness.
4. The worker creates `AppContext`, loads enabled plugins, creates the Discord client, builds tool definitions and instructions, then sends `ready`.
5. The supervisor creates the MCP server with current tools and instructions and connects stdio transport.

Restart sequence:

1. Claude calls `restart`, or worker sends `request_restart` after persona/plugin/voice config changes.
2. The supervisor sends `shutdown` to the current worker and waits up to 5 seconds.
3. The supervisor spawns a fresh worker, waits for `ready`, and emits `notifications/tools/list_changed`.
4. The MCP stdio connection stays alive throughout the worker restart.

## Plugin Lifecycle

Plugins are workspace packages under `plugins/`. The loader resolves enabled
plugin names through an explicit package map in `packages/core/lib/plugins.ts`.

```mermaid
flowchart TD
  Config[config.json plugins array] --> Loader[loadPlugins config]
  Loader --> PackageMap[PLUGIN_PACKAGES map]
  PackageMap --> DynamicImport[dynamic import workspace package]
  DynamicImport --> PluginExport[default Plugin export]

  PluginExport --> ValidateName{plugin.name exists?}
  ValidateName -- no --> SkipName[skip plugin]
  ValidateName -- yes --> CollisionCheck{tool names unique?}
  CollisionCheck -- no --> SkipCollision[skip plugin]
  CollisionCheck -- yes --> Loaded[ctx.plugins]

  Loaded --> Intents[collect extra Discord intents]
  Intents --> DiscordClient[createDiscordClient]
  DiscordClient --> Ready[Discord ClientReady]
  Ready --> Init[plugin.init ctx]
  Init --> ToolList[getAllTools ctx]
  ToolList --> SupervisorReady[worker ready tools + instructions]

  DiscordMessage[MessageCreate] --> OnMessage[plugin.onMessage hooks]
  OnMessage --> DefaultMessage[default Discord-to-Claude routing]

  DiscordInteraction[InteractionCreate] --> Dispatch[handleInteraction]
  Dispatch --> PluginInteraction[plugin.onInteraction hooks]
  Dispatch --> Registries[shared command/button/modal registries]

  Shutdown[worker shutdown] --> Destroy[plugin.destroy]
```

Lifecycle details:

- `tools` are appended to the MCP tool list after core tools.
- `instructions` are appended to the MCP system prompt.
- `intents` are merged into the Discord gateway intent list before login.
- `init(ctx)` runs after Discord is ready, reminder schedulers start, and owner fallback detection completes.
- `onMessage` hooks run before the default message forwarding logic.
- `onInteraction` hooks run before command, button, and modal dispatch.
- `destroy()` runs during worker shutdown before Discord and SQLite close.

## Daemon Mode

Daemon mode launches Claude Code sessions through the Agent SDK and keeps the
system running across context cycles.

```mermaid
flowchart TD
  CLI[packages/core/daemon.ts] --> Runtime[packages/core/daemon/runtime.ts]
  Runtime --> AgentSDK["@anthropic-ai/claude-agent-sdk query"]
  AgentSDK --> Session[Claude Code session]
  Session --> PluginDir[local plugin path]
  PluginDir --> Supervisor[supervisor.ts MCP stdio]
  Supervisor --> Worker[worker.ts Discord bridge]

  Runtime --> Generator[message generator]
  Generator --> Session
  Session --> Results[assistant results + usage]
  Results --> State[daemon-state.json]

  Results --> Thresholds{120k tokens or 80 turns?}
  Thresholds -- yes --> HandoffPrompt[capture handoff summary]
  HandoffPrompt --> Handoffs[meta/handoffs.json]
  Handoffs --> Cycle[close session + start new session]
  Cycle --> AgentSDK
  Handoffs --> SystemPrompt[append handoff to next system prompt]
  SystemPrompt --> Session

  HealthTimer[worker health timer every 30s] --> PidCheck[check choomfie.pid process]
  PidCheck --> Healthy{process alive?}
  Healthy -- yes --> State
  Healthy -- no --> FailureCount[consecutive failures]
  FailureCount --> FailureLimit{3 failures?}
  FailureLimit -- yes --> Cycle

  AgentErrors[session stream errors] --> Retry[restart session with exponential backoff]
  Retry --> AgentSDK
```

Daemon state files:

- `meta/meta.pid` tracks the daemon process.
- `choomfie.pid` tracks the supervisor process used by worker health checks.
- `meta/handoffs.json` stores recent handoff summaries.
- `meta/daemon-state.json` records turns, tokens, cycles, provider, and worker health for status reporting.

Provider note: daemon sessions start on Anthropic. Repeated Anthropic API failures switch subsequent session starts to the Ollama-compatible fallback provider.

## Voice Pipeline

The voice plugin turns Discord voice activity into Claude channel notifications
and speaks Claude responses back through Discord voice.

```mermaid
flowchart LR
  User[User audio] --> DiscordOpus[Discord Opus packets]
  DiscordOpus --> Receiver[VoiceConnection receiver]
  Receiver --> SpeakerPipeline[per-speaker pipeline]
  SpeakerPipeline --> OpusDecode["@discordjs/opus decode"]
  OpusDecode --> VadInput[downsample for VAD]
  VadInput --> Silero[SileroVAD + SpeechDetector]

  Silero --> SpeechStart[speech_start]
  SpeechStart --> Collect[collect Opus chunks]
  Collect --> SegmentFlush{150 chunks?}
  SegmentFlush -- yes --> ParallelSTT[transcribe segment in parallel]
  Collect --> SpeechEnd[speech_end]
  SpeechEnd --> FinalFlush[flush final segment]
  FinalFlush --> Ffmpeg[ffmpeg 48kHz stereo PCM to 16kHz mono WAV]
  Ffmpeg --> STT[STT provider]
  STT --> Combine[combine transcripts]
  Combine --> Notification[MCP channel notification]
  Notification --> Claude[Claude Code]

  Claude --> SpeakTool[speak tool]
  SpeakTool --> Queue[speak queue + generation id]
  Queue --> Split[split into sentences]
  Split --> TTS[TTS provider]
  TTS --> Pipelined[pipeline next sentence while current plays]
  Pipelined --> AudioPlayer[Discord AudioPlayer]
  AudioPlayer --> VoiceChannel[Discord voice channel]

  Silero --> BargeIn{bot speaking + 300ms user speech?}
  BargeIn -- yes --> Interrupt[stop playback + invalidate generation]
  Interrupt --> Notification
  SpeechEnd --> Filler[optional persona filler audio]
  Filler --> AudioPlayer
```

Voice implementation notes:

- `plugins/voice/manager.ts` owns voice connections, provider selection, speak queues, and lifecycle cleanup.
- `plugins/voice/listening.ts` owns per-speaker receive pipelines, VAD, barge-in detection, chunk flushing, and transcript notification.
- `plugins/voice/transcription.ts` decodes Opus, runs ffmpeg resampling, calls STT, and emits MCP notifications.
- `plugins/voice/playback.ts` splits long speech into sentence chunks and pipelines TTS playback through `AudioPlayer`.
