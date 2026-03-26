/**
 * Edge TTS provider — free Microsoft TTS via edge-tts CLI.
 *
 * Install: pip install edge-tts
 *
 * Uses Microsoft Edge's online TTS API (free, no key needed).
 * Good quality, 300+ voices, many languages.
 *
 * Default voices:
 *   en: en-US-AriaNeural (female, expressive)
 *   ja: ja-JP-NanamiNeural (female, natural)
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import type { TTSProvider } from "../types.ts";
import { checkBinary } from "../detect.ts";

const DEFAULT_VOICES: Record<string, string> = {
  en: "en-US-AriaNeural",
  ja: "ja-JP-NanamiNeural",
  ko: "ko-KR-SunHiNeural",
  zh: "zh-CN-XiaoxiaoNeural",
  es: "es-ES-ElviraNeural",
  fr: "fr-FR-DeniseNeural",
  de: "de-DE-KatjaNeural",
};

export const edgeTTS: TTSProvider = {
  name: "edge-tts",

  async detect() {
    const has = await checkBinary("edge-tts");
    return {
      available: has,
      reason: has ? "edge-tts installed" : "edge-tts not found",
      install: has ? undefined : "pip install edge-tts",
      type: "free" as const,
    };
  },

  async synthesize(text: string, language: string = "en"): Promise<Buffer> {
    const voice =
      process.env.EDGE_TTS_VOICE ||
      DEFAULT_VOICES[language] ||
      DEFAULT_VOICES.en;

    const tempMp3 = join(tmpdir(), `choomfie-tts-${Date.now()}.mp3`);

    try {
      // Generate MP3 via edge-tts CLI
      const ttsProc = Bun.spawn(
        ["edge-tts", "--voice", voice, "--text", text, "--write-media", tempMp3],
        { stdout: "pipe", stderr: "pipe" }
      );

      const stderr = await new Response(ttsProc.stderr).text();
      await ttsProc.exited;

      if (ttsProc.exitCode !== 0) {
        if (stderr.includes("not found") || stderr.includes("No module")) {
          throw new Error(
            "edge-tts not found. Install: pip install edge-tts"
          );
        }
        throw new Error(
          `edge-tts error (exit ${ttsProc.exitCode}): ${stderr}`
        );
      }

      // Convert MP3 → raw PCM 48kHz mono 16-bit (what Discord expects)
      const ffProc = Bun.spawn(
        [
          "ffmpeg",
          "-i",
          tempMp3,
          "-f",
          "s16le",
          "-ar",
          "48000",
          "-ac",
          "1",
          "-acodec",
          "pcm_s16le",
          "pipe:1",
        ],
        { stdout: "pipe", stderr: "pipe" }
      );

      const output = await new Response(ffProc.stdout).arrayBuffer();
      await ffProc.exited;

      if (ffProc.exitCode !== 0) {
        throw new Error("ffmpeg conversion failed for edge-tts output");
      }

      return Buffer.from(output);
    } finally {
      try {
        unlinkSync(tempMp3);
      } catch {
        // Already cleaned up
      }
    }
  },
};
