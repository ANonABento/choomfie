/**
 * Social platform tools — YouTube search/info, Reddit browse/search.
 */

import type { ToolDef } from "../../lib/types.ts";
import { text, err } from "../../lib/types.ts";
import { getYouTubeProvider, getRedditProvider } from "./providers/index.ts";

const yt = getYouTubeProvider();
const reddit = getRedditProvider();

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
      } catch (e: any) {
        return err(`YouTube search failed: ${e.message}`);
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
      } catch (e: any) {
        return err(`YouTube info failed: ${e.message}`);
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
      } catch (e: any) {
        return err(`Transcript failed: ${e.message}`);
      }
    },
  },

  // --- Reddit ---
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
      } catch (e: any) {
        return err(`Reddit search failed: ${e.message}`);
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
      } catch (e: any) {
        return err(`Reddit posts failed: ${e.message}`);
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
      } catch (e: any) {
        return err(`Reddit comments failed: ${e.message}`);
      }
    },
  },
];
