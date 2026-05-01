# Voice Optimization Roadmap

Comprehensive plan to reduce Choomfie's voice round-trip latency from ~5-8s to ~1.5-2.5s perceived.

## Implementation Status

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 1 | Streaming TTS (sentence chunking + one-ahead pipelining) | ✅ Implemented |
| Phase 2 | Silero VAD + adaptive endpointing | ✅ Implemented |
| Phase 3 | Interruption handling + barge-in detection | ✅ Implemented |
| Phase 4 | Filler audio (persona-aware, pre-synthesized) | ✅ Implemented |
| Phase 5 | Streaming STT | Planned |
| Phase 6 | Multi-speaker architecture (per-speaker VAD pipelines) | ✅ Implemented |
| Phase 7 | Prompt optimization for voice | ✅ Implemented |

**Key files:**
- `plugins/voice/vad.ts` — SileroVAD (ONNX) + SpeechDetector (adaptive endpointing)
- `plugins/voice/sentence-splitter.ts` — `splitSentences()` for TTS chunking
- `plugins/voice/playback.ts` — `speakText()` with one-ahead synthesis pipelining
- `plugins/voice/fillers.ts` — Persona-aware filler phrase sets
- `plugins/voice/listening.ts` — Multi-speaker pipelines, barge-in detection, VAD loop
- `plugins/voice/manager.ts` — Orchestration: filler cache, interrupt(), generation IDs
- `plugins/voice/providers/kokoro/tts.ts` — Persistent KokoroSession subprocess

## Updated Architecture

```
User speaks → Discord Opus → EndBehaviorType.Manual
  → per-speaker SileroVAD (adaptive endpointing, 400-1200ms)
  → speech_end → play filler immediately (Phase 4)
  → parallel STT segments → combine → MCP notification (source=voice)
  → Claude LLM → speak tool → sentence splitter
  → pipelined kokoro TTS (one-ahead synthesis) → AudioPlayer → Discord
```

Barge-in: user speaking ≥300ms while bot plays → `interrupt()` → generation ID invalidates queued speak() calls.

## Original Architecture

```
User speaks → Discord Opus → opusToPcm() → ffmpeg resample → whisper-cpp STT → MCP notification
  → Claude LLM → speak tool → kokoro-onnx TTS → ffmpeg toDiscordPcm() → AudioPlayer → Discord
```

**Current latency breakdown:**

| Stage | Time | Notes |
|-------|------|-------|
| EndBehaviorType.AfterSilence | ~1000ms | Fixed 1s silence threshold |
| Opus decode + ffmpeg resample | ~100ms | |
| whisper-cpp STT | ~500ms-2s | Depends on utterance length |
| Claude LLM (full response) | ~2-4s | Waits for complete response |
| kokoro-onnx TTS (full text) | ~200ms-1s | Scales with text length |
| ffmpeg PCM conversion | ~100ms | |
| AudioPlayer start | ~100ms | |
| **Total** | **~5-8s** | |

**Key bottleneck:** Everything is sequential. LLM must finish entirely before TTS starts, and TTS must finish entirely before playback starts.

---

## Phase 1: Streaming TTS (Sentence Chunking)

**Goal:** Start playing audio as soon as the first sentence is ready, while the LLM is still generating.

**Expected improvement:** Perceived latency drops from ~5-8s to ~3-4s.

### Design

Instead of waiting for Claude's full response, buffer tokens and flush to TTS on sentence boundaries. Play each chunk as it arrives.

```
Claude tokens: "Sure! " + "I can help " + "with that. " + "Let me explain..."
                                            ^flush 1        ^flush 2 (continues)
                                            ↓
                              kokoro("Sure! I can help with that.")
                                            ↓
                                     AudioPlayer plays chunk 1
                                     (meanwhile, kokoro synthesizes chunk 2)
```

### Implementation

#### 1. Add `StreamingTTSQueue` class

New file: `plugins/voice/streaming-queue.ts`

```typescript
import { Readable } from "node:stream";
import { createAudioResource, StreamType, AudioPlayerStatus, type AudioPlayer } from "@discordjs/voice";
import type { TTSProvider } from "./providers/types.ts";

/**
 * Queues text chunks for TTS synthesis and streams audio to Discord
 * without gaps between chunks.
 */
export class StreamingTTSQueue {
  private queue: Buffer[] = [];
  private synthesizing = false;
  private playing = false;
  private cancelled = false;

  constructor(
    private player: AudioPlayer,
    private tts: TTSProvider,
    private language: string = "en",
    private speed: number = 1.0,
  ) {}

  /** Enqueue a text chunk for synthesis and playback */
  async push(text: string) {
    if (this.cancelled) return;

    // Synthesize in background, push PCM to queue
    const pcm = await this.tts.synthesize(text, this.language, this.speed);
    if (this.cancelled) return;

    this.queue.push(pcm);
    this.drain();
  }

  /** Play queued audio chunks sequentially */
  private async drain() {
    if (this.playing || this.queue.length === 0 || this.cancelled) return;
    this.playing = true;

    while (this.queue.length > 0 && !this.cancelled) {
      const pcm = this.queue.shift()!;
      const stream = Readable.from(pcm);
      const resource = createAudioResource(stream, { inputType: StreamType.Raw });

      this.player.play(resource);

      // Wait for this chunk to finish before playing next
      await new Promise<void>((resolve) => {
        const onIdle = () => {
          this.player.off(AudioPlayerStatus.Idle, onIdle);
          resolve();
        };
        // If already idle (very short chunk), resolve immediately
        if (this.player.state.status === AudioPlayerStatus.Idle) {
          resolve();
        } else {
          this.player.on(AudioPlayerStatus.Idle, onIdle);
        }
      });
    }

    this.playing = false;
  }

  /** Cancel all pending synthesis and playback */
  cancel() {
    this.cancelled = true;
    this.queue.length = 0;
    this.player.stop();
  }
}
```

