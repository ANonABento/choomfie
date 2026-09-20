/**
 * Regression tests for the supervisor's single-instance guard.
 *
 * The guard identifies a running Choomfie by grepping its `ps` command line.
 * When `server.ts` was deleted, the supervisor's command became
 * `bun packages/core/supervisor.ts` and the marker list ("choomfie",
 * "server.ts") stopped matching anything — the guard silently became a no-op,
 * so a second supervisor could start alongside the first, both connecting the
 * same bot token to Discord and both writing the same heartbeat file.
 *
 * Nothing caught it because the match is against a runtime string. These tests
 * derive the expected command from package.json, so renaming or moving an
 * entry point fails here instead of in production.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHOOMFIE_PROCESS_MARKERS,
  isChoomfieCommand,
  isChoomfieDaemonCommand,
} from "@choomfie/shared";

const ROOT = join(import.meta.dir, "../../../..");

function packageScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  return pkg.scripts ?? {};
}

/**
 * The package.json scripts that start a long-lived process holding a PID file:
 * `start` -> supervisor.ts (choomfie.pid), `daemon` -> daemon.ts (meta.pid).
 * Short-lived scripts like deploy-commands are deliberately NOT included —
 * they take no PID file, and matching them risks signalling a one-shot script.
 */
const LONG_LIVED_SCRIPTS = ["start", "daemon"];

function longLivedEntryPoints(): { script: string; entry: string }[] {
  const scripts = packageScripts();
  const found: { script: string; entry: string }[] = [];
  for (const script of LONG_LIVED_SCRIPTS) {
    const command = scripts[script];
    expect(command).toBeString();
    for (const match of command.matchAll(/(\S+\.ts)\b/g)) {
      found.push({ script, entry: match[1] });
    }
  }
  return found;
}

describe("supervisor single-instance guard", () => {
  test("every long-lived entry point in package.json is recognisable", () => {
    const entries = longLivedEntryPoints();
    // Guard the guard: if this ever finds nothing, the test is vacuous.
    expect(entries.length).toBeGreaterThan(0);

    const unrecognised = entries
      // `ps -o command=` shows how the process was launched, e.g.
      // "bun packages/core/supervisor.ts".
      .filter(({ entry }) => !isChoomfieCommand(`bun ${entry}`))
      .map(({ script, entry }) => `${script} -> ${entry}`);

    expect(unrecognised).toEqual([]);
  });

  test("one-shot scripts are not mistaken for a running instance", () => {
    expect(isChoomfieCommand("bun packages/core/scripts/deploy-commands.ts")).toBe(false);
    expect(isChoomfieCommand("bun packages/core/scripts/reset.ts")).toBe(false);
  });

  test("recognises the real supervisor, worker and daemon command lines", () => {
    // Exactly what `ps -o command=` reports for the live processes.
    expect(isChoomfieCommand("bun packages/core/supervisor.ts")).toBe(true);
    expect(isChoomfieCommand("bun packages/core/worker.ts")).toBe(true);
    expect(isChoomfieCommand("bun packages/core/daemon.ts")).toBe(true);
  });

  test("merely mentioning a choomfie path is not a Choomfie process", () => {
    // The repo and the data dir are both named "choomfie", so a "choomfie"
    // marker matched any command line touching either — including an ordinary
    // shell. With a recycled PID from a stale PID file that meant signalling
    // an unrelated process, or refusing to start on its behalf.
    expect(
      isChoomfieCommand("/bin/zsh -c cat /Users/me/.claude/plugins/data/choomfie-inline/meta/meta.pid"),
    ).toBe(false);
    expect(isChoomfieCommand("tail -f /Users/me/choomfie/logs/out.log")).toBe(false);
    expect(isChoomfieCommand("vim /Users/me/choomfie/CLAUDE.md")).toBe(false);
  });

  test("daemon detection matches only the daemon entry point", () => {
    expect(isChoomfieDaemonCommand("bun packages/core/daemon.ts")).toBe(true);
    // A supervisor or worker is not a daemon — refusing to start because one
    // of those is alive would break the daemon's own supervisor.
    expect(isChoomfieDaemonCommand("bun packages/core/supervisor.ts")).toBe(false);
    expect(isChoomfieDaemonCommand("bun packages/core/worker.ts")).toBe(false);
    expect(isChoomfieDaemonCommand("vim /Users/me/choomfie/CLAUDE.md")).toBe(false);
    expect(isChoomfieDaemonCommand("")).toBe(false);
  });

  test("does not claim unrelated processes", () => {
    expect(isChoomfieCommand("bun run some-other-project/server.ts")).toBe(false);
    expect(isChoomfieCommand("/usr/bin/ssh-agent -l")).toBe(false);
    expect(isChoomfieCommand("node index.js")).toBe(false);
    expect(isChoomfieCommand("")).toBe(false);
  });

  test("markers list is non-empty and free of dangerously short entries", () => {
    // A one- or two-character marker would match almost any command line and
    // make the guard signal something it shouldn't.
    expect(CHOOMFIE_PROCESS_MARKERS.length).toBeGreaterThan(0);
    for (const marker of CHOOMFIE_PROCESS_MARKERS) {
      expect(marker.length).toBeGreaterThan(3);
    }
  });
});
