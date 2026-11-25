import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBrain, setBrainPoster, type Brain, type BrainMessage, type PluginContext } from "@choomfie/shared";
import { ChatStore } from "../../core/lib/chats/store.ts";
import { answerText, COMPACT_PROMPT, defineWebBrain, modePrompt } from "../define.ts";
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
      expect((await reply).stopped).toBe(true);
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

  test("an answer the site cut short carries on in the same conversation, keeping every part's files", async () => {
    const seen: { text: string; ref?: string }[] = [];
    const { brain, destroy } = await setup(
      async (input, t) => {
        seen.push({ text: input.text, ref: t.ref });
        if (seen.length === 1) return { text: "half done (cut)", ref: "conv-9", files: [{ name: "a.png", data: Buffer.from("a") }] };
        if (seen.length === 2) return { text: "more (cut)", ref: "conv-9" };
        return { text: "all done", ref: "conv-9", files: [{ name: "b.patch", data: Buffer.from("b") }] };
      },
      { continueAfter: (a) => (a.endsWith("(cut)") ? "continue" : null) }
    );
    try {
      const r = await brain.send(msg("c", "build it"), {} as never);
      expect(r.text).toBe("all done");
      expect(r.files?.map((f) => f.name)).toEqual(["a.png", "b.patch"]);
      expect(seen.map((s) => s.text)).toEqual(["build it", "continue", "continue"]);
      expect(seen.map((s) => s.ref)).toEqual([undefined, "conv-9", "conv-9"]);
    } finally {
      await destroy();
    }
  });

  test("it carries on a few times at most", async () => {
    let n = 0;
    const { brain, destroy } = await setup(
      async () => ({ text: `cut ${++n}`, ref: "r" }),
      { continueAfter: () => "continue" }
    );
    try {
      expect((await brain.send(msg("d"), {} as never)).text).toBe("cut 4");
    } finally {
      await destroy();
    }
  });

  test("a turn left running in the background isn't continued, and says so", async () => {
    let n = 0;
    const { brain, destroy } = await setup(
      async () => (n++, { text: "still going", ref: "r", background: true, lastMessageId: "m1" }),
      { continueAfter: () => "continue" }
    );
    try {
      const r = await brain.send(msg("bg"), {} as never);
      expect(r.background).toBe(true);
      expect(n).toBe(1);
    } finally {
      await destroy();
    }
  });

  test("a work mode's turn gets the longer wait, and continueAfter is told the mode", async () => {
    const waits: number[] = [];
    const modesSeen: (string | undefined)[] = [];
    const { brain, chats, destroy } = await setup(
      async (_i, t) => (waits.push(t.timeoutMs), { text: "ok", ref: "r" }),
      {
        modes: [
          { id: "code", label: "Code", description: "d", frame: "[code]", repo: true },
          { id: "ask", label: "Ask", description: "d", frame: "[ask]" },
        ],
        continueAfter: (_a, mode) => (modesSeen.push(mode), null),
      }
    );
    try {
      await brain.send(msg("w"), {} as never);
      chats.setMode(chats.bound("w", "fakesite")!.id, "code");
      await brain.send(msg("w"), {} as never);
      chats.setMode(chats.bound("w", "fakesite")!.id, "ask");
      await brain.send(msg("w"), {} as never);
      expect(waits).toEqual([15 * 60_000, 45 * 60_000, 15 * 60_000]);
      expect(modesSeen).toEqual([undefined, "code", "ask"]);
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
});

describe("modes", () => {
  const modes = [{ id: "code", label: "Code", description: "d", frame: "[code mode — test it]" }];

  test("the chat's mode frame rides on every message, and the adapter is told the mode", async () => {
    const seen: TurnInput[] = [];
    const { brain, chats, destroy } = await setup(
      async (input, t) => (seen.push(input), { text: "ok", ref: t.ref ?? "r" }),
      { modes }
    );
    try {
      expect(brain.modes).toEqual([{ id: "code", label: "Code", description: "d" }]); // no frame leaks out
      await brain.send(msg("c1", "plain"), {} as never);
      chats.setMode(chats.bound("c1", "fakesite")!.id, "code");
      await brain.send(msg("c1", "fix it"), {} as never);
      await brain.send(msg("c1", "and again"), {} as never);
      expect(seen.map((i) => [i.text, i.mode])).toEqual([
        ["plain", undefined],
        ["[code mode — test it]\n\nfix it", "code"],
        ["[code mode — test it]\n\nand again", "code"],
      ]);
    } finally {
      await destroy();
    }
  });

  test("a thread on a pipeline gets no default frame, but an explicit mode still applies", async () => {
    const seen: TurnInput[] = [];
    const { brain, chats, destroy } = await setup(
      async (input, t) => (seen.push(input), { text: "ok", ref: t.ref ?? "r" }),
      { modes, defaultMode: "code" }
    );
    try {
      await brain.send(msg("off", "plain"), {} as never);
      chats.setPipeline("lochara-thread", "lochara");
      await brain.send(msg("lochara-thread", "make a character"), {} as never);
      chats.setMode(chats.bound("lochara-thread", "fakesite")!.id, "code");
      await brain.send(msg("lochara-thread", "fix it"), {} as never);
      expect(seen.map((i) => [i.text, i.mode])).toEqual([
        ["[code mode — test it]\n\nplain", "code"],
        ["make a character", undefined],
        ["[code mode — test it]\n\nfix it", "code"],
      ]);
    } finally {
      await destroy();
    }
  });

  test("a tasks mode's reply carries its task list and the adapter's task context", async () => {
    const { brain, chats, destroy } = await setup(
      async (_i, t) => ({ text: "Plan.\nTasks\n1. [code] Fix it — in repo x. Done when: tests pass", ref: t.ref ?? "r" }),
      { modes: [...modes, { id: "plan", label: "Plan", description: "d", frame: "[plan]", tasks: true }], taskContext: () => "ctx" }
    );
    try {
      await brain.send(msg("c1", "hi"), {} as never);
      chats.setMode(chats.bound("c1", "fakesite")!.id, "plan");
      const reply = await brain.send(msg("c1", "plan it"), {} as never);
      expect(reply.tasks).toEqual([{ n: 1, mode: "code", title: "Fix it", spec: "Fix it — in repo x. Done when: tests pass" }]);
      expect(reply.taskContext).toBe("ctx");
      chats.setMode(chats.bound("c1", "fakesite")!.id, "code");
      expect((await brain.send(msg("c1", "again"), {} as never)).tasks).toBeUndefined();
    } finally {
      await destroy();
    }
  });

  test("a mode the adapter no longer has is ignored", () => {
    expect(modePrompt({ modes }, "gone", "hi")).toEqual({ text: "hi" });
    expect(modePrompt({}, "code", "hi")).toEqual({ text: "hi" });
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

describe("web-brain /compact", () => {
  test("asks the site for a summary, then the next message opens a fresh conversation with it", async () => {
    const sent: { text: string; ref?: string }[] = [];
    let n = 0;
    const { brain, chats, destroy } = await setup(async (input, t) => {
      sent.push({ text: input.text, ref: t.ref });
      if (input.text === COMPACT_PROMPT) return { text: "Goal: arm CAD. Decided: MGN9 rail.", ref: t.ref! };
      const ref = t.ref ?? `conv-${++n}`;
      t.started(ref);
      return { text: "ok", ref };
    });
    try {
      expect(await brain.compact!("chan")).toContain("Nothing to compact");
      await brain.send(msg("chan", "design the arm"), {} as never);
      expect(await brain.compact!("chan")).toContain("summarized");
      // Until the next message, the old conversation is still the bound one.
      expect(chats.bound("chan", "fakesite")!.backendRef).toBe("conv-1");
      await brain.send(msg("chan", "now the gripper"), {} as never);
      const seeded = sent[2];
      expect(seeded.ref).toBeUndefined();
      expect(seeded.text).toContain("Goal: arm CAD. Decided: MGN9 rail.");
      expect(seeded.text).toContain("now the gripper");
      expect(chats.bound("chan", "fakesite")!.backendRef).toBe("conv-2");
      // Only once: the message after continues the new conversation.
      await brain.send(msg("chan", "thanks"), {} as never);
      expect(sent[3]).toEqual({ text: expect.not.stringContaining("Summary") as never, ref: "conv-2" });
    } finally {
      await destroy();
    }
  });

  test("/clear drops a pending summary", async () => {
    const refs: (string | undefined)[] = [];
    const { brain, destroy } = await setup(async (input, t) => {
      refs.push(t.ref);
      return { text: input.text === COMPACT_PROMPT ? "summary" : "ok", ref: t.ref ?? "conv-1" };
    });
    try {
      await brain.send(msg("chan"), {} as never);
      await brain.compact!("chan");
      await brain.reset!("chan");
      await brain.send(msg("chan", "hi"), {} as never);
      expect(refs.at(-1)).toBe("conv-1");
    } finally {
      await destroy();
    }
  });
});

describe("local tools", () => {
  const ask = (cmd: string) => ({ text: `Let me check.\nCode snippet\n${cmd}`, ref: "r", codeBlocks: [{ lang: "code", code: `#!run\n${cmd}` }] });

  test("a look-only command runs at once, its output goes back to the site, and the reply says what ran", async () => {
    const turns: string[] = [];
    const { brain, ctx, destroy } = await setup(
      async (input) => {
        turns.push(input.text);
        return turns.length === 1 ? ask("pwd") : { text: "You're in your home folder.", ref: "r" };
      },
      { localTools: true }
    );
    const reply = await brain.send(msg("t1", "where am i"), ctx);
    expect(turns[0]).toContain("#!run"); // the guide opens the conversation
    expect(turns[0]).toEndWith("where am i");
    expect(turns[1]).toStartWith("[Output from the owner's Mac:]\n$ pwd\n");
    expect(reply.text).toStartWith("You're in your home folder.");
    expect(reply.text).toContain("-# 🔧 ran on this Mac: `pwd`");
    await destroy();
  });

  test("anything else waits for the owner's approval, then runs and the site's answer is posted", async () => {
    const pushed: string[] = [];
    setBrainPoster(async (_id, _key, reply) => void pushed.push(reply.text ?? ""));
    const turns: string[] = [];
    const { brain, ctx, destroy } = await setup(
      async (input) => {
        turns.push(input.text);
        return turns.length === 1 ? ask("echo committed") : { text: "Done: committed.", ref: "r" };
      },
      { localTools: true }
    );
    const reply = await brain.send(msg("t1", "commit it"), ctx);
    expect(turns.length).toBe(1);
    expect(reply.approvals?.[0]).toMatchObject({ title: "FakeSite wants to run this on your Mac", approveLabel: "Run" });
    expect(reply.approvals![0].detail).toContain("echo committed");

    expect(await brain.resolveApproval!("t1", reply.approvals![0].id, true)).toBe("Running it…");
    for (let i = 0; i < 50 && !pushed.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(turns[1]).toContain("$ echo committed\ncommitted");
    expect(turns[1]).not.toContain("#!run"); // no guide on the output message
    expect(pushed[0]).toStartWith("Done: committed.");
    expect(pushed[0]).toContain("ran on this Mac: `echo committed`");
    await destroy();
  });

  test("the posted answer leaves out the fenced #!run block (the Run card shows it)", async () => {
    const { brain, ctx, destroy } = await setup(
      async () => ({ text: "I'll commit it.\n```bash\n#!run\ngit commit -am x\n```\n", ref: "r", codeBlocks: [{ lang: "bash", code: "#!run\ngit commit -am x" }] }),
      { localTools: true }
    );
    const reply = await brain.send(msg("t1", "commit it"), ctx);
    expect(reply.text).toBe("I'll commit it.");
    expect(reply.approvals![0].detail).toContain("git commit -am x");
    await destroy();
  });

  test("someone other than the owner gets no guide, and a run block is just text", async () => {
    const turns: string[] = [];
    const { brain, ctx, destroy } = await setup(async (input) => (turns.push(input.text), ask("pwd")), { localTools: true });
    const reply = await brain.send(msg("t1", "hi", { meta: { role: "user", user: "sam" } }), ctx);
    expect(turns.length).toBe(1);
    expect(turns[0]).not.toContain("#!run");
    expect(reply.approvals ?? []).toEqual([]);
    await destroy();
  });
});
