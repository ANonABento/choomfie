/**
 * Social platform tools — YouTube search/info, Reddit browse/search/post, LinkedIn posting.
 */

import type { ToolDef, PluginContext } from "@choomfie/shared";
import {
  text,
  err,
  errorMessage,
  parseNaturalTime,
  dateToSQLite,
} from "@choomfie/shared";
import {
  getYouTubeProvider,
  getRedditProvider,
  getRedditClient,
  getYouTubeCommentClient,
} from "./providers/index.ts";
import { LinkedInClient } from "./providers/linkedin/api.ts";
import { TwitterClient } from "./providers/twitter/api.ts";
import { withRetry } from "./providers/retry.ts";
import { LinkedInMonitor } from "./providers/linkedin/monitor.ts";
import { LinkedInScheduler } from "./providers/linkedin/scheduler.ts";

const yt = getYouTubeProvider();
const reddit = getRedditProvider();

interface SocialsConfig {
  socials?: {
    twitter?: {
      username?: string;
      password?: string;
      email?: string;
    };
    linkedin?: {
      clientId?: string;
      clientSecret?: string;
    };
  };
}

/** LinkedIn client — lazily initialized when first tool is called (needs ctx.DATA_DIR + config) */
let linkedInClient: LinkedInClient | null = null;

/** Twitter client — lazily initialized */
let twitterClient: TwitterClient | null = null;

function getTwitterClient(): TwitterClient {
  if (twitterClient) return twitterClient;
  twitterClient = new TwitterClient();
  return twitterClient;
}

function getTwitterConfig(ctx: PluginContext): { username: string; password: string; email: string } {
  const config = ctx.config.getConfig() as SocialsConfig;
  const socialsConfig = config.socials?.twitter;

  if (!socialsConfig?.username || !socialsConfig?.password || !socialsConfig?.email) {
    throw new Error(
      "Twitter not configured. Add to config.json:\n" +
      '  "socials": { "twitter": { "username": "...", "password": "...", "email": "..." } }'
    );
  }

  return {
    username: socialsConfig.username,
    password: socialsConfig.password,
    email: socialsConfig.email,
  };
}

export function destroyTwitterClient(): void {
  if (twitterClient) {
    twitterClient.destroy();
    twitterClient = null;
  }
}
let linkedInMonitor: LinkedInMonitor | null = null;
let linkedInScheduler: LinkedInScheduler | null = null;

function getLinkedInClient(ctx: PluginContext): LinkedInClient {
  if (linkedInClient) return linkedInClient;

  const config = ctx.config.getConfig() as SocialsConfig;
  const socialsConfig = config.socials?.linkedin;

  if (!socialsConfig?.clientId || !socialsConfig?.clientSecret) {
    throw new Error(
      "LinkedIn not configured. Add socials.linkedin.clientId and socials.linkedin.clientSecret to config.json. " +
      "Create a LinkedIn app at https://developer.linkedin.com first."
    );
  }

  linkedInClient = new LinkedInClient(
    ctx.DATA_DIR,
    socialsConfig.clientId,
    socialsConfig.clientSecret
  );
  return linkedInClient;
}

/** Get or create the LinkedIn monitor (shares the LinkedIn client). */
export function getLinkedInMonitor(ctx: PluginContext): LinkedInMonitor | null {
  if (linkedInMonitor) return linkedInMonitor;
  try {
    const client = getLinkedInClient(ctx);
    linkedInMonitor = new LinkedInMonitor(`${ctx.DATA_DIR}/choomfie.db`, client);
    return linkedInMonitor;
  } catch {
    return null;
  }
}

/** Get or create the LinkedIn scheduler. */
export function getLinkedInScheduler(ctx: PluginContext): LinkedInScheduler | null {
  if (linkedInScheduler) return linkedInScheduler;
  try {
    const client = getLinkedInClient(ctx);
    const monitor = getLinkedInMonitor(ctx);
    linkedInScheduler = new LinkedInScheduler(`${ctx.DATA_DIR}/choomfie.db`, client, monitor);
    return linkedInScheduler;
  } catch {
    return null;
  }
}

/** Called on plugin destroy to clean up LinkedIn client + monitor + scheduler */
export function destroyLinkedInClient(): void {
  linkedInScheduler?.destroy();
  linkedInScheduler = null;
  linkedInMonitor?.destroy();
  linkedInMonitor = null;
  linkedInClient?.destroy();
  linkedInClient = null;
}

