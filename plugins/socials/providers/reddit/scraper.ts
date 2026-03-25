/**
 * Reddit provider — JSON scraper fallback (no auth needed).
 *
 * Uses Reddit's public .json endpoints. No API key, no OAuth.
 * Less reliable than official API but works as fallback.
 */

import type { RedditProvider, RedditPost, RedditComment } from "../types.ts";

const REDDIT_BASE = "https://www.reddit.com";
const HEADERS = {
  "User-Agent": "choomfie-bot/1.0",
  Accept: "application/json",
};

export const redditScraperProvider: RedditProvider = {
  name: "reddit-scraper",

  async search(
    query: string,
    subreddit?: string,
    limit: number = 10
  ): Promise<RedditPost[]> {
    const path = subreddit
      ? `/r/${subreddit}/search.json?q=${encodeURIComponent(query)}&restrict_sr=on&limit=${limit}`
      : `/search.json?q=${encodeURIComponent(query)}&limit=${limit}`;

    const response = await fetch(`${REDDIT_BASE}${path}`, { headers: HEADERS });
    if (!response.ok) throw new Error(`Reddit error (${response.status})`);

    const data = (await response.json()) as any;
    return (data.data?.children || []).map((c: any) => postToResult(c.data));
  },

  async getPosts(
    subreddit: string,
    sort: "hot" | "top" | "new" = "hot",
    limit: number = 10
  ): Promise<RedditPost[]> {
    const timeParam = sort === "top" ? "&t=week" : "";
    const response = await fetch(
      `${REDDIT_BASE}/r/${subreddit}/${sort}.json?limit=${limit}${timeParam}`,
      { headers: HEADERS }
    );
    if (!response.ok) throw new Error(`Reddit error (${response.status})`);

    const data = (await response.json()) as any;
    return (data.data?.children || []).map((c: any) => postToResult(c.data));
  },

  async getComments(
    postUrl: string,
    limit: number = 10
  ): Promise<RedditComment[]> {
    // Normalize URL: strip query params, ensure .json suffix
    let cleanUrl = postUrl.split("?")[0].replace(/\/+$/, "");
    if (!cleanUrl.endsWith(".json")) cleanUrl += ".json";
    const fullUrl = cleanUrl.startsWith("http")
      ? cleanUrl
      : `${REDDIT_BASE}${cleanUrl}`;

    const response = await fetch(`${fullUrl}?limit=${limit}`, {
      headers: HEADERS,
    });
    if (!response.ok) throw new Error(`Reddit error (${response.status})`);

    const data = (await response.json()) as any;
    const comments = data[1]?.data?.children || [];

    return comments
      .filter((c: any) => c.kind === "t1")
      .slice(0, limit)
      .map((c: any) => ({
        author: c.data.author || "[deleted]",
        body: c.data.body || "",
        score: c.data.score || 0,
        created: new Date(c.data.created_utc * 1000).toISOString(),
      }));
  },
};

function postToResult(data: any): RedditPost {
  return {
    title: data.title,
    url: data.url,
    subreddit: data.subreddit || "",
    author: data.author || "[deleted]",
    score: data.score || 0,
    comments: data.num_comments || 0,
    selftext: data.selftext?.slice(0, 500) || undefined,
    created: new Date(data.created_utc * 1000).toISOString(),
    permalink: `https://reddit.com${data.permalink}`,
  };
}
