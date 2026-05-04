# Voice Plugin Completion Audit

Audit date: 2026-05-04

Source roadmap: `docs/voice-optimization-roadmap.md`

## Status

| Area | Status | Evidence |
| --- | --- | --- |
| Streaming TTS sentence pipelining | Implemented | `plugins/voice/playback.ts` splits text with `splitSentences`, synthesizes the next sentence while the current chunk plays, and stops stale playback by generation ID. |
| Silero VAD adaptive endpointing | Implemented | `plugins/voice/vad.ts` wraps Silero ONNX and `SpeechDetector` uses adaptive silence thresholds from 400ms to 1200ms. |
| Interruption handling | Implemented | `plugins/voice/manager.ts` tracks `generationId`; `plugins/voice/listening.ts` confirms barge-in after 300ms while the bot is speaking and calls `interrupt`. |
| Streaming STT 3s flush | Partially implemented | `plugins/voice/manager.ts` sets `MAX_SEGMENT_CHUNKS = 150`, about 3 seconds of Discord Opus frames. `plugins/voice/listening.ts` flushes and transcribes segments while the user continues speaking, then combines segment transcripts before notification. |
| Multi-speaker per-VAD pipelines | Implemented | `plugins/voice/listening.ts` creates per-speaker `SileroVAD` and `SpeechDetector` pipelines, caps them through `maxConcurrentSpeakers`, and evicts the least recently active idle pipeline. `plugins/voice/manager.ts` sets the cap to 4. |
| Silence priming on join | Implemented | `plugins/voice/manager.ts` plays 0.5s of raw PCM silence immediately after joining to prime Discord voice receive. |

## Remaining Work

### Streaming STT

The implemented 3-second flush reduces long-utterance latency by segmenting STT work, but it is not true live streaming STT. The notification to Claude is still sent after the utterance is finalized and segment transcripts are combined.

Remaining scope:

- Decide whether true partial transcript notifications are desirable for voice UX.
- Add a transcript event model if partials should be forwarded before `speech_end`.
- Ensure interruption context and partial transcript ordering remain deterministic.
- Add integration tests around long utterances split into multiple STT segments.

## Verification Added

- Plugin lifecycle tests cover `init -> onMessage -> destroy` and hook isolation.
- Supervisor boundary tests cover bounded draining of active worker tool calls during planned restarts.
- MCP proxy tests cover duck-typed notification forwarding and permission request relay.
- `packages/core/scripts/plugin-smoke-test.ts` imports each workspace plugin, validates tool shapes, and sends a synthetic message through `onMessage` when present.
