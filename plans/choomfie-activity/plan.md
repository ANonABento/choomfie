# Choomfie Activity — plan handoff
Full plan lives in the Waymond workspace (plans/choomfie-activity/plan.md).

## Task 2 — Voice pipeline interface (Req 1, 3)
- Done: `plugins/voice/pipeline/` — `VoiceEvent` contract (user_transcript, assistant_text, audio_chunk, speaking_start/end, emotion, tool_call, error), `VoicePipeline`, `RealtimeVoiceProvider`; `CascadedPipeline` wraps existing STT/TTS providers unchanged (`createCascadedPipeline` uses `getSTTProvider`/`getTTSProvider`); `RealtimePipeline` maps raw provider events and turns `set_emotion` tool calls into `emotion`. Fake-provider sequence tests in `pipeline.test.ts`.
- Left: manager.ts/listening.ts still call providers directly — wiring them through the pipeline is task 3 (config `voice.pipeline`). Cascaded emits one audio_chunk per reply (no sentence streaming yet).
- Surprises: no plan.md was in the repo before this task; 4 pre-existing `bun test` failures unrelated to voice.

## Task 3 — Config, budget guard and privacy (Req 2, 5, 11)
- Done: `VoiceConfig` gains `pipeline` (cascaded|realtime, default cascaded), `realtime`, `realtimeModel`, `dailyLimits` ("provider:model" → cap), `blockCloudInPrivate`; `parseVoiceConfig` validates on load and names the bad key/provider. `plugins/voice/pipeline/guard.ts`: `DailyBudget` (counter in `<dataDir>/voice-budget.json`, atomic writes, resets by local date), `selectWithBudget` (falls back to next pipeline, logs it), `checkCloudAudio` (refuses cloud in private, logs `⚠️ VOICE AUDIO SENT TO CLOUD PROVIDER`). Tests: `packages/core/test/voice-config.test.ts`, `plugins/voice/pipeline/guard.test.ts`.
- Left: manager.ts/listening.ts not yet wired to the guard/pipeline choice (do with task 4 when gemini exists). Provider name lists in config.ts duplicate the voice registries — keep in sync.
- Surprises: `daemon/rate-limit.ts` only parses SDK events; persistence pattern actually lives in `daemon/state-file.ts` (writeJsonAtomic), which is what the counter follows.
