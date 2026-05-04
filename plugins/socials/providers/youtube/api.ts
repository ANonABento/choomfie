/**
 * YouTube provider — Official YouTube Data API v3 (fallback for reads, required for writes).
 *
 * Free: 10,000 units/day (~100 searches, ~200 comments).
 * Reads: Requires YOUTUBE_API_KEY in env or socials.youtube.apiKey in config.
 * Writes (comments): Requires OAuth 2.0 (socials.youtube.clientId + clientSecret).
 */

import type { PluginContext } from "@choomfie/shared";
import type { YouTubeProvider, VideoResult, TranscriptSegment } from "../types.ts";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";

// --- Constants ---

const API_BASE = "https://www.googleapis.com/youtube/v3";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"];

/** Buffer before expiry to trigger refresh (5 min) */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// --- Types ---

interface YouTubeTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // Unix ms
}

interface PendingAuth {
  codeVerifier: string;
  state: string;
  resolve: (code: string) => void;
  reject: (err: Error) => void;
  server?: ReturnType<typeof Bun.serve>;
  timeout?: Timer;
}

// --- Read-only provider (API key based) ---

export const youtubeApiProvider: YouTubeProvider = {
  name: "youtube-api",

  async search(query: string, limit: number = 5): Promise<VideoResult[]> {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error("YOUTUBE_API_KEY not set and socials.youtube.apiKey not configured");

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
    const apiKey = getApiKey();
    if (!apiKey) throw new Error("YOUTUBE_API_KEY not set and socials.youtube.apiKey not configured");

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

// --- YouTube Comment Client (OAuth 2.0 based) ---

export class YouTubeCommentClient {
  private tokensPath: string;
  private tokens: YouTubeTokens | null = null;
  private pendingAuth: PendingAuth | null = null;
  private clientId: string;
  private clientSecret: string;

  constructor(dataDir: string, clientId: string, clientSecret: string) {
    const socialsDir = `${dataDir}/socials`;
    if (!existsSync(socialsDir)) {
      mkdirSync(socialsDir, { recursive: true });
    }
    this.tokensPath = `${socialsDir}/youtube-tokens.json`;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.loadTokens();
  }

  // --- Token Management ---

  private loadTokens(): void {
    try {
      const raw = readFileSync(this.tokensPath, "utf-8");
      this.tokens = JSON.parse(raw) as YouTubeTokens;
    } catch {
      this.tokens = null;
    }
  }

  private saveTokens(): void {
    if (!this.tokens) return;
    writeFileSync(this.tokensPath, JSON.stringify(this.tokens, null, 2));
  }

  isAuthenticated(): boolean {
    return this.tokens !== null && this.tokens.accessToken !== "";
  }

  getStatus(): {
    authenticated: boolean;
    expiresAt?: number;
  } {
    if (!this.tokens) return { authenticated: false };
    return {
      authenticated: true,
      expiresAt: this.tokens.expiresAt,
    };
  }

  private async ensureToken(): Promise<string> {
    if (!this.tokens) {
      throw new Error("Not authenticated. Run youtube_auth first.");
    }

    const now = Date.now();

    // Token still valid
    if (now < this.tokens.expiresAt - REFRESH_BUFFER_MS) {
      return this.tokens.accessToken;
    }

    // Try refresh
    if (this.tokens.refreshToken) {
      await this.refreshAccessToken();
      return this.tokens.accessToken;
    }

    throw new Error(
      "YouTube access token expired and no refresh token. Run youtube_auth again."
    );
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.tokens?.refreshToken) {
      throw new Error("No refresh token available.");
    }

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.tokens.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const resp = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Token refresh failed (${resp.status}): ${body}`);
    }

    const data = (await resp.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    const now = Date.now();
    this.tokens.accessToken = data.access_token;
    this.tokens.expiresAt = now + data.expires_in * 1000;
    if (data.refresh_token) {
      this.tokens.refreshToken = data.refresh_token;
    }
    this.saveTokens();
  }

  // --- OAuth Flow ---

  async startAuth(): Promise<{ authUrl: string; port: number }> {
    this.cleanupPendingAuth();

    // Generate PKCE challenge
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const state = randomBytes(16).toString("hex");

    let resolveAuth: (code: string) => void;
    let rejectAuth: (err: Error) => void;
    const authPromise = new Promise<string>((resolve, reject) => {
      resolveAuth = resolve;
      rejectAuth = reject;
    });

    this.pendingAuth = {
      codeVerifier,
      state,
      resolve: resolveAuth!,
      reject: rejectAuth!,
    };

    // Start temporary HTTP server for callback
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/callback") {
          return this.handleCallback(url);
        }
        return new Response("YouTube OAuth callback server", { status: 200 });
      },
    });

    this.pendingAuth.server = server;
    const port = server.port;

    // 5 minute timeout
    this.pendingAuth.timeout = setTimeout(() => {
      this.cleanupPendingAuth();
    }, 5 * 60 * 1000);

    const redirectUri = `http://localhost:${port}/callback`;

    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: redirectUri,
      state,
      scope: SCOPES.join(" "),
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });

    const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;

    // Wait for callback in background
    authPromise
      .then(async (code) => {
        await this.exchangeCode(code, redirectUri);
      })
      .catch((e) => {
        console.error(`YouTube auth failed: ${e.message}`);
      })
      .finally(() => {
        this.cleanupPendingAuth();
      });

    return { authUrl, port };
  }

  private handleCallback(url: URL): Response {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      this.pendingAuth?.reject(new Error(`Google denied: ${error}`));
      return new Response(
        htmlPage("Authorization Failed", `Google denied the request: ${error}. You can close this tab.`),
        { headers: { "Content-Type": "text/html" } }
      );
    }

    if (!code || !state) {
      this.pendingAuth?.reject(new Error("Missing code or state in callback"));
      return new Response(
        htmlPage("Error", "Missing authorization code. Try again."),
        { headers: { "Content-Type": "text/html" } }
      );
    }

    if (state !== this.pendingAuth?.state) {
      this.pendingAuth?.reject(new Error("State mismatch — possible CSRF"));
      return new Response(
        htmlPage("Security Error", "State parameter mismatch. Try again."),
        { headers: { "Content-Type": "text/html" } }
      );
    }

    this.pendingAuth?.resolve(code);

    return new Response(
      htmlPage("YouTube Connected!", "Authorization successful. You can close this tab and return to Discord."),
      { headers: { "Content-Type": "text/html" } }
    );
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<void> {
    if (!this.pendingAuth) throw new Error("No pending auth flow");

    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code_verifier: this.pendingAuth.codeVerifier,
    });

    const resp = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Token exchange failed (${resp.status}): ${body}`);
    }

    const data = (await resp.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    const now = Date.now();
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: now + data.expires_in * 1000,
    };
    this.saveTokens();
  }

  private cleanupPendingAuth(): void {
    if (!this.pendingAuth) return;
    if (this.pendingAuth.timeout) clearTimeout(this.pendingAuth.timeout);
    if (this.pendingAuth.server) this.pendingAuth.server.stop();
    this.pendingAuth = null;
  }

  // --- API Methods ---

  /**
   * Post a top-level comment on a YouTube video.
   * Uses commentThreads.insert (50 units/call).
   */
  async postComment(videoId: string, text: string): Promise<{ commentId: string }> {
    const token = await this.ensureToken();

    const body = {
      snippet: {
        videoId,
        topLevelComment: {
          snippet: {
            textOriginal: text,
          },
        },
      },
    };

    const resp = await fetch(`${API_BASE}/commentThreads?part=snippet`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const respBody = await resp.text();
      throw new Error(`YouTube comment failed (${resp.status}): ${respBody}`);
    }

    const data = (await resp.json()) as any;
    return {
      commentId: data.id || "",
    };
  }

  /** Cleanup — stop any pending auth server. */
  destroy(): void {
    this.cleanupPendingAuth();
  }
}

// --- Singleton management ---

let commentClient: YouTubeCommentClient | null = null;

/**
 * Initialize YouTube comment client with OAuth credentials.
 * Call during plugin init if YouTube OAuth is configured.
 */
export function initYouTubeCommentClient(ctx: PluginContext): YouTubeCommentClient | null {
  if (commentClient) return commentClient;

  const config = ctx.config.getConfig();
  const ytConfig = (config as any).socials?.youtube;

  if (!ytConfig?.clientId || !ytConfig?.clientSecret) {
    return null;
  }

  commentClient = new YouTubeCommentClient(
    ctx.DATA_DIR,
    ytConfig.clientId,
    ytConfig.clientSecret
  );

  return commentClient;
}

/** Get the YouTube comment client (null if not configured). */
export function getYouTubeCommentClient(): YouTubeCommentClient | null {
  return commentClient;
}

/** Reset client (for destroy/cleanup). */
export function destroyYouTubeCommentClient(): void {
  commentClient?.destroy();
  commentClient = null;
}

// --- Helpers ---

/** Get API key from env or config (set by initYouTubeConfig). */
let configApiKey: string | undefined;

export function setYouTubeApiKey(key: string | undefined): void {
  configApiKey = key;
}

function getApiKey(): string | undefined {
  return process.env.YOUTUBE_API_KEY || configApiKey;
}

function htmlPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>${title}</title>
<style>
  body { font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
  .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
  h1 { color: #ff0000; margin-bottom: 0.5rem; }
  p { color: #666; }
</style>
</head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body>
</html>`;
}
