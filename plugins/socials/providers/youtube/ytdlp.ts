/**
 * YouTube provider — yt-dlp CLI wrapper.
 *
 * Free, no API key, no rate limits.
 * Requires: brew install yt-dlp
 */

import type { YouTubeProvider, VideoResult, TranscriptSegment } from "../types.ts";

async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn(["yt-dlp", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
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
            url: data.url
              ? `https://www.youtube.com/watch?v=${data.id || data.url}`
              : `https://www.youtube.com/watch?v=${data.id}`,
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
    try {
      // Get auto-generated or manual subtitles
      const output = await run([
        videoUrl,
        "--write-auto-subs",
        "--write-subs",
        "--sub-langs", "en,ja",
        "--skip-download",
        "--sub-format", "json3",
        "--output", "/tmp/yt-transcript-%(id)s",
        "--print", "after_move:filepath",
      ]);

      // Read the subtitle file
      const subFiles = await Bun.file("/tmp/").text().catch(() => "");

      // Fallback: use --get-description for basic content
      const desc = await run([videoUrl, "--get-description"]);
      if (desc) {
        return [{ text: desc }];
      }
      return [];
    } catch {
      return [];
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
  if (!seconds) return "?";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
