/**
 * Seeds: the handoff summary each chat's latest session started with.
 *
 * A compacted chat carries on in a fresh session whose system prompt holds the
 * summary. Resuming that session later gets its transcript back from the SDK,
 * but not its system prompt — so the summary is kept here, by chat id, and
 * supplied again.
 */

import { readFileSync } from "node:fs";
import { writeJsonAtomic } from "@choomfie/shared";
import { META_DIR } from "./constants.ts";
import { getErrorMessage } from "./error.ts";
import { log } from "./log.ts";

export const SEEDS_PATH = `${META_DIR}/claude-seeds.json`;

/** Seeds kept; older chats resume without one. */
const MAX_SEEDS = 30;

export type Seeds = Record<string, string>;

export function parseSeeds(raw: unknown): Seeds {
  const seeds: Seeds = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") seeds[k] = v;
  }
  return seeds;
}

export function loadSeeds(path = SEEDS_PATH): Seeds {
  try {
    return parseSeeds(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return {};
  }
}

/** `seeds` with `chatId` set to `summary` (or cleared), newest last, oldest dropped past the cap. */
export function withSeed(seeds: Seeds, chatId: string, summary: string | undefined): Seeds {
  const next = { ...seeds };
  delete next[chatId];
  if (summary) next[chatId] = summary;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SEEDS))) delete next[k];
  return next;
}

export async function saveSeeds(seeds: Seeds, path = SEEDS_PATH): Promise<void> {
  try {
    await writeJsonAtomic(path, seeds);
  } catch (error: unknown) {
    log(`Failed to save seeds: ${getErrorMessage(error)}`);
  }
}
