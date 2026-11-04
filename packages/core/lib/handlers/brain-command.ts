/**
 * `/brain` — choose who answers in this channel (owner only).
 *
 *   /brain set brain:<id>   this channel/thread now answers with <id>; `claude` clears it
 *   /brain new              start a fresh backend conversation here
 *   /brain stop             interrupt the reply in progress here
 *   /brain status           what answers here, and who it answers
 *
 * Also handles the quick-reply buttons a brain's answer can carry
 * (`brain:choice:<n>`): clicking one sends that option to the brain.
 *
 * Threads inherit their parent channel's brain unless set directly, but each
 * thread is its own backend conversation.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
} from "discord.js";
import { AUTOCOMPLETE_LIMIT, CLAUDE_BRAIN, getBrain, listBrainIds } from "@choomfie/shared";
import { registerButtonHandler, registerCommand } from "../register.ts";
import {
  clearPendingApproval,
  dispatchToBrain,
  getPendingApproval,
  resolveBrainId,
  takeChoices,
  type SendableChannel,
} from "../brain-router.ts";
import { isAllowed, isOwner } from "../access.ts";
import { onMessageReceived } from "../typing.ts";
import { requireOwner } from "./shared.ts";

function parentOf(channel: unknown): string | null {
  const c = channel as { isThread?: () => boolean; parentId?: string | null } | null;
  return c?.isThread?.() ? (c.parentId ?? null) : null;
}

function label(id: string): string {
  return id === CLAUDE_BRAIN ? "Claude" : (getBrain(id)?.label ?? `${id} (not loaded)`);
}

registerCommand("brain", {
  data: new SlashCommandBuilder()
    .setName("brain")
    .setDescription("Choose who answers in this channel (owner only)")
    .addSubcommand((s) =>
      s
        .setName("set")
        .setDescription("Set this channel's brain")
        .addStringOption((o) =>
          o.setName("brain").setDescription("claude, or a loaded brain").setRequired(true).setAutocomplete(true)
        )
    )
    .addSubcommand((s) => s.setName("new").setDescription("Start a fresh conversation with this channel's brain"))
    .addSubcommand((s) => s.setName("stop").setDescription("Interrupt the reply in progress here"))
    .addSubcommand((s) => s.setName("status").setDescription("Show what answers here"))
    .toJSON(),
  // Lists only brains actually loaded right now — in-memory, well inside 3s.
  autocomplete: async (interaction) => {
    const typed = interaction.options.getFocused().toLowerCase();
    await interaction.respond(
      listBrainIds()
        .filter((id) => id.includes(typed))
        .slice(0, AUTOCOMPLETE_LIMIT)
        .map((id) => ({ name: `${label(id)} (${id})`.slice(0, 100), value: id }))
    );
  },
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;
    const channelId = interaction.channelId;
    const parentId = parentOf(interaction.channel);
    const sub = interaction.options.getSubcommand();
    const current = resolveBrainId(channelId, parentId, (id) => ctx.config.getChannelBrain(id));
    const reply = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

    if (sub === "set") {
      const wanted = interaction.options.getString("brain", true).trim().toLowerCase();
      if (wanted !== CLAUDE_BRAIN && !getBrain(wanted)) {
        await reply(`No brain called \`${wanted}\` is loaded. Available: ${listBrainIds().map((b) => `\`${b}\``).join(", ")}.`);
        return;
      }
      // `claude` clears the override, so a thread falls back to its parent again.
      ctx.config.setChannelBrain(channelId, wanted === CLAUDE_BRAIN ? undefined : wanted);
      const now = resolveBrainId(channelId, parentId, (id) => ctx.config.getChannelBrain(id));
      const who = ctx.config.getBrainAccess() === "owner" ? "only you" : "everyone on the allowlist";
      await interaction.reply(
        now === CLAUDE_BRAIN
          ? "This channel is answered by **Claude**."
          : `This channel is now answered by **${label(now)}** — for ${who}. Others still get Claude. ` +
              "Change who with `/config setting:brainAccess`."
      );
      return;
    }

    if (sub === "new") {
      if (current === CLAUDE_BRAIN) {
        await reply("Claude's conversation is shared by every channel — use `/compact` or `/clear` instead.");
        return;
      }
      const brain = getBrain(current);
      if (!brain?.reset) {
        await reply(`**${label(current)}** can't start a fresh conversation.`);
        return;
      }
      await brain.reset(channelId);
      await interaction.reply(`Started a fresh **${brain.label}** conversation in this channel.`);
      return;
    }

    if (sub === "stop") {
      const brain = current === CLAUDE_BRAIN ? undefined : getBrain(current);
      if (!brain?.stop) {
        await reply(`**${label(current)}** can't be stopped from here.`);
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const stopped = await brain.stop(channelId);
        await interaction.editReply(stopped ? `Asked **${brain.label}** to stop.` : "Nothing is running here.");
      } catch (e) {
        await interaction.editReply(`Couldn't stop **${brain.label}**: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    // status
    const own = ctx.config.getChannelBrain(channelId);
    const source = own ? "set on this channel" : parentId && ctx.config.getChannelBrain(parentId) ? "inherited from the parent channel" : "default";
    const lines = [
      `**${label(current)}** answers here (${source}).`,
      current === CLAUDE_BRAIN ? "" : `Answers: ${ctx.config.getBrainAccess() === "owner" ? "owner only" : "everyone on the allowlist"}; others get Claude.`,
      `Loaded brains: ${listBrainIds().map((b) => `\`${b}\``).join(", ")}`,
    ].filter(Boolean);
    await reply(lines.join("\n"));
  },
});

// Quick-reply buttons on a brain's answer. Same gate as typing a message to
// that brain: owner, or anyone allowlisted when brainAccess is "allowlist".
registerButtonHandler("brain", async (interaction, parts, ctx) => {
  if (parts[1] === "approval") return handleApproval(interaction, parts[2] === "yes", ctx);
  if (parts[1] !== "choice") return;
  const userId = interaction.user.id;
  const owner = isOwner(ctx, userId);
  if (!owner && !(ctx.config.getBrainAccess() === "allowlist" && isAllowed(ctx, userId))) {
    await interaction.reply({ content: "Only the owner can answer this one~", flags: MessageFlags.Ephemeral });
    return;
  }
  const pending = takeChoices(interaction.message.id);
  const index = Number(parts[2]);
  const choice = pending?.choices[index];
  const brain = pending ? getBrain(pending.brainId) : undefined;
  if (!pending || choice === undefined || !brain || !interaction.channel) {
    await interaction.reply({ content: "Those options have expired — just type your answer.", flags: MessageFlags.Ephemeral });
    return;
  }

  // Freeze the buttons, highlighting the pick, so nobody answers twice.
  const rows = interaction.message.components.map((row) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      (row as unknown as { components: { customId?: string; label?: string }[] }).components.map((c) =>
        new ButtonBuilder()
          .setCustomId(c.customId ?? `brain:done:${Math.random()}`)
          .setLabel(c.label ?? "…")
          .setStyle(c.customId === `brain:choice:${index}` ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(true)
      )
    )
  );
  await interaction.update({ components: rows });

  const channel = interaction.channel as unknown as SendableChannel;
  onMessageReceived(pending.chatKey, interaction.channel as never, false);
  void dispatchToBrain(ctx, brain, channel, {
    chatKey: pending.chatKey,
    messageId: interaction.message.id,
    content: choice,
    meta: {
      chat_id: pending.chatKey,
      user: interaction.user.username,
      user_id: userId,
      role: owner ? "owner" : "user",
    },
    filePaths: [],
  });
});

/**
 * Approve/decline a brain's pending action. Owner-only regardless of
 * brainAccess: approving acts as the owner's account on the brain's side.
 */
async function handleApproval(
  interaction: ButtonInteraction,
  approve: boolean,
  ctx: Parameters<Parameters<typeof registerButtonHandler>[1]>[2]
): Promise<void> {
  if (!isOwner(ctx, interaction.user.id)) {
    await interaction.reply({ content: "Only the owner can approve this~", flags: MessageFlags.Ephemeral });
    return;
  }
  const pending = getPendingApproval(interaction.message.id);
  const brain = pending ? getBrain(pending.brainId) : undefined;
  if (!pending || !brain?.resolveApproval) {
    await interaction.reply({
      content: "This approval expired (Choomfie restarted) — approve or decline it in the app.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferUpdate();
  try {
    const status = await brain.resolveApproval(pending.chatKey, pending.approval.id, approve);
    clearPendingApproval(interaction.message.id);
    const embed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(approve ? 0x57f287 : 0x99aab5)
      .setFooter({ text: `${approve ? "Approved" : "Declined"} by ${interaction.user.username} · ${status}` });
    await interaction.editReply({ embeds: [embed], components: [] });
  } catch (e) {
    await interaction.followUp({
      content: `Couldn't ${approve ? "approve" : "decline"}: ${e instanceof Error ? e.message : String(e)}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}
