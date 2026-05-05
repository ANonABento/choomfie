/**
 * LinkedIn API provider — personal profile posting via "Share on LinkedIn" product.
 *
 * Standard 3-legged OAuth 2.0 (no PKCE — LinkedIn rejects PKCE with `invalid_client`
 * for the "Share on LinkedIn" product, even with correct credentials).
 * Callback server runs on fixed port 9876 — must match redirect URL in LinkedIn app config.
 * Auth link must be opened on the same machine running the bot (localhost callback).
 * Tokens stored as JSON file in the plugin data directory.
 * Uses raw fetch against LinkedIn REST API (no library needed).
 */

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { writeSecretFileSync } from "@choomfie/shared";
import type { LinkedInProfile, LinkedInPostResult } from "../types.ts";

// --- Constants ---

const LINKEDIN_AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const LINKEDIN_REST_BASE = "https://api.linkedin.com/rest";
const LINKEDIN_VERSION = "202603";
const SCOPES = ["openid", "profile", "w_member_social"];

// Token refresh buffer — refresh 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// --- Types ---

export interface LinkedInTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // Unix ms
  refreshExpiresAt?: number; // Unix ms
  personUrn?: string; // urn:li:person:{id}
  name?: string;
}

interface PendingAuth {
  state: string;
  resolve: (code: string) => void;
  reject: (err: Error) => void;
  server?: ReturnType<typeof Bun.serve>;
  timeout?: Timer;
}

// --- LinkedIn Client ---

export class LinkedInClient {
  private tokensPath: string;
  private tokens: LinkedInTokens | null = null;
  private pendingAuth: PendingAuth | null = null;
  private clientId: string;
  private clientSecret: string;

  constructor(dataDir: string, clientId: string, clientSecret: string) {
    const socialsDir = `${dataDir}/socials`;
    if (!existsSync(socialsDir)) {
      mkdirSync(socialsDir, { recursive: true });
    }
    this.tokensPath = `${socialsDir}/linkedin-tokens.json`;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.loadTokens();
  }

  // --- Token Management ---

  private loadTokens(): void {
    try {
      const raw = readFileSync(this.tokensPath, "utf-8");
      this.tokens = JSON.parse(raw) as LinkedInTokens;
    } catch {
      this.tokens = null;
    }
  }

  private saveTokens(): void {
    if (!this.tokens) return;
    writeSecretFileSync(this.tokensPath, JSON.stringify(this.tokens, null, 2));
  }

  isAuthenticated(): boolean {
    return this.tokens !== null && this.tokens.accessToken !== "";
  }

  getStatus(): {
    authenticated: boolean;
    name?: string;
    personUrn?: string;
    expiresAt?: number;
  } {
    if (!this.tokens) return { authenticated: false };
    return {
      authenticated: true,
      name: this.tokens.name,
      personUrn: this.tokens.personUrn,
      expiresAt: this.tokens.expiresAt,
    };
  }

