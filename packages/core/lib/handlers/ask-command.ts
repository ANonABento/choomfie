/**
 * `/choomfie <prompt>` and the "Ask Choomfie" message menu — Choomfie in chats
 * the bot isn't in.
 *
 * Both are user-installable (Developer Portal → Installation → User Install),
 * so the owner can use them in group DMs and other people's DMs, where a bot
 * can't be added. There Choomfie only sees the command or the one message
 * right-clicked — never the chat — and can only answer through the
 * interaction, for 15 minutes (see ask-relay.ts).
 *
 * Keeping a conversation going there:
 * - every answer carries a stateless 💬 Reply button → a text box (plus an
 *   optional file upload) → a new ask that quotes the answer it replies to, so
 *   context survives a session cycle;
 * - the menu opens a text box for an optional instruction ("summarize this");
 * - the question is quoted above the answer, since nobody else sees a modal's
 *   text or which message was right-clicked.
 *
 * Same gates as a typed message: allowlist, rate limit, then the chat's brain
 * (`/brain` works in a group DM too) under brainAccess.
 */

import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  FileUploadBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { ANYWHERE } from "@choomfie/shared";
import { isAllowed, isOwner } from "../access.ts";
import { decideRoute, dispatchToBrain, parentChannelId } from "../brain-router.ts";
import { isRateLimited } from "../conversation.ts";
import { downloadAttachments, forwardToClaude, type AttachmentLike } from "../inbound.ts";
import {
  ASK_NOTE,
  NOT_ALLOWED,
  RELAY_WINDOW_MS,
  botIsAbsent,
  interactionChannel,
  openAskRelay,
  questionHeader,
  rememberBrainRelay,
  isLatestAnswer,
  replyExcerpt,
  replyPrompt,
} from "../ask-relay.ts";
import { registerButtonHandler, registerCommand, registerMessageMenu, registerModalHandler } from "../register.ts";
import type { AppContext } from "../types.ts";

export const ASK_MENU_NAME = "Ask Choomfie";

type AskInteraction =
  | ChatInputCommandInteraction
  | MessageContextMenuCommandInteraction
  | ModalSubmitInteraction;

export interface AskInput {
  prompt: string;
  attachments?: AttachmentLike[];
  ephemeral?: boolean;
  /** Quoted above the answer (the question as the chat should see it). */
  header?: string;
}

export async function runAsk(interaction: AskInteraction, ctx: AppContext, input: AskInput): Promise<void> {
  const userId = interaction.user.id;
  const refuse = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  if (!isAllowed(ctx, userId)) {
    await refuse(NOT_ALLOWED);
    return;
  }
  if (isRateLimited(ctx.lastMessageTime, userId, ctx.config.getRateLimitMs())) {
    await refuse("Slow down a sec~");
    return;
  }

  const owner = isOwner(ctx, userId) || (!ctx.ownerUserId && ctx.allowedUsers.size === 0);
  const chatKey = interaction.channelId!;
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

  const ephemeral = input.ephemeral ?? false;
  // Shows "Choomfie is thinking…"; the answer replaces it.
  await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
  const relay = interactionChannel(interaction, {
    ephemeral,
    header: input.header,
    // Where a normal reply can't reach Choomfie, give the chat a way to answer back.
    replyButton: botIsAbsent(interaction),
    chatKey,
  });

  const meta: Record<string, string> = {
    message_id: interaction.id,
    user: interaction.user.username,
    user_id: userId,
    ts: interaction.createdAt.toISOString(),
    is_dm: interaction.guildId ? "false" : "true",
    role: owner ? "owner" : "user",
    via: "ask",
  };
  const filePaths = await downloadAttachments(ctx, input.attachments ?? [], meta);
  const content = input.prompt.trim() || "(empty prompt)";

  if (route.kind === "brain") {
    meta.chat_id = chatKey;
    // Late results (background jobs) can still land here while the window is open.
    rememberBrainRelay(chatKey, relay);
    void dispatchToBrain(ctx, route.brain, relay, {
      chatKey,
      messageId: interaction.id,
      content,
      meta,
      filePaths,
      progress: (line) => relay.progress(line),
    });
    return;
  }

  meta.chat_id = openAskRelay(interaction.id, relay, chatKey);
  await forwardToClaude(ctx, `${ASK_NOTE}\n${content}`, meta, content, chatKey);
}

/** The prompt for a right-clicked message: who said it, what, and what to do with it. */
export function menuPrompt(author: string, text: string, attachmentCount: number, instruction = ""): string {
  const body = text.trim() || (attachmentCount ? "(attachments only)" : "(empty message)");
  const ask = instruction.trim();
  return `${ask ? `${ask}\n\n` : ""}${author} said:\n${body}`;
}

