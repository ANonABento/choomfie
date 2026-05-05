/**
 * Reddit provider — OAuth 2.0 "script" app with raw fetch.
 *
 * Free: 100 req/min for non-commercial use.
 * Auth: password grant (simplest for bots).
 * Token auto-refresh on expiry (1 hour lifetime).
 * Token persisted to disk so restarts don't re-auth.
 *
 * Config: socials.reddit in config.json (clientId, clientSecret, username, password)
 * Token storage: DATA_DIR/socials/reddit-tokens.json
 */

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { VERSION, writeSecretFileSync, type PluginContext } from "@choomfie/shared";
import type { RedditProvider, RedditWriteProvider, RedditPost, RedditComment, RedditSubmitResult } from "../types.ts";
import { mapCommentChildren, mapPostChildren } from "./common.ts";

// --- Constants ---

const REDDIT_AUTH_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_API_BASE = "https://oauth.reddit.com";

/** Buffer before expiry to trigger refresh (5 min) */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// --- Types ---

interface RedditTokens {
  accessToken: string;
  expiresAt: number; // Unix ms
}

interface RedditConfig {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

// --- Client ---

export class RedditClient implements RedditWriteProvider {
  name = "reddit-api";

  private tokensPath: string;
  private tokens: RedditTokens | null = null;
  private config: RedditConfig;
  private userAgent: string;

  constructor(dataDir: string, config: RedditConfig) {
    const socialsDir = `${dataDir}/socials`;
    if (!existsSync(socialsDir)) {
      mkdirSync(socialsDir, { recursive: true });
    }
    this.tokensPath = `${socialsDir}/reddit-tokens.json`;
    this.config = config;
    this.userAgent = `bun:choomfie:v${VERSION} (by /u/${config.username})`;
    this.loadTokens();
  }

  // --- Token Management ---

  private loadTokens(): void {
    try {
      const raw = readFileSync(this.tokensPath, "utf-8");
      this.tokens = JSON.parse(raw) as RedditTokens;
    } catch {
      this.tokens = null;
    }
  }

  private saveTokens(): void {
    if (!this.tokens) return;
    writeSecretFileSync(this.tokensPath, JSON.stringify(this.tokens, null, 2));
  }

  private async authenticate(): Promise<void> {
    const basicAuth = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`
    ).toString("base64");

    const params = new URLSearchParams({
      grant_type: "password",
      username: this.config.username,
      password: this.config.password,
    });

    const resp = await fetch(REDDIT_AUTH_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": this.userAgent,
      },
      body: params.toString(),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Reddit auth failed (${resp.status}): ${body}`);
    }

    const data = (await resp.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };

    if (!data.access_token) {
      throw new Error(`Reddit auth returned no access token: ${JSON.stringify(data)}`);
    }

