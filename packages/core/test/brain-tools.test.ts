import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushBrainReply, registerBrain, unregisterBrain, type BrainMessage, type BrainReply } from "@choomfie/shared";
import { brainTools } from "../lib/tools/brain-tools.ts";
import { delegate, stopDelegations } from "../lib/delegate.ts";
import { inConversation } from "../lib/brain-router.ts";
import { _resetTurns, callerIsOwner, recordTurn } from "../lib/caller.ts";
import type { AppContext } from "../lib/types.ts";

const askTool = brainTools.find((t) => t.definition.name === "delegate")!;
const dataDir = mkdtempSync(join(tmpdir(), "delegate-"));
const ctx = { DATA_DIR: dataDir } as unknown as AppContext;
const textOf = (r: Awaited<ReturnType<typeof askTool.handler>>) => (r.content[0] as { text: string }).text;
const fake = (send: (m: BrainMessage) => Promise<BrainReply>) => registerBrain({ id: "fake", label: "Fake", send });
const ask = (args: Record<string, unknown>) => askTool.handler({ to: "fake", task: "go", chat_id: "c1", ...args }, ctx, { via: "local" });

beforeEach(() => {
  _resetTurns();
  recordTurn({ chat_id: "c1", role: "owner" });
});
afterEach(() => unregisterBrain("fake"));

describe("callerIsOwner", () => {
  test("the latest message in the caller's chat decides; remote is the owner's token", () => {
    recordTurn({ chat_id: "c2", role: "user" });
    recordTurn({ chat_id: "c3", role: "owner", location_id: "thread-3" });
    expect(callerIsOwner({ via: "local" }, { chat_id: "c1" })).toBe(true);
    expect(callerIsOwner({ via: "local" }, { chat_id: "c2" })).toBe(false);
    expect(callerIsOwner({ via: "local" }, {})).toBe(false);
    expect(callerIsOwner({ via: "session", location: "thread-3" }, {})).toBe(true);
    // a session can't borrow another chat's role through chat_id
    expect(callerIsOwner({ via: "session", location: "c2" }, { chat_id: "c1" })).toBe(false);
    expect(callerIsOwner({ via: "remote" }, {})).toBe(true);
    // foreground: a non-owner's message anywhere can't name a chat where the owner spoke
    recordTurn({ chat_id: "c2", role: "user" });
    expect(callerIsOwner({ via: "local" }, { chat_id: "c1" })).toBe(false);
    expect(callerIsOwner({ via: "session", location: "thread-3" }, {})).toBe(true);
    recordTurn({ chat_id: "c1", role: "owner" });
    expect(callerIsOwner({ via: "local" }, { chat_id: "c1" })).toBe(true);
    recordTurn({ chat_id: "c1", role: "user" });
    expect(callerIsOwner({ via: "local" }, { chat_id: "c1" })).toBe(false);
  });
});

describe("delegate tool", () => {
  test("sends the task and files, saves what comes back under safe names", async () => {
    let got: BrainMessage | null = null;
    fake(async (m) => {
      got = m;
      return { text: "made two", files: [{ name: "a.png", data: new Uint8Array([1, 2]) }, { name: "../../evil.png", data: new Uint8Array([3]) }] };
    });
    const ref = join(dataDir, "ref.png");
    writeFileSync(ref, "x");
    const saveTo = join(dataDir, "out");
    const r = await ask({ files: [ref], save_to: saveTo });
    const t = textOf(r);
    expect(r.isError).toBeFalsy();
    expect(got!.chatKey).toBe("c1");
    expect(got!.filePaths).toEqual([ref]);
    expect(got!.meta.role).toBe("owner");
    expect(t).toContain("made two");
    expect(readFileSync(join(saveTo, "a.png"))).toEqual(Buffer.from([1, 2]));
    expect(existsSync(join(saveTo, "evil.png"))).toBe(true);
    expect(t).toContain(join(saveTo, "evil.png"));
  });

  test("refuses when the owner isn't behind the call", async () => {
    let sent = false;
    fake(async () => ((sent = true), { text: "" }));
    recordTurn({ chat_id: "c1", role: "user" });
    const r = await ask({});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("owner only");
    expect(sent).toBe(false);
    // a daemon session is judged by its own chat, not by the chat_id it names
    const s = await askTool.handler({ to: "fake", task: "go", chat_id: "owner-dm" }, ctx, { via: "session", location: "c1" });
    expect(s.isError).toBe(true);
  });

  test("continues another conversation when asked to", async () => {
    let key = "";
    fake(async (m) => ((key = m.chatKey), { text: "ok" }));
    await ask({ conversation: "design-thread" });
    expect(key).toBe("design-thread");
  });

  test("default folder is under the data dir", async () => {
    fake(async () => ({ text: "ok", files: [{ name: "b.png", data: new Uint8Array([9]) }] }));
    expect(textOf(await ask({}))).toContain(join(dataDir, "brain-files", "fake"));
  });

  test("errors: unknown brain, claude, missing file, relative save_to", async () => {
    fake(async () => ({ text: "" }));
    expect((await ask({ to: "nope" })).isError).toBe(true);
    expect((await ask({ to: "claude" })).isError).toBe(true);
    expect((await ask({ files: ["/no/such.png"] })).isError).toBe(true);
    expect((await ask({ save_to: "rel/dir" })).isError).toBe(true);
  });
});

