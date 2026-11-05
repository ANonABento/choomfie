import { log } from "./log.ts";

/**
 * Daemon sessions run the Claude Code build bundled inside the Agent SDK, not
 * the `claude` on PATH that foreground mode uses. Model aliases ("opus",
 * "sonnet") are resolved by that bundled build, so a stale SDK in the lockfile
 * silently pins the daemon to whatever those aliases meant when it shipped —
 * observed: config said "opus", foreground got the current Opus, the daemon
 * got Opus 4.7 from an SDK copy two minor versions behind.
 */

/** Numeric dotted-version compare. Non-numeric suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (v.match(/\d+(\.\d+)*/)?.[0] ?? "0").split(".").map(Number);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** `claude --version` of the CLI foreground mode would run, or null if absent. */
export async function installedClaudeVersion(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["claude", "--version"], { stdout: "pipe", stderr: "ignore" });
    const output = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) !== 0) return null;
    return output.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Logs a warning when the daemon's bundled Claude Code lags the installed CLI. */
export async function warnIfBundledCliStale(bundled: string): Promise<void> {
  const installed = await installedClaudeVersion();
  if (!installed || compareVersions(bundled, installed) >= 0) return;
  log(
    `WARNING: daemon is running bundled Claude Code ${bundled}, older than the installed ` +
      `${installed}. Model aliases may resolve to an older model than foreground mode gets. ` +
      "Fix: bun update @anthropic-ai/claude-agent-sdk (in packages/core), then restart the daemon.",
  );
}
