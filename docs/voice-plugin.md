# Voice Plugin

Discord voice channel support with swappable STT/TTS providers.

> Last updated: 2026-03-25

---

## Overview

The voice plugin lets Choomfie join Discord voice channels, listen to users speak, transcribe their speech, and respond with text-to-speech. It uses a provider architecture so STT and TTS backends can be swapped with a single config change.

### Current Providers

| Provider | Type | Cost | Languages | Notes |
|----------|------|------|-----------|-------|
| **Groq Whisper** | STT | Free | 50+ (incl. JP) | 30 req/min, 14,400 req/day, 25MB/req |
| **ElevenLabs Scribe** | STT | Credits (~$0.40/hr) | 90+ (incl. JP) | Higher accuracy (3.5% vs 8.4% WER) |
| **ElevenLabs** | TTS | Credits | 70+ (incl. JP) | Streaming, multiple models, voice cloning |

### Planned Providers

| Provider | Type | Cost | Notes |
|----------|------|------|-------|
| whisper.cpp | STT | Free (local) | Apple Silicon optimized |
| VOICEVOX | TTS | Free (local) | Cute Japanese voices, ~2GB download |
| Edge TTS | TTS | Free | Microsoft voices, zero setup |
| Kokoro | TTS | Free (local) | 54 voices, fast |

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

### 2. Get API keys

**Groq (free STT):**
1. Go to [console.groq.com](https://console.groq.com)
2. Sign up / log in
3. Go to API Keys → Create API Key
4. Copy the key

**ElevenLabs (TTS):**
1. Go to [elevenlabs.io](https://elevenlabs.io)
2. Sign up / log in
3. Go to Profile + API Key
4. Copy the key

### 3. Add keys to .env

Edit `~/.claude/channels/choomfie/.env`:

```
DISCORD_TOKEN=<your-discord-token>
GROQ_API_KEY=<your-groq-key>
ELEVENLABS_API_KEY=<your-elevenlabs-key>
```

Optional voice overrides:
```
ELEVENLABS_VOICE_EN=<voice-id-for-english>
ELEVENLABS_VOICE_JA=<voice-id-for-japanese>
```

### 4. Enable the plugin

Edit `~/.claude/channels/choomfie/config.json`:

```json
{
  "plugins": ["voice"],
  "voice": {
    "stt": "groq",
    "tts": "elevenlabs"
  }
}
```

### 5. Restart the bot

Restart Claude Code with `--channels` flag.

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
    types.ts                  — STTProvider + TTSProvider interfaces
    index.ts                  — Provider factory (picks from config)
    groq/
      index.ts                — Exports STT provider
      stt.ts                  — Groq Whisper implementation
    elevenlabs/
      index.ts                — Exports STT + TTS providers
      stt.ts                  — ElevenLabs Scribe implementation
      tts.ts                  — ElevenLabs TTS implementation
```

### Interfaces

```typescript
// providers/types.ts

interface STTProvider {
  name: string;
  transcribe(audio: Buffer, language?: string): Promise<string>;
}

interface TTSProvider {
  name: string;
  synthesize(text: string, language?: string): Promise<Buffer>;
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
    "stt": "groq",          // or "elevenlabs"
    "tts": "elevenlabs"     // or future: "voicevox", "edge-tts", "kokoro"
  }
}
```

---

## Adding a New Provider

### Example: Adding Edge TTS

#### 1. Create the provider directory

```
plugins/voice/providers/edge-tts/
  index.ts
  tts.ts
```

#### 2. Implement the interface

```typescript
// providers/edge-tts/tts.ts
import type { TTSProvider } from "../types.ts";

export const edgeTTS: TTSProvider = {
  name: "edge-tts",

  async synthesize(text: string, language: string = "en"): Promise<Buffer> {
    // Implementation here
    // Must return PCM audio buffer (48kHz)
  },
};
```

```typescript
// providers/edge-tts/index.ts
export { edgeTTS } from "./tts.ts";
```

#### 3. Register in the factory

Edit `providers/index.ts`:

```typescript
import { edgeTTS } from "./edge-tts/index.ts";

const ttsProviders: Record<string, TTSProvider> = {
  elevenlabs: elevenlabsTTS,
  "edge-tts": edgeTTS,       // ← add this line
};
```

#### 4. Use it

```json
{
  "voice": {
    "stt": "groq",
    "tts": "edge-tts"
  }
}
```

That's it. The manager doesn't change — it calls `this.tts.synthesize()` regardless of which provider is behind it.

---

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `GROQ_API_KEY` | If STT=groq | — | Groq API key for Whisper |
| `ELEVENLABS_API_KEY` | If using ElevenLabs | — | ElevenLabs API key |
| `ELEVENLABS_VOICE_EN` | No | `21m00Tcm4TlvDq8ikWAM` (Rachel) | English voice ID |
| `ELEVENLABS_VOICE_JA` | No | Same as EN | Japanese voice ID |

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
