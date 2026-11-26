import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRecord, ChatsApi, PluginContext } from "@choomfie/shared";
import { setBrainPoster } from "@choomfie/shared";
import { acpTurn, describeAction, permissionAsk, type AcpSpawn, type AcpTransport } from "../acp.ts";
import { createHarnessBrain, unlinkLocalFiles } from "../define.ts";
import { defineHarness } from "../spec.ts";

type Msg = { id?: number | string; method?: string; params?: Record<string, any>; result?: any; error?: any };

/**
 * An agent in-process: answers the handshake, then runs `script` for the
 * prompt with helpers to stream updates and ask permission.
 */
function fakeAgent(opts: {
  loadable?: string[];
  script(a: { update(u: object): void; ask(toolCall: object): Promise<string | undefined>; cancelled(): boolean }): Promise<string>;
  usage?: object;
}) {
  const seen: Msg[] = [];
  const spawn: AcpSpawn = () => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    let cancelled = false;
    let exit!: (c: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    const out = (m: object) => {
      queue.push(JSON.stringify({ jsonrpc: "2.0", ...m }));
      wake?.();
    };
    let nextId = 1000;
    const waiting = new Map<number, (r: any) => void>();
    const sid = "ses_new";
    const t: AcpTransport = {
      write(line) {
        const m = JSON.parse(line) as Msg;
        seen.push(m);
        if (m.id !== undefined && !m.method) {
          waiting.get(Number(m.id))?.(m.result);
          return;
        }
        const reply = (result: object) => out({ id: m.id, result });
        switch (m.method) {
          case "initialize":
            return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
          case "session/load":
            return opts.loadable?.includes(m.params!.sessionId) ? reply({}) : out({ id: m.id, error: { code: -32000, message: "no such session" } });
          case "session/new":
            return reply({ sessionId: sid });
          case "session/set_mode":
            return reply({});
          case "session/set_model":
            return out({ id: m.id, error: { code: -32601, message: "no" } });
          case "session/set_config_option":
            return reply({});
          case "session/cancel":
            cancelled = true;
            return;
          case "session/prompt": {
            const session = m.params!.sessionId;
            void opts
              .script({
                update: (u) => out({ method: "session/update", params: { sessionId: session, update: u } }),
                ask: (toolCall) =>
                  new Promise((resolve) => {
                    const id = ++nextId;
                    waiting.set(id, (r) => resolve(r?.outcome?.optionId));
                    out({
                      id,
                      method: "session/request_permission",
                      params: { sessionId: session, toolCall, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] },
                    });
                  }),
                cancelled: () => cancelled,
              })
              .then((stopReason) => reply({ stopReason, usage: opts.usage ?? { inputTokens: 10, outputTokens: 5, cachedReadTokens: 100 } }));
            return;
          }
        }
      },
      lines: (async function* () {
        while (true) {
          while (queue.length) yield queue.shift()!;
          if (closed) return;
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      })(),
      kill() {
        closed = true;
        wake?.();
        exit(null);
      },
      exited,
      stderr: async () => "",
    };
    return t;
  };
  return { spawn, seen };
}

const base = { cmd: ["agent", "acp"], cwd: "/tmp/x", timeoutMs: 10_000 };

