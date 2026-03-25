/**
 * Reddit provider — Official API via snoowrap (primary).
 *
 * Free: 100 req/min for non-commercial use.
 * Requires: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD in .env
 */

import type { RedditProvider, RedditPost, RedditComment } from "../types.ts";

// Lazy init — only create client when first used
let snoowrap: any = null;

async function getClient() {
  if (snoowrap) return snoowrap;

  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const username = process.env.REDDIT_USERNAME;
  const password = process.env.REDDIT_PASSWORD;

  if (!clientId || !clientSecret || !username || !password) {
    throw new Error(
      "Reddit API requires REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD in .env"
    );
  }

  const Snoowrap = (await import("snoowrap")).default;
  snoowrap = new Snoowrap({
    userAgent: "choomfie-bot/1.0",
    clientId,
    clientSecret,
    username,
    password,
  });

  return snoowrap;
}

export const redditApiProvider: RedditProvider = {
  name: "reddit-api",

  async search(
    query: string,
    subreddit?: string,
    limit: number = 10
  ): Promise<RedditPost[]> {
    const client = await getClient();
    const results = subreddit
      ? await client.getSubreddit(subreddit).search({ query, limit })
      : await client.search({ query, limit });

    return results.map(postToResult);
  },

  async getPosts(
    subreddit: string,
    sort: "hot" | "top" | "new" = "hot",
    limit: number = 10
  ): Promise<RedditPost[]> {
    const client = await getClient();
    const sub = client.getSubreddit(subreddit);
    let posts;

    switch (sort) {
      case "hot":
        posts = await sub.getHot({ limit });
        break;
      case "top":
        posts = await sub.getTop({ time: "week", limit });
        break;
      case "new":
        posts = await sub.getNew({ limit });
        break;
    }

    return posts.map(postToResult);
  },

  async getComments(
    postUrl: string,
    limit: number = 10
  ): Promise<RedditComment[]> {
    const client = await getClient();
    // Extract post ID from URL
    const match = postUrl.match(/comments\/([a-z0-9]+)/);
    if (!match) throw new Error("Invalid Reddit post URL");

    const submission = await client.getSubmission(match[1]).fetch();

    return submission.comments.slice(0, limit).map((c: any) => ({
      author: c.author?.name || "[deleted]",
      body: c.body || "",
      score: c.score || 0,
      created: new Date(c.created_utc * 1000).toISOString(),
    }));
  },
};

function postToResult(post: any): RedditPost {
  return {
    title: post.title,
    url: post.url,
    subreddit: post.subreddit?.display_name || post.subreddit_name_prefixed || "",
    author: post.author?.name || "[deleted]",
    score: post.score || 0,
    comments: post.num_comments || 0,
    selftext: post.selftext?.slice(0, 500) || undefined,
    created: new Date(post.created_utc * 1000).toISOString(),
    permalink: `https://reddit.com${post.permalink}`,
  };
}