  /**
   * Ensure access token is valid, refreshing if needed.
   * Returns the current access token or throws.
   */
  private async ensureToken(): Promise<string> {
    if (!this.tokens) throw new Error("Not authenticated. Run linkedin_auth first.");

    const now = Date.now();

    // Token still valid
    if (now < this.tokens.expiresAt - REFRESH_BUFFER_MS) {
      return this.tokens.accessToken;
    }

    // Try refresh
    if (this.tokens.refreshToken) {
      const refreshExpired =
        this.tokens.refreshExpiresAt && now >= this.tokens.refreshExpiresAt;
      if (!refreshExpired) {
        await this.refreshAccessToken();
        return this.tokens.accessToken;
      }
    }

    throw new Error(
      "LinkedIn access token expired and no valid refresh token. Run linkedin_auth again."
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

    const resp = await fetch(LINKEDIN_TOKEN_URL, {
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
      refresh_token_expires_in?: number;
    };

    if (!this.tokens) throw new Error("Token state lost during refresh");
    const now = Date.now();
    this.tokens.accessToken = data.access_token;
    this.tokens.expiresAt = now + data.expires_in * 1000;
    if (data.refresh_token) {
      this.tokens.refreshToken = data.refresh_token;
      this.tokens.refreshExpiresAt = data.refresh_token_expires_in
        ? now + data.refresh_token_expires_in * 1000
        : undefined;
    }
    this.saveTokens();
  }

  // --- OAuth Flow ---

  /**
   * Start OAuth 2.0 flow (standard 3-legged, no PKCE).
   * Spins up a temporary HTTP server on port 9876 to catch the callback.
   * Returns the authorization URL for the user to visit.
   */
  async startAuth(): Promise<{ authUrl: string; port: number }> {
    // Clean up any pending auth
    this.cleanupPendingAuth();

    const state = randomBytes(16).toString("hex");

    // Create a promise that resolves when we get the callback
    let resolveAuth: (code: string) => void;
    let rejectAuth: (err: Error) => void;
    const authPromise = new Promise<string>((resolve, reject) => {
      resolveAuth = resolve;
      rejectAuth = reject;
    });

    this.pendingAuth = {
      state,
      resolve: resolveAuth!,
      reject: rejectAuth!,
    };

    // Start temporary HTTP server — fixed port so it matches LinkedIn's registered redirect URL
    const server = Bun.serve({
      port: 9876,
      fetch: async (req) => {
        const url = new URL(req.url);

        if (url.pathname === "/callback") {
          return this.handleCallback(url);
        }

        return new Response("LinkedIn OAuth callback server", { status: 200 });
      },
    });

    if (server.port !== 9876) {
      server.stop();
      throw new Error(`Port 9876 not available (got ${server.port}). Ensure nothing else is using it.`);
    }
    this.pendingAuth.server = server;
    const port = server.port;

    // Set 5-minute timeout for auth flow
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
    });

    const authUrl = `${LINKEDIN_AUTH_URL}?${params.toString()}`;

    // Wait for callback in background, then exchange code
    authPromise
      .then(async (code) => {
        await this.exchangeCode(code, redirectUri);
      })
      .catch((e) => {
        console.error(`LinkedIn auth failed: ${e.message}`);
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
    const errorDesc = url.searchParams.get("error_description");

    if (error) {
      this.pendingAuth?.reject(
        new Error(`LinkedIn denied: ${error} — ${errorDesc}`)
      );
      return new Response(
        htmlPage(
          "Authorization Failed",
          `LinkedIn denied the request: ${errorDesc || error}. You can close this tab.`
        ),
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
        htmlPage(
          "Security Error",
          "State parameter mismatch. This could be a CSRF attack. Try again."
        ),
        { headers: { "Content-Type": "text/html" } }
      );
    }

    this.pendingAuth?.resolve(code);

    return new Response(
      htmlPage(
        "LinkedIn Connected!",
        "Authorization successful. You can close this tab and return to Discord."
      ),
      { headers: { "Content-Type": "text/html" } }
    );
  }

  private async exchangeCode(
    code: string,
    redirectUri: string
  ): Promise<void> {
    if (!this.pendingAuth) throw new Error("No pending auth flow");

    // Standard 3-legged OAuth (no PKCE) — client_secret in body
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const resp = await fetch(LINKEDIN_TOKEN_URL, {
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
      refresh_token_expires_in?: number;
      scope?: string;
    };

    const now = Date.now();
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: now + data.expires_in * 1000,
      refreshExpiresAt: data.refresh_token_expires_in
        ? now + data.refresh_token_expires_in * 1000
        : undefined,
    };
    this.saveTokens();

    // Fetch profile to get URN + name
    try {
      const profile = await this.getProfile();
      this.tokens.personUrn = `urn:li:person:${profile.sub}`;
      this.tokens.name = profile.name;
      this.saveTokens();
    } catch (e: any) {
      console.error(`Failed to fetch LinkedIn profile: ${e.message}`);
    }
  }

  private cleanupPendingAuth(): void {
    if (!this.pendingAuth) return;

    if (this.pendingAuth.timeout) {
      clearTimeout(this.pendingAuth.timeout);
    }
    if (this.pendingAuth.server) {
      this.pendingAuth.server.stop();
    }
    this.pendingAuth = null;
  }

  // --- API Methods ---

  /**
   * Get the authenticated user's profile via OpenID userinfo endpoint.
   */
  async getProfile(): Promise<LinkedInProfile> {
    const token = await this.ensureToken();

    const resp = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Profile fetch failed (${resp.status}): ${body}`);
    }

    const data = (await resp.json()) as {
      sub: string;
      name: string;
      email?: string;
      picture?: string;
    };

    return {
      sub: data.sub,
      name: data.name,
      email: data.email,
      picture: data.picture,
    };
  }

  /** Common headers for LinkedIn REST API calls. */
  private restHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
      "LinkedIn-Version": LINKEDIN_VERSION,
    };
  }

  /** Ensure we have the person URN, fetching profile if needed. */
  private async ensurePersonUrn(): Promise<string> {
    if (this.tokens?.personUrn) return this.tokens.personUrn;
    const profile = await this.getProfile();
    this.tokens!.personUrn = `urn:li:person:${profile.sub}`;
    this.tokens!.name = profile.name;
    this.saveTokens();
    return this.tokens!.personUrn;
  }

  /**
   * Create a text post on the authenticated user's personal profile.
   * Uses the Posts API (/rest/posts) — replacement for deprecated ugcPosts.
   */
  async post(text: string): Promise<LinkedInPostResult> {
    const token = await this.ensureToken();
    const personUrn = await this.ensurePersonUrn();

    const body = {
      author: personUrn,
      commentary: text,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };

    const resp = await fetch(`${LINKEDIN_REST_BASE}/posts`, {
      method: "POST",
      headers: this.restHeaders(token),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const respBody = await resp.text();
      throw new Error(`LinkedIn post failed (${resp.status}): ${respBody}`);
    }

    const postUrn =
      resp.headers.get("x-restli-id") || "";

    const postUrl = postUrn
      ? `https://www.linkedin.com/feed/update/${postUrn}/`
      : undefined;

    return { id: postUrn, url: postUrl };
  }

  /**
   * Upload an image to LinkedIn and return its URN.
   * Accepts a URL (fetched) or a local file path (read from disk).
   */
  async uploadImage(source: string): Promise<string> {
    const token = await this.ensureToken();
    const personUrn = await this.ensurePersonUrn();

    // Step 1: Initialize upload
    const initResp = await fetch(
      `${LINKEDIN_REST_BASE}/images?action=initializeUpload`,
      {
        method: "POST",
        headers: this.restHeaders(token),
        body: JSON.stringify({
          initializeUploadRequest: { owner: personUrn },
        }),
      }
    );

    if (!initResp.ok) {
      const body = await initResp.text();
      throw new Error(`Image upload init failed (${initResp.status}): ${body}`);
    }

    const initData = (await initResp.json()) as {
      value: { uploadUrl: string; image: string };
    };
    const { uploadUrl, image: imageUrn } = initData.value;

    // Step 2: Get image bytes
    let imageBytes: ArrayBuffer;
    if (source.startsWith("http://") || source.startsWith("https://")) {
      const imgResp = await fetch(source);
      if (!imgResp.ok) throw new Error(`Failed to fetch image from ${source}`);
      imageBytes = await imgResp.arrayBuffer();
    } else {
      // Local file path
      const file = Bun.file(source);
      if (!(await file.exists())) throw new Error(`Image file not found: ${source}`);
      imageBytes = await file.arrayBuffer();
    }

    // Step 3: Upload binary
    const uploadResp = await fetch(uploadUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: imageBytes,
    });

    if (!uploadResp.ok) {
      const body = await uploadResp.text();
      throw new Error(`Image upload failed (${uploadResp.status}): ${body}`);
    }

    return imageUrn;
  }

  /**
   * Create a post with a single image.
   */
  async postWithImage(
    text: string,
    imageSource: string,
    altText?: string
  ): Promise<LinkedInPostResult> {
    const token = await this.ensureToken();
    const personUrn = await this.ensurePersonUrn();

    const imageUrn = await this.uploadImage(imageSource);

    const body = {
      author: personUrn,
      commentary: text,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content: {
        media: {
          id: imageUrn,
          ...(altText ? { altText } : {}),
        },
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };

    const resp = await fetch(`${LINKEDIN_REST_BASE}/posts`, {
      method: "POST",
      headers: this.restHeaders(token),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const respBody = await resp.text();
      throw new Error(`LinkedIn image post failed (${resp.status}): ${respBody}`);
    }

    const postUrn =
      resp.headers.get("x-restli-id") || "";
    const postUrl = postUrn
      ? `https://www.linkedin.com/feed/update/${postUrn}/`
      : undefined;

    return { id: postUrn, url: postUrl };
  }

  /**
   * Create a post with multiple images (2-20).
   */
  async postWithImages(
    text: string,
    imageSources: string[],
    altTexts?: string[]
  ): Promise<LinkedInPostResult> {
    if (imageSources.length < 2 || imageSources.length > 20) {
      throw new Error("Multi-image posts require 2-20 images.");
    }

    const token = await this.ensureToken();
    const personUrn = await this.ensurePersonUrn();

    // Upload all images in parallel
    const imageUrns = await Promise.all(
      imageSources.map((src) => this.uploadImage(src))
    );

    const images = imageUrns.map((urn, i) => ({
      id: urn,
      ...(altTexts?.[i] ? { altText: altTexts[i] } : {}),
    }));

    const body = {
      author: personUrn,
      commentary: text,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content: {
        multiImage: { images },
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };

    const resp = await fetch(`${LINKEDIN_REST_BASE}/posts`, {
      method: "POST",
      headers: this.restHeaders(token),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const respBody = await resp.text();
      throw new Error(`LinkedIn multi-image post failed (${resp.status}): ${respBody}`);
    }

    const postUrn =
      resp.headers.get("x-restli-id") || "";
    const postUrl = postUrn
      ? `https://www.linkedin.com/feed/update/${postUrn}/`
      : undefined;

    return { id: postUrn, url: postUrl };
  }

  /**
   * Create an article/link post with metadata.
   */
  async postWithLink(
    text: string,
    url: string,
    title?: string,
    description?: string
  ): Promise<LinkedInPostResult> {
    const token = await this.ensureToken();
    const personUrn = await this.ensurePersonUrn();

    const article: Record<string, string> = { source: url };
    if (title) article.title = title;
    if (description) article.description = description;

    const body = {
      author: personUrn,
      commentary: text,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content: { article },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };

    const resp = await fetch(`${LINKEDIN_REST_BASE}/posts`, {
      method: "POST",
      headers: this.restHeaders(token),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const respBody = await resp.text();
      throw new Error(`LinkedIn link post failed (${resp.status}): ${respBody}`);
    }

    const postUrn =
      resp.headers.get("x-restli-id") || "";
    const postUrl = postUrn
      ? `https://www.linkedin.com/feed/update/${postUrn}/`
      : undefined;

    return { id: postUrn, url: postUrl };
  }

  /**
   * Delete a post by its URN.
   */
  async deletePost(postUrn: string): Promise<void> {
    const token = await this.ensureToken();
    const encodedUrn = encodeURIComponent(postUrn);

    const resp = await fetch(`${LINKEDIN_REST_BASE}/posts/${encodedUrn}`, {
      method: "DELETE",
      headers: {
        ...this.restHeaders(token),
        "X-RestLi-Method": "DELETE",
      },
    });

    if (!resp.ok) {
      const respBody = await resp.text();
      throw new Error(`LinkedIn delete failed (${resp.status}): ${respBody}`);
    }
  }

  /**
   * Edit a post's text. Only the commentary can be updated.
   */
  async editPost(postUrn: string, newText: string): Promise<void> {
    const token = await this.ensureToken();
    const encodedUrn = encodeURIComponent(postUrn);

    const body = {
      patch: {
        $set: { commentary: newText },
      },
    };

    const resp = await fetch(`${LINKEDIN_REST_BASE}/posts/${encodedUrn}`, {
      method: "POST",
      headers: {
        ...this.restHeaders(token),
        "X-RestLi-Method": "PARTIAL_UPDATE",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const respBody = await resp.text();
      throw new Error(`LinkedIn edit failed (${resp.status}): ${respBody}`);
    }
  }

  /**
   * Create a poll post.
   */
  async postPoll(
    text: string,
    options: string[],
    durationDays: 1 | 3 | 7 | 14 = 3
  ): Promise<LinkedInPostResult> {
    if (options.length < 2 || options.length > 4) {
      throw new Error("Polls require 2-4 options.");
    }

    const token = await this.ensureToken();
    const personUrn = await this.ensurePersonUrn();

    // Duration mapping
    const durationMap: Record<number, string> = {
      1: "ONE_DAY",
      3: "THREE_DAYS",
      7: "SEVEN_DAYS",
      14: "FOURTEEN_DAYS",
    };

    const body = {
      author: personUrn,
      commentary: text,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content: {
        poll: {
          question: text,
          options: options.map((o) => ({ text: o })),
          settings: {
            duration: durationMap[durationDays] || "THREE_DAYS",
          },
        },
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };

    const resp = await fetch(`${LINKEDIN_REST_BASE}/posts`, {
      method: "POST",
      headers: this.restHeaders(token),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const respBody = await resp.text();
      throw new Error(`LinkedIn poll failed (${resp.status}): ${respBody}`);
    }

    const postUrn =
      resp.headers.get("x-restli-id") || "";
    const postUrl = postUrn
      ? `https://www.linkedin.com/feed/update/${postUrn}/`
      : undefined;

    return { id: postUrn, url: postUrl };
  }

  /**
   * Repost/share someone else's post.
   */
  async repost(originalPostUrn: string, commentary?: string): Promise<LinkedInPostResult> {
    const token = await this.ensureToken();
    const personUrn = await this.ensurePersonUrn();

    const body: Record<string, any> = {
      author: personUrn,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };

    if (commentary) {
      // Reshare with commentary
      body.commentary = commentary;
      body.content = {
        reshare: { resharedPost: originalPostUrn },
      };
    } else {
      // Simple repost (no added text)
      body.content = {
        reshare: { resharedPost: originalPostUrn },
      };
    }

    const resp = await fetch(`${LINKEDIN_REST_BASE}/posts`, {
      method: "POST",
      headers: this.restHeaders(token),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const respBody = await resp.text();
      throw new Error(`LinkedIn repost failed (${resp.status}): ${respBody}`);
    }

    const postUrn =
      resp.headers.get("x-restli-id") || "";
    const postUrl = postUrn
      ? `https://www.linkedin.com/feed/update/${postUrn}/`
      : undefined;

    return { id: postUrn, url: postUrl };
  }

  /**
   * Get comments on a post by its URN.
   */
  async getComments(postUrn: string): Promise<Array<{
    commentUrn: string;
    authorName: string;
    text: string;
    createdAt: number;
  }>> {
    const token = await this.ensureToken();
    const encodedUrn = encodeURIComponent(postUrn);

    const resp = await fetch(
      `${LINKEDIN_REST_BASE}/socialActions/${encodedUrn}/comments?count=20`,
      { headers: this.restHeaders(token) }
    );

    if (!resp.ok) {
      const respBody = await resp.text();
      throw new Error(`LinkedIn comments fetch failed (${resp.status}): ${respBody}`);
    }

    const data = await resp.json() as {
      elements?: Array<{
        $URN?: string;
        actor?: string;
        message?: { text?: string };
        created?: { time?: number };
        "actor~"?: { localizedFirstName?: string; localizedLastName?: string };
      }>;
    };

    return (data.elements || []).map((c) => ({
      commentUrn: c.$URN || "",
      authorName: c["actor~"]
        ? `${c["actor~"].localizedFirstName || ""} ${c["actor~"].localizedLastName || ""}`.trim()
        : c.actor || "Unknown",
      text: c.message?.text || "",
      createdAt: c.created?.time || 0,
    }));
  }

  /**
   * Post a comment on a LinkedIn post.
   */
  async commentOnPost(postUrn: string, commentText: string): Promise<string> {
    const token = await this.ensureToken();
    const personUrn = await this.ensurePersonUrn();
    const encodedUrn = encodeURIComponent(postUrn);

    const body = {
      actor: personUrn,
      message: { text: commentText },
    };

    const resp = await fetch(
      `${LINKEDIN_REST_BASE}/socialActions/${encodedUrn}/comments`,
      {
        method: "POST",
        headers: this.restHeaders(token),
        body: JSON.stringify(body),
      }
    );

    if (!resp.ok) {
      const respBody = await resp.text();
      throw new Error(`LinkedIn comment failed (${resp.status}): ${respBody}`);
    }

    const commentUrn =
      resp.headers.get("x-restli-id") || "";
    return commentUrn;
  }

  /**
   * React to a post (LIKE by default).
   */
  async reactToPost(
    postUrn: string,
    reaction: "LIKE" | "CELEBRATE" | "SUPPORT" | "LOVE" | "INSIGHTFUL" | "FUNNY" = "LIKE"
  ): Promise<void> {
    const token = await this.ensureToken();
    const personUrn = await this.ensurePersonUrn();
    const encodedUrn = encodeURIComponent(postUrn);

    const body = {
      root: postUrn,
      reactionType: reaction,
      actor: personUrn,
    };

    const resp = await fetch(
      `${LINKEDIN_REST_BASE}/socialActions/${encodedUrn}/likes`,
      {
        method: "POST",
        headers: this.restHeaders(token),
        body: JSON.stringify(body),
      }
    );

    if (!resp.ok) {
      const respBody = await resp.text();
      throw new Error(`LinkedIn react failed (${resp.status}): ${respBody}`);
    }
  }

  /**
   * Get the like/reaction count for a post.
   */
  async getLikeCount(postUrn: string): Promise<number> {
    const token = await this.ensureToken();
    const encodedUrn = encodeURIComponent(postUrn);

    const resp = await fetch(
      `${LINKEDIN_REST_BASE}/socialActions/${encodedUrn}/likes?count=0`,
      { headers: this.restHeaders(token) }
    );

    if (!resp.ok) return 0;

    const data = await resp.json() as { paging?: { total?: number } };
    return data.paging?.total || 0;
  }

  /**
   * Cleanup — stop any pending auth server.
   */
  destroy(): void {
    this.cleanupPendingAuth();
  }
}

// --- Helpers ---

function htmlPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>${title}</title>
<style>
  body { font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
  .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
  h1 { color: #0a66c2; margin-bottom: 0.5rem; }
  p { color: #666; }
</style>
</head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body>
</html>`;
}
