/**
 * Provider factory — picks STT/TTS backends from config.
 *
 * Config example (in config.json):
 *   "voice": { "stt": "groq", "tts": "elevenlabs" }
 *
 * To add a new provider:
 *   1. Create providers/<name>/index.ts
 *   2. Add to the registry maps below
 */

import type { STTProvider, TTSProvider } from "./types.ts";
import type { ConfigManager } from "../../../lib/config.ts";
import { groqSTT } from "./groq/index.ts";
import { elevenlabsTTS, elevenlabsSTT } from "./elevenlabs/index.ts";

// --- Provider registries ---

const sttProviders: Record<string, STTProvider> = {
  groq: groqSTT,
  elevenlabs: elevenlabsSTT,
};

const ttsProviders: Record<string, TTSProvider> = {
  elevenlabs: elevenlabsTTS,
};

// --- Factory ---

export function getSTTProvider(config: ConfigManager): STTProvider {
  const voiceConfig = config.getVoiceConfig();
  const name = voiceConfig.stt || "groq";
  const provider = sttProviders[name];
  if (!provider) {
    throw new Error(
      `Unknown STT provider: "${name}". Available: ${Object.keys(sttProviders).join(", ")}`
    );
  }
  return provider;
}

export function getTTSProvider(config: ConfigManager): TTSProvider {
  const voiceConfig = config.getVoiceConfig();
  const name = voiceConfig.tts || "elevenlabs";
  const provider = ttsProviders[name];
  if (!provider) {
    throw new Error(
      `Unknown TTS provider: "${name}". Available: ${Object.keys(ttsProviders).join(", ")}`
    );
  }
  return provider;
}

export type { STTProvider, TTSProvider };
