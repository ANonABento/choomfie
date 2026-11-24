/**
 * What the non-Claude brains report about themselves (`Brain.status()`), for
 * `/status` and `/usage`. Claude's own numbers come from the daemon's state
 * file; every other brain speaks for itself, so a new kind of brain shows up
 * here without core knowing what it is.
 */

import { CLAUDE_BRAIN, getBrain, listBrainIds, type Brain } from "@choomfie/shared";

const FIELD_MAX = 1024;

/** A brain's own status lines, or a note when it has none or they failed. */
export async function brainStatus(brain: Brain): Promise<string[]> {
  if (!brain.status) return [];
  try {
    return await brain.status();
  } catch (e) {
    return [`⚠️ ${brain.label} couldn't report: ${e instanceof Error ? e.message : String(e)}`];
  }
}

/**
 * Usage of the API brains. `free` lists every provider it routes to, so when
 * it's loaded it speaks for all of them; otherwise each brain with a status does.
 */
export async function apiBrainsUsage(): Promise<string[]> {
  const free = getBrain("free");
  if (free) return brainStatus(free);
  const out: string[] = [];
  for (const id of listBrainIds()) {
    const b = getBrain(id);
    if (b && id !== CLAUDE_BRAIN) out.push(...(await brainStatus(b)));
  }
  return out;
}

/** Lines joined to fit one embed field. */
export function fieldText(lines: string[]): string {
  let out = "";
  for (const l of lines) {
    if (out.length + l.length + 1 > FIELD_MAX - 2) return `${out}\n…`;
    out += (out ? "\n" : "") + l;
  }
  return out;
}