export const socialsTools: ToolDef[] = [
  // --- YouTube ---
  {
    definition: {
      name: "youtube_search",
      description:
        "Search YouTube for videos. Returns titles, URLs, channels, and durations.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results (default: 5)" },
        },
        required: ["query"],
      },
    },
    handler: async (args, _ctx) => {
      try {
        const results = await yt.search(
          args.query as string,
          (args.limit as number) || 5
        );
        if (results.length === 0) return text("No results found.");

        const formatted = results
          .map(
            (v, i) =>
              `**${i + 1}.** ${v.title}\n  ${v.url}\n  ${v.channel} · ${v.duration}${v.views ? ` · ${v.views} views` : ""}`
          )
          .join("\n\n");
        return text(formatted);
      } catch (e: unknown) {
        return err(`YouTube search failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "youtube_info",
      description: "Get detailed info about a YouTube video.",
      inputSchema: {
        type: "object" as const,
        properties: {
          url: { type: "string", description: "YouTube video URL" },
        },
        required: ["url"],
      },
    },
    handler: async (args, _ctx) => {
      try {
        const info = await yt.getInfo(args.url as string);
        if (!info) return err("Video not found.");
        return text(
          [
            `**${info.title}**`,
            `Channel: ${info.channel}`,
            `Duration: ${info.duration}`,
            info.views ? `Views: ${info.views}` : null,
            info.published ? `Published: ${info.published}` : null,
            `URL: ${info.url}`,
          ]
            .filter(Boolean)
            .join("\n")
        );
      } catch (e: unknown) {
        return err(`YouTube info failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "youtube_transcript",
      description: "Get the transcript/captions of a YouTube video.",
      inputSchema: {
        type: "object" as const,
        properties: {
          url: { type: "string", description: "YouTube video URL" },
        },
        required: ["url"],
      },
    },
    handler: async (args, _ctx) => {
      try {
        const segments = await yt.getTranscript(args.url as string);
        if (segments.length === 0)
          return text("No transcript available for this video.");
        const transcript = segments.map((s) => s.text).join(" ");
        // Truncate if too long
        return text(
          transcript.length > 3000
            ? transcript.slice(0, 3000) + "\n\n...(truncated)"
            : transcript
        );
      } catch (e: unknown) {
        return err(`Transcript failed: ${errorMessage(e)}`);
      }
    },
  },

  // --- YouTube (Write — owner only, needs OAuth) ---
  {
    definition: {
      name: "youtube_auth",
      description:
        "Start YouTube OAuth flow for commenting. Returns an authorization URL the user must visit. " +
        "Owner only. Requires socials.youtube.clientId and clientSecret in config.json.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    handler: async (_args, _ctx) => {
      try {
        const client = getYouTubeCommentClient();
        if (!client) {
          return text(
            "YouTube: **Not configured for comments**\n\n" +
            "Add YouTube OAuth credentials to config.json:\n" +
            '```json\n"socials": {\n  "youtube": {\n    "clientId": "...",\n    "clientSecret": "..."\n  }\n}\n```\n' +
            "Create a Google Cloud project with YouTube Data API v3 at https://console.cloud.google.com\n" +
            "Then add an OAuth 2.0 client ID (Web application type) with redirect URI http://localhost:{port}/callback."
          );
        }

        const { authUrl, port } = await client.startAuth();
        return text(
          `**YouTube Authorization**\n\n` +
          `Click the link below to connect your YouTube/Google account:\n${authUrl}\n\n` +
          `A temporary callback server is running on port ${port}. ` +
          `It will automatically capture the authorization and shut down.\n` +
          `The link expires in 5 minutes.`
        );
      } catch (e: unknown) {
        return err(`YouTube auth failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "youtube_comment",
      description:
        "Post a comment on a YouTube video. Owner only. Requires YouTube OAuth (run youtube_auth first).",
      inputSchema: {
        type: "object" as const,
        properties: {
          video_url: {
            type: "string",
            description: "YouTube video URL (extracts video ID automatically)",
          },
          text: {
            type: "string",
            description: "Comment text",
          },
        },
        required: ["video_url", "text"],
      },
    },
    handler: async (args, _ctx) => {
      try {
        const client = getYouTubeCommentClient();
        if (!client) {
          return err(
            "YouTube comments not configured. Add socials.youtube.clientId and clientSecret to config.json, " +
            "then run youtube_auth to connect your account."
          );
        }

        if (!client.isAuthenticated()) {
          return err("Not authenticated with YouTube. Run youtube_auth first.");
        }

        const videoUrl = args.video_url as string;
        const commentText = args.text as string;

        // Extract video ID from URL
        const idMatch = videoUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        if (!idMatch) {
          return err("Invalid YouTube URL. Must contain a video ID (e.g. https://youtube.com/watch?v=...)");
        }
        const videoId = idMatch[1];

        const result = await client.postComment(videoId, commentText);
        return text(
          `Comment posted on YouTube video.\n` +
          `Video: https://www.youtube.com/watch?v=${videoId}\n` +
          `Comment ID: ${result.commentId}`
        );
      } catch (e: unknown) {
        return err(`YouTube comment failed: ${errorMessage(e)}`);
      }
    },
  },

  // --- Reddit (Read) ---
  {
    definition: {
      name: "reddit_search",
      description:
        "Search Reddit for posts. Can search all of Reddit or a specific subreddit.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query" },
          subreddit: {
            type: "string",
            description: "Subreddit to search in (optional)",
          },
          limit: { type: "number", description: "Max results (default: 5)" },
        },
        required: ["query"],
      },
    },
    handler: async (args, _ctx) => {
      try {
        const results = await reddit.search(
          args.query as string,
          args.subreddit as string | undefined,
          (args.limit as number) || 5
        );
        if (results.length === 0) return text("No posts found.");

        const formatted = results
          .map(
            (p, i) =>
              `**${i + 1}.** ${p.title}\n  r/${p.subreddit} · ${p.score} pts · ${p.comments} comments\n  ${p.permalink}`
          )
          .join("\n\n");
        return text(formatted);
      } catch (e: unknown) {
        return err(`Reddit search failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "reddit_posts",
      description: "Get posts from a subreddit (hot, top, or new).",
      inputSchema: {
        type: "object" as const,
        properties: {
          subreddit: { type: "string", description: "Subreddit name (without r/)" },
          sort: {
            type: "string",
            enum: ["hot", "top", "new"],
            description: "Sort order (default: hot)",
          },
          limit: { type: "number", description: "Max results (default: 5)" },
        },
        required: ["subreddit"],
      },
    },
    handler: async (args, _ctx) => {
      try {
        const posts = await reddit.getPosts(
          args.subreddit as string,
          (args.sort as "hot" | "top" | "new") || "hot",
          (args.limit as number) || 5
        );
        if (posts.length === 0) return text("No posts found.");

        const formatted = posts
          .map(
            (p, i) =>
              `**${i + 1}.** ${p.title}\n  ${p.score} pts · ${p.comments} comments · u/${p.author}\n  ${p.permalink}`
          )
          .join("\n\n");
        return text(formatted);
      } catch (e: unknown) {
        return err(`Reddit posts failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "reddit_comments",
      description: "Get top comments on a Reddit post.",
      inputSchema: {
        type: "object" as const,
        properties: {
          url: { type: "string", description: "Reddit post URL or permalink" },
          limit: { type: "number", description: "Max comments (default: 5)" },
        },
        required: ["url"],
      },
    },
    handler: async (args, _ctx) => {
      try {
        const comments = await reddit.getComments(
          args.url as string,
          (args.limit as number) || 5
        );
        if (comments.length === 0) return text("No comments found.");

        const formatted = comments
          .map(
            (c, i) =>
              `**${i + 1}.** u/${c.author} (${c.score} pts)\n  ${c.body.slice(0, 300)}${c.body.length > 300 ? "..." : ""}`
          )
          .join("\n\n");
        return text(formatted);
      } catch (e: unknown) {
        return err(`Reddit comments failed: ${errorMessage(e)}`);
      }
    },
  },

  // --- Reddit (Write — owner only) ---
  {
    definition: {
      name: "reddit_auth",
      description:
        "Check Reddit API authentication status. Reddit uses OAuth password grant — " +
        "auto-authenticates from config. Shows connection status, username, and token expiry.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    handler: async (_args, _ctx) => {
      try {
        const client = getRedditClient();
        if (!client) {
          return text(
            "Reddit: **Not configured**\n\n" +
            "Add Reddit credentials to config.json:\n" +
            '```json\n"socials": {\n  "reddit": {\n    "clientId": "...",\n    "clientSecret": "...",\n    "username": "...",\n    "password": "..."\n  }\n}\n```\n' +
            "Create a script app at https://www.reddit.com/prefs/apps"
          );
        }

        const status = await client.getAuthStatus();
        if (!status.authenticated) {
          return text(
            `Reddit: **Auth failed** for u/${status.username}\n` +
            "Check your credentials in config.json."
          );
        }

        const expiresIn = status.expiresAt
          ? Math.max(0, Math.round((status.expiresAt - Date.now()) / (1000 * 60)))
          : "unknown";

        return text(
          `Reddit: **Connected**\n` +
          `Username: u/${status.username}\n` +
          `Token expires in: ~${expiresIn} minutes (auto-refreshes)`
        );
      } catch (e: unknown) {
        return err(`Reddit auth check failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "reddit_post",
      description:
        "Submit a post to a subreddit. Supports text, link, and image posts. Owner only. " +
        "Returns the post URL on success.",
      inputSchema: {
        type: "object" as const,
        properties: {
          subreddit: {
            type: "string",
            description: "Subreddit to post to (without r/)",
          },
          title: { type: "string", description: "Post title" },
          text: {
            type: "string",
            description: "Post body text (markdown supported)",
          },
          kind: {
            type: "string",
            enum: ["self", "link", "image"],
            description: "Post type: 'self' for text (default), 'link' for link, 'image' for image post",
          },
          url: {
            type: "string",
            description: "URL for link posts (required when kind=link)",
          },
          image: {
            type: "string",
            description: "Absolute file path to image for image posts (PNG/JPG/GIF, required when kind=image)",
          },
        },
        required: ["subreddit", "title"],
      },
    },
    handler: async (args, _ctx) => {
      try {
        const client = getRedditClient();
        if (!client) {
          return err(
            "Reddit not configured. Add socials.reddit config to config.json."
          );
        }

        const subreddit = args.subreddit as string;
        const title = args.title as string;
        const kind = (args.kind as string) || "self";

        let result;
        if (kind === "image") {
          const imagePath = args.image as string;
          if (!imagePath) return err("Image path is required for image posts.");
          const postText = (args.text as string) || undefined;
          result = await client.submitImage(subreddit, title, imagePath, postText);
        } else if (kind === "link") {
          const url = args.url as string;
          if (!url) return err("URL is required for link posts.");
          result = await client.submitLink(subreddit, title, url);
        } else {
          const postText = (args.text as string) || "";
          result = await client.submitPost(subreddit, title, postText);
        }

        return text(
          `Posted to r/${subreddit} successfully.\n` +
          `Post ID: ${result.fullname}\n` +
          `URL: ${result.url}`
        );
      } catch (e: unknown) {
        return err(`Reddit post failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "reddit_comment",
      description:
        "Comment on a Reddit post or reply to a comment. Owner only. " +
        "Use the post's fullname (t3_xxx) or a comment's fullname (t1_xxx) as the parent.",
      inputSchema: {
        type: "object" as const,
        properties: {
          parent: {
            type: "string",
            description:
              "Fullname of the post (t3_xxx) or comment (t1_xxx) to reply to",
          },
          text: {
            type: "string",
            description: "Comment text (markdown supported)",
          },
        },
        required: ["parent", "text"],
      },
    },
    handler: async (args, _ctx) => {
      try {
        const client = getRedditClient();
        if (!client) {
          return err(
            "Reddit not configured. Add socials.reddit config to config.json."
          );
        }

        const parent = args.parent as string;
        const commentText = args.text as string;

        // Validate fullname format
        if (!/^t[13]_[a-z0-9]+$/i.test(parent)) {
          return err(
            "Invalid parent fullname. Must be t3_xxx (post) or t1_xxx (comment)."
          );
        }

        const result = await client.comment(parent, commentText);
        return text(
          `Comment posted successfully.\n` +
          `Comment ID: ${result.fullname}`
        );
      } catch (e: unknown) {
        return err(`Reddit comment failed: ${errorMessage(e)}`);
      }
    },
  },

  // --- LinkedIn ---
  {
    definition: {
      name: "linkedin_auth",
      description:
        "Start LinkedIn OAuth flow. Returns an authorization URL the user must visit to connect their LinkedIn account. " +
        "A temporary local server catches the callback automatically.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    handler: async (_args, ctx) => {
      try {
        const client = getLinkedInClient(ctx);
        const { authUrl, port } = await client.startAuth();
        return text(
          `**LinkedIn Authorization**\n\n` +
          `Click the link below to connect your LinkedIn account:\n${authUrl}\n\n` +
          `A temporary callback server is running on port ${port}. ` +
          `It will automatically capture the authorization and shut down.\n` +
          `The link expires in 5 minutes.`
        );
      } catch (e: unknown) {
        return err(`LinkedIn auth failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "linkedin_post",
      description:
        "Post text content to the authenticated user's LinkedIn personal profile.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: {
            type: "string",
            description: "The post content (text). LinkedIn supports up to 3000 characters.",
          },
        },
        required: ["text"],
      },
    },
    handler: async (args, ctx) => {
      try {
        const client = getLinkedInClient(ctx);
        const postText = args.text as string;

        if (postText.length > 3000) {
          return err("LinkedIn posts are limited to 3000 characters.");
        }

        const result = await client.post(postText);

        // Auto-track for comment monitoring
        const monitor = getLinkedInMonitor(ctx);
        if (monitor && result.id) {
          monitor.trackPost(result.id, postText);
        }

        const urlLine = result.url ? `\nURL: ${result.url}` : "";
        return text(`Posted to LinkedIn successfully.\nPost ID: ${result.id}${urlLine}`);
      } catch (e: unknown) {
        return err(`LinkedIn post failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "linkedin_post_image",
      description:
        "Post to LinkedIn with an image. Accepts a URL or local file path for the image. Owner only.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: {
            type: "string",
            description: "Post text (up to 3000 characters).",
          },
          image: {
            type: "string",
            description: "Image URL (https://...) or local file path.",
          },
          alt_text: {
            type: "string",
            description: "Alt text for accessibility (optional).",
          },
        },
        required: ["text", "image"],
      },
    },
    handler: async (args, ctx) => {
      try {
        const client = getLinkedInClient(ctx);
        const postText = args.text as string;
        if (postText.length > 3000) {
          return err("LinkedIn posts are limited to 3000 characters.");
        }
        const result = await client.postWithImage(
          postText,
          args.image as string,
          args.alt_text as string | undefined
        );
        const monitor = getLinkedInMonitor(ctx);
        if (monitor && result.id) monitor.trackPost(result.id, postText);
        const urlLine = result.url ? `\nURL: ${result.url}` : "";
        return text(`Posted to LinkedIn with image.\nPost ID: ${result.id}${urlLine}`);
      } catch (e: unknown) {
        return err(`LinkedIn image post failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "linkedin_post_images",
      description:
        "Post to LinkedIn with multiple images (2-20). Accepts URLs or local file paths. Owner only.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: {
            type: "string",
            description: "Post text (up to 3000 characters).",
          },
          images: {
            type: "array",
            items: { type: "string" },
            description: "Array of image URLs or local file paths (2-20 images).",
          },
        },
        required: ["text", "images"],
      },
    },
    handler: async (args, ctx) => {
      try {
        const client = getLinkedInClient(ctx);
        const postText = args.text as string;
        const images = args.images as string[];
        if (postText.length > 3000) {
          return err("LinkedIn posts are limited to 3000 characters.");
        }
        if (images.length < 2 || images.length > 20) {
          return err("Multi-image posts require 2-20 images.");
        }
        const result = await client.postWithImages(postText, images);
        const monitor = getLinkedInMonitor(ctx);
        if (monitor && result.id) monitor.trackPost(result.id, postText);
        const urlLine = result.url ? `\nURL: ${result.url}` : "";
        return text(`Posted to LinkedIn with ${images.length} images.\nPost ID: ${result.id}${urlLine}`);
      } catch (e: unknown) {
        return err(`LinkedIn multi-image post failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "linkedin_post_link",
      description:
        "Post to LinkedIn with a link/article card. Includes URL with optional title and description. Owner only.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: {
            type: "string",
            description: "Post text (up to 3000 characters).",
          },
          url: {
            type: "string",
            description: "URL to share.",
          },
          title: {
            type: "string",
            description: "Link title (optional, for the article card).",
          },
          description: {
            type: "string",
            description: "Link description (optional, for the article card).",
          },
        },
        required: ["text", "url"],
      },
    },
    handler: async (args, ctx) => {
      try {
        const client = getLinkedInClient(ctx);
        const postText = args.text as string;
        if (postText.length > 3000) {
          return err("LinkedIn posts are limited to 3000 characters.");
        }
        const result = await client.postWithLink(
          postText,
          args.url as string,
          args.title as string | undefined,
          args.description as string | undefined
        );
        const monitor = getLinkedInMonitor(ctx);
        if (monitor && result.id) monitor.trackPost(result.id, postText);
        const urlLine = result.url ? `\nURL: ${result.url}` : "";
        return text(`Posted to LinkedIn with link.\nPost ID: ${result.id}${urlLine}`);
      } catch (e: unknown) {
        return err(`LinkedIn link post failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "linkedin_edit",
      description:
        "Edit the text of an existing LinkedIn post. Only the post text can be changed. Owner only.",
      inputSchema: {
        type: "object" as const,
        properties: {
          post_urn: {
            type: "string",
            description: "The post URN to edit.",
          },
          text: {
            type: "string",
            description: "New post text (up to 3000 characters).",
          },
        },
        required: ["post_urn", "text"],
      },
    },
    handler: async (args, ctx) => {
      try {
        const client = getLinkedInClient(ctx);
        const newText = args.text as string;
        if (newText.length > 3000) {
          return err("LinkedIn posts are limited to 3000 characters.");
        }
        await client.editPost(args.post_urn as string, newText);
        return text(`Edited LinkedIn post: ${args.post_urn}`);
      } catch (e: unknown) {
        return err(`LinkedIn edit failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "linkedin_poll",
      description:
        "Create a poll on LinkedIn. 2-4 options, duration 1/3/7/14 days. Owner only.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: {
            type: "string",
            description: "Poll question / post text.",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Poll options (2-4 choices).",
          },
          duration: {
            type: "number",
            enum: [1, 3, 7, 14],
            description: "Duration in days (default: 3).",
          },
        },
        required: ["text", "options"],
      },
    },
    handler: async (args, ctx) => {
      try {
        const client = getLinkedInClient(ctx);
        const options = args.options as string[];
        if (options.length < 2 || options.length > 4) {
          return err("Polls require 2-4 options.");
        }
        const duration = (args.duration as number || 3) as 1 | 3 | 7 | 14;
        const result = await client.postPoll(args.text as string, options, duration);

        const monitor = getLinkedInMonitor(ctx);
        if (monitor && result.id) monitor.trackPost(result.id, args.text as string);

        const urlLine = result.url ? `\nURL: ${result.url}` : "";
        return text(`Poll created on LinkedIn.\nPost ID: ${result.id}${urlLine}`);
      } catch (e: unknown) {
        return err(`LinkedIn poll failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "linkedin_repost",
      description:
        "Repost/share someone else's LinkedIn post. Optionally add your own commentary. Owner only.",
      inputSchema: {
        type: "object" as const,
        properties: {
          post_urn: {
            type: "string",
            description: "URN of the post to repost.",
          },
          commentary: {
            type: "string",
            description: "Your commentary to add (optional, for a reshare with text).",
          },
        },
        required: ["post_urn"],
      },
    },
    handler: async (args, ctx) => {
      try {
        const client = getLinkedInClient(ctx);
        const result = await client.repost(
          args.post_urn as string,
          args.commentary as string | undefined
        );
        const urlLine = result.url ? `\nURL: ${result.url}` : "";
        return text(`Reposted on LinkedIn.\nPost ID: ${result.id}${urlLine}`);
      } catch (e: unknown) {
        return err(`LinkedIn repost failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "linkedin_delete",
      description:
        "Delete a LinkedIn post by its URN (e.g. urn:li:share:123456). Owner only.",
      inputSchema: {
        type: "object" as const,
        properties: {
          post_urn: {
            type: "string",
            description: "The post URN to delete (returned by linkedin_post).",
          },
        },
        required: ["post_urn"],
      },
    },
    handler: async (args, ctx) => {
      try {
        const client = getLinkedInClient(ctx);
        await client.deletePost(args.post_urn as string);
        const monitor = getLinkedInMonitor(ctx);
        if (monitor) monitor.untrackPost(args.post_urn as string);
        return text(`Deleted LinkedIn post: ${args.post_urn}`);
      } catch (e: unknown) {
        return err(`LinkedIn delete failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "linkedin_comments",
      description:
        "Get comments on a LinkedIn post. Use the post URN from linkedin_post.",
      inputSchema: {
        type: "object" as const,
        properties: {
          post_urn: {
            type: "string",
            description: "The post URN to get comments for.",
          },
        },
        required: ["post_urn"],
      },
    },
    handler: async (args, ctx) => {
      try {
        const client = getLinkedInClient(ctx);
        const comments = await client.getComments(args.post_urn as string);

        if (comments.length === 0) return text("No comments on this post.");

        const formatted = comments
          .map(
            (c, i) =>
              `**${i + 1}.** ${c.authorName}\n  ${c.text.slice(0, 300)}${c.text.length > 300 ? "..." : ""}`
          )
          .join("\n\n");
        return text(formatted);
      } catch (e: unknown) {
        return err(`LinkedIn comments failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "linkedin_comment",
      description:
        "Post a comment on a LinkedIn post. Owner only.",
      inputSchema: {
        type: "object" as const,
        properties: {
          post_urn: {
            type: "string",
            description: "The post URN to comment on.",
          },
          text: {
            type: "string",
            description: "Comment text.",
          },
        },
        required: ["post_urn", "text"],
      },
    },
    handler: async (args, ctx) => {
      try {
        const client = getLinkedInClient(ctx);
        const commentUrn = await client.commentOnPost(
          args.post_urn as string,
          args.text as string
        );
        return text(`Comment posted.\nComment URN: ${commentUrn}`);
      } catch (e: unknown) {
        return err(`LinkedIn comment failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "linkedin_react",
      description:
        "React to a LinkedIn post (like, celebrate, support, love, insightful, funny).",
      inputSchema: {
        type: "object" as const,
        properties: {
          post_urn: {
            type: "string",
            description: "The post URN to react to.",
          },
          reaction: {
            type: "string",
            enum: ["LIKE", "CELEBRATE", "SUPPORT", "LOVE", "INSIGHTFUL", "FUNNY"],
            description: "Reaction type (default: LIKE).",
          },
        },
        required: ["post_urn"],
      },
    },
    handler: async (args, ctx) => {
      try {
        const client = getLinkedInClient(ctx);
        const reaction = (args.reaction as string || "LIKE") as
          "LIKE" | "CELEBRATE" | "SUPPORT" | "LOVE" | "INSIGHTFUL" | "FUNNY";
        await client.reactToPost(args.post_urn as string, reaction);
        return text(`Reacted to post with ${reaction}.`);
      } catch (e: unknown) {
        return err(`LinkedIn react failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "linkedin_schedule",
      description:
        "Schedule a LinkedIn post for later. Supports text, image, and link posts. " +
        "Use time like '2h', '30m', '3d', or a date like '2026-04-02 09:00'. " +
        "Optionally add a first_comment that auto-posts after the main post. Owner only.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: {
            type: "string",
            description: "Post text (up to 3000 characters).",
          },
          time: {
            type: "string",
            description: "When to post: relative ('2h', '30m', '3d') or absolute ('2026-04-02 09:00').",
          },
          image: {
            type: "string",
            description: "Image URL or file path (optional, makes it an image post).",
          },
          url: {
            type: "string",
            description: "Link URL (optional, makes it a link/article post).",
          },
          link_title: {
            type: "string",
            description: "Link title for article card (optional).",
          },
          link_description: {
            type: "string",
            description: "Link description for article card (optional).",
          },
          first_comment: {
            type: "string",
            description: "Auto-post this comment after the main post (optional, good for CTAs).",
          },
        },
        required: ["text", "time"],
      },
    },
    handler: async (args, ctx) => {
      try {
        const scheduler = getLinkedInScheduler(ctx);
        if (!scheduler) return err("LinkedIn not configured.");

        const postText = args.text as string;
        if (postText.length > 3000) {
          return err("LinkedIn posts are limited to 3000 characters.");
        }

        const timeStr = args.time as string;
        let scheduledAt: string;

        const parsed = parseNaturalTime(timeStr);
        if (parsed) {
          scheduledAt = dateToSQLite(parsed);
        } else if (/^\d{4}-\d{2}-\d{2}/.test(timeStr)) {
          // Absolute datetime
          scheduledAt = timeStr.replace("T", " ").replace(/Z$/, "").trim();
        } else {
          return err(`Couldn't parse time "${timeStr}". Use '2h', '30m', '3d', or '2026-04-02 09:00'.`);
        }

        const mediaType = args.image ? "image" : args.url ? "link" : "text";
        const post = scheduler.schedule({
          text: postText,
          scheduledAt,
          mediaType: mediaType as "text" | "image" | "link",
          imageUrl: args.image as string | undefined,
          linkUrl: args.url as string | undefined,
          linkTitle: args.link_title as string | undefined,
          linkDescription: args.link_description as string | undefined,
          firstComment: args.first_comment as string | undefined,
        });

        return text(
          `Scheduled LinkedIn post #${post.id} for ${post.scheduledAt} UTC.\n` +
          `Type: ${mediaType}` +
          (post.firstComment ? `\nFirst comment: "${post.firstComment}"` : "")
        );
      } catch (e: unknown) {
        return err(`LinkedIn schedule failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "linkedin_queue",
      description:
        "View or manage the LinkedIn post queue. Shows pending scheduled posts by default.",
      inputSchema: {
        type: "object" as const,
        properties: {
          action: {
            type: "string",
            enum: ["list", "cancel", "all"],
            description: "Action: 'list' (default, pending only), 'all' (include posted/cancelled), 'cancel' (cancel a post by ID).",
          },
          id: {
            type: "number",
            description: "Post ID to cancel (required for action='cancel').",
          },
        },
      },
    },
    handler: async (args, ctx) => {
      try {
        const scheduler = getLinkedInScheduler(ctx);
        if (!scheduler) return err("LinkedIn not configured.");

        const action = (args.action as string) || "list";

        if (action === "cancel") {
          const id = args.id as number;
          if (!id) return err("Provide an ID to cancel.");
          const cancelled = scheduler.cancel(id);
          return cancelled
            ? text(`Cancelled scheduled post #${id}.`)
            : err(`Post #${id} not found or already posted/cancelled.`);
        }

        const posts = scheduler.getQueue(action === "all");
        if (posts.length === 0) {
          return text("No scheduled LinkedIn posts.");
        }

        const formatted = posts
          .map(
            (p) =>
              `**#${p.id}** [${p.status}] ${p.scheduledAt} UTC\n  ${p.mediaType} · "${p.text.slice(0, 80)}..."` +
              (p.postUrn ? `\n  URN: ${p.postUrn}` : "") +
              (p.error ? `\n  Error: ${p.error}` : "")
          )
          .join("\n\n");
        return text(`**LinkedIn Queue (${posts.length}):**\n\n${formatted}`);
      } catch (e: unknown) {
        return err(`LinkedIn queue failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "linkedin_monitor",
      description:
        "View tracked LinkedIn posts and their comment counts. Posts are auto-tracked when created. " +
        "Use action='check' to manually poll for new comments now.",
      inputSchema: {
        type: "object" as const,
        properties: {
          action: {
            type: "string",
            enum: ["list", "check"],
            description: "Action: 'list' shows tracked posts (default), 'check' polls for new comments now.",
          },
        },
      },
    },
    handler: async (args, ctx) => {
      try {
        const monitor = getLinkedInMonitor(ctx);
        if (!monitor) return err("LinkedIn not configured or monitor unavailable.");

        const action = (args.action as string) || "list";

        if (action === "check") {
          const newComments = await monitor.pollOnce();
          if (newComments.length === 0) {
            return text("No new comments found on tracked posts.");
          }
          const formatted = newComments
            .map(
              (c) => `**${c.authorName}** on "${c.postText}...":\n  ${c.text}`
            )
            .join("\n\n");
          return text(`Found ${newComments.length} new comment(s):\n\n${formatted}`);
        }

        // Default: list tracked posts
        const posts = monitor.getTrackedPosts();
        if (posts.length === 0) {
          return text("No LinkedIn posts being tracked. Posts are auto-tracked when you create them.");
        }

        const formatted = posts
          .map(
            (p, i) =>
              `**${i + 1}.** ${p.text}...\n  URN: \`${p.postUrn}\`\n  Likes: ${p.likeCount} · Comments: ${p.commentCount} · Last checked: ${p.lastChecked || "never"}`
          )
          .join("\n\n");
        return text(`**Tracked LinkedIn posts (${posts.length}):**\n\n${formatted}`);
      } catch (e: unknown) {
        return err(`LinkedIn monitor failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "linkedin_analytics",
      description:
        "Show engagement analytics for your LinkedIn posts — likes, comments, and top performing content.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    handler: async (_args, ctx) => {
      try {
        const monitor = getLinkedInMonitor(ctx);
        if (!monitor) return err("LinkedIn not configured.");

        const posts = monitor.getTrackedPosts();
        if (posts.length === 0) {
          return text("No tracked posts yet. Post something first!");
        }

        const totalLikes = posts.reduce((sum, p) => sum + p.likeCount, 0);
        const totalComments = posts.reduce((sum, p) => sum + p.commentCount, 0);
        const sorted = [...posts].sort((a, b) => (b.likeCount + b.commentCount) - (a.likeCount + a.commentCount));
        const topPost = sorted[0];

        let output = `**LinkedIn Analytics (${posts.length} posts tracked)**\n\n`;
        output += `Total: **${totalLikes}** likes · **${totalComments}** comments\n`;
        output += `Avg per post: **${(totalLikes / posts.length).toFixed(1)}** likes · **${(totalComments / posts.length).toFixed(1)}** comments\n\n`;

        if (topPost) {
          output += `**Top post:** "${topPost.text}..."\n`;
          output += `  ${topPost.likeCount} likes · ${topPost.commentCount} comments\n\n`;
        }

        output += `**All posts:**\n`;
        for (const p of sorted) {
          output += `- ${p.likeCount} likes · ${p.commentCount} comments — "${p.text.slice(0, 60)}..."\n`;
        }

        return text(output);
      } catch (e: unknown) {
        return err(`LinkedIn analytics failed: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "linkedin_status",
      description:
        "Check LinkedIn authentication status — whether connected, who is connected, and token expiry.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    handler: async (_args, ctx) => {
      try {
        const client = getLinkedInClient(ctx);
        const status = client.getStatus();

        if (!status.authenticated) {
          return text("LinkedIn: **Not connected**. Use `linkedin_auth` to connect.");
        }

        const expiresIn = status.expiresAt
          ? Math.max(0, Math.round((status.expiresAt - Date.now()) / (1000 * 60 * 60 * 24)))
          : "unknown";

        return text(
          `LinkedIn: **Connected**\n` +
          `Name: ${status.name || "Unknown"}\n` +
          `URN: ${status.personUrn || "Unknown"}\n` +
          `Token expires in: ~${expiresIn} days`
        );
      } catch (e: unknown) {
        return err(`LinkedIn status check failed: ${errorMessage(e)}`);
      }
    },
  },

  // ─── Twitter/X Tools ──────────────────────────────────────────────────────

  {
    definition: {
      name: "twitter_auth",
      description: "Login to Twitter/X using credentials from config.json. Caches session cookies for reuse. Owner only.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    handler: async (_args: unknown, ctx: PluginContext) => {
      try {
        const twitterConfig = getTwitterConfig(ctx);
        const client = getTwitterClient();
        const result = await client.login(twitterConfig);
        return text(`Twitter: ${result}`);
      } catch (e: unknown) {
        return err(`Twitter auth failed: ${errorMessage(e)}`);
      }
    },
  },

  {
    definition: {
      name: "twitter_post",
      description: "Post a tweet to the connected X account.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "Tweet text (max 280 chars)" },
        },
        required: ["text"],
      },
    },
    handler: async (args: Record<string, unknown>, _ctx: PluginContext) => {
      try {
        const client = getTwitterClient();
        const result = await withRetry(
          () => client.postTweet(args.text as string),
          { label: "twitter_post", maxAttempts: 2 },
        );
        return text(`Tweet posted!\nURL: ${result.url}\nID: ${result.id}`);
      } catch (e: unknown) {
        return err(`Tweet failed: ${errorMessage(e)}`);
      }
    },
  },

  {
    definition: {
      name: "twitter_post_image",
      description: "Post a tweet with an image to the connected X account.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "Tweet text (max 280 chars)" },
          image: { type: "string", description: "Absolute file path to image (PNG/JPG/GIF)" },
        },
        required: ["text", "image"],
      },
    },
    handler: async (args: Record<string, unknown>, _ctx: PluginContext) => {
      try {
        const client = getTwitterClient();
        const result = await withRetry(
          () => client.postTweetWithMedia(args.text as string, args.image as string),
          { label: "twitter_post_image", maxAttempts: 2 },
        );
        return text(`Tweet with image posted!\nURL: ${result.url}\nID: ${result.id}`);
      } catch (e: unknown) {
        return err(`Tweet with image failed: ${errorMessage(e)}`);
      }
    },
  },

  {
    definition: {
      name: "twitter_thread",
      description: "Post a thread (multiple chained tweets) to the connected X account.",
      inputSchema: {
        type: "object" as const,
        properties: {
          tweets: {
            type: "array",
            items: { type: "string" },
            description: "Array of tweet texts, posted in order as a thread",
          },
        },
        required: ["tweets"],
      },
    },
    handler: async (args: Record<string, unknown>, _ctx: PluginContext) => {
      try {
        const client = getTwitterClient();
        const results = await client.postThread(args.tweets as string[]);
        const summary = results
          .map((r, i) => `${i + 1}. ${r.url}`)
          .join("\n");
        return text(`Thread posted! (${results.length} tweets)\n${summary}`);
      } catch (e: unknown) {
        return err(`Thread failed: ${errorMessage(e)}`);
      }
    },
  },

  {
    definition: {
      name: "twitter_status",
      description: "Check Twitter/X authentication status.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    handler: async (_args: unknown, _ctx: PluginContext) => {
      try {
        const client = getTwitterClient();
        const status = client.getStatus();

        if (!status.authenticated) {
          return text("Twitter: **Not connected**\n\nRun `twitter_auth` to login.");
        }

        return text(
          `Twitter: **Connected**\n` +
          `Username: @${status.username || "unknown"}\n` +
          `Session: cookie-based (no expiry)`
        );
      } catch (e: unknown) {
        return err(`Twitter status check failed: ${errorMessage(e)}`);
      }
    },
  },
];
