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
import { readdir, stat, unlink } from "node:fs/promises";
import { handleInteraction, getCommandDefs } from "./interactions.ts";
import type { AppContext } from "./types.ts";
import { saveAccess } from "./context.ts";
import { onMessageReceived } from "./typing.ts";
import {
  isChannelActive,
  activateChannel,
  refreshChannel,
  isRateLimited,
} from "./conversation.ts";
import { clearGuildCommands, deployGlobalCommands } from "./command-deploy.ts";
import { isAllowed, isOwner } from "./access.ts";
import {
  errorMessage,
  type McpTransport,
  type NotificationMessage,
} from "@choomfie/shared";
import { downloadAttachments, forwardToClaude } from "./inbound.ts";
import { decideRoute, dispatchToBrain, installBrainPoster, parentChannelId } from "./brain-router.ts";
import { isOwnThread, openThread, wantsThread } from "./chats/auto-thread.ts";
import { replyExcerpt, replyPrompt, repliesToLatest } from "./ask-relay.ts";
import {
  dispatchPluginMessage,
  initializePlugins,
} from "./plugin-lifecycle.ts";

/** How far past a replied-to bot message to look for a newer answer. */
const QUOTE_LOOKAHEAD = 20;

/** Channels already told that auto-thread lacks permission (once per worker). */
const threadWarned = new Set<string>();

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

