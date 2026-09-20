import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "@choomfie/shared";
import { HANDOFFS_PATH } from "./constants.ts";
import type { HandoffEntry } from "./types.ts";

export async function loadHandoffs(): Promise<HandoffEntry[]> {
  try {
    const data = await readFile(HANDOFFS_PATH, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function saveHandoff(entry: HandoffEntry): Promise<void> {
  const handoffs = await loadHandoffs();
  handoffs.push(entry);
  await writeJsonAtomic(HANDOFFS_PATH, handoffs.slice(-20));
}

export function getLastHandoffSummary(handoffs: HandoffEntry[]): string | undefined {
  if (handoffs.length === 0) return undefined;
  return handoffs[handoffs.length - 1].summary;
}
