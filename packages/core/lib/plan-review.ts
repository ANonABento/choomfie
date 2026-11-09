/**
 * The review loop that closes a plan: when every task on a board has landed,
 * a reviewer reads the plan's whole change against the repo's rules; what it
 * finds goes back to the brain as a fix task on the same branch; a clean
 * review waits for CI and offers the owner one Merge button.
 *
 *   tasks done → review ─ findings → fix task → review … (MAX_FIX_ROUNDS)
 *                       └ clean → CI → Merge button
 *
 * The reviewer is the brain itself, in its `review` mode (Waymond: a fresh
 * chat in the review thread, so it judges the plan rather than defending its
 * own task, and the same chat checks the fixes on later rounds). It runs in
 * the brain's sandbox, not on this Mac and not on Claude's quota. A brain with
 * no review mode skips straight to CI. The rules come from the default
 * branch, so a patch can't rewrite the rules it's held to.
 */

import type { BrainTask } from "@choomfie/shared";
import { prepareReview, waitForChecks, type ChecksResult, type PlanBranch } from "./plan-branch.ts";
import { runCommand, type Runner } from "./patch-pr.ts";

export interface Finding {
  /** "must": wrong, breaks a rule, or isn't what was asked. "nit": worth knowing, not worth a round. */
  severity: "must" | "nit";
  title: string;
  file?: string;
  /** What to change, concretely enough for a coding agent working from the branch. */
  fix: string;
}

export interface Review {
  summary: string;
  findings: Finding[];
}

export interface ReviewInput {
  /** 0 on the first review, then one more per fix round (the reviewer checks its earlier findings). */
  round: number;
  repo: string;
  branch: string;
  base: string;
  /** The tasks the plan asked for, as their lines. */
  tasks: string[];
  rules: string;
  stat: string;
  diff: string;
}

export type Reviewer = (input: ReviewInput) => Promise<Review>;

/** Fix rounds before the loop hands over to the owner. */
export const MAX_FIX_ROUNDS = 2;

export interface ReviewState {
  status: "reviewing" | "fixing" | "checks" | "ready" | "merged" | "stuck";
  /** Fix rounds since the plan was last ready (or stuck). */
  round: number;
  /** The head the last review passed: the only head the Merge button merges. */
  head?: string;
  /** The review's thread. */
  threadId?: string;
  threadUrl?: string;
}

export function blocking(review: Review): Finding[] {
  return review.findings.filter((f) => f.severity === "must");
}

/** The fix task for a round: every blocking finding, one task (they'd clash on one branch in parallel). */
export function fixTask(repo: string, round: number, findings: Finding[], mode: string): BrainTask {
  const lines = findings.map((f) => `   - ${f.title}${f.file ? ` (\`${f.file}\`)` : ""}: ${f.fix}`);
  const spec = [
    `Review fixes, round ${round} — in ${repo}: the review of this plan's branch found these. Fix each one and change nothing else:`,
    ...lines,
    "   Done when: the repo's own checks (tests, type-check, lint, whatever it has) pass.",
  ].join("\n");
  return { n: 0, mode, title: `Review fixes (round ${round})`, spec, repo };
}

/** The CI failure as a fix task. */
export function ciFixTask(repo: string, round: number, failed: string[], prUrl: string | undefined, mode: string): BrainTask {
  const spec =
    `CI fixes, round ${round} — in ${repo}: the plan's PR ${prUrl ?? ""} fails CI (${failed.join(", ")}). ` +
    "Run the repo's checks the way its CI config does, find what fails, and fix it; change nothing else.\n" +
    "   Done when: those checks pass.";
  return { n: 0, mode, title: `CI fixes (round ${round})`, spec, repo };
}

/** One line under the reviewer's own reply (which is already in the thread). */
export function formatReview(review: Review, round: number): string {
  const must = blocking(review).length;
  return `-# 🔎 Review ${round + 1}: ${must ? `${must} to fix` : "clean"}`;
}

export interface LoopDeps {
  /** Undefined: the brain has no review mode, so only CI gates the merge. */
  reviewer?: Reviewer;
  /** Messages in the review's thread. */
  say: (content: string) => Promise<unknown>;
  /** Add a task to the board and run it on the plan's branch; true when it landed. */
  runFix: (task: BrainTask) => Promise<boolean>;
  /** Post the Merge button for this head. */
  offerMerge: (head: string, checks: ChecksResult) => Promise<unknown>;
  save: () => void;
  /** The brain's mode for code fixes. */
  fixMode: string;
  run?: Runner;
  checks?: Parameters<typeof waitForChecks>[3];
}

/**
 * Review the plan's branch until it's clean and CI passes (then offer the
 * merge), or until MAX_FIX_ROUNDS fix rounds didn't get it there, or a fix
 * task fails (then it's the owner's). Updates `state` as it goes.
 */