describe("delegate()", () => {
  const req = { to: "fake", task: "go", conversation: "t1", saveTo: join(dataDir, "late"), from: "test" };

  test("waits for work that went to the background and returns its files", async () => {
    fake(async () => {
      setTimeout(() => {
        void pushBrainReply("fake", "t1", { text: "step 2", background: true });
        setTimeout(() => void pushBrainReply("fake", "t1", { text: "done", files: [{ name: "v.png", data: new Uint8Array([7]) }] }), 10);
      }, 10);
      return { text: "started", background: true };
    });
    const r = await delegate({ ...req, waitMs: 2000 }, ctx);
    expect(r.text).toBe("started\n\nstep 2\n\ndone");
    expect(r.files).toEqual([join(dataDir, "late", "v.png")]);
    expect(r.stillWorking).toBe(false);
  });

  test("stops waiting at the deadline and says it's still working", async () => {
    fake(async () => ({ text: "started", background: true }));
    const r = await delegate({ ...req, waitMs: 20 }, ctx);
    expect(r.stillWorking).toBe(true);
  });

  test("shares the conversation's queue with Discord messages", async () => {
    const order: string[] = [];
    fake(async () => (order.push("ask"), { text: "" }));
    let release!: () => void;
    const busy = inConversation("t1", () => new Promise<void>((r) => (release = () => (order.push("message"), r()))));
    const asked = delegate({ ...req, waitMs: 100 }, ctx);
    await Bun.sleep(10);
    expect(order).toEqual([]);
    release();
    await Promise.all([busy, asked]);
    expect(order).toEqual(["message", "ask"]);
  });

  test("/stop in the chat that asked stops the task, and only while it runs", async () => {
    const stopped: string[] = [];
    let finish!: (r: BrainReply) => void;
    registerBrain({ id: "fake", label: "Fake", send: () => new Promise((r) => (finish = r)), stop: async (k) => (stopped.push(k), finish({ text: "half", stopped: true }), true) });
    const asked = delegate({ ...req, waitMs: 1000, askedFrom: "c1" }, ctx);
    await Bun.sleep(5);
    expect(await stopDelegations("other")).toEqual([]);
    expect(await stopDelegations("c1")).toEqual(["Fake"]);
    expect(stopped).toEqual(["t1"]);
    expect((await asked).stopped).toBe(true);
    expect(await stopDelegations("c1")).toEqual([]);
  });
});

describe("delegate between brains", () => {
  test("the target is told how deep this is; past the limit it's refused; a one-off model rides along", async () => {
    const got: BrainMessage[] = [];
    fake(async (m) => (got.push(m), { text: "ok" }));
    await delegate({ to: "fake", task: "go", conversation: "c9", saveTo: join(dataDir, "d1"), from: "Gemini web", waitMs: 5_000, depth: 1, model: "groq" }, ctx);
    expect(got[0].meta).toMatchObject({ delegation_depth: "2", model: "groq", user: "Gemini web" });
    await expect(delegate({ to: "fake", task: "go", conversation: "c9", saveTo: join(dataDir, "d2"), from: "x", waitMs: 5_000, depth: 2 }, ctx)).rejects.toThrow("hand-offs deep");
  });

  test("the tool's description names the loaded brains and what they do; an unknown brain lists them", async () => {
    registerBrain({ id: "drawer", label: "Drawer", capabilities: ["image-gen"], send: async () => ({ text: "" }) });
    try {
      expect(askTool.definition.description).toContain("drawer (Drawer): image-gen");
      expect(textOf(await ask({ to: "nobody" }))).toContain("drawer (Drawer): image-gen");
    } finally {
      unregisterBrain("drawer");
    }
  });
});