/** Discord's cap on files in one modal upload field. */
export const MODAL_MAX_FILES = 10;

/**
 * A text box plus an optional file upload, as the modal's two labelled fields.
 * Group DMs have no other way to hand Choomfie a file mid-conversation.
 */
export function askModal(customId: string, title: string, text: { label: string; required: boolean; placeholder: string }) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title.slice(0, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(text.label)
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("text")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(text.required)
            .setMaxLength(4000)
            .setPlaceholder(text.placeholder)
        ),
      new LabelBuilder()
        .setLabel("Attach files (optional)")
        .setFileUploadComponent(
          new FileUploadBuilder().setCustomId("files").setRequired(false).setMaxValues(MODAL_MAX_FILES)
        )
    );
}

/** Files uploaded in the modal, if the field was used. */
function uploadedFiles(interaction: ModalSubmitInteraction): AttachmentLike[] {
  try {
    return [...(interaction.fields.getUploadedFiles("files")?.values() ?? [])];
  } catch {
    return []; // field absent (an older modal still open across a restart)
  }
}

// --- /choomfie ---

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
    const prompt = interaction.options.getString("prompt", true);
    const file = interaction.options.getAttachment("file");
    await runAsk(interaction, ctx, {
      prompt,
      attachments: file ? [file] : [],
      ephemeral: interaction.options.getBoolean("private") ?? false,
      header: questionHeader(interaction.user.username, prompt),
    });
  },
});

// --- Ask Choomfie (message menu) ---

/** Right-clicked message, held for the few seconds the instruction box is open. */
const menuTargets = new Map<string, { author: string; content: string; attachments: AttachmentLike[]; at: number }>();

registerMessageMenu(ASK_MENU_NAME, {
  data: {
    ...new ContextMenuCommandBuilder().setName(ASK_MENU_NAME).setType(ApplicationCommandType.Message).toJSON(),
    ...ANYWHERE,
  },
  handler: async (interaction, ctx) => {
    if (!isAllowed(ctx, interaction.user.id)) {
      await interaction.reply({ content: NOT_ALLOWED, flags: MessageFlags.Ephemeral });
      return;
    }
    const now = Date.now();
    for (const [k, v] of menuTargets) if (now - v.at > RELAY_WINDOW_MS) menuTargets.delete(k);
    const m = interaction.targetMessage;
    menuTargets.set(interaction.id, {
      author: m.author.username,
      content: m.content,
      attachments: [...m.attachments.values()],
      at: now,
    });
    await interaction.showModal(
      askModal(`ask:menu:${interaction.id}`, `Ask Choomfie about ${m.author.username}'s message`, {
        label: "What should Choomfie do? (optional)",
        required: false,
        placeholder: "e.g. summarize this, is this true?",
      })
    );
  },
});

// --- 💬 Reply button → text box ---

registerButtonHandler("ask", async (interaction, parts, ctx) => {
  if (parts[1] !== "reply") return;
  if (!isAllowed(ctx, interaction.user.id)) {
    await interaction.reply({ content: NOT_ALLOWED, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.showModal(
    askModal("ask:reply", "Reply to Choomfie", {
      label: "Your reply",
      required: true,
      placeholder: "Keep the conversation going…",
    })
  );
});

registerModalHandler("ask", async (interaction, parts, ctx) => {
  const text = interaction.fields.getTextInputValue("text") ?? "";

  if (parts[1] === "reply") {
    const answer = interaction.isFromMessage() ? interaction.message : null;
    // Quote the answer only when it isn't the latest one: that's already in the chat's context.
    const latest = answer && interaction.channelId ? isLatestAnswer(interaction.channelId, answer.id) : false;
    await runAsk(interaction, ctx, {
      prompt: replyPrompt(latest ? "" : replyExcerpt(answer?.content ?? ""), text),
      attachments: uploadedFiles(interaction),
      ephemeral: answer?.flags.has(MessageFlags.Ephemeral) ?? false,
      header: questionHeader(interaction.user.username, text),
    });
    return;
  }

  if (parts[1] === "menu") {
    const target = menuTargets.get(parts[2]);
    menuTargets.delete(parts[2]);
    if (!target) {
      await interaction.reply({
        content: "Lost track of that message (Choomfie restarted) — right-click it again.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const about = `about ${target.author}'s message`;
    await runAsk(interaction, ctx, {
      prompt: menuPrompt(target.author, target.content, target.attachments.length, text),
      attachments: [...target.attachments, ...uploadedFiles(interaction)],
      header: questionHeader(interaction.user.username, text.trim() ? `${text.trim()} (${about})` : `asked ${about}`),
    });
  }
});
