/**
 * `webbrain doctor <id>` — one real round trip through the adapter: open the
 * site headless on its profile, start a new chat, send "Reply with exactly:
 * pong", and check the answer. The quickest way to tell "still works" from
 * "the site changed" — run it after writing an adapter and whenever a brain
 * starts failing.
 *
 * It sends a real message and leaves a new conversation on the site.
 */

import type { SiteAdapter, TurnContext } from "./adapter.ts";
import { engineFor, launchContext } from "./engine/launch.ts";
import { createHuman, Pacer } from "./engine/human.ts";
import { profileDir, profileInUse } from "./paths.ts";

export const PONG_PROMPT = "Reply with exactly: pong";

export interface DoctorReport {
  ok: boolean;
  ms: number;
  ref?: string;
  text?: string;
  error?: string;
}

export function looksLikePong(text: string): boolean {
  return /\bpong\b/i.test(text);
}

export async function doctor(dataDir: string, adapter: SiteAdapter, opts: { headless?: boolean; timeoutMs?: number } = {}): Promise<DoctorReport> {
  const engine = engineFor(dataDir, adapter);
  const profile = profileDir(dataDir, adapter.id, engine);
  if (profileInUse(profile)) {
    return { ok: false, ms: 0, error: `${adapter.label}'s profile is open in another browser (Choomfie mid-conversation?). Try again when it's idle.` };
  }
  const started = Date.now();
  const context = await launchContext(profile, { headless: opts.headless ?? true, engine });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    let ref: string | undefined;
    const t: TurnContext = {
      ref: undefined,
      started: (r) => {
        ref = r;
        console.error(`  conversation ${r}`);
      },
      stopRequested: () => false,
      progress: (line) => console.error(`  ${line}`),
      notice: (line) => console.error(`  ! ${line}`),
      human: createHuman(new Pacer(0)),
      timeoutMs: opts.timeoutMs ?? 90_000,
    };
    const result = await adapter.turn(page, { text: PONG_PROMPT, files: [] }, t);
    return { ok: looksLikePong(result.text), ms: Date.now() - started, ref: result.ref ?? ref, text: result.text };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await context.close().catch(() => {});
  }
}
