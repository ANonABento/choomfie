/**
 * Local tools for web brains: a site's model can't run anything on this Mac,
 * so it asks in text and the kit runs it. The model writes a code block whose
 * first line is `#!run`:
 *
 *     ```sh
 *     #!run
 *     df -h
 *     ```
 *
 * The marker is inside the code because sites render markdown and drop a
 * block's language (Gemini shows any unknown one as "Code snippet"); a block
 * whose language survives as `run` counts too.
 *
 * and the kit runs the command (zsh, from the home folder), sends the output
 * back as the next message, and repeats until the model answers in plain text.
 *
 * Owner only, and only for adapters that opt in (`localTools`). A command
 * that only looks at things (`df`, `git status`, …, no redirects or chaining
 * beyond `&&` and `|`) runs at once; anything else (a commit, a push, a
 * write, an unknown program) waits for the owner's Approve button. Whatever a
 * command prints goes to the site, so anything touching secrets is never
 * auto-run.
 */

import { homedir } from "node:os";

export const RUN_LANG = "run";
/** Commands per reply; the rest are ignored (and the model is told). */
export const MAX_CALLS = 3;
/** Rounds of run → output → answer in one message, before the kit stops and says so. */
export const MAX_STEPS = 6;
const OUTPUT_CHARS = 6_000;
const TIMEOUT_MS = 60_000;

export function toolGuide(): string {
  return [
    "[This chat is relayed from Discord by a bot running on the owner's Mac (macOS, zsh). The bot runs shell commands for you:",
    "you don't need shell access yourself, and you shouldn't tell the owner to run commands. When a request needs this Mac (disk space, files, git, …), ask the bot.",
    "To run one, put it in a code block whose FIRST LINE is exactly `#!run`, then the command:",
    "```sh",
    "#!run",
    "df -h",
    "```",
    `Up to ${MAX_CALLS} blocks per reply. Commands run from the home folder (use \`cd path && …\`). The output comes back as the next message; then answer the owner.`,
    "Commands that only look at things run right away; anything that changes something (commit, push, writing files, installing) waits for the owner to approve it.",
    "Only run commands when the request needs this Mac; otherwise just answer. Never print secrets (keys, tokens, .env files).]",
  ].join("\n");
}

/** A one-line reminder for later messages in the same conversation. */
export const TOOL_REMINDER = "[The bot can still run commands on the owner's Mac for you: a code block whose first line is #!run.]";

export interface CodeBlock {
  lang?: string;
  code: string;
}

/** ```run blocks in markdown text. */
export function fencedBlocks(text: string): CodeBlock[] {
  const out: CodeBlock[] = [];
  for (const m of text.matchAll(/```([\w-]*)[^\n]*\n([\s\S]*?)```/g)) out.push({ lang: m[1] || undefined, code: m[2] });
  return out;
}

const MARKER = /^\s*#!\s*run\s*(?:\n|$)/i;

/** The commands a reply asks for, from the adapter's code blocks or the reply's fences. */
export function runCalls(text: string, blocks?: CodeBlock[]): string[] {
  return (blocks ?? fencedBlocks(text))
    .filter((b) => b.lang?.toLowerCase() === RUN_LANG || MARKER.test(b.code))
    .map((b) => b.code.replace(MARKER, "").trim())
    .filter(Boolean);
}

/**
 * The answer as Discord should see it: fenced `#!run` blocks taken out (the
 * Run card and the "ran on this Mac" line already show the command). Only
 * fenced blocks: an adapter that wants this returns its text with fences.
 */
