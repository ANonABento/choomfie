/**
 * Step cards: a pipeline's next step as a Discord message with a button per
 * choice. A pipeline whose `--json` result carries `next` (lochara's state
 * machine: `waiting`, `options`, `run` templates) says every choice with its
 * exact command, so moving on needs no brain: a click runs the filled-in
 * command (lib/handlers/pipeline-cards.ts) and the job's end posts the next
 * card (lib/pipelines/index.ts).
 *
 * Templates are argument lists. `<option>` is one of `options`, `<folder>` is
 * the folder of pictures handed over (the job's `{files}`), `<name>` is typed
 * in a pop-up. A template with any other `<…>` can't be filled and gets no button.
 *
 * Cards live in memory: a click on one forgotten by a restart shows where
 * things stand instead (the pipeline's folders are the state, not the card).
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { FILES_PLACEHOLDER } from "./args.ts";

export interface Step {
  character?: string | null;
  stage?: string;
  waiting?: string;
  say?: string;
  show?: string[];
  options?: string[];
  run?: Record<string, string[]>;
  request?: { prompt?: string };
}

export type PictureSource = "last_mine" | "last_reply";

export interface CardAction {
  label: string;
  style: "primary" | "secondary" | "success";
  /** The command, filled in except for `<name>` when `modal` is set. */
  args: string[];
  /** Pictures from the chat for `{files}`. */
  files?: PictureSource;
  /** Ask for a name first, then run `args` with it in place of `<name>`. */
  modal?: "name";
}

/** Which kinds of pictures this chat has kept, so a button is offered only for those. */
export type Sources = Partial<Record<PictureSource, boolean>>;

const MAX_OPTIONS = 20;
const MAX_BUTTONS = 25;
const MAX_LABEL = 80;
const PER_ROW = 5;
export const MAX_CONTENT = 1900;

const SOURCE_LABEL: Record<PictureSource, string> = { last_mine: "📎 My pictures", last_reply: "🎨 Bot's pictures" };
/** Keys a step's main action uses, by what it's waiting for; every other key is a secondary button. */
const MAIN: Record<string, string> = { pick: "pick", run: "next", pictures: "deliver" };
const KEY_LABEL: Record<string, string> = { new: "➕ New", export: "📦 Export", redraw: "🔁 Redraw", refresh: "🔄 Check again" };

const label = (s: string) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s);

/** The template with `<option>` and `<folder>` filled; undefined if it has a placeholder nobody can fill. */
function fill(template: string[], option?: string): string[] | undefined {
  const out = template.map((a) => (a === "<option>" && option !== undefined ? option : a === "<folder>" ? FILES_PLACEHOLDER : a));
  return out.some((a) => /^<[^>]+>$/.test(a) && a !== "<name>") ? undefined : out;
}

function actionFor(lbl: string, style: CardAction["style"], args: string[]): CardAction {
  return { label: label(lbl), style, args, ...(args.includes("<name>") ? { modal: "name" as const } : {}) };
}

/** The same command once per kind of picture the chat has. */
function withPictures(lbl: (source: PictureSource) => string, style: CardAction["style"], args: string[], sources: Sources): CardAction[] {
  return (["last_mine", "last_reply"] as const).filter((s) => sources[s]).map((s) => ({ label: label(lbl(s)), style, args, files: s }));
}

