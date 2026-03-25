/**
 * Socials plugin — YouTube + Reddit integration.
 *
 * Provider pattern with auto-fallback:
 *   YouTube: yt-dlp (primary) → YouTube Data API (fallback)
 *   Reddit: Official API via snoowrap (primary) → JSON scraper (fallback)
 *
 * Future: Twitter/X, Bluesky
 */

import type { Plugin } from "../../lib/types.ts";
import { socialsTools } from "./tools.ts";

const socialsPlugin: Plugin = {
  name: "socials",

  tools: socialsTools,

  instructions: [
    "## Social Platforms",
    "You can search and browse YouTube and Reddit.",
    "",
    "**YouTube:**",
    "- `youtube_search` — search for videos",
    "- `youtube_info` — get video details",
    "- `youtube_transcript` — get video captions/transcript",
    "",
    "**Reddit:**",
    "- `reddit_search` — search posts (optionally in a specific subreddit)",
    "- `reddit_posts` — browse a subreddit (hot/top/new)",
    "- `reddit_comments` — read comments on a post",
    "",
    "When sharing YouTube links, post the full URL so Discord auto-embeds the video.",
  ],

  userTools: [
    "youtube_search",
    "youtube_info",
    "youtube_transcript",
    "reddit_search",
    "reddit_posts",
    "reddit_comments",
  ],
};

export default socialsPlugin;
