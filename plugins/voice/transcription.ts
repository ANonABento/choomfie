import type { PluginContext } from "@choomfie/shared";
import type { STTProvider } from "./providers/types.ts";
import { STT_WAV } from "./providers/audio.ts";

const MIN_PCM_BYTES = 4800; // Skip audio < 300ms at 16kHz mono

export async function transcribeOpusSegment(
  stt: STTProvider,
  opusChunks: Buffer[],
): Promise<string | null> {
  if (opusChunks.length < 10) return null;

  try {
    const pcmBuffer = await opusToPcm(opusChunks);
    if (pcmBuffer.length < MIN_PCM_BYTES) return null;

    const transcript = await stt.transcribe(pcmBuffer);
    if (!transcript || transcript.trim().length === 0) return null;

    const normalized = transcript.trim().toLowerCase();
    if (normalized === "[blank_audio]" || normalized === "(blank audio)") return null;

    return transcript.trim();
  } catch (e) {
    console.error(`Voice STT segment error: ${e}`);
    return null;
  }
}

export async function combineTranscriptSegments(
  segmentPromises: Promise<string | null>[],
): Promise<string | null> {
  const results = await Promise.allSettled(segmentPromises);
  const transcripts = results
    .flatMap((result) => result.status === "fulfilled" ? [result.value] : [])
    .filter((value): value is string => value !== null);

  for (const result of results) {
    if (result.status === "rejected") {
      console.error(`Voice STT segment error: ${result.reason}`);
    }
  }

  if (transcripts.length === 0) return null;
  return transcripts.join(" ");
}

export async function sendVoiceTranscriptNotification(
  ctx: PluginContext,
  guildId: string,
  userId: string,
  content: string,
  channelId?: string | null,
  interruptionContext?: string,
): Promise<void> {
  const user = await ctx.discord?.users.fetch(userId);
  if (!user || !ctx.mcp?.notification) return;

  const fullContent = interruptionContext
    ? `[${interruptionContext}]\n\n${content}`
    : content;

  ctx.mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: fullContent,
      meta: {
        chat_id: channelId || guildId,
        message_id: `voice_${Date.now()}`,
        user: user.username,
        user_id: userId,
        ts: new Date().toISOString(),
        is_dm: "false",
        role:
          ctx.ownerUserId && userId === ctx.ownerUserId
            ? "owner"
            : "user",
        source: "voice",
        guild_id: guildId,
        max_response_tokens: "150",
      },
    },
  });
}

async function opusToPcm(opusChunks: Buffer[]): Promise<Buffer> {
  const { OpusEncoder } = require("@discordjs/opus");
  const decoder = new OpusEncoder(48000, 2);

  const pcmChunks: Buffer[] = [];
  for (const chunk of opusChunks) {
    try {
      pcmChunks.push(decoder.decode(chunk));
    } catch {
      // Skip corrupted frames
    }
  }

  if (pcmChunks.length === 0) {
    throw new Error("No valid opus frames decoded");
  }

  const rawPcm = Buffer.concat(pcmChunks);
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "-i", "pipe:0",
      "-f", "wav",
      "-ar", String(STT_WAV.sampleRate),
      "-ac", String(STT_WAV.channels),
      "-c:a", STT_WAV.codec,
      "pipe:1",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );

  proc.stdin.write(rawPcm);
  proc.stdin.end();

  const [output, stderr] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  if (proc.exitCode !== 0) {
    throw new Error(`ffmpeg resample failed: ${stderr}`);
  }

  return Buffer.from(output);
}
