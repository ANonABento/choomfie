# Voice Implementation Guide

How to add voice channel support (TTS + STT) to Choomfie. Based on research of existing Discord voice bot projects, TTS/STT services, and VAD solutions.

> Last updated: 2026-03-24

---

## Critical: DAVE E2EE Fix

Discord enforced end-to-end encryption (DAVE protocol) on all voice channels as of March 2, 2026. This broke audio receiving for all bots. The fix was merged in `@discordjs/voice@0.19.2` (March 17, 2026). **You MUST use v0.19.2 or later.**

---

## Architecture

```
User speaks in voice channel
  → @discordjs/voice VoiceReceiver (Opus packets, per user)
  → Opus decode → PCM 16-bit 48kHz mono
  → Downsample to 16kHz → Silero VAD (speech detection)
  → On speech end: send buffered 48kHz PCM to STT
  → Transcript → Claude (LLM) → response text
  → TTS → audio stream → Opus encode → Discord voice playback
```

### End-to-End Latency Budget

| Step | Time |
|------|------|
| VAD + buffering | ~300ms silence detection |
| STT (Deepgram streaming) | ~200-300ms |
| LLM (Claude) | ~500-2000ms |
| TTS (OpenAI streaming) | ~350ms |
| **Total** | **~1.5-3.5s** |

---

## Dependencies

```json
{
  "@discordjs/voice": "^0.19.2",
  "@discordjs/opus": "^0.10.0",
  "prism-media": "^1.3.5",
  "sodium-native": "^4.0.0",
  "ffmpeg-static": "^5.2.0",
  "wav": "^1.0.2"
}
```

**Bun compatibility note:** `@discordjs/opus` and `sodium-native` are native Node addons. Bun supports most N-API modules but test these. Fallbacks: `opusscript` (pure JS Opus, slower) and `tweetnacl` (pure JS encryption).

---

## STT (Speech-to-Text)

### Recommended: Deepgram Nova-3 (Real-Time Streaming)

- **Why:** WebSocket streaming, ~200-300ms latency, built-in endpointing, $0.0043/min
- **Package:** `@deepgram/sdk`
- **Key:** Accepts 48kHz PCM directly (no resampling needed for STT)

```typescript
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const connection = deepgram.listen.live({
  model: "nova-3",
  language: "en",
  smart_format: true,
  interim_results: true,
  endpointing: 300,        // ms of silence to finalize
  encoding: "linear16",
  sample_rate: 48000,
  channels: 1,
});

connection.on(LiveTranscriptionEvents.Transcript, (data) => {
  const transcript = data.channel.alternatives[0]?.transcript;
  if (data.is_final && transcript) {
    // Send to LLM
  }
});

// Pipe PCM audio chunks:
connection.send(pcmBuffer);
```

### Budget: Groq Whisper API (Free Tier)

- Batch-only (not streaming), but Groq is fast (~1-2s)
- Free tier available
- Buffer utterances via VAD, save as WAV, send to API

### Local: whisper.cpp (Free, Offline)

- `whisper-medium` on Apple Silicon: ~0.5s per utterance
- Zero cost, full privacy
- Setup: `git clone https://github.com/ggerganov/whisper.cpp && make -j`
- Call via `Bun.spawn()`

### Comparison

| | Deepgram | Groq Whisper | whisper.cpp | OpenAI Whisper |
|---|---|---|---|---|
| Streaming | WebSocket | No | No | No |
| Latency | ~200ms | ~1-2s | ~0.5-2s | ~1-5s |
| Cost/min | $0.0043 | Free tier | Free | $0.006 |
| Accuracy | Excellent | Excellent | Excellent | Excellent |

---

## TTS (Text-to-Speech)

### Recommended: OpenAI TTS (Best Balance)

- **Why:** Native Opus output (zero transcoding for Discord), good latency, simple API
- **Package:** `openai`
- **Cost:** $15/1M chars (`tts-1`), $30/1M chars (`tts-1-hd`)
- **Voices:** alloy, echo, fable, onyx, nova, shimmer + 7 more

```typescript
import { createAudioResource, StreamType } from "@discordjs/voice";

const response = await openai.audio.speech.create({
  model: "tts-1",
  input: text,
  voice: "nova",
  response_format: "opus",  // OggOpus — Discord-native!
});

const resource = createAudioResource(response.body, {
  inputType: StreamType.OggOpus,
});
player.play(resource);
```

### Premium: ElevenLabs (Lowest Latency)

- **Why:** WebSocket API with text-input streaming — pipe LLM tokens directly to TTS
- **Cost:** Free 10K chars/mo, then $22-330/mo
- **Best for:** Ultra-low perceived latency in conversation (start speaking before full response)

```typescript
// ElevenLabs WebSocket — send partial text as LLM generates
const ws = new WebSocket(`wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input`);
ws.send(JSON.stringify({ text: " ", xi_api_key: key, voice_settings: {...} }));
ws.send(JSON.stringify({ text: "Hello, how are " })); // partial
ws.send(JSON.stringify({ text: "you today?" }));
ws.send(JSON.stringify({ text: "" })); // flush
ws.on('message', (audioChunk) => { /* pipe to Discord */ });
```