describe("ACP turn", () => {
  test("streams text and tool calls; what changed becomes actions; tokens add cached reads", async () => {
    const lines: string[] = [];
    const a = fakeAgent({
      async script(s) {
        s.update({ sessionUpdate: "tool_call", toolCallId: "1", title: "write", kind: "edit", status: "pending" });
        s.update({ sessionUpdate: "tool_call_update", toolCallId: "1", status: "in_progress", rawInput: { filePath: "/w/note.txt" } });
        s.update({ sessionUpdate: "tool_call_update", toolCallId: "1", status: "completed" });
        s.update({ sessionUpdate: "tool_call", toolCallId: "2", title: "ls", kind: "execute", status: "completed", rawInput: { command: "ls" } });
        s.update({ sessionUpdate: "tool_call", toolCallId: "3", title: "read", kind: "read", status: "completed" });
        s.update({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Created" } });
        s.update({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: " it." } });
        s.update({ sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "Done." } });
        return "end_turn";
      },
    });
    const r = await acpTurn({ ...base, prompt: "make it", mode: "build", signal: new AbortController().signal, progress: (l) => lines.push(l) }, a.spawn);
    expect(r).toMatchObject({ text: "Created it.\n\nDone.", ref: "ses_new", actions: ["edited note.txt", "ran `ls`"], tokens: { in: 110, out: 5 } });
    expect(lines).toEqual(["🔧 write"]);
    // Mode set the standard way; the model call isn't made without a model.
    expect(a.seen.find((m) => m.method === "session/set_mode")?.params).toEqual({ sessionId: "ses_new", modeId: "build" });
    expect(a.seen.some((m) => m.method === "session/set_model")).toBe(false);
  });

  test("resumes the chat's session; one that can't be loaded starts a new one and says so", async () => {
    const a = fakeAgent({ loadable: ["ses_old"], script: async (s) => (s.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }), "end_turn") });
    expect(await acpTurn({ ...base, prompt: "x", ref: "ses_old", signal: new AbortController().signal }, a.spawn)).toMatchObject({ ref: "ses_old", text: "hi" });
    const lost = await acpTurn({ ...base, prompt: "x", ref: "ses_gone", signal: new AbortController().signal }, a.spawn);
    expect(lost).toMatchObject({ ref: "ses_new", restarted: true });
  });

  test("a model that the agent only takes as a config option still gets set", async () => {
    const a = fakeAgent({ script: async () => "end_turn" });
    await acpTurn({ ...base, prompt: "x", model: "big", signal: new AbortController().signal }, a.spawn);
    expect(a.seen.find((m) => m.method === "session/set_config_option")?.params).toEqual({ sessionId: "ses_new", configId: "model", value: "big" });
  });

  test("permission: asked of the owner and answered with the matching option; no asker means deny", async () => {
    const answers: (string | undefined)[] = [];
    const a = fakeAgent({
      async script(s) {
        answers.push(await s.ask({ title: "git push", kind: "execute", rawInput: { command: "git push" } }));
        return "end_turn";
      },
    });
    const asked: string[] = [];
    await acpTurn({ ...base, prompt: "x", signal: new AbortController().signal, permission: async (ask) => (asked.push(ask.detail), true) }, a.spawn);
    await acpTurn({ ...base, prompt: "x", signal: new AbortController().signal }, a.spawn);
    expect(asked).toEqual(["```sh\ngit push\n```"]);
    expect(answers).toEqual(["yes", "no"]);
  });

  test("/stop sends session/cancel and the turn ends as stopped", async () => {
    const abort = new AbortController();
    const a = fakeAgent({
      async script(s) {
        s.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } });
        abort.abort();
        while (!s.cancelled()) await new Promise((r) => setTimeout(r, 5));
        return "cancelled";
      },
    });
    const r = await acpTurn({ ...base, prompt: "x", signal: abort.signal }, a.spawn);
    expect(r).toMatchObject({ stopped: true, text: "partial" });
    expect(r.failed).toBeUndefined();
  });

  test("links to files on this machine become plain names", () => {
    expect(unlinkLocalFiles("Created [note.txt](file:///private/tmp/x/note.txt) and [docs](https://x.dev).")).toBe("Created `note.txt` and [docs](https://x.dev).");
  });

  test("describing steps and permission cards", () => {
    // Antigravity's own field names.
    expect(describeAction({ kind: "edit", args: { Path: "/w/a.py" } })).toBe("edited a.py");
    expect(describeAction({ kind: "execute", title: "npm test" })).toBe("ran `npm test`");
    expect(describeAction({ kind: "search", title: "grep" })).toBeUndefined();
    expect(permissionAsk({ title: "File note.txt", kind: "edit", content: [{ type: "diff", path: "/w/note.txt", newText: "42\n" } as never] }).detail).toBe("`/w/note.txt`\n```\n42\n\n```");
  });
});

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
  };
}

describe("harness brain over ACP", () => {
  const spec = defineHarness({
    id: "acpfake",
    label: "AcpFake",
    bin: "acpfake",
    modes: [
      { id: "work", label: "Work", description: "" },
      { id: "ask", label: "Ask", description: "" },
    ],
    defaultMode: "work",
    readOnlyMode: "ask",
    args: () => {
      throw new Error("print mode shouldn't run");
    },
    parse: () => ({ text: "" }),
    acp: { args: ["acp"], modes: { work: "auto", ask: "plan" } },
  });

  test("a permission request becomes an Allow / Deny card; the click answers the agent; the reply has the work record", async () => {
    const posted: { brainId: string; approvals?: { id: string; title: string }[] }[] = [];
    let brain!: ReturnType<typeof createHarnessBrain>;
    setBrainPoster(async (brainId, chatKey, reply) => {
      posted.push({ brainId, approvals: reply.approvals });
      // The owner clicks Allow.
      if (reply.approvals?.[0]) setTimeout(() => void brain.resolveApproval!(chatKey, reply.approvals![0].id, true), 0);
    });
    const a = fakeAgent({
      async script(s) {
        const answer = await s.ask({ title: "git push", kind: "execute", rawInput: { command: "git push" } });
        s.update({ sessionUpdate: "tool_call", toolCallId: "p", kind: "execute", status: answer === "yes" ? "completed" : "failed", rawInput: { command: "git push" } });
        s.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer === "yes" ? "Pushed." : "Not pushed." } });
        return "end_turn";
      },
    });
    const ctx = { DATA_DIR: mkdtempSync(join(tmpdir(), "acp-")), chats: fakeChats() } as unknown as PluginContext;
    brain = createHarnessBrain(spec, ctx, { binPath: "/bin/acpfake", acpSpawn: a.spawn });
    const r = await brain.send({ chatKey: "chan", content: "push it", meta: { role: "owner" }, filePaths: [] }, ctx);
    expect(posted[0].brainId).toBe("acpfake");
    expect(posted[0].approvals![0].title).toBe("AcpFake wants to: git push");
    expect(r.text).toBe("Pushed.");
    expect(r.record).toBe("[did: ran `git push`]");
    expect(a.seen.find((m) => m.method === "session/set_mode")?.params?.modeId).toBe("auto");
    setBrainPoster(null as never);
  });

  test("anyone but the owner runs in the read-only mode and can't allow anything", async () => {
    const answers: (string | undefined)[] = [];
    const a = fakeAgent({
      async script(s) {
        answers.push(await s.ask({ title: "rm", kind: "delete" }));
        return "end_turn";
      },
    });
    const ctx = { DATA_DIR: mkdtempSync(join(tmpdir(), "acp-")), chats: fakeChats() } as unknown as PluginContext;
    const brain = createHarnessBrain(spec, ctx, { binPath: "/bin/acpfake", acpSpawn: a.spawn });
    await brain.send({ chatKey: "chan", content: "delete it", meta: { role: "user" }, filePaths: [] }, ctx);
    expect(answers).toEqual(["no"]);
    expect(a.seen.find((m) => m.method === "session/set_mode")?.params?.modeId).toBe("plan");
  });
});