/** The buttons for a step, main choices first. */
export function actionsFor(step: Step, sources: Sources = {}): CardAction[] {
  const run = step.run ?? {};
  const waiting = step.waiting ?? "";
  const out: CardAction[] = [];
  const main = MAIN[waiting];
  if (waiting === "pick" && run.pick) {
    for (const o of (step.options ?? []).slice(0, MAX_OPTIONS)) {
      const args = fill(run.pick, o);
      if (args) out.push(actionFor(o, "primary", args));
    }
  } else if (waiting === "run" && run.next) {
    const args = fill(run.next);
    if (args) out.push(actionFor(`▶ ${args.join(" ")}`, "primary", args));
  } else if (waiting === "pictures" && run.deliver) {
    const args = fill(run.deliver);
    if (args) out.push(...withPictures((s) => `${SOURCE_LABEL[s]} → deliver`, "primary", args, sources));
  }
  for (const [key, template] of Object.entries(run)) {
    if (key === main || key === "refresh") continue;
    const args = fill(template);
    if (args) out.push(actionFor(KEY_LABEL[key] ?? key, waiting === "approve" ? "success" : "secondary", args));
  }
  const c = step.character;
  if (c && waiting !== "pictures") {
    out.push(...withPictures((s) => `🖼 Add designs: ${SOURCE_LABEL[s].slice(3).toLowerCase()}`, "secondary", ["concept", c, "--from", FILES_PLACEHOLDER], sources));
  }
  out.push(actionFor(KEY_LABEL.refresh, "secondary", run.refresh ?? (c ? ["next", c] : ["next"])));
  return out.slice(0, MAX_BUTTONS);
}

/** After a name is typed for `new <name>`: start it from the chat's pictures, or without designs. */
export function newCharacterActions(template: string[], name: string, sources: Sources): CardAction[] {
  const args = template.map((a) => (a === "<name>" ? name : a));
  return [
    ...withPictures((s) => `${SOURCE_LABEL[s]} as designs`, "primary", [...args, "--from", FILES_PLACEHOLDER], sources),
    { label: "⏭ No designs", style: "secondary", args },
  ];
}

/** The card's text: what the step says, what it's waiting for, and how many options didn't fit. */
export function cardText(step: Step, header?: string): string {
  const shown = Math.min(step.options?.length ?? 0, MAX_OPTIONS);
  const more = (step.options?.length ?? 0) - shown;
  const lines = [
    header ?? "",
    step.say ?? "",
    step.request?.prompt ? `> ${step.request.prompt.slice(0, 500)}` : "",
    step.waiting === "pictures" ? "Draw them here (or ask the bot to), then press a button to hand them over." : "",
    more > 0 ? `+${more} more not shown: type the one you want.` : "",
  ];
  return lines.filter(Boolean).join("\n").slice(0, MAX_CONTENT);
}

const STYLE = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success };

/** Button rows; each button's id is `lc:<card>:<index>`. */
export function buttonRows(cardId: string, actions: CardAction[]): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  actions.forEach((a, i) => {
    if (i % PER_ROW === 0) rows.push(new ActionRowBuilder<ButtonBuilder>());
    rows.at(-1)!.addComponents(new ButtonBuilder().setCustomId(`lc:${cardId}:${i}`).setLabel(a.label).setStyle(STYLE[a.style]));
  });
  return rows;
}

/** The Stop button for the job a card's click started. */
export function stopRow(cardId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lcstop:${cardId}`).setLabel("⏹ Stop").setStyle(ButtonStyle.Danger)
  );
}

// --- Cards posted, newest per chat ---

export interface Card {
  id: string;
  pipeline: string;
  chatId: string;
  actions: CardAction[];
  messageId?: string;
  /** The job its button started, for Stop. */
  jobId?: string;
}

const cards = new Map<string, Card>();
const latest = new Map<string, string>();
const MAX_CARDS = 200;
let seq = 0;

export function newCardId(): string {
  return `${Date.now().toString(36)}${(++seq).toString(36)}`;
}

/** Keep a card; it becomes its chat's newest. Returns the card it replaced as newest, if any. */
export function saveCard(card: Card): Card | undefined {
  const before = cards.get(latest.get(card.chatId) ?? "");
  cards.set(card.id, card);
  latest.set(card.chatId, card.id);
  for (const id of cards.keys()) {
    if (cards.size <= MAX_CARDS) break;
    cards.delete(id);
  }
  return before;
}

export function getCard(id: string): Card | undefined {
  return cards.get(id);
}

/** True for the chat's newest card that hasn't been used yet. */
export function isLatest(card: Card): boolean {
  return latest.get(card.chatId) === card.id;
}

/** A card's button was pressed: no other button on it runs. */
export function useCard(card: Card): void {
  if (isLatest(card)) latest.delete(card.chatId);
}

/** Tests only. */
export function _resetCards(): void {
  cards.clear();
  latest.clear();
}
