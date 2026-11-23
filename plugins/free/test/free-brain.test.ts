import { describe, expect, test } from "bun:test";
import { ApiMember, defineProvider, Health, Quota, Transcript, type Classification, type Classifier } from "@choomfie/apibrain";
import type { Brain, BrainMessage, ChatRecord, ChatsApi, PluginContext } from "@choomfie/shared";
import { createFreeBrain } from "../brain.ts";
import { expandTargets, parseFreeConfig } from "../config.ts";
import { setupFree } from "../index.ts";

/** In-memory chat store with the same semantics as core's (one chat per location × brain). */
function fakeChats(): ChatsApi & { all: ChatRecord[] } {
  const all: ChatRecord[] = [];
  const bindings = new Map<string, string>();
  const make = (locationId: string, brain: string): ChatRecord => {
    const c = { id: `c${all.length + 1}`, brain, backendRef: null, title: "t", cwd: null, model: null, mode: null, locationId, createdAt: "", lastActiveAt: "" };
    all.push(c);
    bindings.set(`${locationId}|${brain}`, c.id);
    return c;
  };
  const get = (id: string) => all.find((c) => c.id === id) ?? null;
  return {
    all,
    get,
    bound: (loc, brain) => get(bindings.get(`${loc}|${brain}`) ?? ""),
    current: (loc, brain) => get(bindings.get(`${loc}|${brain}`) ?? "") ?? make(loc, brain),
    start: (loc, brain) => make(loc, brain),
    setBackendRef: () => {},
    touch: () => {},
    setMode: (id, mode) => void (get(id)!.mode = mode),
    setModel: (id, model) => void (get(id)!.model = model),
  };
}

type Script = (model: string, body: { messages: { role: string; content: unknown }[] }) => Response;

function apiMember(id: string, script: Script, health: Health, quota: Quota) {
  const spec = defineProvider({ id, label: id.toUpperCase(), baseURL: `https://${id}/v1`, keyEnv: `${id.toUpperCase()}_KEY`, defaultModels: [`${id}-m`] });
  const calls: { model: string; messages: { role: string; content: unknown }[] }[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    calls.push(body);
    return script(body.model, body);
  }) as typeof fetch;
  return { member: new ApiMember(spec, { env: { [`${id.toUpperCase()}_KEY`]: "k" }, health, quota, fetch: fetchImpl }), calls };
}

const ok = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));

function fakeWeb(id: string, modes: string[] = []): Brain & { got: BrainMessage[]; resets: number; approvals: string[]; fail?: string } {
  const b = {
    fail: undefined as string | undefined,
    id,
    label: id[0].toUpperCase() + id.slice(1),
    modes: modes.map((m) => ({ id: m, label: m, description: `${m} mode`, ...(m === "code" ? { repo: true } : {}) })),
    got: [] as BrainMessage[],
    resets: 0,
    approvals: [] as string[],
    async send(m: BrainMessage) {
      b.got.push(m);
      if (b.fail) throw new Error(b.fail);
      return { text: `web did: ${m.content.split("\n").at(-1)}` };
    },
    async reset() {
      b.resets++;
    },
    async resolveApproval(_k: string, id: string) {
      b.approvals.push(id);
      return "ok";
    },
  };
  return b;
}

/** A classifier that answers what the test says. */
function scripted(): Classifier & { next: Partial<Classification> } {
  const c = {
    next: { bucket: "chat", confidence: 0.9 } as Partial<Classification>,
    async classify() {
      return { by: "zero-shot", reason: "test", ...c.next } as Classification;
    },
  };
  return c;
}

function setup(over: Record<string, unknown> = {}) {
  const health = new Health();
  const quota = new Quota();
  const transcript = new Transcript(":memory:");
  const fast = apiMember("fast", () => ok("fast answer"), health, quota);
  const smart = apiMember("smart", () => ok("smart answer"), health, quota);
  const web = fakeWeb("waymond", ["code", "cad"]);
  const classifier = scripted();
  const config = parseFreeConfig(
    {
      priority: ["fast", "smart"],
      buckets: { chat: ["fast", "smart"], quality: ["smart", "fast"], code: ["smart"], agentic: ["waymond", "@code"], research: ["waymond", "smart"] },
      footer: true,
      ...over,
    },
    () => {}
  );
  const chats = fakeChats();
  const ctx = { DATA_DIR: "/tmp", config: { getConfig: () => ({}), getActivePersona: () => ({ name: "Choomfie", personality: "Be fun." }) }, chats } as unknown as PluginContext;
  const members = new Map([
    ["fast", fast.member],
    ["smart", smart.member],
  ]);
  const brain = createFreeBrain(
    { config, members, unconfigured: [{ id: "nvidia", label: "NVIDIA NIM" }], classifier, transcript, health, lookupBrain: (id) => (id === "waymond" ? web : undefined) },
    ctx
  );
  return { brain, fast, smart, web, classifier, transcript, chats, ctx, health };
}

