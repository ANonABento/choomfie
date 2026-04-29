import type { ToolDef } from "@choomfie/shared";
import { dateToSQLite, err, parseNaturalTime, text } from "@choomfie/shared";
import { getLinkedInClient, getLinkedInMonitor, getLinkedInScheduler } from "./linkedin-runtime.ts";
import { validateLinkedInText } from "./linkedin-tool-helpers.ts";

export const linkedinOpsTools: ToolDef[] = [
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
        const validationError = validateLinkedInText(postText);
        if (validationError) return err(validationError);

        const timeStr = args.time as string;
        let scheduledAt: string;

        const parsed = parseNaturalTime(timeStr);
        if (parsed) {
          scheduledAt = dateToSQLite(parsed);
        } else if (/^\d{4}-\d{2}-\d{2}/.test(timeStr)) {
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
          (post.firstComment ? `\nFirst comment: "${post.firstComment}"` : ""),
        );
      } catch (e: any) {
        return err(`LinkedIn schedule failed: ${e.message}`);
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
            (post) =>
              `**#${post.id}** [${post.status}] ${post.scheduledAt} UTC\n  ${post.mediaType} · "${post.text.slice(0, 80)}..."` +
              (post.postUrn ? `\n  URN: ${post.postUrn}` : "") +
              (post.error ? `\n  Error: ${post.error}` : ""),
          )
          .join("\n\n");
        return text(`**LinkedIn Queue (${posts.length}):**\n\n${formatted}`);
      } catch (e: any) {
        return err(`LinkedIn queue failed: ${e.message}`);
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
            .map((comment) => `**${comment.authorName}** on "${comment.postText}...":\n  ${comment.text}`)
            .join("\n\n");
          return text(`Found ${newComments.length} new comment(s):\n\n${formatted}`);
        }

        const posts = monitor.getTrackedPosts();
        if (posts.length === 0) {
          return text("No LinkedIn posts being tracked. Posts are auto-tracked when you create them.");
        }

        const formatted = posts
          .map(
            (post, i) =>
              `**${i + 1}.** ${post.text}...\n  URN: \`${post.postUrn}\`\n  Likes: ${post.likeCount} · Comments: ${post.commentCount} · Last checked: ${post.lastChecked || "never"}`,
          )
          .join("\n\n");
        return text(`**Tracked LinkedIn posts (${posts.length}):**\n\n${formatted}`);
      } catch (e: any) {
        return err(`LinkedIn monitor failed: ${e.message}`);
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

        const totalLikes = posts.reduce((sum, post) => sum + post.likeCount, 0);
        const totalComments = posts.reduce((sum, post) => sum + post.commentCount, 0);
        const sorted = [...posts].sort(
          (a, b) => (b.likeCount + b.commentCount) - (a.likeCount + a.commentCount),
        );
        const topPost = sorted[0];

        let output = `**LinkedIn Analytics (${posts.length} posts tracked)**\n\n`;
        output += `Total: **${totalLikes}** likes · **${totalComments}** comments\n`;
        output += `Avg per post: **${(totalLikes / posts.length).toFixed(1)}** likes · **${(totalComments / posts.length).toFixed(1)}** comments\n\n`;

        if (topPost) {
          output += `**Top post:** "${topPost.text}..."\n`;
          output += `  ${topPost.likeCount} likes · ${topPost.commentCount} comments\n\n`;
        }

        output += "**All posts:**\n";
        for (const post of sorted) {
          output += `- ${post.likeCount} likes · ${post.commentCount} comments — "${post.text.slice(0, 60)}..."\n`;
        }

        return text(output);
      } catch (e: any) {
        return err(`LinkedIn analytics failed: ${e.message}`);
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
          `Token expires in: ~${expiresIn} days`,
        );
      } catch (e: any) {
        return err(`LinkedIn status check failed: ${e.message}`);
      }
    },
  },
];
