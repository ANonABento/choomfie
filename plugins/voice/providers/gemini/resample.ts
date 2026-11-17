/**
 * PCM conversion between Discord (48 kHz stereo s16le) and Gemini Live
 * (16 kHz mono in, 24 kHz mono out).
 */

/** 48 kHz stereo → 16 kHz mono: average channels, then each block of 3 frames. */
export function discordToGemini(pcm: Buffer): Buffer {
  const frames = Math.floor(pcm.length / 4);
  const out = Buffer.alloc(Math.floor(frames / 3) * 2);
  for (let i = 0; i < out.length / 2; i++) {
    let sum = 0;
    for (let f = i * 3; f < i * 3 + 3; f++) {
      sum += pcm.readInt16LE(f * 4) + pcm.readInt16LE(f * 4 + 2);
    }
    out.writeInt16LE(Math.round(sum / 6), i * 2);
  }
  return out;
}

/** 24 kHz mono → 48 kHz stereo: linear interpolation, sample copied to both channels. */
export function geminiToDiscord(pcm: Buffer): Buffer {
  const samples = Math.floor(pcm.length / 2);
  const out = Buffer.alloc(samples * 8);
  for (let i = 0; i < samples; i++) {
    const a = pcm.readInt16LE(i * 2);
    const b = i + 1 < samples ? pcm.readInt16LE(i * 2 + 2) : a;
    const mid = Math.round((a + b) / 2);
    out.writeInt16LE(a, i * 8);
    out.writeInt16LE(a, i * 8 + 2);
    out.writeInt16LE(mid, i * 8 + 4);
    out.writeInt16LE(mid, i * 8 + 6);
  }
  return out;
}
