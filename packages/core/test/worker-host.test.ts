/**
 * WorkerHost — the worker's lifecycle, shared by the supervisor and the
 * daemon: ready handshake, tool calls, the restart tool, crash respawn.
 * Runs a fake worker script over real Bun IPC.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { RESTART_TOOL, WorkerHost } from "../lib/worker-host.ts";

const FAKE = join(import.meta.dir, "fixtures", "fake-worker.ts");
const hosts: WorkerHost[] = [];

function host(env: Record<string, string> = {}) {
  const h = new WorkerHost({ name: "test", workerPath: FAKE, env, log: () => {} });
  hosts.push(h);
  return h;
}

afterEach(async () => {
  while (hosts.length) await hosts.pop()!.stop();
});

const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

describe("WorkerHost", () => {
  test("ready: tools (with restart first) and instructions from the worker", async () => {
    const h = host();
    h.start();
    expect(await h.waitReady(5_000)).toBe(true);
    expect(h.listTools().map((t) => t.name)).toEqual([RESTART_TOOL.name, "echo"]);
    expect(h.instructions).toBe("be nice");
  });

  test("a tool call goes to the worker and its result comes back", async () => {
    const h = host();
    h.start();
    await h.waitReady(5_000);
    expect(text(await h.callTool("echo", { a: 1 }))).toStartWith('echo:{"a":1}:');
  });

  test("the restart tool replaces the worker", async () => {
    const h = host();
    h.start();
    await h.waitReady(5_000);
    const before = h.pid;
    expect(text(await h.callTool("restart", { reason: "test" }))).toContain("Restarted successfully");
    expect(h.pid).not.toBe(before);
    expect(text(await h.callTool("echo", {}))).toEndWith(`:${h.pid}`);
  });

  test("a crashed worker is respawned", async () => {
    const h = host({ FAKE_WORKER_CRASH: "1" });
    h.start();
    await h.waitReady(5_000);
    const first = h.pid;
    // Crashes 50ms after ready; the first respawn waits 1s.
    for (let i = 0; i < 40 && h.pid === first; i++) await new Promise((r) => setTimeout(r, 100));
    expect(h.pid).not.toBe(first);
  });

  test("not ready: a tool call says so instead of hanging", async () => {
    const h = host();
    const r = await h.callTool("echo", {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("starting up");
  });
});
