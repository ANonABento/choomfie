/**
 * Mouth openness from reply audio: RMS of PCM 48 kHz s16le stereo
 * (the VoiceEvent audio_chunk format) in ~33 ms windows.
 */

export const MOUTH_HZ = 30;
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
/** RMS of normal speech sits well below full scale; this gain maps it to ~0.5–1 */
const GAIN = 4;

export interface MouthFrame {
  type: "mouth";
  value: number;
}

/** One 0–1 level per 1/MOUTH_HZ s window; a trailing partial window counts */
export function mouthLevels(pcm: Buffer): number[] {
  const samplesPerWindow = (SAMPLE_RATE / MOUTH_HZ) * CHANNELS;
  const total = Math.floor(pcm.length / 2);
  const levels: number[] = [];
  for (let start = 0; start < total; start += samplesPerWindow) {
    const end = Math.min(start + samplesPerWindow, total);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const s = pcm.readInt16LE(i * 2) / 32768;
      sum += s * s;
    }
    const rms = Math.sqrt(sum / (end - start));
    levels.push(Math.min(1, rms * GAIN));
  }
  return levels;
}
