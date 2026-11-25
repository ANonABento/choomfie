/**
 * The kinds of message the free brain tells apart, and what each needs.
 *
 * One table: the zero-shot classifier's prompt is built from `description`,
 * and each bucket names a **need** (fast, strong, vision, long), never a
 * model. Which models meet a need is worked out from each provider's live
 * model list (`@choomfie/apibrain` models.ts), so nothing here goes stale
 * when a provider renames or retires a model. `brains` are web brains tried
 * first for that kind of work (on a first message) or offered with a button:
 * Waymond works in its own cloud sandbox, a harness (Antigravity, OpenCode)
 * on this computer, a media site makes images, music or video (its files come
 * back as attachments).
 *
 * config.json `free.buckets.<id>` pins a bucket to explicit targets
 * (`member[:model]`; `@bucket` splices another bucket's pins).
 */

import type { BucketDef, Need } from "@choomfie/apibrain";
import { PROVIDERS } from "./providers/index.ts";

export interface Bucket extends BucketDef {
  need: Need;
  /** Web brains for this kind of work, before any API model. */
  brains: string[];
  /** Explicit targets from config, replacing need-based routing. */
  targets?: string[];
}

export const BUCKETS: Bucket[] = [
  {
    id: "chat",
    label: "Chat",
    description: "small talk, greetings, opinions, jokes, quick factual questions, short everyday help",
    need: "fast",
    brains: [],
  },
  {
    id: "quality",
    label: "Think it through",
    description: "needs careful thinking or good writing: analysis, comparisons, plans, long explanations, math, editing or rewriting text",
    need: "strong",
    brains: [],
  },
  {
    id: "code",
    label: "Code",
    description: "about programming, answered in the reply itself: explain, write, review or debug code, errors, shell commands, regex, SQL",
    need: "strong",
    brains: [],
  },
  {
    id: "media",
    label: "Make media",
    description:
      "asks to MAKE or EDIT media, not talk about it: generate or edit an image, picture, drawing, logo or sticker; make music, a song or a sound; a video or animation; a voice clip or text read aloud",
    need: "strong",
    // Sites that generate media first (ChatGPT, Hugging Face Spaces next); Waymond's sandbox after.
    brains: ["gemini-web", "waymond"],
  },
  {
    id: "agentic",
    label: "Do the work",
    description:
      "asks the assistant to DO something with tools in the cloud, not just answer in text: change a GitHub repo; build an app or a website; a 3D/CAD part; browse sites; multi-step tasks",
    need: "strong",
    brains: ["waymond"],
  },
  {
    id: "local",
    label: "On this computer",
    description:
      "work that has to happen on the user's own computer: run commands or scripts here, read or change local files and folders, a project or repo on this machine, installed programs, checking this machine (disk, processes, ports)",
    need: "strong",
    brains: ["antigravity", "opencode"],
  },
  {
    id: "research",
    label: "Research",
    description: "needs current or sourced information from the web: news, today's prices, recent releases, looking something up, citations",
    need: "strong",
    // Gemini searches Google for free; Waymond (paid credits) after it.
    brains: ["gemini-web", "waymond"],
  },
  {
    id: "vision",
    label: "Images",
    description: "about an attached image",
    need: "vision",
    brains: [],
  },
  {
    id: "long",
    label: "Long input",
    description: "a very long document or message to read",
    need: "long",
    brains: [],
  },
];

/** When a bucket's list is spent: any provider that can answer at all (each with its own best model). */
export const DEFAULT_PRIORITY = PROVIDERS.map((p) => p.id);
