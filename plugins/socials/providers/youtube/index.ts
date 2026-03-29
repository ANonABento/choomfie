/**
 * YouTube providers — yt-dlp (primary) + Official API (fallback).
 */

export { ytdlpProvider } from "./ytdlp.ts";
export {
  youtubeApiProvider,
  YouTubeCommentClient,
  initYouTubeCommentClient,
  getYouTubeCommentClient,
  destroyYouTubeCommentClient,
  setYouTubeApiKey,
} from "./api.ts";
