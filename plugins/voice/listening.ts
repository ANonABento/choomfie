import { EndBehaviorType } from "@discordjs/voice";
import type { PluginContext } from "@choomfie/shared";
import type { STTProvider } from "./providers/index.ts";
import {
  combineTranscriptSegments,
  sendVoiceTranscriptNotification,
  transcribeOpusSegment,
} from "./transcription.ts";
import type { GuildVoice, SpeakerPipeline } from "./types.ts";
import { downsampleForVAD, SileroVAD, SpeechDetector } from "./vad.ts";

export async function getOrCreatePipeline(
  gv: GuildVoice,
  userId: string,
  maxConcurrentSpeakers: number,
): Promise<SpeakerPipeline> {
  const existing = gv.speakerPipelines.get(userId);
  if (existing && existing.ready) {
    existing.lastActive = Date.now();
    return existing;
  }

  if (gv.speakerPipelines.size >= maxConcurrentSpeakers) {
    evictOldestPipeline(gv);
  }

  const vad = await SileroVAD.create();
  const pipeline: SpeakerPipeline = {
    vad,
    speechDetector: new SpeechDetector(),
    lastActive: Date.now(),
    ready: true,
  };
  gv.speakerPipelines.set(userId, pipeline);
  console.error(
    `Voice: created pipeline for speaker ${userId} (${gv.speakerPipelines.size}/${maxConcurrentSpeakers})`,
  );
  return pipeline;
}

export function cleanupIdlePipelines(gv: GuildVoice, pipelineIdleTimeout: number): void {
  const now = Date.now();
  for (const [id, pipeline] of gv.speakerPipelines) {
    if (gv.listeningTo.has(id)) continue;
    if (now - pipeline.lastActive > pipelineIdleTimeout) {
      gv.speakerPipelines.delete(id);
      console.error(`Voice: cleaned up idle pipeline for speaker ${id}`);
    }
  }
}