function notifyMcp(ctx: AppContext, message: NotificationMessage): void {
  (ctx.mcp as McpTransport).notification?.(message);
}

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
    const initDone = () => { ctx._discordReadyResolve?.(); };

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
    ctx.reminderScheduler.init(ctx);
    ctx.birthdayScheduler.init(ctx);

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
    // Clear previous interval if restarting, then start fresh
    if (ctx._inboxInterval) clearInterval(ctx._inboxInterval);
    ctx._inboxInterval = setInterval(cleanInbox, 60 * 60 * 1000);
    cleanInbox(); // Run on startup

    // Brains may post late results (background jobs) — give them the poster first.
    installBrainPoster(ctx);

    // Initialize plugins
    await initializePlugins(ctx.plugins, ctx);

    // Auto-deploy slash commands if they've changed.
    //
    // "global:" tags the hash with the deployment scope, so an install that
    // previously deployed guild-scoped commands sees a changed hash on first
    // boot after the switch and redeploys — no manual migration step.
    try {
      const commands = getCommandDefs();
      const hash = `global:${Bun.hash(JSON.stringify(commands)).toString(36)}`;
      const hashFile = `${ctx.DATA_DIR}/.commands-hash`;
      let lastHash = "";
      try { lastHash = await Bun.file(hashFile).text(); } catch {}

      if (hash !== lastHash.trim()) {
        const { REST } = await import("discord.js");
        const rest = new REST().setToken(ctx.discord.token!);
        const appId = c.application.id;
        await deployGlobalCommands(rest, appId, commands);
        // Guild-scoped commands shadow global ones of the same name, so a
        // leftover copy from before the switch would pin that guild to an old
        // definition forever. Cheap and idempotent, so just always do it.
        const cleared = await clearGuildCommands(rest, appId, c.guilds.cache.keys());
        await Bun.write(hashFile, hash);
        console.error(
          `Slash commands deployed globally (${commands.length} commands` +
            `${cleared > 0 ? `, cleared guild-scoped copies in ${cleared} guild(s)` : ""})`,
        );
      }
    } catch (e) {
      console.error(`Slash command auto-deploy failed: ${errorMessage(e)}`);
    }

    initDone();
  });

  discord.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;

    // Plugin message hooks (run before default handler)
    await dispatchPluginMessage(ctx.plugins, message, ctx);

    const userId = message.author.id;
    const isDM = !message.guild;

    // Track message stats
    ctx.messageStats.received++;
    ctx.messageStats.byUser.set(
      userId,
      (ctx.messageStats.byUser.get(userId) || 0) + 1
    );

    // Handle permission replies before anything else (no rate limit).
    // isOwner returns false when ownerUserId is null — fail closed in
    // bootstrap mode so no allowlisted user can approve tool calls.
    const permMatch = PERMISSION_REPLY_RE.exec(message.content);
    if (permMatch && isOwner(ctx, userId)) {
      notifyMcp(ctx, {
        method: "notifications/claude/channel/permission",
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
    // DMs and threads Choomfie opened: always respond
    // Servers: only when @mentioned or replying to the bot
    const botId = discord.user!.id;
    const ownThread = isOwnThread(message.channel as never, botId);
    // An @mention in a text channel moves the conversation into a new thread.
    const threadIt = wantsThread(message, botId, ctx.config.getAutoThread(message.channelId));
    // The message this one replies to (a forward points at another channel, so skip it).
    const ref = message.reference;
    const repliedTo =
      ref?.messageId && ref.channelId === message.channelId
        ? await message.channel.messages.fetch(ref.messageId).catch(() => null)
        : null;
    const replyToUserId = repliedTo?.author.id ?? null;
    const isReplyToBot = replyToUserId === botId;
    if (!isDM && !ownThread) {
      const isMentioned = message.mentions.has(discord.user!.id);
      const convoTimeout = ctx.config.getConvoTimeoutMs();
      const channelActive = isChannelActive(
        ctx.activeChannels,
        message.channelId,
        convoTimeout
      );

      if (!isMentioned && !isReplyToBot && !channelActive) return;

      // Activate channel on @mention or reply; refresh on ongoing conversation.
      // Not when the answer goes to a new thread — the channel itself stays quiet.
      if (threadIt) {
        // nothing to follow here
      } else if (isMentioned || isReplyToBot) {
        activateChannel(ctx.activeChannels, message.channelId);
      } else if (channelActive) {
        refreshChannel(ctx.activeChannels, message.channelId);
      }
    }

    // Only forward messages from allowlisted users
    // (bootstrap mode: accept all if no users allowlisted yet)
    // Note: !pair handler above is intentionally before this check
    if (!isAllowed(ctx, userId)) return;

    const owner = isOwner(ctx, userId) || (!ctx.ownerUserId && ctx.allowedUsers.size === 0);

    // Rate limit (anti-spam): not for the owner, who runs several chats at
    // once — two quick pings used to silently drop the second. Anyone else
    // sees a ⏳ rather than nothing.
    if (!owner && isRateLimited(ctx.lastMessageTime, userId, ctx.config.getRateLimitMs())) {
      await message.react("\u23f3").catch(() => {});
      return;
    }

    // Build metadata
    const isMentionedHere =
      !isDM && message.mentions.has(discord.user!.id);
    const meta: Record<string, string> = {
      chat_id: message.channelId,
      message_id: message.id,
      user: message.author.username,
      user_id: userId,
      ts: message.createdAt.toISOString(),
      is_dm: message.guild ? "false" : "true",
      role: owner ? "owner" : "user",
    };

    // Mark conversation mode messages
    if (
      !isDM &&
      !ownThread &&
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
    const filePaths = await downloadAttachments(ctx, message.attachments.values(), meta);

    const isConversationMode = meta.conversation_mode === "true";

    // Which brain answers here? Claude unless this channel was set otherwise
    // with /brain — and even then only for whoever brainAccess permits.
    const route = decideRoute({
      channelId: message.channelId,
      parentId: parentChannelId(message.channel),
      isOwner: owner,
      isConversationMode,
      access: ctx.config.getBrainAccess(),
      channelBrain: (id) => ctx.config.getChannelBrain(id),
    });
    if (route.kind === "ignore") return;
    if (route.kind === "unavailable") {
      await message
        .reply(`The \`${route.brainId}\` brain isn't loaded right now. \`/brain\` for details, or \`/brain claude\` to switch back.`)
        .catch(() => {});
      return;
    }

    // Auto-thread: answer (and keep the chat) in a new thread off the message.
    // Without permission, answer inline and say why once per channel.
    const thread = threadIt ? await openThread(message) : null;
    if (threadIt && !thread && !threadWarned.has(message.channelId)) {
      threadWarned.add(message.channelId);
      await message
        .reply(
          "I couldn't open a thread here (I need **Create Public Threads**), so I'll answer inline. " +
            "`/brain threads:false` turns threads off for this channel."
        )
        .catch(() => {});
    }
    const where = thread ?? message.channel;
    const whereId = thread?.id ?? message.channelId;
    meta.chat_id = whereId;

    // Show typing indicator while the brain processes (state machine in lib/typing.ts)
    onMessageReceived(whereId, where, isConversationMode);

    // Strip bot @mention from the message so Claude sees clean text
    const cleanContent = message.content
      .replace(new RegExp(`<@!?${botId}>`, "g"), "")
      .trim();

    const typed = cleanContent || "(empty message — user may have just mentioned you)";
    // Replying to one of the bot's older messages works like the 💬 Reply
    // button: that answer rides along. Not for its latest answer — the brain
    // just said it, so quoting it again only costs tokens.
    let content = typed;
    if (isReplyToBot && repliedTo) {
      const after = await message.channel.messages
        .fetch({ after: repliedTo.id, limit: QUOTE_LOOKAHEAD })
        .then((page) =>
          [...page.values()]
            .filter((m) => m.id !== message.id)
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .map((m) => ({ authorId: m.author.id }))
        )
        .catch(() => null);
      const latest = after ? repliesToLatest(after, botId, QUOTE_LOOKAHEAD - 1) : false;
      if (!latest) content = replyPrompt(replyExcerpt(repliedTo.content), typed);
    }

    if (route.kind === "brain") {
      void dispatchToBrain(ctx, route.brain, where as never, {
        chatKey: whereId,
        // The message sits in the parent channel; a reply can't point across.
        messageId: thread ? undefined : message.id,
        content,
        meta,
        filePaths,
      });
      return;
    }

    // Forward to Claude Code (MCP notification, or the daemon's file channel).
    await forwardToClaude(ctx, content, meta);
  });

  // Handle interactions (buttons, slash commands, modals)
  discord.on(Events.InteractionCreate, async (interaction) => {
    await handleInteraction(interaction, ctx);
  });

  return discord;
}
