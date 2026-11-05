/**
 * `/compact` and `/clear` — context control from Discord.
 *
 * Named after the Claude Code commands they mirror, and doing the same thing:
 * `/compact` frees context but keeps a summary of what mattered, `/clear`
 * starts over with nothing. Neither touches memories, reminders or personas —
 * those live in SQLite, the same way Claude Code's `/clear` leaves CLAUDE.md
 * alone.
 *
 * Both only work in daemon mode. The daemon owns the Claude session, so only
 * the daemon can replace it; in foreground mode the session belongs to the
 * `claude` CLI in your terminal and there is no remote way in. Rather than hide
 * the commands, they say so — the names match what you would type there.
 *
 * Both follow the channel's brain (`/brain`). In a channel answered by another
 * brain, Claude's shared session isn't what's talking, so `/clear` starts a
 * fresh conversation with *that* brain for this channel only — no daemon
 * needed, no confirm (the old conversation still exists on the brain's side) —
 * and `/compact` explains that the brain manages its own context.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
} from "discord.js";
import type { DaemonControlCommand } from "@choomfie/shared";
import { registerCommand, registerButtonHandler } from "../register.ts";
import { isDaemonMode, requestDaemonControl } from "../daemon-status.ts";
import { ANYWHERE, CLAUDE_BRAIN, getBrain } from "@choomfie/shared";
import { botIsAbsent } from "../ask-relay.ts";
import { requireOwner } from "./shared.ts";
import { parentChannelId, resolveBrainId } from "../brain-router.ts";
import type { AppContext } from "../types.ts";

/**
 * If this channel is answered by a non-Claude brain, handle the command for
 * that brain and return true. Claude channels return false and carry on.
 */
async function handledByOtherBrain(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext,
  command: DaemonControlCommand,
): Promise<boolean> {
  const brainId = resolveBrainId(interaction.channelId, parentChannelId(interaction.channel), (id) =>
    ctx.config.getChannelBrain(id),
  );
  if (brainId === CLAUDE_BRAIN) return false;

  const brain = getBrain(brainId);
  const name = brain?.label ?? brainId;
  if (command === "compact") {
    await interaction.reply({
      content: `This channel is answered by **${name}**, which manages its own context — nothing to compact. ` +
        "`/clear` starts a fresh conversation with it here.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  // A new chat bound here; the old one stays in `/chat list` to come back to.
  ctx.chats.start(interaction.channelId, brainId);
  await brain?.reset?.(interaction.channelId);
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle(`Fresh ${name} conversation`)
        .setDescription(
          `My next message to ${name} from this channel starts a new chat. ` +
            "The old one is in `/chat list` if you want it back. Claude's session and other channels are untouched.",
        ),
    ],
  });
  return true;
}

const FOREGROUND_NOTICE =
  "Choomfie is running in **foreground mode**, where the session belongs to the " +
  "`claude` CLI in your terminal — nothing in Discord can reach it.\n" +
  "Type the same command there, or run `choomfie --daemon` to make it work from here.";

/**
 * Write the request and confirm optimistically.
 *
 * There is no acknowledgement to wait for: the daemon's answer would have to
 * come back through the very session it is about to throw away. The daemon
 * picks the request up within a couple of seconds and the replacement session
 * posts in this channel once it is up.
 */
async function submit(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  ctx: AppContext,
  command: DaemonControlCommand,
): Promise<void> {
  await requestDaemonControl(ctx.DATA_DIR, command, {
    requestedBy: interaction.user.id,
    // The fresh session says hello here, unless this is a chat the bot can't post in.
    chatId: botIsAbsent(interaction) ? undefined : (interaction.channelId ?? undefined),
  });

  const embed = new EmbedBuilder()
    .setColor(command === "clear" ? 0xed4245 : 0x57f287)
    .setTitle(command === "clear" ? "Clearing context" : "Compacting context")
    .setDescription(
      command === "clear"
        ? "Starting a fresh session with nothing carried over. Saved memories, " +
          "reminders and personas are untouched."
        : "Summarising the conversation and starting a fresh session with it. " +
          "Who you were talking to and what about carries over.",
    )
    .setFooter({ text: "Takes a few seconds — I'll post here when I'm back." });

  if (interaction.isButton()) {
    await interaction.update({ embeds: [embed], components: [] });
  } else {
    await interaction.reply({ embeds: [embed] });
  }
}

// /compact — cycle the session, keeping a handoff summary (owner only)
registerCommand("compact", {
  data: new SlashCommandBuilder()
    .setName("compact")
    .setDescription("Free up context, keeping a summary of the conversation (owner only)")
    .toJSON(),
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;
    if (await handledByOtherBrain(interaction, ctx, "compact")) return;

    if (!(await isDaemonMode(ctx.DATA_DIR))) {
      await interaction.reply({
        content: FOREGROUND_NOTICE,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await submit(interaction, ctx, "compact");
  },
});

// /clear — cycle the session with nothing carried over (owner only)
//
// Behind a confirm button, which /compact is not. The session is shared: if
// someone else is mid-conversation with Choomfie, this wipes it for them too,
// and unlike /compact there is no summary to fall back on.
registerCommand("clear", {
  data: {
    ...new SlashCommandBuilder()
      .setName("clear")
      .setDescription("Clear conversation history and start fresh (owner only)")
      .toJSON(),
    // In a group DM answered by another brain, this is the only way to start it fresh.
    ...ANYWHERE,
  },
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;
    if (await handledByOtherBrain(interaction, ctx, "clear")) return;

    if (!(await isDaemonMode(ctx.DATA_DIR))) {
      await interaction.reply({
        content: FOREGROUND_NOTICE,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle("Clear conversation history?")
      .setDescription(
        "The next session starts with **no memory of this conversation** — " +
          "including anyone else mid-conversation with me right now.\n\n" +
          "Saved memories, reminders and personas are untouched.\n" +
          "Want the context freed but the gist kept? Use `/compact` instead.",
      );

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("session:clear")
        .setLabel("Clear it")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("session:cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    );

    await interaction.reply({ embeds: [embed], components: [row] });
  },
});

registerButtonHandler("session", async (interaction, parts, ctx) => {
  // Owner-gated again at click time: the confirmation message is visible in the
  // channel, so anyone could press the button on it.
  if (interaction.user.id !== ctx.ownerUserId) {
    await interaction.reply({
      content: "This one's owner-only~",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (parts[1] === "cancel") {
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor(0x99aab5)
          .setDescription("Cancelled — context left alone."),
      ],
      components: [],
    });
    return;
  }

  if (parts[1] === "clear") {
    await submit(interaction, ctx, "clear");
  }
});