#### 2. Sentence boundary splitter

```typescript
// plugins/voice/sentence-splitter.ts

/**
 * Buffers streaming text tokens and emits complete sentences.
 *
 * First flush is aggressive — triggers on the first clause boundary
 * (comma, dash, semicolon) to minimize time-to-first-audio.
 */
export class SentenceSplitter {
  private buffer = "";
  private flushedOnce = false;

  /** Feed a token, returns a sentence if boundary detected, null otherwise */
  feed(token: string): string | null {
    this.buffer += token;

    // First flush: aggressive — flush on first clause for fastest audio
    if (!this.flushedOnce) {
      // Flush on clause boundaries (comma, semicolon, dash) if we have 20+ chars
      const clauseMatch = this.buffer.match(/^(.{20,}?[,;:\-\u2014])\s/);
      if (clauseMatch) {
        return this.flush(clauseMatch[1].length + 1);
      }
      // Also flush on sentence boundaries
      const sentenceMatch = this.buffer.match(/^(.+?[.!?\n])\s/);
      if (sentenceMatch) {
        return this.flush(sentenceMatch[1].length + 1);
      }
      return null;
    }

    // Subsequent flushes: standard sentence boundaries
    const match = this.buffer.match(/^(.+?[.!?\n])\s/);
    if (match) {
      return this.flush(match[1].length + 1);
    }
    return null;
  }

  /** Flush remaining buffer (call when stream ends) */
  drain(): string | null {
    if (this.buffer.trim().length === 0) return null;
    const text = this.buffer.trim();
    this.buffer = "";
    return text;
  }

  private flush(upTo: number): string {
    const sentence = this.buffer.slice(0, upTo).trim();
    this.buffer = this.buffer.slice(upTo);
    this.flushedOnce = true;
    return sentence;
  }
}
```

#### 3. Modify `VoiceManager.speak()` to support streaming

Add a new `speakStreaming()` method alongside the existing `speak()`:

```typescript
// In manager.ts — new method

async speakStreaming(
  guildId: string,
  onChunkReady?: (chunkIndex: number) => void,
): Promise<{ queue: StreamingTTSQueue; splitter: SentenceSplitter }> {
  this.ensureInitialized();
  const gv = this.guilds.get(guildId);
  if (!gv) throw new Error("Not connected to voice in this server");

  const speed = this.ctx.config.getVoiceConfig().ttsSpeed ?? 1.0;
  const queue = new StreamingTTSQueue(gv.player, this.tts, "en", speed);
  const splitter = new SentenceSplitter();

  return { queue, splitter };
}
```

#### 4. Kokoro session reuse

The current implementation spawns a new Python process per synthesis call. For streaming, this overhead (~100ms startup) adds up. Optimization: keep a long-running Python process with a persistent ONNX session.

```python
# kokoro_server.py — persistent subprocess, reads JSON lines from stdin
import sys, json, soundfile as sf, tempfile, os
from kokoro_onnx import Kokoro

kokoro = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")

for line in sys.stdin:
    req = json.loads(line)
    samples, sr = kokoro.create(req["text"], voice=req["voice"], speed=1.0)
    out = tempfile.mktemp(suffix=".wav")
    sf.write(out, samples, sr)
    print(json.dumps({"path": out}), flush=True)
```

This keeps the ONNX session warm. Synthesis drops from ~200ms to ~80-120ms per sentence after the first call.

### Migration

- Keep existing `speak()` unchanged for backward compatibility
- New `speakStreaming()` is opt-in, used when the reply tool detects voice mode
- The reply tool would need a voice-aware path that streams tokens to the splitter

---

## Phase 2: Silero VAD + Adaptive Endpointing

**Goal:** Detect speech end faster and more accurately than fixed silence timeout.

**Expected improvement:** Endpointing drops from ~1000ms to ~400ms.

### Current Problem

```typescript
// manager.ts line 161-165
const opusStream = gv.connection.receiver.subscribe(userId, {
  end: {
    behavior: EndBehaviorType.AfterSilence,
    duration: 1000,  // Fixed 1s — too slow for quick exchanges, too fast for pauses
  },
});
```

This is a blunt instrument: 1000ms of silence always, regardless of context.

### Design

Replace `EndBehaviorType.AfterSilence` with `EndBehaviorType.Manual` and use Silero VAD to detect speech end with adaptive thresholds.

```
Opus frames → decode → PCM 16kHz mono → Silero VAD
                                          ↓
                              speech_start → begin buffering
                              speech_end   → silence timer starts
                                             adaptive threshold = min(1200, 400 + duration * 0.3)
                              timer expires → finalize, send to STT
```

### Implementation

#### 1. Install VAD dependency

```bash
bun add @ricky0123/vad-node
```

Note: `@ricky0123/vad-node` wraps Silero's ONNX model. Runs locally, no cloud dependency. Compatible with Bun via ONNX Runtime.

#### 2. Create VAD wrapper

New file: `plugins/voice/vad.ts`

