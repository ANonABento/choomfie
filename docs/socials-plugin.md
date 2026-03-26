# Socials Plugin

YouTube + Reddit integration with auto-fallback providers.

> Last updated: 2026-03-25

---

## Overview

The socials plugin gives Choomfie access to YouTube and Reddit. Each platform has a primary provider and an automatic fallback — if the primary fails, it seamlessly retries with the secondary.

```
YouTube: yt-dlp (primary) → YouTube Data API (fallback)
Reddit:  snoowrap API (primary) → JSON scraper (fallback)
```

---

## Setup

### YouTube (zero setup needed)

yt-dlp is the primary provider — free, no API key, no rate limits.

```bash
brew install yt-dlp
```

That's it. If you also want the YouTube Data API as fallback:
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project → Enable YouTube Data API v3
3. Create an API key
4. Add to `~/.claude/plugins/data/choomfie-inline/.env`:
   ```
   YOUTUBE_API_KEY=<your-key>
   ```

### Reddit

**Option A: Zero setup (scraper fallback only)**

Works immediately — the JSON scraper needs no auth. Just enable the plugin.

**Option B: Full API access (recommended)**

1. Go to [reddit.com/prefs/apps](https://reddit.com/prefs/apps)
2. Click "create another app"
3. Choose "script" type
4. Set redirect URI to `http://localhost`
5. Note the client ID (under app name) and secret
6. Add to `~/.claude/plugins/data/choomfie-inline/.env`:
   ```
   REDDIT_CLIENT_ID=<your-client-id>
   REDDIT_CLIENT_SECRET=<your-secret>
   REDDIT_USERNAME=<your-reddit-username>
   REDDIT_PASSWORD=<your-reddit-password>
   ```

### Enable the plugin

Edit `~/.claude/plugins/data/choomfie-inline/config.json`:
```json
{
  "plugins": ["socials"]
}
```

Restart the bot.

---

## Tools

### YouTube

| Tool | Description | Args |
|------|-------------|------|
| `youtube_search` | Search for videos | `query`, `limit` (default 5) |
| `youtube_info` | Get video details | `url` |
| `youtube_transcript` | Get video captions | `url` |

### Reddit

| Tool | Description | Args |
|------|-------------|------|
| `reddit_search` | Search posts | `query`, `subreddit` (optional), `limit` |
| `reddit_posts` | Browse a subreddit | `subreddit`, `sort` (hot/top/new), `limit` |
| `reddit_comments` | Read post comments | `url`, `limit` |

---

## Provider Architecture

Same pattern as the voice plugin — swappable providers with a shared interface.

```
plugins/socials/
  index.ts                        — Plugin entry
  tools.ts                        — 6 MCP tools
  providers/
    types.ts                      — YouTubeProvider + RedditProvider interfaces
    index.ts                      — Factory with auto-fallback proxy
    youtube/
      index.ts                    — Exports both providers
      ytdlp.ts                    — yt-dlp CLI wrapper (primary)
      api.ts                      — YouTube Data API v3 (fallback)
    reddit/
      index.ts                    — Exports both providers
      api.ts                      — snoowrap official API (primary)
      scraper.ts                  — JSON endpoint scraper (fallback)
```

### Interfaces

```typescript
interface YouTubeProvider {
  name: string;
  search(query: string, limit?: number): Promise<VideoResult[]>;
  getTranscript(videoUrl: string): Promise<TranscriptSegment[]>;
  getInfo(videoUrl: string): Promise<VideoResult | null>;
}

interface RedditProvider {
  name: string;
  search(query: string, subreddit?: string, limit?: number): Promise<RedditPost[]>;
  getPosts(subreddit: string, sort?: string, limit?: number): Promise<RedditPost[]>;
  getComments(postUrl: string, limit?: number): Promise<RedditComment[]>;
}
```

### Auto-Fallback

The provider factory creates a Proxy that intercepts every method call. If the primary provider throws, it automatically retries with the next provider in the fallback chain:

```
youtube_search("cats")
  → try yt-dlp.search("cats")
  → if fail → try youtubeApi.search("cats")
  → if fail → throw "All providers failed"
```

No configuration needed — fallback is automatic and transparent.

---

## Provider Comparison

### YouTube

```
                yt-dlp (primary)    YouTube API (fallback)
─────────────────────────────────────────────────────────
Cost            FREE                FREE (10k units/day)
Auth            none                API key
Search          yes                 yes (~100/day limit)
Transcripts     yes                 no
Download        yes                 no
Video info      yes                 yes (more detailed)
Rate limit      none                 quota-based
Reliability     high                high
```

### Reddit

```
                snoowrap (primary)  JSON scraper (fallback)
─────────────────────────────────────────────────────────
Cost            FREE                FREE
Auth            OAuth app           none
Search          yes                 yes
Browse subs     yes                 yes
Comments        yes                 yes
Post/comment    yes                 no
Rate limit      100 req/min         unknown
Reliability     high                medium
```

---

## Adding a New Platform

### Example: Adding Bluesky

1. Create `providers/bluesky/` directory
2. Implement the provider interface:

```typescript
// providers/bluesky/api.ts
import type { SocialProvider } from "../types.ts";

export const blueskyProvider: SocialProvider = {
  name: "bluesky",
  async search(query) { /* ... */ },
};
```

3. Register in `providers/index.ts`
4. Add tools in `tools.ts`

---

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `YOUTUBE_API_KEY` | No | — | YouTube Data API fallback |
| `REDDIT_CLIENT_ID` | No | — | Reddit official API |
| `REDDIT_CLIENT_SECRET` | No | — | Reddit official API |
| `REDDIT_USERNAME` | No | — | Reddit API auth |
| `REDDIT_PASSWORD` | No | — | Reddit API auth |

None are required — the plugin works with zero config using yt-dlp + Reddit JSON scraper.

---

## Troubleshooting

**yt-dlp not found:**
```bash
brew install yt-dlp
```

**YouTube search returns nothing:**
- Check `yt-dlp --version` works
- Try: `yt-dlp "ytsearch5:test" --dump-json --flat-playlist` manually

**Reddit scraper 429 (rate limited):**
- Register an OAuth app for the official API (more reliable, higher limits)
- Or wait a few minutes and retry

**Reddit API auth error:**
- Double-check client ID/secret in .env
- App type must be "script" (not "web" or "installed")
- Username/password must match the account that created the app
