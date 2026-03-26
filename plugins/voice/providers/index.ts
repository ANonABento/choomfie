/**
 * Provider factory — picks STT/TTS backends from config.
 *
 * Config example (in config.json):
 *   "voice": { "stt": "groq", "tts": "elevenlabs" }
 *
 * Use "auto" to let the factory pick the best available provider:
 *   "voice": { "stt": "auto", "tts": "auto" }
 *
 * Auto-detection priority:
 *   STT: whisper (local) → groq (free API) → elevenlabs (paid)
 *   TTS: kokoro (local) → edge-tts (free) → elevenlabs (paid)
 */

import type { STTProvider, TTSProvider, ProviderStatus } from "./types.ts";
import type { ConfigManager } from "../../../lib/config.ts";
import { groqSTT } from "./groq/index.ts";
import { elevenlabsTTS, elevenlabsSTT } from "./elevenlabs/index.ts";
import { whisperSTT } from "./whisper/index.ts";
import { edgeTTS } from "./edge-tts/index.ts";
import { kokoroTTS } from "./kokoro/index.ts";

// --- Provider registries ---

const sttProviders: Record<string, STTProvider> = {
  groq: groqSTT,
  elevenlabs: elevenlabsSTT,
  whisper: whisperSTT,
};

const ttsProviders: Record<string, TTSProvider> = {
  elevenlabs: elevenlabsTTS,
  "edge-tts": edgeTTS,
  kokoro: kokoroTTS,
};

// Priority order for auto-detection (local free → API free → paid)
const sttPriority: string[] = ["whisper", "groq", "elevenlabs"];
const ttsPriority: string[] = ["kokoro", "edge-tts", "elevenlabs"];

// --- Auto-detection ---

async function autoSelectProvider<T extends STTProvider | TTSProvider>(
  providers: Record<string, T>,
  priority: string[],
  type: string
): Promise<T> {
  // Detect all in priority order, cache results for error message
  const results: { name: string; provider: T; status: ProviderStatus }[] = [];

  for (const name of priority) {
    const provider = providers[name];
    if (!provider) continue;
    const status = await provider.detect();
    results.push({ name, provider, status });
    if (status.available) {
      console.error(`Voice auto-detect: ${type} → ${name} (${status.reason})`);
      return provider;
    }
  }

  // Nothing available — use cached results for helpful error
  const lines = results.map((r) => `  ${r.name}: ${r.status.install || r.status.reason}`);
  throw new Error(
    `No ${type} provider available. Install one of:\n${lines.join("\n")}`
  );
}

// --- Factory ---

export async function getSTTProvider(config: ConfigManager): Promise<STTProvider> {
  const voiceConfig = config.getVoiceConfig();
  const name = voiceConfig.stt ?? "auto";

  if (name === "auto") {
    return autoSelectProvider(sttProviders, sttPriority, "STT");
  }

  const provider = sttProviders[name];
  if (!provider) {
    throw new Error(
      `Unknown STT provider: "${name}". Available: ${Object.keys(sttProviders).join(", ")}, auto`
    );
  }
  return provider;
}

export async function getTTSProvider(config: ConfigManager): Promise<TTSProvider> {
  const voiceConfig = config.getVoiceConfig();
  const name = voiceConfig.tts ?? "auto";

  if (name === "auto") {
    return autoSelectProvider(ttsProviders, ttsPriority, "TTS");
  }

  const provider = ttsProviders[name];
  if (!provider) {
    throw new Error(
      `Unknown TTS provider: "${name}". Available: ${Object.keys(ttsProviders).join(", ")}, auto`
    );
  }
  return provider;
}

// --- Detection report (for wizard/status) ---

export interface ProviderReport {
  name: string;
  kind: "stt" | "tts";
  status: ProviderStatus;
}

const DETECT_ALL_TIMEOUT = 15_000; // 15s overall cap for scanning all providers

export async function detectAllProviders(): Promise<ProviderReport[]> {
  const checks: Promise<ProviderReport>[] = [];

  for (const [name, provider] of Object.entries(sttProviders)) {
    checks.push(
      provider.detect().then((status) => ({ name, kind: "stt" as const, status }))
    );
  }
  for (const [name, provider] of Object.entries(ttsProviders)) {
    checks.push(
      provider.detect().then((status) => ({ name, kind: "tts" as const, status }))
    );
  }

  return Promise.race([
    Promise.all(checks),
    new Promise<ProviderReport[]>((_, reject) =>
      setTimeout(() => reject(new Error("Provider detection timed out")), DETECT_ALL_TIMEOUT)
    ),
  ]);
}

export type { STTProvider, TTSProvider, ProviderStatus };
