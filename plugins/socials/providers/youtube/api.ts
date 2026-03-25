/**
 * YouTube provider — Official YouTube Data API v3 (fallback).
 *
 * Free: 10,000 units/day (~100 searches).
 * Requires: YOUTUBE_API_KEY in .env
 */

import type { YouTubeProvider, VideoResult, TranscriptSegment } from "../types.ts";

const API_BASE = "https://www.googleapis.com/youtube/v3";

export const youtubeApiProvider: YouTubeProvider = {
  name: "youtube-api",

  async search(query: string, limit: number = 5): Promise<VideoResult[]> {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) throw new Error("YOUTUBE_API_KEY not set");

    const params = new URLSearchParams({
      part: "snippet",
      q: query,
      type: "video",
      maxResults: String(limit),
      key: apiKey,
    });

    const response = await fetch(`${API_BASE}/search?${params}`);
    if (!response.ok) {
      throw new Error(`YouTube API error (${response.status})`);
    }

    const data = (await response.json()) as any;
    return (data.items || []).map((item: any) => ({
      title: item.snippet.title,
      url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
      channel: item.snippet.channelTitle,
      duration: "?", // Search API doesn't return duration
      published: item.snippet.publishedAt,
      thumbnail: item.snippet.thumbnails?.medium?.url,
    }));
  },

  async getTranscript(_videoUrl: string): Promise<TranscriptSegment[]> {
    // Official API doesn't support transcript retrieval
    return [];
  },

  async getInfo(videoUrl: string): Promise<VideoResult | null> {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) throw new Error("YOUTUBE_API_KEY not set");

    const videoId = videoUrl.match(
      /(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/
    )?.[1];
    if (!videoId) return null;

    const params = new URLSearchParams({
      part: "snippet,contentDetails,statistics",
      id: videoId,
      key: apiKey,
    });

    const response = await fetch(`${API_BASE}/videos?${params}`);
    if (!response.ok) throw new Error(`YouTube API error (${response.status})`);

    const data = (await response.json()) as any;
    const item = data.items?.[0];
    if (!item) return null;

    return {
      title: item.snippet.title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      channel: item.snippet.channelTitle,
      duration: item.contentDetails?.duration || "?",
      views: item.statistics?.viewCount
        ? `${(Number(item.statistics.viewCount) / 1000).toFixed(0)}K`
        : undefined,
      published: item.snippet.publishedAt,
      thumbnail: item.snippet.thumbnails?.medium?.url,
    };
  },
};
