/**
 * Kokoro TTS provider — free, local, high-quality neural TTS.
 *
 * Install:
 *   pip install kokoro-onnx soundfile
 *
 * Models auto-download on first use (~300MB).
 * Runs on CPU (Apple Silicon optimized via CoreML), ~150ms latency.
 *
 * Voices: af_heart (default), af_sky, am_adam, bf_emma, etc.
 * See: https://github.com/thewh1teagle/kokoro-onnx
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import type { TTSProvider } from "../types.ts";
import { checkPythonModule, getPython } from "../detect.ts";
import { toDiscordPcm } from "../audio.ts";

const DEFAULT_VOICE = "af_heart";

// Inline Python script for Kokoro synthesis
const KOKORO_SCRIPT = `
import sys, soundfile as sf
from kokoro_onnx import Kokoro

voice = sys.argv[1]
output_path = sys.argv[2]
text = sys.argv[3]

kokoro = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
samples, sr = kokoro.create(text, voice=voice, speed=1.0)
sf.write(output_path, samples, sr)
`;

export const kokoroTTS: TTSProvider = {
  name: "kokoro",

  async detect() {
    const has = await checkPythonModule("kokoro_onnx");
    return {
      available: has,
      reason: has ? "kokoro-onnx installed" : "kokoro-onnx not found",
      install: has ? undefined : "pip install kokoro-onnx soundfile",
      type: "local" as const,
    };
  },

  async synthesize(text: string, _language: string = "en", speed: number = 1.0): Promise<Buffer> {
    console.error(`Kokoro TTS: speed=${speed}, text="${text.slice(0, 50)}..."`);
    if (!text?.trim()) throw new Error("Cannot synthesize empty text");

    const voice = process.env.KOKORO_VOICE || DEFAULT_VOICE;
    const tempWav = join(tmpdir(), `choomfie-kokoro-${Date.now()}.wav`);

    try {
      // Run Kokoro via Python (speed=1.0 always — kokoro-onnx has int32 bug with fractional speeds)
      const pyProc = Bun.spawn(
        [getPython(), "-c", KOKORO_SCRIPT, voice, tempWav, text],
        { stdout: "pipe", stderr: "pipe" }
      );

      const stderr = await new Response(pyProc.stderr).text();
      await pyProc.exited;

      if (pyProc.exitCode !== 0) {
        if (stderr.includes("No module named")) {
          throw new Error(
            "kokoro-onnx not found. Install: pip install kokoro-onnx soundfile"
          );
        }
        if (stderr.includes("FileNotFoundError")) {
          throw new Error(
            "Kokoro models not found. They auto-download on first run — try again or check disk space."
          );
        }
        throw new Error(
          `Kokoro TTS error (exit ${pyProc.exitCode}): ${stderr}`
        );
      }

      return await toDiscordPcm(tempWav, speed);
    } finally {
      try {
        unlinkSync(tempWav);
      } catch {
        // Already cleaned up
      }
    }
  },
};
