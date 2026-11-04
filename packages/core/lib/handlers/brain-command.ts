/**
 * `/brain [name]` and `/stop` — who answers in this channel, and interrupting it.
 *
 *   /brain           show what answers here, for whom, and what's loaded
 *   /brain <name>    this channel/thread now answers with <name>; `claude` clears it
 *   /stop            interrupt the reply in progress here, whoever is answering
 *
 * Starting over is `/clear`, which also follows the channel's brain, and the
 * channel's brain shows in `/status`. One command per verb, whoever answers.
 *
 * Also handles the buttons a brain's answer can carry: quick replies
 * (`brain:choice:<n>`) and approvals (`brain:approval:yes|no`).
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
import { ANYWHERE, AUTOCOMPLETE_LIMIT, CLAUDE_BRAIN, getBrain, listBrainIds } from "@choomfie/shared";
import { botIsAbsent, interactionChannel, rememberBrainRelay } from "../ask-relay.ts";
import { registerButtonHandler, registerCommand } from "../register.ts";
import {
  clearPendingApproval,
  dispatchToBrain,
  getPendingApproval,
  parentChannelId,
  resolveBrainId,
  takeChoices,
  type SendableChannel,
} from "../brain-router.ts";
import { isAllowed, isOwner } from "../access.ts";
import { onMessageReceived } from "../typing.ts";
import { requireOwner } from "./shared.ts";

function label(id: string): string {
  return id === CLAUDE_BRAIN ? "Claude" : (getBrain(id)?.label ?? `${id} (not loaded)`);
}

registerCommand("brain", {
  data: {
    ...new SlashCommandBuilder()
      .setName("brain")
      .setDescription("Who answers in this channel (owner only)")
      .addStringOption((o) =>
        o
          .setName("name")
          .setDescription("claude, or a loaded brain — omit to see what answers here")
          .setAutocomplete(true)
      )
      .toJSON(),
    // Usable in group DMs (user install), so /choomfie there can be pointed at a brain.
    ...ANYWHERE,
  },
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
    const parentId = parentChannelId(interaction.channel);
    const current = resolveBrainId(channelId, parentId, (id) => ctx.config.getChannelBrain(id));
    const reply = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
    const wantedRaw = interaction.options.getString("name");

    if (!wantedRaw) {
      const own = ctx.config.getChannelBrain(channelId);
      const source = own
        ? "set on this channel"
        : parentId && ctx.config.getChannelBrain(parentId)
          ? "inherited from the parent channel"
          : "default";
      const lines = [
        `**${label(current)}** answers here (${source}).`,
        current === CLAUDE_BRAIN
          ? ""
          : `Answers: ${ctx.config.getBrainAccess() === "owner" ? "owner only" : "everyone on the allowlist"}; others get Claude.`,
        `Loaded brains: ${listBrainIds().map((b) => `\`${b}\``).join(", ")} · \`/brain <name>\` to switch`,
      ].filter(Boolean);
      await reply(lines.join("\n"));
      return;
    }

    const wanted = wantedRaw.trim().toLowerCase();
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
  },
});

// /stop — interrupt whoever is answering in this channel.
registerCommand("stop", {
  data: {
    ...new SlashCommandBuilder()
      .setName("stop")
      .setDescription("Interrupt the reply in progress in this channel (owner only)")
      .toJSON(),
    ...ANYWHERE,
  },
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;
    const channelId = interaction.channelId;
    const current = resolveBrainId(channelId, parentChannelId(interaction.channel), (id) =>
      ctx.config.getChannelBrain(id)
    );
    if (current === CLAUDE_BRAIN) {
      // Interrupting the Claude session means reaching into the daemon's turn
      // loop; not wired yet. Say so rather than pretend.
      await interaction.reply({
        content: "Claude can't be interrupted from Discord yet — it finishes its turn. Other brains stop with `/stop`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const brain = getBrain(current);
    if (!brain?.stop) {
      await interaction.reply({
        content: brain ? `**${brain.label}** can't be stopped from here.` : `The \`${current}\` brain isn't loaded right now.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const stopped = await brain.stop(channelId);
      await interaction.editReply(stopped ? `Asked **${brain.label}** to stop.` : "Nothing is running here.");
    } catch (e) {
      await interaction.editReply(`Couldn't stop **${brain.label}**: ${e instanceof Error ? e.message : String(e)}`);
    }
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
  // In a chat the bot isn't in (a group DM /choomfie), answer through the button's own interaction.
  const absent = botIsAbsent(interaction);
  if (!pending || choice === undefined || !brain || (!absent && !interaction.channel)) {
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

  let channel: SendableChannel;
  if (absent) {
    const relay = interactionChannel(interaction, {
      first: "followUp",
      ephemeral: interaction.message.flags.has(MessageFlags.Ephemeral),
    });
    rememberBrainRelay(pending.chatKey, relay);
    channel = relay;
  } else {
    channel = interaction.channel as unknown as SendableChannel;
    onMessageReceived(pending.chatKey, interaction.channel as never, false);
  }
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
