/**
 * ElevenLabs Scribe STT provider.
 *
 * Higher accuracy than Groq Whisper (3.5% vs 8.4% WER).
 * 90+ languages, speaker diarization, entity detection.
 * Paid: ~$0.40/hr audio (uses credits from plan).
 */

import type { STTProvider } from "../types.ts";

const API_URL = "https://api.elevenlabs.io/v1/speech-to-text";

export const elevenlabsSTT: STTProvider = {
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

  async transcribe(audio: Buffer, language?: string): Promise<string> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ELEVENLABS_API_KEY not set. Add it to your .env file (see docs/voice-plugin.md)"
      );
    }

    const audioBytes = new Uint8Array(audio);
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([audioBytes], { type: "audio/wav" }),
      "audio.wav"
    );
    formData.append("model_id", "scribe_v1");

    if (language) {
      formData.append("language_code", language);
    }

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
      },
      body: formData,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `ElevenLabs STT error (${response.status}): ${body}`
      );
    }

    const result = (await response.json()) as { text?: string };
    if (!result?.text) throw new Error("ElevenLabs STT returned no text");
    return result.text;
  },
};
