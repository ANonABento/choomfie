/**
 * The review loop that closes a plan: when every task on a board has landed,
 * a reviewer reads the plan's whole change against the repo's rules; what it
 * finds goes back to the brain as a fix task on the same branch; a clean
 * review waits for CI and offers the owner one Merge button.
 *
 *   tasks done → review ─ findings → fix task → review … (MAX_FIX_ROUNDS)
 *                       └ clean → CI → Merge button
 *
 * The reviewer only reads: Claude with Read/Grep/Glob in the plan's clone, no
 * shell, no settings or hooks from the repo (a patch could add some), so
 * nothing from a patch runs on this Mac. The rules come from the default
 * branch, so a patch can't rewrite the rules it's held to.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
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
  repo: string;
  branch: string;
  base: string;
  /** The tasks the plan asked for, as their lines. */
  tasks: string[];
  rules: string;
  stat: string;
  diff: string;
  /** The plan's clone at the reviewed head, for reading around the diff. */
  cwd: string;
}

export type Reviewer = (input: ReviewInput) => Promise<Review>;

/** Fix rounds before the loop hands over to the owner. */
export const MAX_FIX_ROUNDS = 2;
const MAX_DIFF_CHARS = 150_000;

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

export function formatReview(review: Review, round: number): string {
  const must = blocking(review);
  const nits = review.findings.filter((f) => f.severity !== "must");
  const item = (f: Finding) => `- **${f.title}**${f.file ? ` \`${f.file}\`` : ""} — ${f.fix}`;
  return [
    `🔎 **Review, round ${round + 1}:** ${must.length ? `${must.length} to fix` : "clean"}`,
    review.summary,
    ...(must.length ? ["", "**To fix:**", ...must.map(item)] : []),
    ...(nits.length ? ["", "**Notes (not blocking):**", ...nits.map(item)] : []),
  ].join("\n");
}

export interface LoopDeps {
  reviewer: Reviewer;
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

    let review: Review;
    try {
      review = await deps.reviewer({
        repo: pb.repo,
        branch: pb.branch,
        base: prep.base,
        tasks: tasks.map((t) => `${t.n}. [${t.mode}] ${t.spec}`),
        rules: prep.rules,
        stat: prep.stat,
        diff: prep.diff,
        cwd: pb.dir,
      });
    } catch (e) {
      return stuck(`The review itself failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 1500));
    }
    await deps.say(formatReview(review, state.round).slice(0, 1990));
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

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Two or three sentences: what the change does and whether it's ready." },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["must", "nit"] },
          title: { type: "string" },
          file: { type: "string" },
          fix: { type: "string" },
        },
        required: ["severity", "title", "fix"],
      },
    },
  },
  required: ["summary", "findings"],
} as const;

export function reviewPrompt(input: ReviewInput): string {
  const diff =
    input.diff.length > MAX_DIFF_CHARS
      ? `${input.diff.slice(0, MAX_DIFF_CHARS)}\n… (diff cut at ${MAX_DIFF_CHARS} characters: Read the changed files in the stat for the rest)`
      : input.diff;
  return [
    `Review this pull request before it merges. An AI coding agent wrote it, task by task, on branch ${input.branch} of ${input.repo}; it merges into ${input.base}.`,
    "Your working directory is the branch, checked out: Read, Grep and Glob it for context around the diff.",
    "",
    "What makes a finding `must` (the change can't merge with it):",
    "- a bug: wrong behaviour, a crash, a broken edge case, a security hole",
    "- it breaks one of the repo's rules below",
    "- it doesn't do what its task asked, or one task's change undoes or contradicts another's",
    "- code added that nothing calls, config nothing reads, or a test that doesn't test the behaviour",
    "- secrets, personal IDs or private details in a file that will be public",
    "Everything else worth saying (style, naming, small simplifications) is a `nit`. Don't invent findings: a clean change has none.",
    "Each finding: one title, the file, and a `fix` concrete enough that another agent with only the branch can do it.",
    "",
    "The plan's tasks:",
    ...input.tasks,
    "",
    input.rules ? `The repo's rules (from ${input.base}):\n${input.rules}` : "The repo has no CLAUDE.md, AGENTS.md or CONTRIBUTING.md.",
    "",
    `Changed files:\n${input.stat}`,
    "",
    `The diff (${input.base}...${input.branch}):`,
    diff,
  ].join("\n");
}

/** Parse the reviewer's answer; throws on anything that isn't a review. */
export function parseReview(raw: unknown): Review {
  const v = (typeof raw === "string" ? JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")) : raw) as Partial<Review>;
  if (!v || typeof v.summary !== "string" || !Array.isArray(v.findings)) throw new Error("the reviewer didn't return a review");
  const findings = v.findings
    .filter((f): f is Finding => !!f && typeof f.title === "string" && typeof f.fix === "string")
    .map((f) => ({ severity: f.severity === "must" ? ("must" as const) : ("nit" as const), title: f.title, fix: f.fix, ...(f.file ? { file: f.file } : {}) }));
  return { summary: v.summary, findings };
}

/** Claude as the reviewer: read-only tools, nothing from the repo's settings, a structured answer. */
export function claudeReviewer(model?: string): Reviewer {
  return async (input) => {
    const q = query({
      prompt: reviewPrompt(input),
      options: {
        cwd: input.cwd,
        ...(model ? { model } : {}),
        tools: ["Read", "Grep", "Glob"],
        allowedTools: ["Read", "Grep", "Glob"],
        permissionMode: "dontAsk",
        settingSources: [],
        mcpServers: {},
        strictMcpConfig: true,
        persistSession: false,
        maxTurns: 60,
        outputFormat: { type: "json_schema", schema: REVIEW_SCHEMA as unknown as Record<string, unknown> },
        env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
      },
    });
    for await (const m of q) {
      if (m.type !== "result") continue;
      if (m.subtype !== "success") throw new Error(`review ended with ${m.subtype}`);
      return parseReview(m.structured_output ?? m.result);
    }
    throw new Error("the review ended without a result");
  };
}
