/**
 * Shared audio utilities for voice providers.
 */

/** Discord expects PCM at these settings (stereo for StreamType.Raw) */
export const DISCORD_PCM = {
  sampleRate: 48000,
  channels: 2,
  codec: "pcm_s16le",
} as const;

/** STT providers expect WAV at these settings */
export const STT_WAV = {
  sampleRate: 16000,
  channels: 1,
  codec: "pcm_s16le",
} as const;

export function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
}

/**
 * Convert audio file to raw PCM for Discord playback (48kHz, stereo, s16le).
 * Caller is responsible for cleaning up inputPath (use try/finally).
 * @param speed - Playback speed multiplier (0.5-2.0, default 1.0)
 */
export async function toDiscordPcm(inputPath: string, speed: number = 1.0): Promise<Buffer> {
  const args = [
    "ffmpeg",
    "-i",
    inputPath,
  ];

  // Add atempo filter for speed adjustment (ffmpeg atempo range: 0.5-2.0)
  if (speed !== 1.0) {
    const clamped = Math.max(0.5, Math.min(2.0, speed));
    args.push("-af", `atempo=${clamped}`);
  }

  args.push(
    "-f",
    "s16le",
    "-ar",
    String(DISCORD_PCM.sampleRate),
    "-ac",
    String(DISCORD_PCM.channels),
    "-c:a",
    DISCORD_PCM.codec,
    "pipe:1",
  );

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });

  const [output, stderr] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  if (proc.exitCode !== 0) {
    throw new Error(`ffmpeg conversion failed: ${stderr}`);
  }

  return Buffer.from(output);
}