### Free: Edge TTS (Microsoft, Unofficial)

- **Why:** Zero cost, 300+ voices, good quality
- **Risk:** Unofficial API, could break
- **Package:** `edge-tts` (npm)
- **Output:** MP3 (needs transcoding to Opus via ffmpeg)

### Local: Kokoro (Apple Silicon)

- **Why:** Free, ~150ms latency, good quality
- **Setup:** Python wrapper, call via HTTP server or subprocess
- **Output:** Raw audio, needs Opus encoding

### Japanese Voices (Cute/Anime)

For Japanese language support (language learning, anime personas, etc):

**VOICEVOX** (Recommended for JP)
- Free, open source Japanese TTS engine
- Multiple cute character voices built in (Zundamon, Shikoku Metan, etc)
- Runs locally as HTTP API server
- Repo: [VOICEVOX/voicevox_engine](https://github.com/VOICEVOX/voicevox_engine)
- Setup: Download app or run engine, call `POST /audio_query` → `POST /synthesis`
- Output: WAV (needs Opus encoding for Discord)

**Style-Bert-VITS2** (Best for custom anime voices)
- Train on any anime character's voice (~10 min of audio)
- Controllable emotion + speaking style intensity
- Has Hololive pretrained models available
- Repo: [litagin02/Style-Bert-VITS2](https://github.com/litagin02/Style-Bert-VITS2)
- Setup: `pip install style-bert-vits2` (runs on CPU, no nvidia needed)

**anime-tts** (30+ voices ready to go)
- 30+ pretrained anime voice models
- Japanese language model
- Repo: [Damarcreative/anime-tts](https://github.com/Damarcreative/anime-tts)

**Tsukasa-Speech** (Studio quality)
- Trained on ~800 hrs of game/novel audio
- "Anime Japanese" style specifically
- Repo: [Respaired/Tsukasa-Speech](https://github.com/Respaired/Tsukasa-Speech)

**GPT-SoVITS** (Voice cloning from 5s)
- Clone any voice from ~5 seconds of audio
- Very popular in JP voice community
- Repo: [RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)

### Comparison

| | OpenAI TTS | ElevenLabs | Edge TTS | Kokoro | VOICEVOX | Style-Bert-VITS2 |
|---|---|---|---|---|---|---|
| Cost | $$  | $$$$ | Free | Free | Free | Free |
| Quality | 8/10 | 9.5/10 | 8/10 | 7.5/10 | 8/10 (JP) | 9/10 (JP) |
| Latency (TTFB) | ~350ms | ~300ms (WS) | ~500ms | ~150ms | ~300ms | ~500ms |
| Streaming | HTTP | WebSocket | Internal WS | No | No | No |
| Discord-native | Opus output | Needs work | Needs transcode | Needs wrapper | Needs wrapper | Needs wrapper |
| Voice cloning | No | Yes | No | No | No | Yes (train) |
| Japanese | OK | Good | Good | Limited | Excellent | Excellent |
| Cute voices | No | Some | Some | No | Yes (built in) | Yes (trainable) |

---

## VAD (Voice Activity Detection)

### Recommended: Silero VAD

- **Why:** Neural network VAD, extremely accurate, <5ms per frame
- **Package:** `@ricky0123/vad-node` + `onnxruntime-node`
- **Input:** 16kHz audio (downsample from Discord's 48kHz)

```typescript
import { Silero } from "@ricky0123/vad-node";

const vad = await Silero.new();
let speechBuffer: Buffer[] = [];
let silenceFrames = 0;
const SILENCE_THRESHOLD = 20; // ~300ms at 16kHz/512 frames

// For each audio frame (512 samples at 16kHz):
const speechProb = await vad.process(float32AudioFrame);

if (speechProb > 0.5) {
  speechBuffer.push(frame);
  silenceFrames = 0;
} else {
  silenceFrames++;
  if (silenceFrames > SILENCE_THRESHOLD && speechBuffer.length > 0) {
    // End of utterance — send to STT
    transcribe(concatBuffers(speechBuffer));
    speechBuffer = [];
  }
}
```

### Simple Alternative: EndBehaviorType.AfterSilence

Discord.js has built-in silence detection. Less accurate but zero extra deps:

```typescript
const audioStream = receiver.subscribe(userId, {
  end: { behavior: EndBehaviorType.AfterSilence, duration: 1200 },
});
```

---

## Discord Voice Integration

### Joining a Voice Channel

```typescript
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  EndBehaviorType,
  VoiceConnectionStatus,
} from "@discordjs/voice";

const connection = joinVoiceChannel({
  channelId: voiceChannel.id,
  guildId: guild.id,
  adapterCreator: guild.voiceAdapterCreator,
  selfDeaf: false,  // CRITICAL: must not be deaf to receive audio
});

const player = createAudioPlayer();
connection.subscribe(player);
```

### Receiving Per-User Audio

```typescript
const receiver = connection.receiver;

receiver.speaking.on("start", (userId) => {
  const audioStream = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
  });

  const opusDecoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 1,
    frameSize: 960,
  });

  const pcmStream = audioStream.pipe(opusDecoder);

  pcmStream.on("data", (pcmChunk: Buffer) => {
    // pcmChunk is signed 16-bit PCM at 48kHz
    // Feed to VAD → STT pipeline
  });
});
```

### Playing Audio Back

```typescript
// From OpenAI TTS (Opus output — best path)
const resource = createAudioResource(audioStream, {
  inputType: StreamType.OggOpus,
});
player.play(resource);

// From raw PCM or MP3 (needs transcoding)
const resource = createAudioResource(audioBuffer, {
  inputType: StreamType.Arbitrary, // ffmpeg handles conversion
});
player.play(resource);
```

---

## Implementation Considerations

### Echo Prevention
Track when the bot is speaking and ignore audio received during that window + 2s buffer:
```typescript
let botSpeakingUntil = 0;
player.on("stateChange", (oldState, newState) => {
  if (newState.status === "playing") botSpeakingUntil = Date.now() + 999999;
  if (newState.status === "idle") botSpeakingUntil = Date.now() + 2200;
});
// In audio handler:
if (Date.now() < botSpeakingUntil) return; // skip echo
```

### Cooldowns
- **Per-user:** 7s between responses to prevent spam
- **Global:** 4-5s between any responses
- **Minimum utterance length:** 48,000 PCM bytes (~0.25s) to filter noise

### Chunked TTS
Split long LLM responses at sentence boundaries (~60 words per chunk), queue playback:
```typescript
const chunks = splitAtSentences(llmResponse, 60);
for (const chunk of chunks) {
  const audio = await generateTTS(chunk);
  audioQueue.push(audio);
}
```

### Per-User Streams
Discord provides separate audio streams per user. This is great for:
- Individual VAD per person
- Knowing WHO is speaking (for context in LLM)
- Per-user rate limiting

---

## Reference Projects

| Project | Stack | Stars | Key Feature |
|---------|-------|-------|-------------|
| [Discord-VC-LLM](https://github.com/Eidenz/Discord-VC-LLM) | JS, discord.js | 33 | Most complete discord.js reference |
| [discord-voice-ai](https://github.com/agentzz1/discord-voice-ai) | JS, discord.js | 1 | Most modern (Mar 2026), echo guard |
| [Discord-Voice-Channel-Bot](https://github.com/Gemeri/Discord-Voice-Channel-Bot) | JS, discord.js | 5 | Clean simple reference, RMS VAD |
| [VoiceGPT](https://github.com/5xp/VoiceGPT) | JS, discord.js | 6 | Local whisper.cpp |
| [LLMChat](https://github.com/hc20k/LLMChat) | Python | 101 | Most mature, multi-provider |
| [openclaw-voice](https://github.com/MCKRUZ/openclaw-voice) | Python | - | Most sophisticated (Silero VAD + Pipecat) |

---

## Recommended Stack for Choomfie

### Tier 1: Quick Start (simplest, ~$5/mo)
- **STT:** Groq Whisper API (free) or OpenAI Whisper ($0.006/min)
- **TTS:** OpenAI TTS with Opus output ($15/1M chars)
- **VAD:** `EndBehaviorType.AfterSilence` (built-in, no extra deps)
- **Latency:** ~3-5s end-to-end

### Tier 2: Production (best latency, ~$10-20/mo)
- **STT:** Deepgram Nova-3 WebSocket streaming ($0.0043/min)
- **TTS:** OpenAI TTS with Opus output ($15/1M chars)
- **VAD:** Silero VAD (`@ricky0123/vad-node`)
- **Latency:** ~1.5-3s end-to-end

### Tier 3: Premium (lowest latency, ~$30-50/mo)
- **STT:** Deepgram Nova-3 WebSocket streaming
- **TTS:** ElevenLabs WebSocket with text-input streaming
- **VAD:** Silero VAD
- **LLM streaming → TTS streaming** pipeline
- **Latency:** ~1-2s end-to-end

### Tier 4: Free / Local
- **STT:** whisper.cpp (local, Apple Silicon)
- **TTS:** Kokoro (local) or Edge TTS (free, unofficial)
- **VAD:** Silero VAD
- **Latency:** ~2-4s end-to-end

---

## Security

| Concern | Mitigation |
|---------|------------|
| **Who can trigger** | Owner-only initially. Expand to allowlisted users after testing. |
| **Always listening** | Clearly communicate when bot is in VC and listening. Add a "listening" status indicator. |
| **Audio privacy** | Don't store recorded audio permanently. Process in memory, delete temp files immediately. |
| **Cost abuse** | Rate limits per user. Max session duration (e.g., 30 min auto-disconnect). Daily spending caps on STT/TTS APIs. |
| **Echo loops** | Echo prevention is mandatory — bot must ignore its own playback audio. |
| **Content filtering** | Same filters as text — apply before TTS generation. |
