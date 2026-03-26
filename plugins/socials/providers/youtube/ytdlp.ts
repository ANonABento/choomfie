/**
 * YouTube provider — yt-dlp CLI wrapper.
 *
 * Free, no API key, no rate limits.
 * Requires: brew install yt-dlp
 */

import type { YouTubeProvider, VideoResult, TranscriptSegment } from "../types.ts";
import { unlink } from "node:fs/promises";

async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn(["yt-dlp", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0 && !output.trim()) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`yt-dlp failed (exit ${exitCode}): ${stderr.slice(0, 200)}`);
  }
  return output.trim();
}

export const ytdlpProvider: YouTubeProvider = {
  name: "yt-dlp",

  async search(query: string, limit: number = 5): Promise<VideoResult[]> {
    const output = await run([
      `ytsearch${limit}:${query}`,
      "--dump-json",
      "--flat-playlist",
      "--no-download",
    ]);

    if (!output) return [];

    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          const data = JSON.parse(line);
          return {
            title: data.title || "Unknown",
            url: `https://www.youtube.com/watch?v=${data.id}`,
            channel: data.channel || data.uploader || "Unknown",
            duration: formatDuration(data.duration),
            views: data.view_count
              ? `${(data.view_count / 1000).toFixed(0)}K`
              : undefined,
            published: data.upload_date || undefined,
            thumbnail: data.thumbnail || undefined,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as VideoResult[];
  },

  async getTranscript(videoUrl: string): Promise<TranscriptSegment[]> {
    const cleanupPaths: string[] = [];

    try {
      // Extract video ID for temp file naming
      const idMatch = videoUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      const videoId = idMatch?.[1] || "unknown";
      const outPath = `/tmp/yt-transcript-${videoId}`;

      // Download subtitles
      await run([
        videoUrl,
        "--write-auto-subs",
        "--write-subs",
        "--sub-langs", "en.*,ja",
        "--skip-download",
        "--sub-format", "json3",
        "--output", outPath,
      ]);

      // Try to read the subtitle file (json3 format)
      const subGlob = new Bun.Glob(`${outPath}*.json3`);
      for await (const file of subGlob.scan("/")) {
        const fullPath = `/${file}`;
        cleanupPaths.push(fullPath);
        try {
          const content = await Bun.file(fullPath).json();
          const events = content.events || [];
          return events
            .filter((e: any) => e.segs)
            .map((e: any) => ({
              text: e.segs.map((s: any) => s.utf8).join(""),
              start: e.tStartMs ? e.tStartMs / 1000 : undefined,
              duration: e.dDurationMs ? e.dDurationMs / 1000 : undefined,
            }))
            .filter((s: TranscriptSegment) => s.text.trim());
        } catch {}
      }

      // Fallback: get video description
      const desc = await run([videoUrl, "--get-description"]).catch(() => "");
      if (desc) return [{ text: desc }];
      return [];
    } catch {
      return [];
    } finally {
      await Promise.all(
        cleanupPaths.map(async (path) => {
          try {
            await unlink(path);
          } catch {}
        })
      );
    }
  },

  async getInfo(videoUrl: string): Promise<VideoResult | null> {
    try {
      const output = await run([
        videoUrl,
        "--dump-json",
        "--no-download",
      ]);

      const data = JSON.parse(output);
      return {
        title: data.title,
        url: data.webpage_url || videoUrl,
        channel: data.channel || data.uploader || "Unknown",
        duration: formatDuration(data.duration),
        views: data.view_count
          ? `${(data.view_count / 1000).toFixed(0)}K`
          : undefined,
        published: data.upload_date || undefined,
        thumbnail: data.thumbnail || undefined,
      };
    } catch {
      return null;
    }
  },
};

function formatDuration(seconds?: number): string {
  if (seconds == null) return "?";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
