/**
 * Make a brain's files fit Discord's attachment limit (10 MB for a bot)
 * before they're posted, with ffmpeg on this machine:
 *
 *   - a song (an audio file, or a video whose name says song/track/music:
 *     Gemini's tracks are an .mp4 with an animated cover) → audio only, .m4a;
 *   - a video → re-encoded at a bitrate sized to fit, scaled down if needed;
 *   - a picture → a JPEG, scaled down if needed.
 *
 * Files already under the limit are left alone. One that can't be shrunk
 * (no ffmpeg, too long to fit at a watchable bitrate) is dropped with a note,
 * since Discord refuses the whole message otherwise.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { extname, join } from "node:path";
import { DISCORD_MESSAGE_BYTES, type BrainFile } from "./brains.ts";

/** What one file may weigh after shrinking (a little under the message limit, for the container's overhead). */
export const FIT_TARGET_BYTES = 9 * 1024 * 1024;

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|opus|aiff?)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|tiff?|heic)$/i;
const SONG_NAME = /song|track|music|audio/i;

let ffmpegPath: string | null | undefined;
/** ffmpeg on PATH, or in the usual places a daemon's PATH may miss. */
export function findFfmpeg(): string | null {
  if (ffmpegPath !== undefined) return ffmpegPath;
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), "bin")].join(":");
  ffmpegPath = Bun.which("ffmpeg", { PATH: `${process.env.PATH ?? ""}:${extra}` }) ?? null;
  return ffmpegPath;
}

async function ffmpeg(args: string[]): Promise<{ ok: boolean; err: string }> {
  const bin = findFfmpeg();
  if (!bin) return { ok: false, err: "ffmpeg not found" };
  const proc = Bun.spawn([bin, "-hide_banner", "-nostdin", "-y", ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 5 * 60_000);
  const err = await new Response(proc.stderr).text();
  clearTimeout(timer);
  return { ok: (await proc.exited) === 0, err };
}

/** Seconds, from `ffmpeg -i`'s "Duration: 00:02:35.93" (there's no ffprobe everywhere). */
export function parseDuration(ffmpegInfo: string): number | null {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(ffmpegInfo);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** Bitrates (kbit/s) that fit `seconds` of video in `bytes`, or null if the picture would be unwatchable. */
export function videoBitrates(seconds: number, bytes = FIT_TARGET_BYTES): { video: number; audio: number; height: number } | null {
  const total = (bytes * 8) / 1000 / seconds;
  const audio = total < 500 ? 64 : 96;
  const video = Math.floor(total - audio - 8);
  if (video < 120) return null;
  return { video, audio, height: video >= 1500 ? 1080 : video >= 700 ? 720 : video >= 350 ? 480 : 360 };
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const base = (name: string) => name.replace(/\.[^.]+$/, "");

/** One file under the limit: itself, a smaller version, or nothing and why. */
export async function fitFile(file: BrainFile, limit = DISCORD_MESSAGE_BYTES): Promise<{ file?: BrainFile; note?: string }> {
  if (file.data.length <= limit) return { file };
  const target = Math.min(FIT_TARGET_BYTES, limit * 0.94);
  const kind = AUDIO_EXT.test(file.name) ? "audio" : VIDEO_EXT.test(file.name) ? "video" : IMAGE_EXT.test(file.name) ? "image" : null;
  const tooBig = (why: string) => ({ note: `${file.name} is too big for Discord (${mb(file.data.length)}) — ${why}.` });
  if (!kind) return tooBig("not a picture, video or audio file to shrink");
  if (!findFfmpeg()) return tooBig("ffmpeg isn't installed here to shrink it");

  const dir = mkdtempSync(join(tmpdir(), "choomfie-fit-"));
  try {
    const input = join(dir, `in${extname(file.name) || ".bin"}`);
    writeFileSync(input, file.data);
    const info = (await ffmpeg(["-i", input])).err;
    const seconds = parseDuration(info);
    const read = (out: string) => (existsSync(out) ? new Uint8Array(readFileSync(out)) : null);

    if (kind === "image") {
      const out = join(dir, "out.jpg");
      for (const [width, q] of [[4096, 3], [2560, 5], [1600, 7]] as const) {
        const r = await ffmpeg(["-i", input, "-vf", `scale='min(${width},iw)':-2`, "-q:v", String(q), out]);
        const data = r.ok ? read(out) : null;
        if (data && data.length <= limit) return { file: { name: `${base(file.name)}.jpg`, data } };
      }
      return tooBig("couldn't make it small enough");
    }

    if (!seconds) return tooBig("couldn't read its length");
    const song = kind === "audio" || SONG_NAME.test(file.name) || !/Video:/.test(info);
    if (song) {
      const out = join(dir, "out.m4a");
      for (const shrink of [1, 0.8]) {
        const kbps = Math.min(160, Math.floor(((target * 8) / 1000 / seconds) * shrink));
        if (kbps < 32) break;
        const r = await ffmpeg(["-i", input, "-vn", "-sn", "-c:a", "aac", "-b:a", `${kbps}k`, "-movflags", "+faststart", out]);
        const data = r.ok ? read(out) : null;
        if (data && data.length <= limit) return { file: { name: `${base(file.name)}.m4a`, data }, note: `${file.name} was ${mb(file.data.length)}: sent as audio only.` };
      }
      return tooBig("too long to fit even as audio");
    }

    const out = join(dir, "out.mp4");
    for (const shrink of [1, 0.8]) {
      const rates = videoBitrates(seconds, target * shrink);
      if (!rates) break;
      const r = await ffmpeg([
        "-i", input,
        "-vf", `scale=-2:'min(${rates.height},ih)'`,
        "-c:v", "libx264", "-preset", "veryfast",
        "-b:v", `${rates.video}k`, "-maxrate", `${rates.video}k`, "-bufsize", `${rates.video * 2}k`,
        "-c:a", "aac", "-b:a", `${rates.audio}k`, "-sn", "-movflags", "+faststart",
        out,
      ]);
      const data = r.ok ? read(out) : null;
      if (data && data.length <= limit) return { file: { name: `${base(file.name)}.mp4`, data }, note: `${file.name} was ${mb(file.data.length)}: shrunk to fit Discord.` };
    }
    return tooBig("too long to fit at a watchable quality");
  } catch (e) {
    return tooBig(`shrinking failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every file under the limit (shrunk, or dropped with a note). `dropped` holds the originals that couldn't fit. */
export async function fitForDiscord(
  files: BrainFile[],
  limit = DISCORD_MESSAGE_BYTES
): Promise<{ files: BrainFile[]; notes: string[]; dropped: { file: BrainFile; note: string }[] }> {
  const out: BrainFile[] = [];
  const notes: string[] = [];
  const dropped: { file: BrainFile; note: string }[] = [];
  for (const f of files) {
    const r = await fitFile(f, limit);
    if (r.file) out.push(r.file);
    else dropped.push({ file: f, note: r.note ?? `${f.name} is too big for Discord.` });
    if (r.note && r.file) notes.push(r.note);
  }
  return { files: out, notes, dropped };
}
