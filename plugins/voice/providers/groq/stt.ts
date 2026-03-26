/**
 * Groq Whisper STT provider.
 *
 * Free tier: 30 req/min, 14,400 req/day, 25MB per request.
 * Models: whisper-large-v3-turbo (fast), whisper-large-v3 (accurate)
 */

import type { STTProvider } from "../types.ts";

const API_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

export const groqSTT: STTProvider = {
  name: "groq",

  async detect() {
    const hasKey = !!process.env.GROQ_API_KEY;
    return {
      available: hasKey,
      reason: hasKey ? "GROQ_API_KEY set" : "GROQ_API_KEY not set",
      install: hasKey ? undefined : "Add GROQ_API_KEY to .env (free at console.groq.com)",
      type: "api" as const,
    };
  },

  async transcribe(audio: Buffer, language?: string): Promise<string> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GROQ_API_KEY not set. Add it to your .env file (see docs/voice-plugin.md)"
      );
    }

    const formData = new FormData();
    formData.append(
      "file",
      new Blob([audio], { type: "audio/wav" }),
      "audio.wav"
    );
    formData.append("model", "whisper-large-v3-turbo");
    formData.append("response_format", "json");

    if (language) {
      formData.append("language", language);
    }

    const response = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Groq STT error (${response.status}): ${body}`);
    }

    const result = (await response.json()) as { text?: string };
    if (!result?.text) throw new Error("Groq STT returned no text");
    return result.text;
  },
};
