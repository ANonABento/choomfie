/**
 * `/choomfie <prompt>` and the "Ask Choomfie" message menu — Choomfie in chats the
 * bot isn't in.
 *
 * Both are user-installable (Developer Portal → Installation → User Install),
 * so the owner can use them in group DMs and other people's DMs, where a bot
 * can't be added. There Choomfie only sees the command or the one message
 * right-clicked — never the chat — and can only answer through the
 * interaction, for 15 minutes (see ask-relay.ts).
 *
 * Same gates as a typed message: allowlist, rate limit, then the chat's brain
 * (`/brain` works in a group DM too) under brainAccess.
 */

import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type MessageContextMenuCommandInteraction,
} from "discord.js";
import { ANYWHERE } from "@choomfie/shared";
import { isAllowed, isOwner } from "../access.ts";
import { decideRoute, dispatchToBrain, parentChannelId } from "../brain-router.ts";
import { isRateLimited } from "../conversation.ts";
import { downloadAttachments, forwardToClaude, type AttachmentLike } from "../inbound.ts";
import {
  ASK_NOTE,
  interactionChannel,
  openAskRelay,
  rememberBrainRelay,
} from "../ask-relay.ts";
import { registerCommand, registerMessageMenu } from "../register.ts";
import type { AppContext } from "../types.ts";

export const ASK_MENU_NAME = "Ask Choomfie";

type AskInteraction = ChatInputCommandInteraction | MessageContextMenuCommandInteraction;

export async function runAsk(
  interaction: AskInteraction,
  ctx: AppContext,
  prompt: string,
  attachments: AttachmentLike[],
  ephemeral: boolean
): Promise<void> {
  const userId = interaction.user.id;
  const refuse = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  if (!isAllowed(ctx, userId)) {
    await refuse("You're not on Choomfie's allowlist.");
    return;
  }
  if (isRateLimited(ctx.lastMessageTime, userId, ctx.config.getRateLimitMs())) {
    await refuse("Slow down a sec~");
    return;
  }

  const owner = isOwner(ctx, userId) || (!ctx.ownerUserId && ctx.allowedUsers.size === 0);
  const chatKey = interaction.channelId;
  const route = decideRoute({
    channelId: chatKey,
    parentId: parentChannelId(interaction.channel),
    isOwner: owner,
    isConversationMode: false,
    access: ctx.config.getBrainAccess(),
    channelBrain: (id) => ctx.config.getChannelBrain(id),
  });
  if (route.kind === "unavailable") {
    await refuse(`The \`${route.brainId}\` brain isn't loaded right now. \`/brain claude\` to switch back.`);
    return;
  }

  // Shows "Choomfie is thinking…"; the answer replaces it.
  await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
  const relay = interactionChannel(interaction, { ephemeral });

  const meta: Record<string, string> = {
    message_id: interaction.id,
    user: interaction.user.username,
    user_id: userId,
    ts: interaction.createdAt.toISOString(),
    is_dm: interaction.guildId ? "false" : "true",
    role: owner ? "owner" : "user",
    via: "ask",
  };
  const filePaths = await downloadAttachments(ctx, attachments, meta);
  const content = prompt.trim() || "(empty prompt)";

  if (route.kind === "brain") {
    meta.chat_id = chatKey;
    // Late results (background jobs) can still land here while the window is open.
    rememberBrainRelay(chatKey, relay);
    void dispatchToBrain(ctx, route.brain, relay, { chatKey, messageId: interaction.id, content, meta, filePaths });
    return;
  }

  meta.chat_id = openAskRelay(interaction.id, relay);
  await forwardToClaude(ctx, `${ASK_NOTE}\n${content}`, meta);
}

/** The prompt for a right-clicked message: who said it, and what. */
export function menuPrompt(author: string, text: string, attachmentCount: number): string {
  const body = text.trim() || (attachmentCount ? "(attachments only)" : "(empty message)");
  return `${author} said:\n${body}`;
}

registerCommand("choomfie", {
  data: {
    ...new SlashCommandBuilder()
      .setName("choomfie")
      .setDescription("Ask Choomfie anything — works in group DMs too")
      .addStringOption((o) =>
        o.setName("prompt").setDescription("What to ask").setRequired(true).setMaxLength(4000)
      )
      .addAttachmentOption((o) => o.setName("file").setDescription("Something to look at"))
      .addBooleanOption((o) =>
        o.setName("private").setDescription("Only you see the answer (default: everyone in the chat)")
      )
      .toJSON(),
    ...ANYWHERE,
  },
  handler: async (interaction, ctx) => {
    const file = interaction.options.getAttachment("file");
    await runAsk(
      interaction,
      ctx,
      interaction.options.getString("prompt", true),
      file ? [file] : [],
      interaction.options.getBoolean("private") ?? false
    );
  },
});

registerMessageMenu(ASK_MENU_NAME, {
  data: {
    ...new ContextMenuCommandBuilder()
      .setName(ASK_MENU_NAME)
      .setType(ApplicationCommandType.Message)
      .toJSON(),
    ...ANYWHERE,
  },
  handler: async (interaction, ctx) => {
    const m = interaction.targetMessage;
    await runAsk(
      interaction,
      ctx,
      menuPrompt(m.author.username, m.content, m.attachments.size),
      [...m.attachments.values()],
      false
    );
  },
});