export function withoutRunBlocks(text: string): string {
  return text
    .replace(/```([\w-]*)[^\n]*\n([\s\S]*?)```/g, (block, lang: string, code: string) => (lang.toLowerCase() === RUN_LANG || MARKER.test(code) ? "" : block))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Programs that only look, and for the ones with subcommands, which subcommands. */
const LOOK_ONLY: Record<string, RegExp | true> = {
  cd: true,
  pwd: true,
  ls: true,
  df: true,
  du: true,
  uptime: true,
  date: true,
  whoami: true,
  hostname: true,
  sw_vers: true,
  uname: true,
  ps: true,
  vm_stat: true,
  // Reading kernel values only: never `-w` or `name=value`.
  sysctl: /^(?!.*(?:-w|=))[\w.\s-]*$/,
  // Bare or -Q only: `-l`/`-p` simulate memory pressure.
  memory_pressure: /^(-Q)?\s*$/,
  nettop: /^-l\s*1\b/,
  pgrep: true,
  ioreg: /^-[lrwcp\d\s]+[\w\s-]*$/,
  which: true,
  wc: true,
  sort: true,
  head: /^-?n?\s*\d*\s*$/, // only in a pipe: `| head -20`
  tail: /^-?n?\s*\d*\s*$/,
  grep: true,
  top: /^-l\s*1\b/,
  pmset: /^-g\b/,
  diskutil: /^(list|info)\b/,
  lsof: /^-i\b/,
  netstat: true,
  ifconfig: true,
  system_profiler: true,
  brew: /^(list|outdated|info|--version)\b/,
  git: /^(status|log|diff|show|branch|remote|rev-parse|describe|shortlog|stash list)\b/,
  gh: /^(pr|issue|run) (list|view|status|checks)\b|^auth status\b/,
};

/** Anything a printout could leak. Never auto-run, whatever the program. */
const SECRETS = /\.ssh|\.env\b|\.aws|\.gnupg|\.netrc|keychain|security\s|id_rsa|id_ed25519|token|secret|passw|credential|\.config\/gh|printenv|\benv\b/i;

/** Runs without asking: every step of a `&&`/`|` chain is a look-only program, nothing redirects or substitutes. */
export function isLookOnly(cmd: string): boolean {
  if (/[;<>`\n]|\$\(|\|\||&(?!&)/.test(cmd.replace(/&&/g, "")) || SECRETS.test(cmd)) return false;
  const steps = cmd.split(/&&|\|/).map((s) => s.trim());
  return steps.every((step, i) => {
    const [prog, ...rest] = step.split(/\s+/);
    const rule = LOOK_ONLY[prog];
    if (!rule) return false;
    const args = rest.join(" ");
    // head/tail/grep/sort/wc read files when given one: only as a later step of a pipe.
    if (["head", "tail", "grep", "sort", "wc"].includes(prog) && (i === 0 || !cmd.includes("|"))) return false;
    return rule === true || rule.test(args);
  });
}

export interface RunResult {
  cmd: string;
  code: number | null;
  output: string;
  timedOut?: boolean;
}

export async function runCommand(cmd: string, cwd = homedir(), timeoutMs = TIMEOUT_MS): Promise<RunResult> {
  const proc = Bun.spawn(["/bin/zsh", "-lc", cmd], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1", PWD: cwd } });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    const both = [out, err].filter((s) => s.trim()).join("\n");
    const output = both.length > OUTPUT_CHARS ? `${both.slice(0, OUTPUT_CHARS)}\n… (${both.length - OUTPUT_CHARS} more characters cut)` : both;
    return { cmd, code, output, ...(timedOut ? { timedOut } : {}) };
  } finally {
    clearTimeout(timer);
  }
}

/** The message that hands the outputs back to the site. */
export function resultsPrompt(results: RunResult[], extra?: string): string {
  const parts = results.map(
    (r) => `$ ${r.cmd}\n${r.timedOut ? `(stopped after ${TIMEOUT_MS / 1000}s)\n` : ""}${r.output || "(no output)"}\n(exit ${r.code ?? "killed"})`
  );
  return `[Output from the owner's Mac:]\n${parts.join("\n\n")}${extra ? `\n\n${extra}` : ""}\n\n[Now answer the owner, or run more if you need to.]`;
}

/** For the Discord line under the answer: what ran. */
export function ranNote(results: RunResult[]): string {
  return `-# 🔧 ran on this Mac: ${results.map((r) => `\`${r.cmd.length > 60 ? `${r.cmd.slice(0, 59)}…` : r.cmd}\`${r.code ? ` (exit ${r.code})` : ""}`).join(", ")}`;
}