export function listenToUser(opts: {
  bargeInThresholdMs: number;
  ctx: PluginContext;
  guildId: string;
  gv: GuildVoice;
  isBotSpeaking: (guildId: string) => boolean;
  listenHardTimeout: number;
  maxConcurrentSpeakers: number;
  maxSegmentChunks: number;
  minOpusChunks: number;
  onInterrupt: (guildId: string) => string | null;
  /** Called immediately when a valid utterance ends — play filler audio to mask LLM latency */
  onSpeechEnd?: () => void;
  stt: STTProvider;
  userId: string;
}): void {
  const { gv, guildId, userId } = opts;
  if (userId === opts.ctx.discord.user?.id) return;

  gv.listeningTo.add(userId);

  const opusStream = gv.connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.Manual },
  });

  const { OpusEncoder } = require("@discordjs/opus");
  const decoder = new OpusEncoder(48000, 2);

  let pipeline: SpeakerPipeline | null = null;
  let pipelineReady = false;
  void getOrCreatePipeline(gv, userId, opts.maxConcurrentSpeakers).then((created) => {
    pipeline = created;
    pipeline.vad.resetState();
    pipeline.speechDetector.reset();
    pipelineReady = true;
  });

  const chunks: Buffer[] = [];
  let collecting = false;
  const segmentTranscripts: Promise<string | null>[] = [];
  let chunksSinceFlush = 0;
  let vadBuffer = new Float32Array(0);
  let processingChain = Promise.resolve();

  const flushSegment = () => {
    if (chunks.length < opts.minOpusChunks) return;
    const segmentChunks = [...chunks];
    chunks.length = 0;
    chunksSinceFlush = 0;
    segmentTranscripts.push(transcribeOpusSegment(opts.stt, segmentChunks));
  };

  const hardTimeout = setTimeout(() => {
    console.error(`Voice: hard timeout for user ${userId}, ending subscription`);
    cleanup();
  }, opts.listenHardTimeout);

  const cleanup = () => {
    clearTimeout(hardTimeout);
    opusStream.destroy();
    gv.listeningTo.delete(userId);
  };

  const finalizeUtterance = () => {
    if (chunks.length >= opts.minOpusChunks) {
      flushSegment();
    }
    chunks.length = 0;
    chunksSinceFlush = 0;

    if (segmentTranscripts.length === 0) return;

    opts.onSpeechEnd?.();

    const pending = [...segmentTranscripts];
    segmentTranscripts.length = 0;
    // Capture and clear interruption context before async work — must be synchronous
    const interruptionCtx = gv.interruptionContext;
    gv.interruptionContext = undefined;
    void combineAndNotify(opts.ctx, guildId, userId, pending, gv, interruptionCtx);
  };

  opusStream.on("data", (chunk: Buffer) => {
    if (!pipelineReady || !pipeline) return;

    pipeline.lastActive = Date.now();

    if (chunk.length <= 3) {
      const event = pipeline.speechDetector.processProbability(0);
      if (event === "speech_end") {
        if (gv.bargeInTimer) {
          clearTimeout(gv.bargeInTimer);
          gv.bargeInTimer = null;
        }
        if (collecting) {
          collecting = false;
          finalizeUtterance();
          cleanup();
        }
      }
      return;
    }

    let pcm: Buffer;
    try {
      pcm = decoder.decode(chunk);
    } catch {
      return;
    }

    if (collecting) {
      chunks.push(chunk);
      chunksSinceFlush++;

      if (chunksSinceFlush >= opts.maxSegmentChunks) {
        console.error(`Voice: flushing STT segment (${chunks.length} chunks) while user still speaking`);
        flushSegment();
      }
    }

    const mono16k = downsampleForVAD(pcm);
    const combined = new Float32Array(vadBuffer.length + mono16k.length);
    combined.set(vadBuffer, 0);
    combined.set(mono16k, vadBuffer.length);
    vadBuffer = combined;

    const speakerVAD = pipeline.vad;
    const speakerDetector = pipeline.speechDetector;

    processingChain = processingChain.then(async () => {
      while (vadBuffer.length >= SileroVAD.FRAME_SIZE) {
        const frame = vadBuffer.slice(0, SileroVAD.FRAME_SIZE);
        vadBuffer = vadBuffer.slice(SileroVAD.FRAME_SIZE);

        let probability: number;
        try {
          probability = await speakerVAD.process(frame);
        } catch (e) {
          console.error(`Voice VAD error [${userId}]: ${e}`);
          continue;
        }

        const event = speakerDetector.processProbability(probability);

        if (event === "speech_start") {
          collecting = true;
          chunks.length = 0;
          chunksSinceFlush = 0;
          segmentTranscripts.length = 0;

          if (opts.isBotSpeaking(guildId) && !gv.bargeInTimer) {
            gv.bargeInTimer = setTimeout(() => {
              gv.bargeInTimer = null;
              if (opts.isBotSpeaking(guildId) && speakerDetector.speaking) {
                console.error(`Voice: barge-in confirmed from user ${userId}`);
                opts.onInterrupt(guildId);
              }
            }, opts.bargeInThresholdMs);
          }
        }

        if (event === "speech_end") {
          if (gv.bargeInTimer) {
            clearTimeout(gv.bargeInTimer);
            gv.bargeInTimer = null;
          }

          if (collecting) {
            collecting = false;
            finalizeUtterance();
            speakerDetector.reset();
            speakerVAD.resetState();
          }
        }
      }
    }).catch((e) => {
      console.error(`Voice VAD chain error [${userId}]: ${e}`);
    });
  });

  opusStream.on("end", () => {
    clearTimeout(hardTimeout);
    gv.listeningTo.delete(userId);

    if (collecting && (chunks.length > 0 || segmentTranscripts.length > 0)) {
      finalizeUtterance();
    }
  });

  opusStream.on("error", (err: Error) => {
    console.error(`Voice opus stream error [${userId}]: ${err.message}`);
    cleanup();
  });
}

function evictOldestPipeline(gv: GuildVoice): void {
  let oldestId: string | null = null;
  let oldestTime = Infinity;

  for (const [id, pipeline] of gv.speakerPipelines) {
    if (gv.listeningTo.has(id)) continue;
    if (pipeline.lastActive < oldestTime) {
      oldestTime = pipeline.lastActive;
      oldestId = id;
    }
  }

  if (oldestId) {
    gv.speakerPipelines.delete(oldestId);
    console.error(`Voice: evicted pipeline for speaker ${oldestId} (LRU)`);
  }
}

async function combineAndNotify(
  ctx: PluginContext,
  guildId: string,
  userId: string,
  segmentPromises: Promise<string | null>[],
  gv: GuildVoice,
  interruptionContext?: string,
): Promise<void> {
  try {
    const segmentCount = segmentPromises.length;
    const combined = await combineTranscriptSegments(segmentPromises);
    if (!combined) return;
    console.error(`Voice STT [${userId}]: ${combined}${segmentCount > 1 ? ` (${segmentCount} segments)` : ""}`);
    const channelId = gv.connection.joinConfig.channelId;
    await sendVoiceTranscriptNotification(ctx, guildId, userId, combined, channelId, interruptionContext);
  } catch (e) {
    console.error(`Voice STT combine error: ${e}`);
  }
}
