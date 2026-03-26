# Voice Plugin

Discord voice channel support with swappable STT/TTS providers.

> Last updated: 2026-03-26

---

## Overview

The voice plugin lets Choomfie join Discord voice channels, listen to users speak, transcribe their speech, and respond with text-to-speech. It uses a provider architecture so STT and TTS backends can be swapped with a single config change.

### Providers

| Provider | Type | Cost | Install | Notes |
|----------|------|------|---------|-------|
| **whisper** | STT | Free (local) | `brew install whisper-cpp` | Apple Silicon optimized, ~0.5s |
| **groq** | STT | Free (API) | `GROQ_API_KEY` in .env | 30 req/min, 14,400 req/day |
| **elevenlabs** | STT/TTS | Paid | `ELEVENLABS_API_KEY` in .env | Highest quality, voice cloning |
| **kokoro** | TTS | Free (local) | `pip install kokoro-onnx soundfile` | High quality neural TTS, ~150ms |
| **edge-tts** | TTS | Free | `pip install edge-tts` | Microsoft voices, 300+ voices, no key |

### Auto-Detection

Set `"stt": "auto"` or `"tts": "auto"` (the default) and the factory picks the best available provider:

- **STT priority:** whisper (local) → groq (free API) → elevenlabs (paid)
- **TTS priority:** kokoro (local) → edge-tts (free) → elevenlabs (paid)

Each provider has a `detect()` method that checks for installed binaries, Python modules, or API keys.

---

## Setup

### 1. Install dependencies

```bash
cd ~/choomfie
bun add @discordjs/voice @discordjs/opus prism-media sodium-native
```

ffmpeg is also required:
```bash
brew install ffmpeg
```

### 2. Install a provider

**Free local setup (no API keys!):**
```bash
brew install whisper-cpp    # STT
pip install edge-tts        # TTS (easiest)
# or: pip install kokoro-onnx soundfile   # TTS (best quality, ~300MB model)
```

