/**
 * A harness: a coding-agent CLI (Antigravity's `agy`, OpenCode, Codex, …)
 * driven as a Choomfie brain. Each Discord message is one non-interactive run
 * (`agy -p … --output-format json`), resumed by the CLI's own conversation id,
 * in a folder of its own per chat. The CLI keeps the conversation; Choomfie
 * keeps the id.
 *
 * A spec is the CLI-specific part: the command line for a turn and how to
 * read what it printed. Adding a harness is one spec file.
 */

import type { BrainMode, Capability } from "@choomfie/shared";

export interface HarnessTurn {
  /** What to send, already framed (who's talking, attached files). */
  prompt: string;
  /** The CLI's conversation id from the last turn; absent = a new conversation. */
  ref?: string;
  /** `/model`, if the chat picked one. */
  model?: string;
  /** One of the spec's modes. */
  mode: string;
  /** The chat's working folder. */
  cwd: string;
}

export interface HarnessResult {
  text: string;
  /** The conversation id to resume next time. */
  ref?: string;
  tokens?: { in: number; out: number };
  /** What the agent did, from its own events: "ran `npm test`", "edited app.ts". Read-only steps left out. */
  actions?: string[];
  /** Set when the run didn't answer: what to tell the user. */
  failed?: string;
}

export interface HarnessSpec {
  /** Brain id (`/brain <id>`). */
  id: string;
  label: string;
  /** The executable, looked up on PATH. */
  bin: string;
  /** One line for `/brain`: what it costs, its catch. */
  note?: string;
  /** Command-line arguments for one turn (no shell: each is passed as is). */
  args(turn: HarnessTurn): string[];
  /** Read one run's output. */
  parse(out: { stdout: string; stderr: string; code: number | null }): HarnessResult;
  /** Modes a chat can be put in; `readOnlyMode` is what anyone but the owner gets. */
  modes: BrainMode[];
  defaultMode: string;
  readOnlyMode: string;
  /** Lists the models a chat can pick (`/model`), e.g. `agy models`. */
  listModels?: { args: string[]; parse(stdout: string): string[] };
  /** One turn's limit. Default 20 minutes. */
  timeoutMs?: number;
  /** A failed run whose output matches this is out of quota, not broken. Default `QUOTA_PATTERN`. */
  quota?: RegExp;
  /**
   * The CLI speaks ACP (`opencode acp`, `agy acp`): turns stream progress and
   * ask permission as Discord buttons instead of one print-mode run. `modes`
   * maps this spec's mode ids to the agent's own (`work` → `auto`). Off with
   * config `harnesses.<id>.acp: false` (back to print mode).
   */
  acp?: { args: string[]; modes: Record<string, string> };
  /** What it can do; default `["local"]` (works on this computer). */
  capabilities?: Capability[];
}

/** What CLIs print when an allowance is spent (agy: `RESOURCE_EXHAUSTED`, "Quota exhausted"). */
export const QUOTA_PATTERN = /RESOURCE_EXHAUSTED|quota (?:exhausted|exceeded|reached)|out of (?:quota|credits)|usage limit|exhausted your capacity|rate.?limit(?:ed| exceeded| reached)|\b429\b/i;

export function defineHarness(spec: HarnessSpec): HarnessSpec {
  if (!spec.modes.some((m) => m.id === spec.defaultMode) || !spec.modes.some((m) => m.id === spec.readOnlyMode)) {
    throw new Error(`harness ${spec.id}: defaultMode and readOnlyMode must be among its modes`);
  }
  return spec;
}

/** The last line of a stream that says something (CLIs end errors there). */
export function lastLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? ""
  );
}
