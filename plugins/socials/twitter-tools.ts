import type { PluginContext, ToolDef } from "@choomfie/shared";
import { err, errorMessage, text } from "@choomfie/shared";
import { withRetry } from "./providers/retry.ts";
import { TwitterClient } from "./providers/twitter/api.ts";

let twitterClient: TwitterClient | null = null;

function getTwitterClient(): TwitterClient {
  if (twitterClient) return twitterClient;
  twitterClient = new TwitterClient();
  return twitterClient;
}

function getTwitterConfig(ctx: PluginContext): { username: string; password: string; email: string } {
  const config = ctx.config.getConfig();
  const socialsConfig = config.socials?.twitter;

  if (!socialsConfig?.username || !socialsConfig?.password || !socialsConfig?.email) {
    throw new Error(
      "Twitter not configured. Add to config.json:\n" +
      '  "socials": { "twitter": { "username": "...", "password": "...", "email": "..." } }',
    );
  }

  return {
    username: socialsConfig.username as string,
    password: socialsConfig.password as string,
    email: socialsConfig.email as string,
  };
}

export function destroyTwitterClient(): void {
  if (twitterClient) {
    twitterClient.destroy();
    twitterClient = null;
  }
}

export const twitterTools: ToolDef[] = [
  {
    definition: {
      name: "twitter_auth",
      description: "Login to Twitter/X using credentials from config.json. Caches session cookies for reuse. Owner only.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    handler: async (_args, ctx) => {
      try {
        const twitterConfig = getTwitterConfig(ctx);
        const client = getTwitterClient();
        const result = await client.login(twitterConfig);
        return text(`Twitter: ${result}`);
      } catch (error: unknown) {
        return err(`Twitter auth failed: ${errorMessage(error)}`);
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
    handler: async (args) => {
      try {
        const client = getTwitterClient();
        const result = await withRetry(
          () => client.postTweet(args.text as string),
          { label: "twitter_post", maxAttempts: 2 },
        );
        return text(`Tweet posted!\nURL: ${result.url}\nID: ${result.id}`);
      } catch (error: unknown) {
        return err(`Tweet failed: ${errorMessage(error)}`);
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
    handler: async (args) => {
      try {
        const client = getTwitterClient();
        const result = await withRetry(
          () => client.postTweetWithMedia(args.text as string, args.image as string),
          { label: "twitter_post_image", maxAttempts: 2 },
        );
        return text(`Tweet with image posted!\nURL: ${result.url}\nID: ${result.id}`);
      } catch (error: unknown) {
        return err(`Tweet with image failed: ${errorMessage(error)}`);
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
    handler: async (args) => {
      try {
        const client = getTwitterClient();
        const tweets = Array.isArray(args.tweets) ? args.tweets.map(String) : [];
        const results = await client.postThread(tweets);
        const summary = results.map((result, i) => `${i + 1}. ${result.url}`).join("\n");
        return text(`Thread posted! (${results.length} tweets)\n${summary}`);
      } catch (error: unknown) {
        return err(`Thread failed: ${errorMessage(error)}`);
      }
    },
  },
  {
    definition: {
      name: "twitter_status",
      description: "Check Twitter/X authentication status.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    handler: async () => {
      try {
        const client = getTwitterClient();
        const status = client.getStatus();

        if (!status.authenticated) {
          return text("Twitter: **Not connected**\n\nRun `twitter_auth` to login.");
        }

        return text(
          `Twitter: **Connected**\n` +
          `Username: @${status.username || "unknown"}\n` +
          "Session: cookie-based (no expiry)",
        );
      } catch (error: unknown) {
        return err(`Twitter status check failed: ${errorMessage(error)}`);
      }
    },
  },
];
