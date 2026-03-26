/**
 * Discord client — creation, event handlers (Ready, MessageCreate).
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import type { AppContext } from "./types.ts";
import { saveAccess } from "./context.ts";
import { ReminderScheduler } from "./reminders.ts";
import {
  isChannelActive,
  activateChannel,
  refreshChannel,
  isRateLimited,
} from "./conversation.ts";

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

function generatePairingCode(): string {
  const chars = "abcdefghjkmnopqrstuvwxyz"; // no 'i' or 'l'
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export function createDiscordClient(ctx: AppContext): Client {
  // Merge core intents with plugin intents
  const pluginIntents = ctx.plugins.flatMap((p) => p.intents ?? []);

  const discord = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      ...pluginIntents,
    ],
    partials: [
      Partials.Channel, // Required for DM support
      Partials.Message,
    ],
  });

  discord.once(Events.ClientReady, async (c) => {
    console.error(`Choomfie Discord: logged in as ${c.user.tag}`);
    ctx.startedAt = Date.now();

    // Fallback: auto-detect owner if not set during setup
    if (!ctx.ownerUserId) {
      try {
        const app = await c.application.fetch();
        const appOwner = app.owner;
        if (appOwner) {
          ctx.ownerUserId = appOwner.id;
          ctx.allowedUsers.add(appOwner.id);
          await saveAccess(ctx);
          console.error(
            `Choomfie: auto-detected owner from Discord app: ${appOwner.id}`
          );
        }
      } catch {
        console.error(
          "Choomfie: no owner set — run /choomfie:access owner <USER_ID>"
        );
      }
    }

    // Initialize timer-based reminder scheduler
    ctx.reminderScheduler = new ReminderScheduler();
    ctx.reminderScheduler.init(ctx);

    // Start inbox cleanup (every hour, delete files older than 24h)
    const cleanInbox = async () => {
      const inboxDir = `${ctx.DATA_DIR}/inbox`;
      try {
        const files = await readdir(inboxDir);
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        for (const file of files) {
          const filePath = `${inboxDir}/${file}`;
          const info = await stat(filePath);
          if (info.mtimeMs < cutoff) {
            await unlink(filePath);
          }
        }
      } catch {
        // inbox dir doesn't exist yet, that's fine
      }
    };
    setInterval(cleanInbox, 60 * 60 * 1000);
    cleanInbox(); // Run on startup

    // Initialize plugins
    for (const plugin of ctx.plugins) {
      if (plugin.init) {
        try {
          await plugin.init(ctx);
          console.error(`Plugin initialized: ${plugin.name}`);
        } catch (e) {
          console.error(`Plugin ${plugin.name} init failed: ${e}`);
        }
      }
    }
  });

  discord.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;

    // Plugin message hooks (run before default handler)
    for (const plugin of ctx.plugins) {
      if (plugin.onMessage) {
        try {
          await plugin.onMessage(message, ctx);
        } catch (e) {
          console.error(`Plugin ${plugin.name} onMessage error: ${e}`);
        }
      }
    }

    const userId = message.author.id;
    const isDM = !message.guild;

    // Track message stats
    ctx.messageStats.received++;
    ctx.messageStats.byUser.set(
      userId,
      (ctx.messageStats.byUser.get(userId) || 0) + 1
    );

    // Handle permission replies before anything else (no rate limit)
    const canApprovePermissions = ctx.ownerUserId
      ? userId === ctx.ownerUserId
      : ctx.allowedUsers.has(userId);
    const permMatch = PERMISSION_REPLY_RE.exec(message.content);
    if (permMatch && canApprovePermissions) {
      ctx.mcp.notification({
        method: "notifications/claude/channel/permission" as any,
        params: {
          request_id: permMatch[2].toLowerCase(),
          behavior: permMatch[1].toLowerCase().startsWith("y")
            ? "allow"
            : "deny",
        },
      });
      await message.react("\u2705");
      return;
    }

    // Handle pairing requests (DMs only, no rate limit)
    if (message.content.startsWith("!pair") && isDM) {
      const code = generatePairingCode();
      ctx.pendingPairings.set(code, {
        userId,
        username: message.author.username,
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 min
      });
      await message.reply(
        `Your pairing code is: \`${code}\`\nRun \`/choomfie:access pair ${code}\` in Claude Code within 5 minutes.`
      );
      return;
    }

    // --- Trigger rules ---
    // DMs: always respond
    // Servers: only when @mentioned or replying to the bot
    let replyToUserId: string | null = null;
    if (!isDM) {
      const isMentioned = message.mentions.has(discord.user!.id);
      // Resolve who this message is replying to (if anyone)
      let isReplyToBot = false;
      if (message.reference?.messageId) {
        try {
          const refMsg = await message.channel.messages.fetch(message.reference.messageId);
          replyToUserId = refMsg.author.id;
          isReplyToBot = refMsg.author.id === discord.user!.id;
        } catch {}
      }
      const convoTimeout = ctx.config.getConvoTimeoutMs();
      const channelActive = isChannelActive(
        ctx.activeChannels,
        message.channelId,
        convoTimeout
      );

      if (!isMentioned && !isReplyToBot && !channelActive) return;

      // Activate channel on @mention or reply; refresh on ongoing conversation
      if (isMentioned || isReplyToBot) {
        activateChannel(ctx.activeChannels, message.channelId);
      } else if (channelActive) {
        refreshChannel(ctx.activeChannels, message.channelId);
      }
    }

    // Only forward messages from allowlisted users
    // (bootstrap mode: accept all if no users allowlisted yet)
    // Note: !pair handler above is intentionally before this check
    if (!ctx.allowedUsers.has(userId)) {
      if (ctx.allowedUsers.size > 0) return;
    }

    // Rate limit check
    if (
      isRateLimited(
        ctx.lastMessageTime,
        userId,
        ctx.config.getRateLimitMs()
      )
    )
      return;

    // Build metadata
    const isMentionedHere =
      !isDM && message.mentions.has(discord.user!.id);
    const isOwner = ctx.ownerUserId
      ? userId === ctx.ownerUserId
      : ctx.allowedUsers.size === 0;
    const meta: Record<string, string> = {
      chat_id: message.channelId,
      message_id: message.id,
      user: message.author.username,
      user_id: userId,
      ts: message.createdAt.toISOString(),
      is_dm: message.guild ? "false" : "true",
      role: isOwner ? "owner" : "user",
    };

    // Mark conversation mode messages
    if (
      !isDM &&
      !isMentionedHere &&
      isChannelActive(ctx.activeChannels, message.channelId, ctx.config.getConvoTimeoutMs())
    ) {
      meta.conversation_mode = "true";
    }

    // Tag who this message is replying to (helps Claude decide whether to butt in)
    if (replyToUserId) {
      meta.reply_to_user = replyToUserId;
    }

    // Handle image/file attachments
    if (message.attachments.size > 0) {
      meta.attachment_count = String(message.attachments.size);
      const descriptions: string[] = [];
      const filePaths: string[] = [];
      const downloadDir = `${ctx.DATA_DIR}/inbox`;
      await mkdir(downloadDir, { recursive: true });

      for (const [, attachment] of message.attachments) {
        descriptions.push(
          `${attachment.name} (${attachment.contentType || "unknown"}, ${Math.round((attachment.size || 0) / 1024)}KB)`
        );

        try {
          const response = await fetch(attachment.url);
          const buffer = await response.arrayBuffer();
          const filePath = `${downloadDir}/${Date.now()}_${attachment.name}`;
          await Bun.write(filePath, buffer);
          filePaths.push(filePath);
        } catch {
          // Download failed, Claude will just see the description
        }
      }
      meta.attachments = descriptions.join("; ");
      // Pass first path as file_path for backwards compat, all paths as file_paths
      if (filePaths.length > 0) meta.file_path = filePaths[0];
      if (filePaths.length > 1) meta.file_paths = filePaths.join(";");
    }

    // Show typing indicator while Claude processes
    // Skip for conversation_mode — Claude may choose not to reply, leaving typing stuck
    const isConversationMode = meta.conversation_mode === "true";
    if (!isConversationMode) {
      try {
        // Clear any existing typing state for this channel
        const existingInterval = ctx.typingIntervals.get(message.channelId);
        if (existingInterval) clearInterval(existingInterval);
        const pendingClear = ctx.typingClearTimeouts.get(message.channelId);
        if (pendingClear) {
          clearTimeout(pendingClear);
          ctx.typingClearTimeouts.delete(message.channelId);
        }

        // Send initial typing indicator
        if (message.channel.isTextBased() && "sendTyping" in message.channel) {
          await message.channel.sendTyping();
        }
        // Keep refreshing every 8s (Discord typing indicator lasts ~10s)
        // Safety: auto-clear after 2 minutes to prevent leaks if Claude never replies
        const channelId = message.channelId;
        const typingInterval = setInterval(async () => {
          try {
            if (message.channel.isTextBased() && "sendTyping" in message.channel) {
              await message.channel.sendTyping();
            }
          } catch {
            clearInterval(typingInterval);
            ctx.typingIntervals.delete(channelId);
          }
        }, 8_000);
        ctx.typingIntervals.set(channelId, typingInterval);

        // Auto-clear typing after 2 minutes (safety fallback)
        const clearTimeout_ = setTimeout(() => {
          if (ctx.typingIntervals.get(channelId) === typingInterval) {
            clearInterval(typingInterval);
            ctx.typingIntervals.delete(channelId);
          }
          ctx.typingClearTimeouts.delete(channelId);
        }, 120_000);
        ctx.typingClearTimeouts.set(channelId, clearTimeout_);
      } catch {
        // Typing indicator is best-effort, don't block message handling
      }
    }

    // Strip bot @mention from the message so Claude sees clean text
    const cleanContent = message.content
      .replace(new RegExp(`<@!?${discord.user!.id}>`, "g"), "")
      .trim();

    // Forward to Claude Code
    ctx.mcp.notification({
      method: "notifications/claude/channel" as any,
      params: {
        content:
          cleanContent ||
          "(empty message — user may have just mentioned you)",
        meta,
      },
    });
  });

  return discord;
}