```typescript
import { type MicVAD, createMicVADStream } from "@ricky0123/vad-node";

interface VADConfig {
  /** Minimum silence after speech to consider end-of-utterance */
  minSilenceMs: number;
  /** Adaptive factor: threshold = min(maxSilenceMs, minSilenceMs + duration * factor) */
  adaptiveFactor: number;
  maxSilenceMs: number;
}

const DEFAULT_VAD_CONFIG: VADConfig = {
  minSilenceMs: 400,
  adaptiveFactor: 0.3,
  maxSilenceMs: 1200,
};

export class SpeechDetector {
  private speechStartTime: number | null = null;
  private lastSpeechTime: number = 0;
  private isSpeaking = false;

  constructor(private config: VADConfig = DEFAULT_VAD_CONFIG) {}

  /**
   * Feed a PCM frame (16kHz mono, 512 samples = 32ms).
   * Returns: 'speech_start' | 'speech_end' | null
   */
  processProbability(probability: number, now: number = Date.now()): string | null {
    const isSpeech = probability > 0.5;

    if (isSpeech && !this.isSpeaking) {
      this.isSpeaking = true;
      this.speechStartTime = now;
      this.lastSpeechTime = now;
      return "speech_start";
    }

    if (isSpeech) {
      this.lastSpeechTime = now;
      return null;
    }

    if (!isSpeech && this.isSpeaking) {
      const speechDuration = now - (this.speechStartTime || now);
      const silenceDuration = now - this.lastSpeechTime;

      // Adaptive threshold: short utterances get shorter silence threshold
      const threshold = Math.min(
        this.config.maxSilenceMs,
        this.config.minSilenceMs + speechDuration * this.config.adaptiveFactor,
      );

      if (silenceDuration >= threshold) {
        this.isSpeaking = false;
        this.speechStartTime = null;
        return "speech_end";
      }
    }

    return null;
  }

  reset() {
    this.isSpeaking = false;
    this.speechStartTime = null;
    this.lastSpeechTime = 0;
  }
}
```

#### 3. Modify `listenToUser()` in `manager.ts`

Replace the current opus stream subscription:

```typescript
private listenToUser(guildId: string, userId: string) {
  const gv = this.guilds.get(guildId);
  if (!gv) return;
  if (userId === this.ctx.discord.user?.id) return;

  gv.listeningTo.add(userId);

  // Manual endpointing — we control when the stream ends
  const opusStream = gv.connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.Manual },
  });

  const { OpusEncoder } = require("@discordjs/opus");
  const decoder = new OpusEncoder(48000, 2);
  const vad = new SpeechDetector();

  const chunks: Buffer[] = [];
  let collecting = false;

  opusStream.on("data", (chunk: Buffer) => {
    // Decode opus frame to PCM for VAD analysis
    let pcm: Buffer;
    try {
      pcm = decoder.decode(chunk);
    } catch {
      return; // Skip corrupted frames
    }

    // Downsample to 16kHz mono for VAD (simple decimation — adequate for detection)
    const mono16k = downsampleForVAD(pcm);
    const probability = this.sileroVAD.process(mono16k); // Silero returns 0-1

    const event = vad.processProbability(probability);

    if (event === "speech_start") {
      collecting = true;
      chunks.length = 0;
    }

    if (collecting) {
      chunks.push(chunk); // Store original opus for full-quality STT
    }

    if (event === "speech_end" && collecting) {
      collecting = false;
      this.processUtterance(guildId, userId, [...chunks]);
      chunks.length = 0;
    }
  });

  // Discord silence frames (0xF8, 0xFF, 0xFE header) as additional signal
  // These 3-byte frames indicate the user stopped transmitting
  opusStream.on("data", (chunk: Buffer) => {
    if (chunk.length <= 3) {
      // Silence frame — boost confidence that speech ended
      vad.processProbability(0);
    }
  });
}
```

#### 4. Silero ONNX model initialization

Load the Silero model once during `VoiceManager.init()`:

```typescript
async init() {
  this.stt = await getSTTProvider(this.ctx.config);
  this.tts = await getTTSProvider(this.ctx.config);

  // Load Silero VAD model (small ONNX, ~2MB)
  // @ricky0123/vad-node bundles the model
  const { Silero } = await import("@ricky0123/vad-node");
  this.sileroVAD = await Silero.new();

  console.error(`Voice providers: STT=${this.stt.name}, TTS=${this.tts.name}, VAD=silero`);
}
```

### Notes

- Silero VAD expects 16kHz mono float32 frames of 512 samples (32ms)
- The downsampling from Discord's 48kHz stereo is a simple 3:1 decimation with channel averaging -- not audiophile quality but fine for voice activity detection
- Keep `EndBehaviorType.Manual` but add a hard timeout (e.g., 30s) as a safety net to prevent leaked subscriptions

---

## Phase 3: Interruption Handling & Cancellation Propagation

**Goal:** Stop playback immediately when the user starts speaking, cancel in-flight work, and reconcile state — like a natural conversation.

**Expected improvement:** Better UX, prevents stale responses from playing.

### Industry Research

**Pipecat** uses a frame-based system where `InterruptionFrame` (high priority) bypasses all queues and hits every processor immediately. Each processor's `_start_interruption()` fires: TTS stops, LLM stops, buffers clear. Critically, they track what was *actually spoken* via TTS timestamps — only committed text is kept in context.

**LiveKit Agents** returns a `SpeechHandle` from `say()` / `generate_reply()` that you can call `interrupt()` on. They have false-interruption recovery — if VAD triggers but transcript is empty (noise), the agent resumes from where it left off.

