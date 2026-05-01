/**
 * VoiceManager — handles voice connections, audio receive/playback.
 *
 * Uses provider interfaces for STT/TTS — backend is swappable via config.
 */

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} from "@discordjs/voice";
import { Readable } from "node:stream";
import type { PluginContext } from "@choomfie/shared";
import {
  getSTTProvider,
  getTTSProvider,
  type STTProvider,
  type TTSProvider,
} from "./providers/index.ts";
import { DISCORD_PCM } from "./providers/audio.ts";
import { cleanupIdlePipelines, listenToUser } from "./listening.ts";
import { speakText } from "./playback.ts";
import type { GuildVoice } from "./types.ts";
import { SileroVAD } from "./vad.ts";
import { getFillersForPersona } from "./fillers.ts";

// --- Timeouts ---
const CONNECTION_TIMEOUT = 10_000; // 10s to establish voice connection
const PLAYBACK_START_TIMEOUT = 5_000; // 5s for player to start playing
const PLAYBACK_FINISH_TIMEOUT = 120_000; // 2min for current playback to finish (long TTS responses)

// --- Audio thresholds ---
const MIN_OPUS_CHUNKS = 10; // Skip utterances shorter than ~200ms
const LISTEN_HARD_TIMEOUT = 30_000; // 30s safety net for leaked subscriptions

// --- Multi-speaker ---
const MAX_CONCURRENT_SPEAKERS = 4; // Max simultaneous VAD pipelines per guild
const PIPELINE_IDLE_TIMEOUT = 60_000; // Evict idle pipelines after 60s
const PIPELINE_CLEANUP_INTERVAL = 30_000; // Check for idle pipelines every 30s

// --- Streaming STT ---
// Max speech duration before flushing a segment to whisper.
// Discord sends ~50 opus packets/sec (20ms frames), so 3s ≈ 150 chunks.
const MAX_SEGMENT_CHUNKS = 150; // ~3s at 50 packets/sec

// --- Interruption ---
const BARGE_IN_THRESHOLD_MS = 300; // Sustained speech before treating as interruption

export class VoiceManager {
  private guilds = new Map<string, GuildVoice>();
  private stt!: STTProvider;
  private tts!: TTSProvider;
  private fillerCache = new Map<string, Buffer[]>();
  private fillerWarm = new Map<string, Promise<void>>();

  constructor(private ctx: PluginContext) {}

  async init() {
    this.stt = await getSTTProvider(this.ctx.config);
    this.tts = await getTTSProvider(this.ctx.config);

    // Verify Silero VAD model loads (fast sanity check), but don't keep it —
    // each speaker gets their own VAD instance (per-speaker pipelines)
    const testVAD = await SileroVAD.create();
    void testVAD; // discard — just verifying model path works

    console.error(
      `Voice providers: STT=${this.stt.name}, TTS=${this.tts.name}, VAD=silero (per-speaker)`
    );

    void this.warmFillers(this.getActivePersona());
  }

  private getActivePersona(): string {
    return (this.ctx.config.getConfig().activePersona as string | undefined) ?? "choomfie";
  }

  private async warmFillers(persona: string): Promise<void> {
    if (this.fillerCache.has(persona)) return;

    const existing = this.fillerWarm.get(persona);
    if (existing) return existing;

    const fillerSet = getFillersForPersona(persona);
    const phrases = fillerSet.thinking;
    const speed = this.ctx.config.getVoiceConfig().ttsSpeed ?? 1.0;

    console.error(`Voice: pre-synthesizing ${phrases.length} fillers for persona "${persona}"`);
    const warm = (async () => {
      try {
        const buffers = await Promise.all(
          phrases.map((phrase) => this.tts.synthesize(phrase, "en", speed)),
        );
        this.fillerCache.set(persona, buffers);
        console.error(`Voice: ${buffers.length} fillers cached for "${persona}"`);
      } catch (e) {
        console.error(`Voice: filler warm-up failed for "${persona}": ${e}`);
      } finally {
        this.fillerWarm.delete(persona);
      }
    })();
    this.fillerWarm.set(persona, warm);
    return warm;
  }

  /**
   * Play a random filler phrase in the guild's voice channel.
   * Called immediately when speech ends to mask LLM latency.
   * Bypasses the speak queue so it plays without waiting for pending speaks.
   */
  playFillerForGuild(guildId: string): void {
    const gv = this.guilds.get(guildId);
    if (!gv) return;

    // Don't interrupt ongoing playback (e.g., bot is mid-sentence)
    if (gv.player.state.status === AudioPlayerStatus.Playing) return;

    const persona = this.getActivePersona();
    const fillers = this.fillerCache.get(persona);
    if (!fillers || fillers.length === 0) return;

    const pcm = fillers[Math.floor(Math.random() * fillers.length)]!;
    try {
      const stream = Readable.from(pcm);
      const resource = createAudioResource(stream, { inputType: StreamType.Raw });
      gv.player.play(resource);
      console.error(`Voice: playing filler for persona "${persona}"`);
    } catch (e) {
      console.error(`Voice: filler playback error: ${e}`);
    }
  }

  private ensureInitialized() {
    if (!this.stt || !this.tts) {
      throw new Error("Voice manager not initialized — call init() first");
    }
  }

