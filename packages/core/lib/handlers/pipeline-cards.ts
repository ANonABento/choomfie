/**
 * Step card buttons (lib/pipelines/cards.ts): a click runs the card's command
 * for that choice; ➕ New asks for a name first; ⏹ Stop stops the job a click
 * started. Owner only, like the `pipeline` tool: a click runs a command on
 * this machine. The command still goes through buildArgv (the pipeline's
 * allow list and folder), so a card can't run anything the tool couldn't.
 *
 *   lc:<card>:<i>       run the card's action i
 *   lcstop:<card>       stop the job that card's click started
 *   lcname:<card>:<i>   (modal) the name for action i's `<name>`
 */

import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalMessageModalSubmitInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { errorMessage } from "@choomfie/shared";
import { registerButtonHandler, registerModalHandler } from "../register.ts";
import { getCard, isLatest, newCharacterActions, saveCard, stopRow, useCard, type Card, type CardAction } from "../pipelines/cards.ts";
import { chatChannel, pipelineRunner, postCard, sourcesIn, startCardJob } from "../pipelines/index.ts";
import type { AppContext } from "../types.ts";

/** A character's short id, as lochara takes it. */
export const NAME = /^[a-z][a-z0-9-]{0,31}$/;

type Clicked = ButtonInteraction | ModalMessageModalSubmitInteraction;

async function ephemeral(i: ButtonInteraction | ModalSubmitInteraction, content: string): Promise<void> {
  if (i.replied || i.deferred) await i.followUp({ content, flags: MessageFlags.Ephemeral });
  else await i.reply({ content, flags: MessageFlags.Ephemeral });
}

/** True (and the clicker told) when the clicker isn't the owner. */
async function notOwner(i: ButtonInteraction | ModalSubmitInteraction, ctx: AppContext): Promise<boolean> {
  if (ctx.ownerUserId && i.user.id === ctx.ownerUserId) return false;
  await ephemeral(i, "Only the owner can run these.");
  return true;
}

/**
 * Run `args` for the card: the card first shows it's running (with Stop), then
 * the job starts, so a quick job's end can't be overwritten by the ⏳ line.
 */
async function runAction(i: Clicked, ctx: AppContext, card: Card, action: CardAction, args: string[]): Promise<void> {
  const text = i.message.content;
  useCard(card);
  await i.update({ content: `${text}\n⏳ \`${args.join(" ")}\``.slice(0, 2000), components: [stopRow(card.id)] });
  try {
    card.jobId = startCardJob(ctx, card.pipeline, card.chatId, args, action.files, { messageId: i.message.id, text }).id;
  } catch (e) {
    // It never ran: the card's buttons come back, with why.
    saveCard(card);
    await i.editReply({ content: `${text}\n❌ \`${args.join(" ")}\`: ${errorMessage(e)}`.slice(0, 2000), components: i.message.components });
  }
}

/** A card forgotten by a restart: show where things stand now instead. */
async function expired(i: ButtonInteraction, ctx: AppContext): Promise<void> {
  await i.update({ components: [] });
  const pipeline = ctx.chats.pipelineAt(i.channelId)?.pipeline;
  if (!pipeline) return ephemeral(i, "That card is from before a restart, and this thread isn't on a pipeline any more.");
  await ephemeral(i, "That card is from before a restart: here's where things stand now.");
  startCardJob(ctx, pipeline, i.channelId, ["next"]);
}

function nameModal(cardId: string, index: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`lcname:${cardId}:${index}`)
    .setTitle("New character")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("name")
          .setLabel("Short name (lowercase letters, digits, -)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(32)
          .setPlaceholder("e.g. mika3")
      )
    );
}

registerButtonHandler("lc", async (i, parts, ctx) => {
  if (await notOwner(i, ctx)) return;
  const card = getCard(parts[1] ?? "");
  const index = Number(parts[2]);
  const action = card?.actions[index];
  if (!card || !action) return expired(i, ctx);
  if (!isLatest(card)) {
    await i.update({ components: [] });
    return ephemeral(i, "That's an older card: use the newest one.");
  }
  if (action.modal === "name") return i.showModal(nameModal(card.id, index));
  await runAction(i, ctx, card, action, action.args);
});

registerButtonHandler("lcstop", async (i, parts, ctx) => {
  if (await notOwner(i, ctx)) return;
  const jobId = getCard(parts[1] ?? "")?.jobId;
  if (!jobId || !pipelineRunner(ctx).stop(jobId)) return ephemeral(i, "Nothing to stop: it already ended.");
  await i.deferUpdate();  // its end edits the card
});

registerModalHandler("lcname", async (i, parts, ctx) => {
  if (await notOwner(i, ctx)) return;
  const card = getCard(parts[1] ?? "");
  const action = card?.actions[Number(parts[2])];
  if (!card || !action || !isLatest(card) || !i.isFromMessage()) return ephemeral(i, "That card is gone: use the newest one.");
  const name = i.fields.getTextInputValue("name").trim().toLowerCase();
  if (!NAME.test(name)) return ephemeral(i, `\`${name}\` won't do: start with a letter, then lowercase letters, digits or -, up to 32.`);
  const sources = sourcesIn(ctx, card.chatId);
  if (!sources.last_mine && !sources.last_reply) {
    return runAction(i, ctx, card, action, action.args.map((a) => (a === "<name>" ? name : a)));
  }
  // Pictures in the thread: start from them, or without designs.
  useCard(card);
  await i.update({ components: [] });
  const channel = await chatChannel(ctx, card.chatId);
  if (!channel) return;
  await postCard(ctx, channel, card.pipeline, card.chatId, `New character **${name}**: start it from pictures in this thread, or without designs.`, newCharacterActions(action.args, name, sources));
});