    this.tokens = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    this.saveTokens();
  }

  private async ensureToken(): Promise<string> {
    if (!this.tokens || Date.now() >= this.tokens.expiresAt - REFRESH_BUFFER_MS) {
      await this.authenticate();
    }
    return this.tokens!.accessToken;
  }

  /** Check if we have valid credentials and can authenticate */
  async getAuthStatus(): Promise<{
    authenticated: boolean;
    username: string;
    expiresAt?: number;
  }> {
    try {
      await this.ensureToken();
      return {
        authenticated: true,
        username: this.config.username,
        expiresAt: this.tokens?.expiresAt,
      };
    } catch {
      return {
        authenticated: false,
        username: this.config.username,
      };
    }
  }

  // --- API Helpers ---

  private async apiGet(path: string, params?: Record<string, string>): Promise<any> {
    const token = await this.ensureToken();
    const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
    const resp = await fetch(`${REDDIT_API_BASE}${path}${qs}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": this.userAgent,
      },
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Reddit API GET ${path} failed (${resp.status}): ${body}`);
    }

    return resp.json();
  }

  private async apiPost(
    path: string,
    params: Record<string, string>
  ): Promise<any> {
    const token = await this.ensureToken();
    const resp = await fetch(`${REDDIT_API_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": this.userAgent,
      },
      body: new URLSearchParams(params).toString(),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Reddit API POST ${path} failed (${resp.status}): ${body}`);
    }

    return resp.json();
  }

  // --- Read Methods (RedditProvider interface) ---

  async search(
    query: string,
    subreddit?: string,
    limit: number = 10
  ): Promise<RedditPost[]> {
    const path = subreddit ? `/r/${subreddit}/search` : "/search";
    const params: Record<string, string> = {
      q: query,
      limit: String(limit),
      type: "link",
    };
    if (subreddit) params.restrict_sr = "on";

    const data = await this.apiGet(path, params);
    return mapPostChildren(data);
  }

  async getPosts(
    subreddit: string,
    sort: "hot" | "top" | "new" = "hot",
    limit: number = 10
  ): Promise<RedditPost[]> {
    const params: Record<string, string> = { limit: String(limit) };
    if (sort === "top") params.t = "week";

    const data = await this.apiGet(`/r/${subreddit}/${sort}`, params);
    return mapPostChildren(data);
  }

  async getComments(
    postUrl: string,
    limit: number = 10
  ): Promise<RedditComment[]> {
    // Extract post ID from URL — handles both full URLs and permalinks
    const match = postUrl.match(/comments\/([a-z0-9]+)/i);
    if (!match) throw new Error("Invalid Reddit post URL — must contain /comments/{id}");

    const data = await this.apiGet(`/comments/${match[1]}`, {
      limit: String(limit),
      sort: "top",
    });

    // Reddit returns [post, comments] array
    const comments = data[1]?.data?.children || [];
    return mapCommentChildren(comments, limit);
  }

  // --- Write Methods ---

  async submitPost(
    subreddit: string,
    title: string,
    text: string
  ): Promise<RedditSubmitResult> {
    const data = await this.apiPost("/api/submit", {
      sr: subreddit,
      kind: "self",
      title,
      text,
      api_type: "json",
    });

    return parseSubmitResponse(data);
  }

  async submitLink(
    subreddit: string,
    title: string,
    url: string
  ): Promise<RedditSubmitResult> {
    const data = await this.apiPost("/api/submit", {
      sr: subreddit,
      kind: "link",
      title,
      url,
      api_type: "json",
    });

    return parseSubmitResponse(data);
  }

  async submitImage(
    subreddit: string,
    title: string,
    imagePath: string,
    _text?: string,
  ): Promise<RedditSubmitResult> {
    if (/^https?:\/\//i.test(imagePath)) {
      return this.submitLink(subreddit, title, imagePath);
    }
    throw new Error(
      "Reddit local image uploads are not supported reliably yet. Pass a public image URL instead.",
    );
  }

  async comment(
    parentFullname: string,
    text: string
  ): Promise<{ id: string; fullname: string }> {
    const data = await this.apiPost("/api/comment", {
      thing_id: parentFullname,
      text,
      api_type: "json",
    });

    const things = data?.json?.data?.things;
    if (!things || things.length === 0) {
      const errors = data?.json?.errors;
      if (errors && errors.length > 0) {
        throw new Error(`Reddit comment failed: ${JSON.stringify(errors)}`);
      }
      throw new Error("Reddit comment returned no data");
    }

    const comment = things[0].data;
    return {
      id: comment.id,
      fullname: comment.name, // t1_{id}
    };
  }

  async vote(
    fullname: string,
    direction: 1 | -1 | 0
  ): Promise<void> {
    await this.apiPost("/api/vote", {
      id: fullname,
      dir: String(direction),
    });
  }
}

function parseSubmitResponse(data: any): RedditSubmitResult {
  const errors = data?.json?.errors;
  if (errors && errors.length > 0) {
    throw new Error(`Reddit submit failed: ${errors.map((e: any) => e.join(": ")).join("; ")}`);
  }

  const result = data?.json?.data;
  if (!result) {
    throw new Error("Reddit submit returned no data");
  }

  return {
    id: result.id || "",
    fullname: result.name || "",
    url: result.url || "",
  };
}

// --- Stub provider (used when Reddit is not configured) ---

export const redditApiStub: RedditProvider = {
  name: "reddit-api",

  async search(): Promise<RedditPost[]> {
    throw new Error(
      "Reddit API not configured. Add socials.reddit config to config.json " +
      "(clientId, clientSecret, username, password). Create a script app at https://www.reddit.com/prefs/apps"
    );
  },
  async getPosts(): Promise<RedditPost[]> {
    throw new Error("Reddit API not configured.");
  },
  async getComments(): Promise<RedditComment[]> {
    throw new Error("Reddit API not configured.");
  },
};

/** Singleton client instance — lazily created */
let clientInstance: RedditClient | null = null;

/**
 * Get or create the Reddit API client.
 * Returns the stub if not configured (will fall through to scraper via proxy).
 */
export function getRedditApiClient(ctx?: PluginContext): RedditProvider {
  if (clientInstance) return clientInstance;
  if (!ctx) return redditApiStub;

  const config = ctx.config.getConfig();
  const redditConfig = (config as any).socials?.reddit;

  if (
    !redditConfig?.clientId ||
    !redditConfig?.clientSecret ||
    !redditConfig?.username ||
    !redditConfig?.password
  ) {
    return redditApiStub;
  }

  clientInstance = new RedditClient(ctx.DATA_DIR, {
    clientId: redditConfig.clientId,
    clientSecret: redditConfig.clientSecret,
    username: redditConfig.username,
    password: redditConfig.password,
  });

  return clientInstance;
}

/** Get the RedditClient instance (for write methods). Returns null if not configured. */
export function getRedditClient(): RedditClient | null {
  return clientInstance;
}

/** Reset client (for destroy/cleanup) */
export function destroyRedditClient(): void {
  clientInstance = null;
}

/**
 * Legacy export for provider registry — uses stub that throws,
 * which triggers fallback to scraper in the proxy.
 * Real client is lazily initialized via getRedditApiClient(ctx).
 */
export const redditApiProvider: RedditProvider = redditApiStub;
