import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRecord, ChatsApi, PluginContext } from "@choomfie/shared";
import { createHarnessBrain } from "../define.ts";
import type { Spawner } from "../run.ts";
import { defineHarness } from "../spec.ts";

function fakeChats(): ChatsApi {
  const rows = new Map<string, ChatRecord>();
  const bound = new Map<string, string>();
  let n = 0;
  const make = (loc: string, brain: string): ChatRecord => {
    const c = { id: `c${++n}`, brain, backendRef: null, title: "", cwd: null, model: null, mode: null, locationId: loc, createdAt: "", lastActiveAt: "" };
    rows.set(c.id, c);
    bound.set(`${loc}|${brain}`, c.id);
    return c;
  };
  return {
    current: (loc, brain) => rows.get(bound.get(`${loc}|${brain}`) ?? "") ?? make(loc, brain),
    bound: (loc, brain) => rows.get(bound.get(`${loc}|${brain}`) ?? "") ?? null,
    get: (id) => rows.get(id) ?? null,
    setBackendRef: (id, ref) => void (rows.get(id)!.backendRef = ref),
    touch: () => {},
    start: (loc, brain) => make(loc, brain),
    setMode: (id, mode) => void (rows.get(id)!.mode = mode),
  };
}

const spec = defineHarness({
  id: "fake",
  label: "Fake",
  bin: "fake",
  modes: [
    { id: "work", label: "Work", description: "" },
    { id: "ask", label: "Ask", description: "" },
  ],
  defaultMode: "work",
  readOnlyMode: "ask",
  args: ({ prompt, ref, mode }) => [mode, ref ?? "-", prompt],
  parse: ({ stdout }) => JSON.parse(stdout),
});

function setup(run: (cmd: string[], cwd: string) => { stdout: string; stderr?: string; code?: number }) {
  const calls: { cmd: string[]; cwd: string }[] = [];
  const spawn: Spawner = async (cmd, { cwd, signal }) => {
    calls.push({ cmd, cwd });
    if (cmd[3] === "hang") {
      await new Promise((r) => signal.addEventListener("abort", r));
      return { stdout: "", stderr: "", code: null, killed: "stopped" };
    }
    const r = run(cmd, cwd);
    return { stdout: r.stdout, stderr: r.stderr ?? "", code: r.code ?? 0 };
  };
  const chats = fakeChats();
  const ctx = { DATA_DIR: mkdtempSync(join(tmpdir(), "harness-")), chats } as unknown as PluginContext;
  const brain = createHarnessBrain(spec, ctx, { binPath: "/bin/fake", spawn });
  return { brain, calls, chats, ctx };
}

const msg = (content: string, role = "owner", filePaths: string[] = []) => ({ chatKey: "chan", content, meta: { role, user: "sam" }, filePaths });
const says = (text: string, ref = "conv-1") => ({ stdout: JSON.stringify({ text, ref }) });

describe("harness brain", () => {
  test("one conversation per chat: the CLI's id is resumed; each chat has its own folder", async () => {
    const t = setup(() => says("hi back"));
    expect((await t.brain.send(msg("hi"), t.ctx)).text).toBe("hi back");
    await t.brain.send(msg("again"), t.ctx);
    expect(t.calls.map((c) => c.cmd.slice(1, 3))).toEqual([
      ["work", "-"],
      ["work", "conv-1"],
    ]);
    expect(t.calls[0].cwd).toContain(join("harness", "fake"));
    await t.brain.reset!("chan");
    await t.brain.send(msg("fresh"), t.ctx);
    expect(t.calls[2].cmd[2]).toBe("-");
    expect(t.calls[2].cwd).not.toBe(t.calls[0].cwd);
  });

  test("anyone but the owner gets the read-only mode, whatever the chat is set to", async () => {
    const t = setup(() => says("ok"));
    await t.brain.send(msg("look at this", "user"), t.ctx);
    expect(t.calls[0].cmd[1]).toBe("ask");
    expect(t.calls[0].cmd[3]).toBe("[Discord message from sam]\nlook at this");
  });

  test("files it makes come back; attachments go in the folder and aren't sent back", async () => {
    const src = join(mkdtempSync(join(tmpdir(), "att-")), "photo.png");
    writeFileSync(src, "png");
    const t = setup((_cmd, cwd) => {
      expect(existsSync(join(cwd, "attachments", "photo.png"))).toBe(true);
      writeFileSync(join(cwd, "out.txt"), "made it");
      return says("done");
    });
    const r = await t.brain.send(msg("make a file", "owner", [src]), t.ctx);
    expect(t.calls[0].cmd[3]).toContain("[Attached files, in your working folder: attachments/photo.png]");
    expect(r.files?.map((f) => [f.name, new TextDecoder().decode(f.data)])).toEqual([["out.txt", "made it"]]);
  });

  test("a failed run is an error (so free can fail over); the conversation id is still kept", async () => {
    const t = setup(() => ({ stdout: JSON.stringify({ text: "", ref: "conv-9", failed: "quota spent" }) }));
    await expect(t.brain.send(msg("hi"), t.ctx)).rejects.toThrow("Fake: quota spent");
    expect(t.chats.bound("chan", "fake")!.backendRef).toBe("conv-9");
  });

  test("/stop kills the run", async () => {
    const t = setup(() => says("never"));
    const pending = t.brain.send(msg("hang"), t.ctx);
    await new Promise((r) => setTimeout(r, 10));
    expect(await t.brain.stop!("chan")).toBe(true);
    expect(await pending).toMatchObject({ stopped: true });
    expect(await t.brain.stop!("chan")).toBe(false);
  });
});

test("a run's PWD is its folder (OpenCode works where PWD says, not where it was started)", async () => {
  const { spawnCli } = await import("../run.ts");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "harness-pwd-")));
  const out = await spawnCli(["/bin/sh", "-c", 'printf %s "$PWD"'], { cwd: dir, signal: new AbortController().signal, timeoutMs: 5_000 });
  expect(out.stdout).toBe(dir);
});

test("a run that says its quota is spent throws QuotaReachedError with the reset time", async () => {
  const t = setup(() => ({ stdout: JSON.stringify({ text: "", failed: "RESOURCE_EXHAUSTED: Quota exhausted, resets in 2 days" }) }));
  const e = await t.brain.send(msg("hi"), t.ctx).catch((x) => x);
  expect(e.name).toBe("QuotaReachedError");
  expect(e.resetAt).toBeGreaterThan(Date.now() + 47 * 3_600_000);
  // Any other failure is an ordinary error.
  const u = setup(() => ({ stdout: JSON.stringify({ text: "", failed: "network down" }) }));
  expect((await u.brain.send(msg("hi"), u.ctx).catch((x) => x)).message).toBe("Fake: network down");
});
