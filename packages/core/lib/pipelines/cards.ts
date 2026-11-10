/**
 * Step cards: a pipeline's next step as a Discord message with a button per
 * choice. Any pipeline whose `--json` result carries `next` in this shape gets
 * them; nothing here knows a particular pipeline:
 *
 *   waiting   pick | approve | pictures | run | input | done
 *   say       what the step is about, for a person
 *   options   for `pick` (and, on `approve`, which `run` keys approve)
 *   run       {key: command template}: every key is a button. The step's main
 *             one by `waiting` (pick → `pick`, run → `next`, pictures →
 *             `deliver`) comes first.
 *   labels    {key: button label} (default: the key; `▶ <command>` for `next`)
 *   title, progress [{label, state: done|now|todo}]   the card's heading
 *   request.prompt   shown quoted (a picture request)
 *
 * Templates are argument lists. `<option>` is one of `options`; `<folder>` is
 * a folder of pictures the owner chooses in a pop-up (posts in the thread or
 * files from their computer: the job's `{files}`); `<name>` is typed in a
 * pop-up. A template with any other `<…>` can't be filled and gets no button.
 *
 * A click runs the filled-in command (lib/handlers/pipeline-cards.ts) and the
 * job's end posts the next card (lib/pipelines/index.ts). Cards live in memory:
 * a click on one forgotten by a restart shows where things stand instead (the
 * pipeline's own files are the state, not the card).
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { FILES_PLACEHOLDER } from "./args.ts";

export interface Step {
  character?: string | null;
  title?: string;
  stage?: string;
  waiting?: string;
  say?: string;
  show?: string[];
  options?: string[];
  run?: Record<string, string[]>;
  labels?: Record<string, string>;
  progress?: { label: string; state: "done" | "now" | "todo" }[];
  request?: { prompt?: string };
}

export interface CardAction {
  label: string;
  style: "primary" | "secondary" | "success";
  /** The command, filled in except for `<name>` (when `modal` is set) and `{files}` (when `pictures` is). */
  args: string[];
  /** Ask for a name first, then run `args` with it in place of `<name>`. */
  modal?: "name";
  /** Ask which pictures first: they go in a folder for `{files}`. */
  pictures?: true;
}

const MAX_OPTIONS = 20;
const MAX_BUTTONS = 25;
const MAX_LABEL = 80;
const PER_ROW = 5;
export const MAX_CONTENT = 1900;

/** The key of a step's main action, by what it's waiting for. */
const MAIN: Record<string, string> = { pick: "pick", run: "next", pictures: "deliver" };

const clip = (s: string) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s);

/** The template with `<option>` and `<folder>` filled; undefined if it has a placeholder nobody can fill. */
function fill(template: string[], option?: string): string[] | undefined {
  const out = template.map((a) => (a === "<option>" && option !== undefined ? option : a === "<folder>" ? FILES_PLACEHOLDER : a));
  return out.some((a) => /^<[^>]+>$/.test(a) && a !== "<name>") ? undefined : out;
}

function action(label: string, style: CardAction["style"], args: string[]): CardAction {
  return {
    label: clip(label),
    style,
    args,
    ...(args.includes("<name>") ? { modal: "name" as const } : {}),
    ...(args.includes(FILES_PLACEHOLDER) ? { pictures: true as const } : {}),
  };
}

/** The buttons for a step: the main choices, then every other `run` key. */
export function actionsFor(step: Step): CardAction[] {
  const run = step.run ?? {};
  const labels = step.labels ?? {};
  const waiting = step.waiting ?? "";
  const main = MAIN[waiting];
  const out: CardAction[] = [];
  if (main === "pick" && run.pick) {
    for (const o of (step.options ?? []).slice(0, MAX_OPTIONS)) {
      const args = fill(run.pick, o);
      if (args) out.push(action(o, "primary", args));
    }
  } else if (main && run[main]) {
    const args = fill(run[main]);
    if (args) out.push(action(labels[main] ?? (main === "next" ? `▶ ${args.join(" ")}` : main), "primary", args));
  }
  for (const [key, template] of Object.entries(run)) {
    if (key === main) continue;
    const args = fill(template);
    const approves = waiting === "approve" && step.options?.includes(key);
    if (args) out.push(action(labels[key] ?? key, approves ? "success" : "secondary", args));
  }
  return out.slice(0, MAX_BUTTONS);
}

/** `✓ Art › **Body** › Build`. */
function progressLine(step: Step): string {
  return (step.progress ?? []).map((p) => (p.state === "done" ? `✓ ${p.label}` : p.state === "now" ? `**${p.label}**` : p.label)).join(" › ");
}

/** The card's text: its heading (title, progress), what the step says, and how many options didn't fit. */
export function cardText(step: Step, header?: string): string {
  const shown = Math.min(step.options?.length ?? 0, MAX_OPTIONS);
  const more = (step.options?.length ?? 0) - shown;
  const heading = [step.title ? `**${step.title}**` : "", progressLine(step)].filter(Boolean).join(" · ");
  const lines = [
    header ?? "",
    heading,
    step.say ?? "",
    step.request?.prompt ? `> ${step.request.prompt.slice(0, 500)}` : "",
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
