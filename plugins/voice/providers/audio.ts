/**
 * Shared audio utilities for voice providers.
 */

/** Discord expects PCM at these settings */
export const DISCORD_PCM = {
  sampleRate: 48000,
  channels: 1,
  codec: "pcm_s16le",
} as const;

/** STT providers expect WAV at these settings */
export const STT_WAV = {
  sampleRate: 16000,
  channels: 1,
  codec: "pcm_s16le",
} as const;

/**
 * Convert audio file to raw PCM for Discord playback (48kHz, mono, s16le).
 * Cleans up the input file after conversion.
 */
export async function toDiscordPcm(inputPath: string): Promise<Buffer> {
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-i",
      inputPath,
      "-f",
      "s16le",
      "-ar",
      String(DISCORD_PCM.sampleRate),
      "-ac",
      String(DISCORD_PCM.channels),
      "-acodec",
      DISCORD_PCM.codec,
      "pipe:1",
    ],
    { stdout: "pipe", stderr: "pipe" }
  );

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