**Vapi** uses `stop_speaking_plan` config with `numWords` (how many user words before interrupting) and `voiceSeconds` (minimum speech duration, default 0.2s). They use word-level TTS timestamps to reconstruct exactly what was heard.

**Retell AI** uses a predictive turn-taking model that combines acoustic signals + LLM fusion, targeting ~800ms response latency.

### Recommended Patterns for Choomfie

#### Pattern A: Generation ID (Invalidate Stale Responses)

Since Claude processes via MCP and we can't cancel its thinking, use a monotonic counter. When `speak()` is called, check if the generation is still current:

```typescript
private generationId = 0;

async speak(guildId: string, text: string) {
  const myGen = ++this.generationId;
  const audio = await this.tts.synthesize(text);
  if (this.generationId !== myGen) return; // stale — discard
  this.playAudio(gv, audio);
}
```

#### Pattern B: Interrupt-on-Speech (Stop Playback)

When user speaks while bot is playing, stop immediately:

```typescript
connection.receiver.speaking.on("start", (userId) => {
  if (userId === botId) return;
  if (gv.player.state.status === AudioPlayerStatus.Playing) {
    gv.player.stop();
    this.generationId++; // invalidate queued speak() calls
  }
});
```

#### Pattern C: Mutable Speak Queue

Replace simple FIFO with cancellable entries:

```typescript
interface SpeakEntry {
  text: string;
  generationId: number;
  cancelled: boolean;
}

cancelPendingSpeech() {
  for (const entry of this.speakQueue) entry.cancelled = true;
  gv.player.stop();
}
```

#### Pattern D: Debounce Rapid Utterances

Combine rapid user messages before sending to Claude:

```typescript
onUtteranceEnd(userId, transcript) {
  const existing = this.pendingTranscripts.get(userId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.text += " " + transcript;
  }
  entry.timer = setTimeout(() => {
    this.sendToClaudeFinal(userId, entry.text);
  }, 300); // 300ms debounce
}
```

#### Pattern E: State Reconciliation

Include interruption context in MCP notifications so Claude knows what the user heard:

```typescript
if (this.wasInterrupted && this.lastSpokenText) {
  meta.interrupted_previous = true;
  meta.partial_response = this.lastSpokenText;
}
```

### Edge Cases

- **Echo cancellation:** Bot's own audio picked up by user mics. Filter by userId (already done) + potentially mute receive during playback.
- **Rapid interruption loops:** User interrupts → bot responds → user interrupts again. Need a circuit breaker — after N interruptions in M seconds, wait for longer silence.
- **Queue starvation with MCP:** Claude may call `speak()` multiple times. If user interrupts during sentence 1, sentences 2-3 are in-flight MCP tool calls. Worker must silently discard stale calls via generation ID.
- **False interruption recovery:** If VAD triggers on noise but transcript is empty, resume previous response (LiveKit pattern).
- **Race between STT and new speech:** User finishes A, bot processes. User starts B. Without debouncing, Claude gets A then B and may generate two responses.

### State Machine

```
        user speaks
IDLE ──────────────► LISTENING
  ▲                      │
  │ timeout               │ speech_end (VAD)
  │                      ▼
  │              ┌── THINKING
  │              │       │
  │   interrupt  │       │ first TTS chunk ready
  │   (barge-in) │       ▼
  │              └── SPEAKING
  │                      │
  │                      │ all chunks played
  └──────────────────────┘
```

### Implementation

#### 1. Add state to `GuildVoice`

```typescript
interface GuildVoice {
  connection: VoiceConnection;
  player: AudioPlayer;
  listeningTo: Set<string>;
  state: "idle" | "listening" | "thinking" | "speaking";
  currentQueue: StreamingTTSQueue | null;
  spokenText: string;        // Text of chunks already played (for context)
  bargeInTimer: Timer | null;
}
```

#### 2. Barge-in detection

In the VAD processing path, detect user speech while bot is speaking:

```typescript
if (event === "speech_start" && gv.state === "speaking") {
  // Barge-in detected — but apply threshold to filter noise
  gv.bargeInTimer = setTimeout(() => {
    // 300ms of sustained speech = real interruption, not a cough
    if (gv.state === "speaking") {
      console.error(`Voice: barge-in detected from ${userId}`);

      // Stop playback immediately
      gv.currentQueue?.cancel();
      gv.player.stop();

      // Preserve context for LLM
      const partialText = gv.spokenText;
      gv.state = "listening";

      // When this utterance completes, include interruption context
      gv.interruptionContext = `User interrupted after hearing: "${partialText}"`;
    }
  }, 300); // 300ms barge-in threshold
}

// Clear barge-in timer if speech stops quickly (was just a cough/backchannel)
if (event === "speech_end" && gv.bargeInTimer) {
  clearTimeout(gv.bargeInTimer);
  gv.bargeInTimer = null;
}
```

#### 3. Context preservation

When sending the interrupted transcript to Claude, prepend interruption context:

```typescript
const notification = {
  method: "notifications/claude/channel",
  params: {
    content: gv.interruptionContext
      ? `[${gv.interruptionContext}]\n\n${transcript}`
      : transcript,
    meta: {
      // ... existing meta fields
      interrupted: gv.interruptionContext ? "true" : "false",
    },
  },
};
```

This tells Claude what the user already heard so it does not repeat itself.

### Edge Cases

