import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBrain, type Brain, type BrainMessage, type PluginContext } from "@choomfie/shared";
import { ChatStore } from "../../core/lib/chats/store.ts";
import { answerText, defineWebBrain } from "../define.ts";
import { LoginRequiredError, type SiteAdapter, type TurnContext, type TurnInput } from "../adapter.ts";
import { LateWatch } from "../watch.ts";
import { FakeContext, gate, tick } from "./fakes.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

type Turn = (input: TurnInput, t: TurnContext) => Promise<Awaited<ReturnType<SiteAdapter["turn"]>>>;

async function setup(turn: Turn, extra: Partial<SiteAdapter> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "webbrain-"));
  dirs.push(dataDir);
  const chats = new ChatStore(new Database(":memory:"));
  const adapter: SiteAdapter = {
    id: "fakesite",
    label: "FakeSite",
    loginUrl: "https://fake.example/login",
    chatUrl: (ref) => `https://fake.example/c/${ref ?? "new"}`,
    turn: (_page, input, t) => turn(input, t),
    ...extra,
  };
  const plugin = defineWebBrain(adapter, { launch: async () => new FakeContext() as never });
  const ctx = { DATA_DIR: dataDir, chats, config: {} } as unknown as PluginContext;
  await plugin.init!(ctx);
  const brain = getBrain("fakesite") as Brain;
  return { brain, chats, dataDir, destroy: () => plugin.destroy!(), ctx };
}

const msg = (chatKey: string, content = "hello", extra: Partial<BrainMessage> = {}): BrainMessage => ({
  chatKey,
  content,
  meta: { role: "owner" },
  filePaths: [],
  ...extra,
});

describe("defineWebBrain", () => {
  test("first turn starts a conversation; the next continues it", async () => {
    const refs: (string | undefined)[] = [];
    const { brain, chats, destroy } = await setup(async (input, t) => {
      refs.push(t.ref);
      return { text: `got: ${input.text}`, ref: "conv-1" };
    });
    try {
      expect((await brain.send(msg("chan1", "plan the arm"), {} as never)).text).toBe("got: plan the arm");
      await brain.send(msg("chan1"), {} as never);
      expect(refs).toEqual([undefined, "conv-1"]);
      const chat = chats.bound("chan1", "fakesite")!;
      expect(chat.backendRef).toBe("conv-1");
      expect(chat.title).toBe("plan the arm");
    } finally {
      await destroy();
    }
  });

  test("two channels answer at the same time", async () => {
    const g = gate();
    let together = 0;
    let running = 0;
    const { brain, destroy } = await setup(async (_i, t) => {
      running++;
      together = Math.max(together, running);
      await g.promise;
      running--;
      return { text: "ok", ref: t.ref ?? "r" };
    });
    try {
      const both = Promise.all([brain.send(msg("a"), {} as never), brain.send(msg("b"), {} as never)]);
      for (let i = 0; i < 5; i++) await tick();
      g.open();
      await both;
      expect(together).toBe(2);
    } finally {
      await destroy();
    }
  });

  test("/stop reaches the turn in flight, which ends as stopped", async () => {
    const started = gate();
    const stops: string[] = [];
    const { brain, destroy } = await setup(
      async (_i, t) => {
        t.started("conv-s");
        started.open();
        while (!t.stopRequested()) await tick();
        return { text: "partial", ref: "conv-s", stopped: true };
      },
      { stop: async (_page, ref) => (stops.push(ref), true) }
    );
    try {
      const reply = brain.send(msg("chan1"), {} as never);
      await started.promise;
      expect(await brain.stop!("chan1")).toBe(true);
      expect((await reply).text).toContain("⏹️ Stopped.");
      expect(stops).toEqual(["conv-s"]);
      expect(await brain.stop!("chan1")).toBe(false);
    } finally {
      await destroy();
    }
  });

  test("someone other than the owner is named in the prompt", async () => {
    let seen = "";
    const { brain, destroy } = await setup(async (input) => ((seen = input.text), { text: "", ref: "r" }));
    try {
      await brain.send(msg("c", "hi", { meta: { role: "user", user: "sam" } }), {} as never);
      expect(seen).toBe("[Discord message from sam]\nhi");
    } finally {
      await destroy();
    }
  });

  test("attachments arrive under their original names and are cleaned up after", async () => {
    let names: string[] = [];
    const { brain, dataDir, destroy } = await setup(async (input) => {
      names = input.files.map((f) => f.split("/").pop()!);
      return { text: "", ref: "r" };
    });
    try {
      const inbox = join(dataDir, "inbox");
      mkdirSync(inbox);
      const file = join(inbox, "1700000000_ab12cd_photo.png");
      writeFileSync(file, "x");
      await brain.send(msg("c", "look", { filePaths: [file] }), {} as never);
      expect(names).toEqual(["photo.png"]);
      expect(readdirSync(join(dataDir, "webbrain", "fakesite", "outbox"))).toEqual([]);
    } finally {
      await destroy();
    }
  });

  test("a logged-out site says how to log in", async () => {
    const { brain, destroy } = await setup(async () => {
      throw new LoginRequiredError({ id: "fakesite", label: "FakeSite" });
    });
    try {
      await expect(brain.send(msg("c"), {} as never)).rejects.toThrow("bun run webbrain login fakesite");
    } finally {
      await destroy();
    }
  });

  test("moves a pre-kit state dir into webbrain/<id>", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "webbrain-legacy-"));
    dirs.push(dataDir);
    mkdirSync(join(dataDir, "fakesite", "profile"), { recursive: true });
    const plugin = defineWebBrain(
      { id: "fakesite", label: "F", loginUrl: "", chatUrl: () => "", turn: async () => ({ text: "", ref: "r" }) },
      { launch: async () => new FakeContext() as never }
    );
    await plugin.init!({ DATA_DIR: dataDir, chats: new ChatStore(new Database(":memory:")), config: {} } as never);
    await plugin.destroy!();
    expect(readdirSync(join(dataDir, "webbrain", "fakesite"))).toContain("profile");
  });
});

describe("answerText", () => {
  test("says stopped, background, or that nothing came back", () => {
    expect(answerText({ text: "half", stopped: true }, "X")).toBe("half\n\n⏹️ Stopped.");
    expect(answerText({ text: "on it", background: true }, "X")).toContain("when X finishes");
    expect(answerText({ text: "" }, "X")).toBe("(X finished without a text reply)");
  });
});

describe("LateWatch", () => {
  test("posts new results once, and stops unless they started more work", async () => {
    const posted: string[] = [];
    let results = [{ text: "result 1", ids: ["m1"], more: true }, { text: "result 2", ids: ["m2"], more: false }];
    const w = new LateWatch(
      async () => results.shift() ?? null,
      async (_k, r) => void posted.push(r.text),
      1e9
    );
    w.start("c", "ref", "m0");
    await w.tick("c");
    expect(w.watching("c")).toBe(true);
    await w.tick("c");
    expect(w.watching("c")).toBe(false);
    expect(posted).toEqual(["result 1", "result 2"]);
    results = [];
  });

  test("gives up after its window", async () => {
    const w = new LateWatch(async () => null, async () => {}, 1e9, -1);
    w.start("c", "ref", "m0");
    await w.tick("c");
    expect(w.watching("c")).toBe(false);
  });
});
