/**
 * ElevenLabs TTS provider.
 *
 * Streaming endpoint, returns PCM 48kHz audio.
 * Models: eleven_multilingual_v2 (29 langs), eleven_v3 (70+ langs, most expressive)
 */

import type { TTSProvider } from "../types.ts";

// Default voice — can be overridden via env vars per language
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"; // Rachel
const API_URL = "https://api.elevenlabs.io/v1/text-to-speech";

export const elevenlabsTTS: TTSProvider = {
  name: "elevenlabs",

  async detect() {
    const hasKey = !!process.env.ELEVENLABS_API_KEY;
    return {
      available: hasKey,
      reason: hasKey ? "ELEVENLABS_API_KEY set" : "ELEVENLABS_API_KEY not set",
      install: hasKey ? undefined : "Add ELEVENLABS_API_KEY to .env (paid, elevenlabs.io)",
      type: "api" as const,
    };
  },

  async synthesize(text: string, language: string = "en"): Promise<Buffer> {
    if (!text?.trim()) throw new Error("Cannot synthesize empty text");

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ELEVENLABS_API_KEY not set. Add it to your .env file (see docs/voice-plugin.md)"
      );
    }

    // Per-language voice selection via env vars
    const voiceId =
      language === "ja"
        ? process.env.ELEVENLABS_VOICE_JA || DEFAULT_VOICE
        : process.env.ELEVENLABS_VOICE_EN || DEFAULT_VOICE;

    const response = await fetch(
      `${API_URL}/${voiceId}/stream?output_format=pcm_48000`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": apiKey,
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          language_code: language,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `ElevenLabs TTS error (${response.status}): ${body}`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  },
};