export async function reviewLoop(pb: PlanBranch, tasks: BrainTask[], state: ReviewState, deps: LoopDeps): Promise<ReviewState> {
  const run = deps.run ?? runCommand;
  const set = (status: ReviewState["status"]) => {
    state.status = status;
    deps.save();
  };
  const stuck = async (why: string) => {
    set("stuck");
    await deps.say(`✋ ${why}\nOver to you: fix it on \`${pb.branch}\` or add a task, then press **🔎 Review** on the board.`);
    return state;
  };
  const fix = async (task: BrainTask) => {
    if (state.round >= MAX_FIX_ROUNDS) return false;
    state.round++;
    set("fixing");
    await deps.say(`🔧 Sending round ${state.round} of fixes to the plan as a task.`);
    if (!(await deps.runFix(task))) {
      await stuck(`The round ${state.round} fix task didn't land (see its thread).`);
      return null;
    }
    return true;
  };

  for (;;) {
    set("reviewing");
    const prep = await prepareReview(pb, run);
    if ("conflict" in prep) return stuck(`\`${prep.base}\` conflicts with \`${pb.branch}\` (${prep.conflict.slice(0, 300)}), so it can't be reviewed or merged as is.`);
    if (!prep.diff.trim()) return stuck(`\`${pb.branch}\` has no changes against \`${prep.base}\`.`);
    if (!pb.prUrl) return stuck(`\`${pb.branch}\` has no PR (opening it failed when the first task landed).`);

    let review: Review = { summary: "", findings: [] };
    if (deps.reviewer) {
      try {
        review = await deps.reviewer({
          round: state.round,
          repo: pb.repo,
          branch: pb.branch,
          base: prep.base,
          tasks: tasks.map((t) => `${t.n}. [${t.mode}] ${t.spec}`),
          rules: prep.rules,
          stat: prep.stat,
          diff: prep.diff,
        });
      } catch (e) {
        return stuck(`The review itself failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 1500));
      }
      await deps.say(formatReview(review, state.round));
    }
    const must = blocking(review);
    if (must.length) {
      const sent = await fix(fixTask(pb.repo, state.round + 1, must, deps.fixMode));
      if (sent === null) return state;
      if (!sent) return stuck(`Still ${must.length} to fix after ${MAX_FIX_ROUNDS} rounds of fixes.`);
      continue;
    }

    set("checks");
    state.head = prep.head;
    const checks = await waitForChecks(pb, prep.head, run, deps.checks);
    if (checks.kind === "failed") {
      await deps.say(`❌ CI failed: ${checks.failed.join(", ")} — ${pb.prUrl}`);
      const sent = await fix(ciFixTask(pb.repo, state.round + 1, checks.failed, pb.prUrl, deps.fixMode));
      if (sent === null) return state;
      if (!sent) return stuck(`CI still fails after ${MAX_FIX_ROUNDS} rounds of fixes.`);
      continue;
    }
    if (checks.kind === "timeout") return stuck(`CI hasn't finished after 30 minutes (${checks.pending.join(", ") || "no checks reported"}).`);
    set("ready");
    await deps.offerMerge(prep.head, checks);
    return state;
  }
}

/** The message that asks the brain for a review (the bundle, plan.diff and rules.md go along as files). */
export function reviewMessage(input: ReviewInput): string {
  if (input.round > 0) {
    return (
      `Fixes for your findings have landed on ${input.branch}. Check again: the attached bundle, plan.diff (the whole change against ${input.base}) and rules.md are current. ` +
      "Say which of your earlier findings are fixed, review anything new, and end with the Verdict lines as before."
    );
  }
  return [
    `Review this plan before it merges: branch ${input.branch} of ${input.repo}, into ${input.base}. An agent wrote it task by task; every task's own checks passed.`,
    "Attached: the branch as a bundle, plan.diff (the whole change), rules.md (the repo's rules, from the default branch).",
    "",
    "The plan's tasks:",
    ...input.tasks,
    "",
    `Changed files:\n${input.stat}`,
  ].join("\n");
}

const FINDING = /^\s*[-*•]\s*\[(must|nit)\]\s*(.+?)(?:\s*\(`?([^()`]+?)`?\))?\s*:\s*(.+)$/i;

/**
 * Read a review out of the brain's reply: a `Verdict: clean|changes` line and
 * `- [must|nit] title (file): fix` lines. Throws when there's no verdict, or
 * the verdict says changes but no [must] line says which.
 */
export function parseReviewText(text: string): Review {
  const lines = text.replace(/\*\*/g, "").split("\n");
  const at = lines.findLastIndex((l) => /^\s*verdict\s*:/i.test(l));
  if (at < 0) throw new Error("the review didn't end with a Verdict line");
  const verdict = /clean/i.test(lines[at]) ? "clean" : "changes";
  const findings: Finding[] = [];
  for (const l of lines.slice(at + 1)) {
    const m = FINDING.exec(l);
    if (m) findings.push({ severity: m[1].toLowerCase() === "must" ? "must" : "nit", title: m[2].trim(), fix: m[4].trim(), ...(m[3] ? { file: m[3].trim() } : {}) });
  }
  if (verdict === "changes" && !findings.some((f) => f.severity === "must")) {
    throw new Error("the review said changes but listed no [must] finding");
  }
  // A clean verdict wins over a stray [must] line: nothing blocks.
  const kept = verdict === "clean" ? findings.map((f) => ({ ...f, severity: "nit" as const })) : findings;
  return { summary: lines.slice(0, at).join("\n").trim(), findings: kept };
}