const msg = (content: string, over: Partial<BrainMessage> = {}): BrainMessage => ({ chatKey: "chan", content, meta: { role: "owner", user: "kev" }, filePaths: [], ...over });

describe("free brain routing", () => {
  test("classifies, answers from the bucket's first target, footers the route, keeps a transcript", async () => {
    const t = setup();
    const r = await t.brain.send(msg("hey what's up"), t.ctx);
    expect(r.text).toBe("fast answer\n-# via FAST · fast-m · chat");
    t.classifier.next = { bucket: "quality", confidence: 0.95 };
    await t.brain.send(msg("compare these two essays"), t.ctx);
    // The second provider sees the first exchange: one transcript per chat.
    const sent = t.smart.calls[0].messages;
    expect(sent[0]).toMatchObject({ role: "system" });
    expect(String(sent[0].content)).toContain("You are Choomfie");
    expect(sent.slice(1).map((m) => m.content)).toEqual(["hey what's up", "fast answer", "compare these two essays"]);
  });

  test("fails over on a rate limit and remembers the cooldown", async () => {
    const limitedFast = setup();
    const fastCalls = () => limitedFast.fast.calls.length;
    // Swap in a member that is rate limited.
    const health = limitedFast.health;
    limitedFast.fast.member.complete = async () => {
      health.cool("fast#1", 60_000, "rate_limit");
      const { ProviderError } = await import("@choomfie/apibrain");
      throw new ProviderError("rate_limit", "429", 60_000);
    };
    const r = await limitedFast.brain.send(msg("hi there friend"), limitedFast.ctx);
    expect(r.text).toStartWith("smart answer");
    expect(fastCalls()).toBe(0);
    const status = await limitedFast.brain.status!();
    expect(status.join("\n")).toMatch(/FAST\*\* — cooling (1m|60s)/);
  });

  test("everything unavailable: a clear answer, not an error", async () => {
    const t = setup({ priority: ["fast"], buckets: { chat: ["fast"] } });
    t.health.cool("fast#1", 120_000, "quota");
    const r = await t.brain.send(msg("hello again friend"), t.ctx);
    expect(r.text).toContain("All free providers are limited");
    expect(r.text).toContain("~2m");
  });

  test("mid-chat, a web member is offered, not taken; accepting hands it over with a recap, and it then holds the chat", async () => {
    const t = setup();
    await t.brain.send(msg("what is a monad"), t.ctx);
    t.classifier.next = { bucket: "agentic", confidence: 0.9 };
    const r = await t.brain.send(msg("build it in my repo"), t.ctx);
    // API models answer mid-chat; the web member is a button.
    expect(r.text).toStartWith("smart answer");
    expect(r.choices).toEqual(["Hand this to Waymond"]);
    expect(t.web.got.length).toBe(0);

    // The click resends the message it was offered for, with what Waymond missed.
    const handed = await t.brain.send(msg("Hand this to Waymond"), t.ctx);
    expect(handed.text).toStartWith("web did: build it in my repo");
    expect(t.web.got[0].content).toContain("[Context from this Discord chat");
    expect(t.web.got[0].content).toContain("User: what is a monad\nAssistant (fast): fast answer");
    expect(t.chats.bound("chan", "free")!.model).toBe("waymond");

    // It holds the chat: no classifier, no recap repeat, whatever the message looks like.
    t.classifier.next = { bucket: "chat", confidence: 1 };
    await t.brain.send(msg("ok continue"), t.ctx);
    expect(t.web.got.length).toBe(2);
    expect(t.web.got[1].content).toBe("ok continue");

    // `/model auto` releases it.
    t.chats.setModel!(t.chats.bound("chan", "free")!.id, null);
    expect((await t.brain.send(msg("thanks, explain it"), t.ctx)).text).toStartWith("fast answer");
  });

  test("a weak guess offers nothing; a first message may go straight to the web member", async () => {
    const t = setup();
    t.classifier.next = { bucket: "agentic", confidence: 0.9 };
    expect((await t.brain.send(msg("make me a website"), t.ctx)).text).toStartWith("web did:");
    expect(t.chats.bound("chan", "free")!.model).toBe("waymond");

    const u = setup();
    await u.brain.send(msg("hey there"), u.ctx);
    u.classifier.next = { bucket: "agentic", confidence: 0.5 };
    expect((await u.brain.send(msg("maybe build something"), u.ctx)).choices).toBeUndefined();
  });

  test("a holding web member that fails doesn't move silently: Retry, or Answer with free models", async () => {
    const t = setup();
    t.classifier.next = { bucket: "agentic", confidence: 1 };
    await t.brain.send(msg("start the project"), t.ctx);
    t.web.fail = "site is down";
    const r = await t.brain.send(msg("now add tests"), t.ctx);
    expect(r.text).toStartWith("⚠️ Waymond couldn't answer: site is down");
    expect(r.choices).toEqual(["Retry", "Answer with free models"]);
    expect(t.smart.calls.length + t.fast.calls.length).toBe(0);

    const released = await t.brain.send(msg("Answer with free models"), t.ctx);
    expect(released.text).toStartWith("smart answer");
    expect(t.smart.calls[0].messages.at(-1)!.content).toBe("now add tests");
    expect(t.chats.bound("chan", "free")!.model).toBeNull();
  });

  test("/model pins an API model; if it can't answer, another does and the reply says so", async () => {
    const t = setup();
    const chat = t.chats.current("chan", "free");
    t.chats.setModel!(chat.id, "smart");
    expect((await t.brain.send(msg("hello you"), t.ctx)).text).toBe("smart answer\n-# via SMART · smart-m · pinned");
    t.health.cool("smart#1", 60_000, "rate_limit");
    expect((await t.brain.send(msg("again"), t.ctx)).text).toBe("fast answer\n-# SMART couldn't answer — FAST did.");
    const ids = t.brain.models!().map((m) => m.id);
    expect(ids.slice(0, 2)).toEqual(["auto", "waymond"]);
    expect(ids).toContain("smart:smart-m");
  });

  test("modes are the web member's own work modes; a member mode pins it and sets its chat's mode", async () => {
    const t = setup();
    const ids = t.brain.modes!.map((m) => m.id);
    expect(ids).toEqual(["code", "cad"]);
    expect(t.brain.modes!.find((m) => m.id === "code")).toMatchObject({ repo: true, description: "Waymond: code mode" });

    const freeChat = t.chats.current("chan", "free");
    t.chats.setMode!(freeChat.id, "cad");
    await t.brain.send(msg("design a bracket"), t.ctx);
    expect(t.web.got.length).toBe(1);
    expect(t.chats.bound("chan", "waymond")!.mode).toBe("cad");
  });

  test("/compact folds the older half now", async () => {
    const t = setup({ summaryTargets: ["fast"] });
    expect(await t.brain.compact!("chan")).toBe("Nothing to compact here yet.");
    for (const m of ["one two three", "four five six"]) await t.brain.send(msg(m), t.ctx);
    expect(await t.brain.compact!("chan")).toStartWith("Summarized");
    expect(t.transcript.summary(t.chats.bound("chan", "free")!.id)!.text).toBe("fast answer");
  });

  test("reset starts fresh member chats; approvals go to the member that asked", async () => {
    const t = setup();
    t.classifier.next = { bucket: "agentic", confidence: 1 };
    await t.brain.send(msg("do the thing"), t.ctx);
    expect(await t.brain.resolveApproval!("chan", "a1", true)).toBe("ok");
    expect(t.web.approvals).toEqual(["a1"]);
    const before = t.chats.bound("chan", "waymond")!.id;
    await t.brain.reset!("chan");
    expect(t.chats.bound("chan", "waymond")!.id).not.toBe(before);
    expect(t.web.resets).toBe(1);
  });

  test("status lists providers, brain members, missing keys, recent routes", async () => {
    const t = setup();
    await t.brain.send(msg("hello there you"), t.ctx);
    const s = (await t.brain.status!()).join("\n");
    expect(s).toContain("**FAST** — ready");
    expect(s).toContain("**Waymond** — ready");
    expect(s).toContain("No key: NVIDIA NIM");
    expect(s).toContain("chat → FAST");
  });
});

