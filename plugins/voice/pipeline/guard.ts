/**
 * Budget guard + privacy toggle for voice pipelines (Req 5, 11).
 *
 * The daily counter is one JSON file in the data dir, written atomically like
 * the daemon's state file. Counts reset when the local date changes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicSync } from "@choomfie/shared";

export const VOICE_BUDGET_FILE = "voice-budget.json";

type BudgetFile = { date: string; counts: Record<string, number> };

function today(now: Date): string {
  return now.toLocaleDateString("en-CA");
}

export function budgetKey(provider: string, model?: string): string {
  return model ? `${provider}:${model}` : provider;
}

export class DailyBudget {
  private readonly path: string;

  constructor(
    dataDir: string,
    private readonly limits: Record<string, number>,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.path = join(dataDir, VOICE_BUDGET_FILE);
  }

  private load(): BudgetFile {
    const date = today(this.now());
    let saved: BudgetFile;
    try {
      saved = JSON.parse(readFileSync(this.path, "utf8")) as BudgetFile;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { date, counts: {} };
      throw new Error(`Voice budget file unreadable: ${this.path}`, { cause: error });
    }
    return saved.date === date ? saved : { date, counts: {} };
  }

  used(key: string): number {
    return this.load().counts[key] ?? 0;
  }

  /** True while the key has budget left; keys without a limit are unlimited. */
  hasBudget(key: string): boolean {
    const limit = this.limits[key];
    return limit === undefined || this.used(key) < limit;
  }

  /** Count one use; false (and nothing counted) when the budget is spent. */
  consume(key: string): boolean {
    if (!this.hasBudget(key)) return false;
    const file = this.load();
    file.counts[key] = (file.counts[key] ?? 0) + 1;
    writeJsonAtomicSync(this.path, file);
    return true;
  }
}

export interface PipelineChoice<T> {
  key: string;
  value: T;
}

/** First configured pipeline with budget left; logs every fallback. */
export function selectWithBudget<T>(
  choices: PipelineChoice<T>[],
  budget: DailyBudget,
  log: (line: string) => void = console.error,
): PipelineChoice<T> {
  for (const [i, choice] of choices.entries()) {
    if (budget.hasBudget(choice.key)) return choice;
    const next = choices[i + 1];
    log(`Voice budget: daily limit reached for ${choice.key}${next ? `, falling back to ${next.key}` : ""}`);
  }
  throw new Error(`Voice budget: every pipeline is out of budget (${choices.map((c) => c.key).join(", ")})`);
}

export interface PrivacyContext {
  /** DM or private-memory conversation */
  isPrivate: boolean;
  blockCloudInPrivate: boolean;
  cloudProviders: readonly string[];
}

/** Throws for a blocked cloud provider; logs loudly whenever audio goes to one. */
export function checkCloudAudio(
  provider: string,
  ctx: PrivacyContext,
  log: (line: string) => void = console.error,
): void {
  if (!ctx.cloudProviders.includes(provider)) return;
  if (ctx.isPrivate && ctx.blockCloudInPrivate) {
    throw new Error(`Voice privacy: cloud provider "${provider}" is blocked for DMs / private memory`);
  }
  log(`⚠️ VOICE AUDIO SENT TO CLOUD PROVIDER: ${provider}`);
}