- **Backchannel filtering:** "mhm", "uh-huh" under 300ms should not trigger interruption. The barge-in threshold handles this.
- **Echo cancellation:** If the bot's own audio is picked up by the user's mic, it could trigger false barge-in. Mitigation: ignore barge-in for the first 200ms after bot starts speaking (echo delay).
- **Multiple speakers:** In Phase 6 each speaker has independent VAD, so one speaker's backchannel does not interrupt for another.

---

## Phase 4: Filler Audio

**Goal:** Mask LLM latency with persona-aware filler phrases.

**Expected improvement:** Perceived latency drops to near-zero for the "thinking" gap.

### Design

Pre-synthesize filler phrases at startup. When a user finishes speaking, immediately play a random filler while Claude thinks. When the real response arrives, crossfade from filler to response.

### Implementation

#### 1. Filler definitions per persona

```typescript
// plugins/voice/fillers.ts

export interface FillerSet {
  /** Fillers played while waiting for LLM response */
  thinking: string[];
  /** Fillers for acknowledgment */
  ack: string[];
}

export const FILLER_SETS: Record<string, FillerSet> = {
  // Default
  choomfie: {
    thinking: [
      "Hmm, let me think...",
      "Oh, interesting...",
      "Give me a sec...",
      "Okay so...",
      "Right, right...",
    ],
    ack: [
      "Got it.",
      "I see.",
      "Okay.",
      "Mmhm.",
    ],
  },
  // Tsundere Taiga
  taiga: {
    thinking: [
      "Hmph, hold on...",
      "Tch, let me think about that...",
      "It's not like I need to think about this or anything...",
      "Ugh, fine, give me a second...",
      "W-well...",
    ],
    ack: [
      "I heard you, idiot.",
      "Yeah yeah...",
      "Hmph.",
      "Whatever.",
    ],
  },
};

/** Get fillers for current persona, falling back to default */
export function getFillersForPersona(persona: string): FillerSet {
  return FILLER_SETS[persona.toLowerCase()] || FILLER_SETS.choomfie;
}
```

#### 2. Pre-synthesis at startup

```typescript
// In VoiceManager.init()

private fillerCache = new Map<string, Buffer[]>(); // persona -> PCM buffers

async init() {
  // ... existing provider init ...

  // Pre-synthesize fillers for active persona
  await this.warmFillers(this.ctx.config.getActivePersona());
}

private async warmFillers(persona: string) {
  const fillers = getFillersForPersona(persona);
  const allPhrases = [...fillers.thinking, ...fillers.ack];
  const speed = this.ctx.config.getVoiceConfig().ttsSpeed ?? 1.0;

  console.error(`Voice: pre-synthesizing ${allPhrases.length} fillers for persona "${persona}"`);
  const buffers = await Promise.all(
    allPhrases.map(phrase => this.tts.synthesize(phrase, "en", speed))
  );

  this.fillerCache.set(persona, buffers);
  console.error(`Voice: ${buffers.length} fillers cached`);
}
```

#### 3. Play filler on speech end

```typescript
// In the speech_end handler, before sending to Claude:

if (gv.state === "idle") {
  gv.state = "thinking";

  // Play a random filler immediately
  const persona = this.ctx.config.getActivePersona();
  const cached = this.fillerCache.get(persona);
  if (cached && cached.length > 0) {
    const filler = cached[Math.floor(Math.random() * cached.length)];
    const stream = Readable.from(filler);
    const resource = createAudioResource(stream, { inputType: StreamType.Raw });
    gv.player.play(resource);
  }

  // Send transcript to Claude (async — response comes later via speak tool)
  this.ctx.mcp.notification({ /* ... */ });
}
```

#### 4. Persona switch hook

When persona changes, re-synthesize fillers:

```typescript
// Hook into persona switch (config change listener)
this.ctx.config.on("personaChanged", async (newPersona: string) => {
  if (!this.fillerCache.has(newPersona)) {
    await this.warmFillers(newPersona);
  }
});
```

### Filler Generation Script (Part of Voice Setup)

Fillers should be generated as part of the `/voice` setup wizard, after the user picks their TTS provider and voice:

```bash
# scripts/generate-fillers.ts
# Run after voice provider selection during /voice setup

import { getTTSProvider } from "../plugins/voice/providers/index.ts";
import { FILLER_SETS } from "../plugins/voice/fillers.ts";

const tts = await getTTSProvider(config);
const outputDir = `${DATA_DIR}/voice-cache/fillers/${persona}`;
await mkdir(outputDir, { recursive: true });

for (const [i, phrase] of fillers.thinking.entries()) {
  const pcm = await tts.synthesize(phrase, "en", speed);
  await Bun.write(`${outputDir}/thinking_${i}.pcm`, pcm);
}
// ... same for ack fillers
```

**Setup flow:**
1. User runs `/voice` → picks TTS provider → picks voice
2. Script generates filler audio files for active persona
3. Files cached to `~/.claude/plugins/data/choomfie-inline/voice-cache/fillers/`
4. On startup, fillers loaded from cache (no re-synthesis needed)
5. On persona switch, check cache → generate if missing

### Memory footprint

- ~5-10 phrases per persona, each ~1-3 seconds of audio
- PCM at 48kHz stereo 16-bit: ~192KB/second
- Total per persona: ~1-3MB
- Acceptable for in-memory caching, also persisted to disk for fast startup

---

## Phase 5: Streaming STT

**Goal:** Start processing speech before the user finishes talking.

**Expected improvement:** STT latency drops from ~1-2s to ~0.5-1s.

