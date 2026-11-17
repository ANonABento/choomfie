# Choomfie Activity — plan handoff
Full plan lives in the Waymond workspace (plans/choomfie-activity/plan.md).

## Task 2 — Voice pipeline interface (Req 1, 3)
- Done: `plugins/voice/pipeline/` — `VoiceEvent` contract (user_transcript, assistant_text, audio_chunk, speaking_start/end, emotion, tool_call, error), `VoicePipeline`, `RealtimeVoiceProvider`; `CascadedPipeline` wraps existing STT/TTS providers unchanged (`createCascadedPipeline` uses `getSTTProvider`/`getTTSProvider`); `RealtimePipeline` maps raw provider events and turns `set_emotion` tool calls into `emotion`. Fake-provider sequence tests in `pipeline.test.ts`.
- Left: manager.ts/listening.ts still call providers directly — wiring them through the pipeline is task 3 (config `voice.pipeline`). Cascaded emits one audio_chunk per reply (no sentence streaming yet).
- Surprises: no plan.md was in the repo before this task; 4 pre-existing `bun test` failures unrelated to voice.