  async join(channelId: string, guildId: string) {
    this.leave(guildId);

    const guild = await this.ctx.discord.guilds.fetch(guildId);

    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    const player = createAudioPlayer();
    connection.subscribe(player);

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, CONNECTION_TIMEOUT);
    } catch (error) {
      connection.destroy();
      throw error;
    }

    const guildVoice: GuildVoice = {
      connection,
      player,
      listeningTo: new Set(),
      speakQueue: Promise.resolve(),
      generationId: 0,
      lastSpokenText: "",
      bargeInTimer: null,
      speakerPipelines: new Map(),
      pipelineCleanupTimer: null,
    };
    this.guilds.set(guildId, guildVoice);

    // Periodic cleanup of idle speaker pipelines
    guildVoice.pipelineCleanupTimer = setInterval(() => {
      cleanupIdlePipelines(guildVoice, PIPELINE_IDLE_TIMEOUT);
    }, PIPELINE_CLEANUP_INTERVAL);

    // Play a short silence frame to prime Discord's voice receive pipeline.
    // Without this, Discord won't send us audio packets (speaking events never fire).
    const silenceBuffer = Buffer.alloc(DISCORD_PCM.sampleRate * DISCORD_PCM.channels * 2 * 0.5, 0); // 0.5s silence
    const silenceStream = Readable.from(silenceBuffer);
    const silenceResource = createAudioResource(silenceStream, { inputType: StreamType.Raw });
    player.play(silenceResource);
    await entersState(player, AudioPlayerStatus.Playing, PLAYBACK_START_TIMEOUT);
    await entersState(player, AudioPlayerStatus.Idle, PLAYBACK_FINISH_TIMEOUT);

    connection.receiver.speaking.on("start", (userId: string) => {
      if (guildVoice.listeningTo.has(userId)) return;
      listenToUser({
        bargeInThresholdMs: BARGE_IN_THRESHOLD_MS,
        ctx: this.ctx,
        guildId,
        gv: guildVoice,
        isBotSpeaking: (currentGuildId) => this.isBotSpeaking(currentGuildId),
        listenHardTimeout: LISTEN_HARD_TIMEOUT,
        maxConcurrentSpeakers: MAX_CONCURRENT_SPEAKERS,
        maxSegmentChunks: MAX_SEGMENT_CHUNKS,
        minOpusChunks: MIN_OPUS_CHUNKS,
        onInterrupt: (currentGuildId) => this.interrupt(currentGuildId),
        onSpeechEnd: () => this.playFillerForGuild(guildId),
        stt: this.stt,
        userId,
      });
    });

    console.error(`Voice: joined channel ${channelId} in guild ${guildId}`);
  }

  leave(guildId: string): boolean {
    const gv = this.guilds.get(guildId);
    if (!gv) return false;

    if (gv.bargeInTimer) {
      clearTimeout(gv.bargeInTimer);
      gv.bargeInTimer = null;
    }
    if (gv.pipelineCleanupTimer) {
      clearInterval(gv.pipelineCleanupTimer);
      gv.pipelineCleanupTimer = null;
    }
    // Clean up all speaker pipelines
    gv.speakerPipelines.clear();
    gv.connection.destroy();
    gv.player.stop();
    this.guilds.delete(guildId);
    console.error(`Voice: left guild ${guildId}`);
    return true;
  }

  disconnectAll() {
    for (const [guildId] of this.guilds) {
      this.leave(guildId);
    }
  }

  /** Check if the bot is currently playing audio in a guild */
  isBotSpeaking(guildId: string): boolean {
    const gv = this.guilds.get(guildId);
    return gv?.player.state.status === AudioPlayerStatus.Playing;
  }

  /**
   * Interrupt current speech — stops playback and invalidates queued speak() calls.
   * Returns the text that was actually spoken before interruption (for context).
   */
  interrupt(guildId: string): string | null {
    const gv = this.guilds.get(guildId);
    if (!gv) return null;

    const wasPlaying = gv.player.state.status === AudioPlayerStatus.Playing;
    const spokenText = gv.lastSpokenText || null;

    // Increment generation to invalidate any queued/in-flight speak() calls
    gv.generationId++;

    // Stop current playback immediately
    if (wasPlaying) {
      gv.player.stop();
    }

    // Reset speak queue — stale tasks will check generationId and bail
    gv.speakQueue = Promise.resolve();

    // Store what was spoken so the next transcript notification can include it as context
    if (spokenText) {
      gv.interruptionContext = `User interrupted after hearing: "${spokenText}"`;
    }

    console.error(`Voice: interrupted (gen=${gv.generationId}), spoken so far: "${spokenText?.slice(0, 80) ?? ""}"`);
    return spokenText;
  }

  async speak(guildId: string, text: string, language: string = "en") {
    this.ensureInitialized();
    const gv = this.guilds.get(guildId);
    if (!gv) throw new Error("Not connected to voice in this server");

    // Capture generation ID — if it changes before we play, discard this speak
    const myGen = gv.generationId;

    // Queue speak calls to prevent racing on the audio player
    const task = gv.speakQueue.then(() => {
      if (gv.generationId !== myGen) {
        console.error("Voice: discarding stale speak() call (interrupted)");
        return;
      }
      return this.doSpeak(gv, text, language, myGen);
    });
    gv.speakQueue = task.catch(() => {}); // swallow errors in queue chain
    return task;
  }

  private async doSpeak(gv: GuildVoice, text: string, language: string, generationId: number) {
    if (gv.connection.state.status !== VoiceConnectionStatus.Ready) {
      throw new Error("Voice connection not ready");
    }

    const speed = this.ctx.config.getVoiceConfig().ttsSpeed ?? 1.0;
    await speakText(gv, text, language, speed, this.tts, generationId, {
      playbackFinishTimeout: PLAYBACK_FINISH_TIMEOUT,
      playbackStartTimeout: PLAYBACK_START_TIMEOUT,
    });
  }
}