**Free API setup:**
- Get a free Groq key at [console.groq.com](https://console.groq.com)
- Add `GROQ_API_KEY=<key>` to `~/.claude/plugins/data/choomfie-inline/.env`

**Paid (highest quality):**
- Get an ElevenLabs key at [elevenlabs.io](https://elevenlabs.io)
- Add `ELEVENLABS_API_KEY=<key>` to `~/.claude/plugins/data/choomfie-inline/.env`

### 3. Enable the plugin

**From Discord (easiest):**
```
/plugins action:enable name:voice
```
Then restart.

**Or edit config.json manually:**

Edit `~/.claude/plugins/data/choomfie-inline/config.json`:

```json
{
  "plugins": ["voice"]
}
```

Providers auto-detect by default. To pin specific ones:

```json
{
  "plugins": ["voice"],
  "voice": {
    "stt": "whisper",
    "tts": "edge-tts"
  }
}
```

### 4. Restart the bot

Restart Choomfie (`choomfie` or `claude --plugin-dir /path/to/choomfie`).

---

## Usage

### From Discord

Tell the bot to join your voice channel:
> "join the voice channel" (bot needs channel ID + guild ID)

Or use the tool directly:
> "join voice channel 123456789 in server 987654321"

Once in VC:
- **Speaking** is automatic — talk and the bot transcribes + forwards to Claude
- **Responding** — Claude uses the `speak` tool to talk back
- **Leave** — "leave the voice channel"

### Tools

| Tool | Description | Args |
|------|-------------|------|
| `join_voice` | Join a voice channel | `channel_id`, `guild_id` |
| `leave_voice` | Leave voice channel | `guild_id` |
| `speak` | Speak text via TTS | `guild_id`, `text`, `language` (en/ja) |

---

## Audio Pipeline

```
User speaks in VC
  → Discord sends Opus packets (48kHz, stereo)
  → @discordjs/voice subscribes to user's audio stream
  → Silence detection (1s of silence = end of utterance)
  → ffmpeg converts Opus → WAV (16kHz, mono, PCM s16le)
  → STT provider transcribes WAV → text
  → Text forwarded to Claude via MCP notification
  → Claude processes and calls `speak` tool
  → TTS provider synthesizes text → PCM audio (48kHz)
  → @discordjs/voice plays audio in VC
```

---

## Provider Architecture

### Structure

```
plugins/voice/
  index.ts                    — Plugin entry point
  tools.ts                    — MCP tools (join, leave, speak)
  manager.ts                  — Voice connections + audio pipeline
  providers/
    types.ts                  — STTProvider + TTSProvider + ProviderStatus interfaces
    index.ts                  — Provider factory (auto-detect + config)
    detect.ts                 — Shared detection utils (checkBinary, checkPythonModule)
    audio.ts                  — Shared audio utils (toDiscordPcm, format constants)
    groq/                     — Groq Whisper STT (free API)
    elevenlabs/               — ElevenLabs STT + TTS (paid API)
    whisper/                  — whisper.cpp STT (free local)
    edge-tts/                 — Microsoft Edge TTS (free online)
    kokoro/                   — Kokoro neural TTS (free local)
```

### Interfaces

```typescript
// providers/types.ts

interface ProviderStatus {
  available: boolean;
  reason: string;
  install?: string;
  type: "local" | "api" | "free";
}

interface STTProvider {
  name: string;
  transcribe(audio: Buffer, language?: string): Promise<string>;
  detect(): Promise<ProviderStatus>;
}

interface TTSProvider {
  name: string;
  synthesize(text: string, language?: string): Promise<Buffer>;
  detect(): Promise<ProviderStatus>;
}
```

**STTProvider.transcribe:**
- Input: WAV audio buffer (16kHz, mono, PCM s16le)
- Input: optional language code (ISO-639-1, e.g. `"en"`, `"ja"`)
- Output: transcribed text string

**TTSProvider.synthesize:**
- Input: text to speak
- Input: optional language code
- Output: PCM audio buffer (48kHz for Discord playback)

### Config

Provider selection in `config.json`:

```json
{
  "voice": {
    "stt": "auto",          // or "whisper", "groq", "elevenlabs"
    "tts": "auto"           // or "kokoro", "edge-tts", "elevenlabs"
  }
}
```

Default is `"auto"` — the factory runs `detect()` on each provider in priority order and picks the first available.

---

## Adding a New Provider

### Example: Adding a New TTS Provider

#### 1. Create the provider

```typescript
// providers/my-tts/tts.ts
import type { TTSProvider } from "../types.ts";
import { checkBinary } from "../detect.ts";
import { toDiscordPcm } from "../audio.ts";

export const myTTS: TTSProvider = {
  name: "my-tts",

  async detect() {
    const has = await checkBinary("my-tts-cli");
    return {
      available: has,
      reason: has ? "my-tts-cli installed" : "my-tts-cli not found",
      install: has ? undefined : "pip install my-tts",
      type: "local" as const,
    };
  },

  async synthesize(text: string, language: string = "en"): Promise<Buffer> {
    if (!text?.trim()) throw new Error("Cannot synthesize empty text");
    // Generate audio to a temp file, then convert:
    // return await toDiscordPcm(tempFilePath);
  },
};
```

```typescript
// providers/my-tts/index.ts
export { myTTS } from "./tts.ts";
```

#### 2. Register in the factory

Edit `providers/index.ts`:

```typescript
import { myTTS } from "./my-tts/index.ts";

const ttsProviders = { ..., "my-tts": myTTS };
// Add to ttsPriority if it should be auto-detected
```

#### 3. Use it

```json
{ "voice": { "tts": "my-tts" } }
```

Or just install the dependency and let `"auto"` pick it up.

---

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `GROQ_API_KEY` | If STT=groq | — | Groq API key for Whisper |
| `ELEVENLABS_API_KEY` | If using ElevenLabs | — | ElevenLabs API key |
| `ELEVENLABS_VOICE_EN` | No | `21m00Tcm4TlvDq8ikWAM` (Rachel) | English voice ID |
| `ELEVENLABS_VOICE_JA` | No | Same as EN | Japanese voice ID |
| `WHISPER_MODEL` | No | `ggml-base.en` | whisper.cpp model (use `ggml-small` for multilingual) |
| `EDGE_TTS_VOICE` | No | Per-language defaults | Override Edge TTS voice |
| `KOKORO_VOICE` | No | `af_heart` | Kokoro voice (af_heart, af_sky, am_adam, etc.) |

### Finding ElevenLabs Voice IDs

```bash
curl -s "https://api.elevenlabs.io/v2/voices" \
  -H "xi-api-key: YOUR_KEY" | jq '.voices[] | {name, voice_id}'
```

Or browse the [ElevenLabs Voice Library](https://elevenlabs.io/voice-library).

---

## ElevenLabs Capabilities (Beyond TTS)

ElevenLabs offers more than just text-to-speech. Future integration opportunities:

| Feature | API | Use Case |
|---------|-----|----------|
| **Voice Cloning** | `POST /v1/voices/add` | Clone persona voices (tonxu, olwl0, etc.) from 1-2 min audio |
| **Conversational AI** | WebSocket `/v1/convai/conversation` | Real-time voice agent (replace manual STT→LLM→TTS pipeline) |
| **Sound Effects** | `POST /v1/sound-generation/generate` | Generate sound effects from text descriptions |
| **Voice Isolation** | `POST /v1/audio/isolation` | Strip background noise from VC audio before STT |

---

## Troubleshooting

**Bot joins but can't hear anyone:**
- Make sure `selfDeaf: false` is set (it is by default)
- Check that the bot has the "Connect" and "Speak" permissions in the voice channel
- Verify `@discordjs/voice@0.19.2+` is installed (DAVE E2EE fix)

**ffmpeg errors:**
- Install ffmpeg: `brew install ffmpeg`
- Check it's in PATH: `which ffmpeg`

**Groq rate limit:**
- Free tier: 30 req/min. If you're hitting it, you're talking a LOT
- Consider switching to `"stt": "elevenlabs"` (uses credits but no rate limit)

**No audio playback:**
- Check that `@discordjs/opus` and `sodium-native` are installed
- Try `bun add @discordjs/opus sodium-native` if missing

**Short utterances ignored:**
- By design: chunks < 10 opus frames or PCM < 4800 bytes are skipped
- This prevents noise/breathing from triggering STT