### Research Options

| Approach | Pros | Cons |
|----------|------|------|
| **whisper-streaming** (ufal/whisper_streaming) | Wraps whisper.cpp, partial transcripts, local | Python wrapper, added complexity |
| **faster-whisper** | Very fast, CTranslate2 backend, streaming | Python, requires separate install |
| **whisper.cpp --stream mode** | Built-in streaming in whisper-cpp | Requires specific build flags |
| **Deepgram** (cloud) | Real-time WebSocket API, very fast | Cloud dependency, costs money |
| **Groq Whisper** | Already have provider, very fast | Cloud dependency, rate limits |

### Recommended: Hybrid Approach

1. **Default (local):** Use whisper.cpp with VAD-segmented chunks. Send shorter audio segments to whisper as they are detected by VAD, rather than waiting for the full utterance. This is not true streaming but reduces effective latency.

2. **Optional cloud tier:** Add a `streaming-stt` provider interface for real-time WebSocket STT (Deepgram, AssemblyAI). Users who want lowest latency can opt in.

### Partial Transcript Architecture

```typescript
// Extended STT provider interface
export interface StreamingSTTProvider extends STTProvider {
  /** Start a streaming session */
  startStream(language?: string): STTStream;
}

export interface STTStream {
  /** Feed PCM audio chunk */
  write(pcm: Buffer): void;
  /** Get partial transcript (may change as more audio arrives) */
  onPartial(callback: (text: string) => void): void;
  /** Get final transcript for a segment */
  onFinal(callback: (text: string) => void): void;
  /** End the stream */
  close(): Promise<string>;
}
```

### Local Streaming with whisper.cpp

whisper.cpp has a `--stream` flag that reads audio from stdin and outputs partial transcripts. This can be wrapped:

```typescript
// Spawn persistent whisper process in stream mode
const proc = Bun.spawn([
  whisperBin,
  "--model", modelPath,
  "--stream",
  "--step", "500",      // Process every 500ms
  "--length", "5000",   // Keep 5s context window
  "-f", "-",            // Read from stdin
], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });

// Feed PCM audio as it arrives from VAD
proc.stdin.write(pcmChunk);

// Read partial transcripts from stdout
// whisper outputs lines like: "[00:00.000 --> 00:01.500]  Hello world"
```

### Timeline

This phase is lower priority than Phases 1-4. The biggest wins come from streaming TTS and better endpointing. Streaming STT shaves ~0.5-1s but adds significant complexity.

---

## Phase 6: Multi-Speaker Architecture

**Goal:** Handle multiple users speaking simultaneously in a voice channel.

**Expected improvement:** Proper multi-user support without blocking.

### Current Limitation

The current `listenToUser()` approach works for one speaker at a time. The `listeningTo` Set prevents re-subscribing to an active speaker, but does not handle true concurrency.

### Design

Spawn a dedicated STT pipeline per active speaker. Each pipeline has its own:
- Opus decoder instance
- VAD state
- Audio buffer
- STT process

```
Speaker A ──→ [Opus Decode → VAD → Buffer → STT] ──→ transcript A
Speaker B ──→ [Opus Decode → VAD → Buffer → STT] ──→ transcript B
Speaker C ──→ [Opus Decode → VAD → Buffer → STT] ──→ transcript C
                                                           ↓
                                               Single LLM context
                                            (all speakers identified)
```

### Implementation

```typescript
interface SpeakerPipeline {
  userId: string;
  decoder: any;            // @discordjs/opus encoder instance
  vad: SpeechDetector;
  chunks: Buffer[];
  collecting: boolean;
  lastActive: number;
}

class MultiSpeakerManager {
  private pipelines = new Map<string, SpeakerPipeline>();
  private maxConcurrent = 4; // M4 Pro can handle 3-4 whisper instances

  getOrCreate(userId: string): SpeakerPipeline {
    let pipeline = this.pipelines.get(userId);
    if (!pipeline) {
      if (this.pipelines.size >= this.maxConcurrent) {
        this.evictOldest();
      }
      const { OpusEncoder } = require("@discordjs/opus");
      pipeline = {
        userId,
        decoder: new OpusEncoder(48000, 2),
        vad: new SpeechDetector(),
        chunks: [],
        collecting: false,
        lastActive: Date.now(),
      };
      this.pipelines.set(userId, pipeline);
    }
    pipeline.lastActive = Date.now();
    return pipeline;
  }

  private evictOldest() {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [id, p] of this.pipelines) {
      if (p.lastActive < oldestTime && !p.collecting) {
        oldest = id;
        oldestTime = p.lastActive;
      }
    }
    if (oldest) this.pipelines.delete(oldest);
  }
}
```

### Subprocess Worker Pool

For true parallelism, offload STT to child processes:

```typescript
class STTWorkerPool {
  private workers: Bun.Subprocess[] = [];
  private available: Bun.Subprocess[] = [];
  private poolSize: number;

  constructor(poolSize: number = 3) {
    this.poolSize = poolSize;
  }

  async init() {
    for (let i = 0; i < this.poolSize; i++) {
      const worker = Bun.spawn(["bun", "plugins/voice/stt-worker.ts"], {
        stdin: "pipe",
        stdout: "pipe",
        ipc: (message) => this.handleResult(message),
      });
      this.workers.push(worker);
      this.available.push(worker);
    }
  }

  async transcribe(audioBuffer: Buffer): Promise<string> {
    const worker = this.available.pop();
    if (!worker) {
      // All busy — fall back to inline processing
      return this.inlineTranscribe(audioBuffer);
    }

    return new Promise((resolve) => {
      worker.send({ type: "transcribe", audio: audioBuffer.toString("base64") });
      // Result comes back via IPC handler
      this.pendingResolves.set(worker, resolve);
    });
  }
}
```