describe("config", () => {
  test("defaults, overrides, @bucket refs, bad values dropped with warnings", () => {
    const warnings: string[] = [];
    const c = parseFreeConfig(
      { strategy: "fastest", buckets: { code: ["groq"], nonsense: ["x"] }, classifier: { suggestAt: 3, target: "groq:tiny" }, providers: { groq: { models: ["a"], limits: { rpm: 5, rpd: "x" } } } },
      (w) => warnings.push(w)
    );
    expect(c.strategy).toBe("smart");
    expect(c.buckets.find((b) => b.id === "code")!.targets).toEqual(["groq"]);
    expect(c.buckets.find((b) => b.id === "agentic")!.targets).toEqual(["waymond", "groq"]);
    expect(c.classifier.suggestAt).toBe(0.75);
    expect(c.classifier.targets[0]).toBe("groq:tiny");
    expect(c.providers.groq).toEqual({ models: ["a"], limits: { rpm: 5 } });
    expect(warnings.length).toBe(2);
    expect(expandTargets(["@a"], new Map([["a", ["@a", "x"]]]))).toEqual(["x"]);
  });

  test("setupFree: providers with keys become members; keyless local ones are opt-in", () => {
    const s = setupFree({}, { GROQ_API_KEY: "k", GEMINI_API_KEY: "g" }, new Health(), new Quota());
    expect([...s.members.keys()]).toEqual(["groq", "gemini"]);
    expect(s.unconfigured.map((u) => u.id)).toContain("openrouter");
    expect(s.unconfigured.map((u) => u.id)).not.toContain("ollama");
    const local = setupFree({ providers: { ollama: { enabled: true }, groq: { enabled: false } } }, { GROQ_API_KEY: "k" }, new Health(), new Quota());
    expect([...local.members.keys()]).toEqual(["ollama"]);
  });
});
