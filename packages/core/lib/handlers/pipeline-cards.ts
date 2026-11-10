/**
 * Step card buttons (lib/pipelines/cards.ts): a click runs the card's command
 * for that choice; one with `<name>` asks for a name first, one with
 * `<folder>` asks which pictures (posts in the thread, or files from the
 * computer); ⏹ Stop stops the job a click started. Owner only, like the
 * `pipeline` tool: a click runs a command on this machine. The command still
 * goes through buildArgv (the pipeline's allow list and folder), so a card
 * can't run anything the tool couldn't.
 *
 *   lc:<card>:<i>       run the card's action i
 *   lcstop:<card>       stop the job that card's click started
 *   lcname:<card>:<i>   (modal) the name for action i's `<name>`
 *   lcpics:<card>:<i>   (modal) the pictures for action i's `{files}`
 */

import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  ActionRowBuilder,
  FileUploadBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Attachment,
  type ButtonInteraction,
  type ModalMessageModalSubmitInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { errorMessage } from "@choomfie/shared";
import { registerButtonHandler, registerModalHandler } from "../register.ts";
import { PipelineError } from "../pipelines/args.ts";
import { getCard, isLatest, saveCard, stopRow, useCard, type Card } from "../pipelines/cards.ts";
import { pipelineRunner, startCardJob } from "../pipelines/index.ts";
import { isImage, resolveThreadFiles, threadPosts } from "../pipelines/thread-files.ts";
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
async function runAction(i: Clicked, ctx: AppContext, card: Card, args: string[], pictures?: (dir: string) => Promise<void>): Promise<void> {
  const text = i.message.content;
  useCard(card);
  await i.update({ content: `${text}\n⏳ \`${args.join(" ")}\``.slice(0, 2000), components: [stopRow(card.id)] });
  try {
    const job = await startCardJob(ctx, card.pipeline, card.chatId, args, { cardMsg: { messageId: i.message.id, text }, ...(pictures ? { pictures } : {}) });
    card.jobId = job.id;
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
  await startCardJob(ctx, pipeline, i.channelId, ["next"]).catch((e) => ephemeral(i, `Couldn't look: ${errorMessage(e)}`));
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

const MAX_POSTS = 25;
const MAX_UPLOADS = 10;

function ago(at: number, now = Date.now()): string {
  const min = Math.round((now - at) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** Which pictures: posts in this thread (newest picked already), or files from the computer. */
export function picturesModal(ctx: AppContext, card: Card, index: number, now = Date.now()): ModalBuilder {
  const posts = threadPosts(ctx.DATA_DIR, card.chatId).slice(0, MAX_POSTS);
  const bot = ctx.discord?.user?.displayName || "Bot";
  const modal = new ModalBuilder().setCustomId(`lcpics:${card.id}:${index}`).setTitle("Choose pictures");
  if (posts.length) {
    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel("Posted in this thread")
        .setDescription("Newest first. Pick one or more posts: all their pictures go.")
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId("posts")
            .setRequired(false)
            .setMinValues(0)
            .setMaxValues(posts.length)
            .addOptions(
              posts.map((p, n) => ({
                label: `${p.source === "brain" ? bot : "You"} · ${p.files.length} picture${p.files.length === 1 ? "" : "s"} · ${ago(p.at, now)}`.slice(0, 100),
                description: p.files.join(", ").slice(0, 100),
                value: p.messageId,
                default: n === 0,
              }))
            )
        )
    );
  }
  modal.addLabelComponents(
    new LabelBuilder()
      .setLabel(posts.length ? "Or upload from your computer" : "Upload from your computer")
      .setDescription(`Up to ${MAX_UPLOADS} pictures${posts.length ? ", as well as or instead of posts" : ""}.`)
      .setFileUploadComponent(new FileUploadBuilder().setCustomId("uploads").setRequired(!posts.length).setMaxValues(MAX_UPLOADS))
  );
  return modal;
}

/** The chosen posts' pictures and the uploaded ones, into `dir`. */
async function gatherPictures(ctx: AppContext, chatId: string, posts: readonly string[], uploads: Attachment[], dir: string): Promise<void> {
  if (posts.length) resolveThreadFiles(ctx.DATA_DIR, chatId, [...posts], dir);
  for (const [n, a] of uploads.entries()) {
    const r = await fetch(a.url);
    if (!r.ok) throw new PipelineError(`couldn't download ${a.name} (${r.status})`);
    writeFileSync(join(dir, `upload-${n + 1}-${basename(a.name).replace(/[^\w.-]+/g, "_")}`), Buffer.from(await r.arrayBuffer()));
  }
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
  if (action.pictures) return i.showModal(picturesModal(ctx, card, index));
  await runAction(i, ctx, card, action.args);
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
  await runAction(i, ctx, card, action.args.map((a) => (a === "<name>" ? name : a)));
});

registerModalHandler("lcpics", async (i, parts, ctx) => {
  if (await notOwner(i, ctx)) return;
  const card = getCard(parts[1] ?? "");
  const action = card?.actions[Number(parts[2])];
  if (!card || !action || !isLatest(card) || !i.isFromMessage()) return ephemeral(i, "That card is gone: use the newest one.");
  let posts: readonly string[] = [];
  try {
    posts = i.fields.getStringSelectValues("posts");
  } catch {
    // no posts to pick from
  }
  const all = [...(i.fields.getUploadedFiles("uploads")?.values() ?? [])];
  const uploads = all.filter((a) => isImage(a.name));
  if (uploads.length < all.length) return ephemeral(i, "Only pictures (png, jpg, webp, gif), please.");
  if (!posts.length && !uploads.length) return ephemeral(i, "Nothing chosen: pick a post or upload pictures.");
  await runAction(i, ctx, card, action.args, (dir) => gatherPictures(ctx, card.chatId, posts, uploads, dir));
});