### Resource Limits

| Hardware | Max Concurrent STT | Notes |
|----------|--------------------|-------|
| M4 Pro (14-core) | 3-4 | whisper-cpp uses ~2 cores per instance |
| M1/M2 (8-core) | 2 | Leave headroom for TTS + Discord |
| Intel i7 | 2-3 | Depends on generation |

Make `maxConcurrent` configurable in `config.json` under `voice.maxSpeakers`.

---

## Phase 7: Prompt Optimization for Voice

**Goal:** Make Claude's responses natural for voice output.

**Expected improvement:** Shorter responses = faster TTS, more natural delivery.

### System Prompt Additions

Add to voice-mode instructions in `plugins/voice/index.ts`:

```typescript
instructions: [
  // ... existing instructions ...

  // Voice-specific response guidelines
  "## Voice Response Style",
  "When responding to voice messages (source='voice'), follow these rules:",
  "- Start with a short acknowledgment or reaction before the main content.",
  "- Keep responses concise — 1-3 sentences for simple questions.",
  "- Use natural speech patterns: contractions, filler words, varied sentence length.",
  "- NEVER use markdown, bullet lists, code blocks, or numbered lists — they sound terrible when spoken.",
  "- NEVER use URLs, file paths, or technical notation in voice responses.",
  "- If the user asks for complex information, give a brief spoken summary and offer to send details in text.",
  "- Use conversational transitions: 'So basically...', 'The thing is...', 'Oh and also...'",
],
```

### max_tokens for Voice

The reply tool (or a voice-specific wrapper) should enforce shorter responses in voice mode:

```typescript
// When processing voice transcripts, add to the notification meta:
meta: {
  // ... existing fields
  source: "voice",
  max_response_tokens: "150", // Guide Claude to be concise
}
```

150 tokens is roughly 2-3 spoken sentences, which takes ~3-5 seconds to speak at natural pace.

### Persona Voice Calibration

Each persona should have voice-specific style hints:

```typescript
// In persona config
{
  "taiga": {
    "personality": "tsundere, sharp-tongued...",
    "voiceStyle": "Short, punchy sentences. Lots of 'hmph' and 'tch' sounds. Trail off when flustered."
  }
}
```

---

## Target Latency Summary

| Stage | Current | Phase 1 | Phase 2 | Phase 4 | All Phases |
|-------|---------|---------|---------|---------|------------|
| VAD/Endpointing | ~1000ms | ~1000ms | ~400ms | ~400ms | ~400ms |
| STT | ~1-2s | ~1-2s | ~1-2s | ~1-2s | ~0.5-1s |
| Filler (masks LLM wait) | -- | -- | -- | ~0ms | ~0ms |
| LLM (to first sentence) | ~2-4s | ~0.5-1s | ~0.5-1s | ~0.5-1s | ~0.5-1s |
| TTS (first chunk) | ~1-2s | ~200-400ms | ~200-400ms | ~200-400ms | ~200-400ms |
| Transport | ~200-500ms | ~100-200ms | ~100-200ms | ~100-200ms | ~100-200ms |
| **Perceived** | **~5-8s** | **~3-4s** | **~2-3s** | **~1-2s** | **~1.5-2.5s** |

Phase 4 (fillers) has the most dramatic effect on perceived latency because it fills the dead air gap.

## Implementation Priority

```
Phase 1 (Streaming TTS)        ████████████ HIGH — biggest latency win
Phase 4 (Filler Audio)         ████████████ HIGH — biggest perceived win, easiest to implement
Phase 2 (Silero VAD)           ████████░░░░ MEDIUM — solid improvement, moderate complexity
Phase 3 (Interruption)         ████████░░░░ MEDIUM — important for UX, depends on Phase 2
Phase 7 (Prompt Optimization)  ██████░░░░░░ MEDIUM — low effort, good return
Phase 5 (Streaming STT)        ████░░░░░░░░ LOW — diminishing returns, high complexity
Phase 6 (Multi-Speaker)        ████░░░░░░░░ LOW — only needed for group conversations
```

Recommended order: **Phase 4 -> Phase 1 -> Phase 2 -> Phase 3 -> Phase 7 -> Phase 5 -> Phase 6**

Phase 4 is trivially implementable and gives the biggest perceived improvement. Phase 1 is the biggest actual latency win but requires the most code changes.

## Open Source References

- **Pipecat** (github.com/pipecat-ai/pipecat) — Sentence aggregation pattern in `SentenceAggregator`. Their frame-based pipeline architecture is a good reference for chunked TTS streaming.
- **LiveKit Agents** (github.com/livekit/agents) — Adaptive endpointing implementation in their `VoicePipelineAgent`. Their `min_endpointing_delay` / `max_endpointing_delay` maps to our adaptive threshold.
- **Bolna** (github.com/bolna-ai/bolna) — Interruption buffer pattern. Their `synthesizer` module handles barge-in with a discard buffer.
- **Vocode** (github.com/vocodedev/vocode-python) — Conversation state machine (`ConversationState` enum) is a clean reference for Phase 3.
- **@ricky0123/vad-node** (npm) — Silero VAD wrapper for Node.js / Bun. Pre-trained model, zero configuration.
- **whisper-streaming** (github.com/ufal/whisper_streaming) — Local streaming STT using whisper.cpp backend with partial transcript support.

## Architectural Analogy: CQRS / Read Replicas

The voice agent architecture maps cleanly to database read/write separation (CQRS):

**Database Pattern:**
- **1 Primary Writer** — handles inserts, updates, deletes. Serialized for consistency.
- **N Read Replicas** — serve queries in parallel. Stateless, horizontally scalable.

**Voice Agent Mapping:**

| Database Concept | Voice Agent Equivalent | Why |
|---|---|---|
| Read Replicas (parallel) | STT Workers | Transcribing audio is stateless, parallelizable per-speaker |
| Primary Writer (serial) | LLM Response | One Claude response at a time per conversation |
| Read Response | TTS Output | Sentence chunks synthesized in parallel |

```
Speaker A → [STT Worker 1] ┐
Speaker B → [STT Worker 2] ├→ Conversation Queue → [Claude] → [TTS Chunker]
Speaker C → [STT Worker 3] ┘       (serial)        (serial)    (parallel)
                                                                ├→ Sentence 1 → play
                                                                ├→ Sentence 2 → queue
                                                                └→ Sentence 3 → queue
```

**Key insight from databases:** Don't make the fast parallel things wait behind the slow serial thing. Keep them on separate paths until they absolutely need to converge.

This principle guides the multi-speaker architecture (Phase 6) and streaming TTS (Phase 1) — both are about maximizing parallelism at each stage.

---

## Bug Fix: Speak Queue (Race Condition)

**Problem:** Multiple concurrent `speak()` calls (e.g., background agent finishes while bot is speaking) race on the same `AudioPlayer`, causing `entersState` to abort with "The operation was aborted."

**Fix:** Added a `speakQueue` promise chain to `GuildVoice`. Each `speak()` call chains onto the previous one, ensuring sequential execution:

```typescript
interface GuildVoice {
  // ...
  speakQueue: Promise<void>; // Serializes speak() calls
}

async speak(guildId, text, language) {
  const gv = this.guilds.get(guildId);
  const task = gv.speakQueue.then(() => this.doSpeak(gv, text, language));
  gv.speakQueue = task.catch(() => {}); // Swallow errors in chain
  return task;
}
```

This is a prerequisite for Phase 1 (Streaming TTS) — the `StreamingTTSQueue` replaces this with a proper audio chunk queue.

**Related regression:** `PLAYBACK_FINISH_TIMEOUT` was bumped from 30s to 120s to accommodate long TTS responses. This is a band-aid — with streaming TTS (Phase 1), each chunk is only a sentence (~3-5s audio), so the timeout can be reduced back to 30s or less. Track this when implementing Phase 1.

---

## Potential Future Providers

### TTS: Microsoft VibeVoice-Realtime-0.5B

- **Repo:** github.com/microsoft/VibeVoice | MIT License
- **Model:** 0.5B params, ~300ms first audio latency, streaming text input
- **Languages:** EN + CN
- **Status:** Model weights on HuggingFace. Official usage code disabled ("widespread misuse"), but community forks have it running.
- **Hardware:** Likely needs NVIDIA GPU. Apple Silicon unknown.
- **Why interesting:** 300ms streaming latency would be excellent for our voice pipeline. If Apple Silicon support arrives, this beats Kokoro on latency.
- **Why not yet:** 6x larger than Kokoro (500M vs 82M), GPU-dependent, only 2 languages, no official install path.
- **Watch:** Community forks, Apple Silicon compatibility, Microsoft re-enabling code.

### TTS: Microsoft VibeVoice-TTS-1.5B

- **Model:** 1.5B params, up to 90 minutes long-form, 4 speakers, expressive/conversational
- **Languages:** EN + CN
- **Status:** Model on HuggingFace (`microsoft/VibeVoice-1.5B`). Code disabled. Community archive at `shijincai/VibeVoice` has restored code including removed 7B version.
- **Hardware:** Definitely needs GPU. Too heavy for CPU.
- **Why interesting:** Multi-speaker, long-form, expressive. Perfect for podcast-style generation.
- **Why not yet:** Way too heavy for real-time Discord voice on our hardware. Better suited for async content generation.

### STT: Microsoft VibeVoice-ASR-7B

- **Model:** 7B params, 60-min long-form in single pass, 50+ languages
- **Features:** Speaker diarization, timestamps, hotwords, structured output
- **Why interesting:** Dramatically better than whisper for long-form. Hotword support useful for domain-specific terms.
- **Why not yet:** 7B is massive. GPU-only. Our use case is short utterances where whisper-cpp is fast enough.

### General Notes on VibeVoice

The 7.5 Hz ultra-low frame rate tokenizer is the key innovation — enables long-form generation that other models can't do. The architecture (LLM + diffusion head) produces very natural speech. Worth re-evaluating when Apple Silicon support materializes or if we add GPU support.

---

## Backward Compatibility

All changes must be backward compatible:

- Existing `speak()` method stays unchanged; `speakStreaming()` is additive
- `TTSProvider` interface unchanged; streaming is handled at the queue level
- `STTProvider` interface unchanged; `StreamingSTTProvider` extends it
- Non-streaming mode remains the default; streaming is opt-in via config
- Cloud providers (Groq STT, ElevenLabs TTS) continue to work through the same interfaces
- The supervisor/worker architecture is unchanged; all modifications are within the worker
