import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { _resetTurns, recordTurn } from "../lib/caller.ts";
import { addChatNote, takeChatNotes } from "../lib/chat-notes.ts";
import { buildArgv, PipelineError } from "../lib/pipelines/args.ts";
import { _resetPosted, announceJob } from "../lib/pipelines/announce.ts";
import { parsePipelines, type PipelineConfig } from "../lib/pipelines/config.ts";
import { _setRunner } from "../lib/pipelines/index.ts";
import { parseResult, PipelineRunner, type Job } from "../lib/pipelines/runner.ts";
import { pruneByAge, recordThreadFiles, resolveThreadFiles } from "../lib/pipelines/thread-files.ts";
import { pipelineNote } from "../lib/pipelines/thread-mode.ts";
import { pipelineTools, pipelineToolsFor } from "../lib/tools/pipeline-tools.ts";
import { ChatStore } from "../lib/chats/store.ts";
import { Database } from "bun:sqlite";
import type { AppContext } from "../lib/types.ts";

const root = mkdtempSync(join(tmpdir(), "pipelines-"));
const toolDir = join(root, "tool");
mkdirSync(toolDir);
// A stand-in pipeline: prints progress on stderr and one JSON result on stdout.
writeFileSync(
  join(toolDir, "tool.ts"),
  `const [cmd, ...rest] = process.argv.slice(2).filter((a) => a !== "--json");
console.error("progress for " + cmd);
if (cmd === "sleep") await Bun.sleep(Number(rest[0]));
if (cmd === "fail") { console.log(JSON.stringify({ ok: false, problem: "bad thing" })); process.exit(1); }
const pic = ${JSON.stringify(join(toolDir, "sheet.png"))};
if (cmd === "pic") await Bun.write(pic, "png");
console.log(JSON.stringify({ ok: true, cmd, rest, ...(cmd === "pic" ? { show: [pic], next: { say: "Pick one.", show: [pic], waiting: "pick" } } : {}) }));
`
);
const tool: PipelineConfig = { name: "tool", dir: toolDir, command: [process.execPath, "tool.ts"], allow: ["echo", "sleep", "fail", "pic", "deliver"], json: "--json" };

describe("parsePipelines", () => {
  test("keeps valid entries, says why others were skipped", () => {
    const { pipelines, problems } = parsePipelines({
      tool: { dir: toolDir, command: ["./x"], allow: ["next"], json: "--json" },
      Bad: { dir: toolDir, command: ["./x"], allow: ["next"] },
      nodir: { dir: "/no/such/dir", command: ["./x"], allow: ["next"] },
      nocmd: { dir: toolDir, command: [], allow: ["next"] },
      shell: { dir: toolDir, command: ["./x"], allow: ["next; rm"] },
      longabout: { dir: toolDir, command: ["./x"], allow: ["next"], about: "x".repeat(301) },
      described: { dir: toolDir, command: ["./x"], allow: ["next"], about: " Makes characters. " },
    });
    expect([...pipelines.keys()]).toEqual(["tool", "described"]);
    expect(pipelines.get("described")?.about).toBe("Makes characters.");
    expect(problems).toHaveLength(5);
    expect(parsePipelines(undefined).pipelines.size).toBe(0);
  });
});

describe("buildArgv", () => {
  test("program, args, then the json flag", () => {
    expect(buildArgv(tool, ["echo", "a b", "c"])).toEqual([process.execPath, "tool.ts", "echo", "a b", "c", "--json"]);
    expect(buildArgv(tool, ["echo", "--json"])).toEqual([process.execPath, "tool.ts", "echo", "--json"]);
  });

  test("only allowed subcommands, only strings", () => {
    expect(() => buildArgv(tool, ["rm", "-rf"])).toThrow(PipelineError);
    expect(() => buildArgv(tool, [])).toThrow(PipelineError);
    expect(() => buildArgv(tool, "echo hi")).toThrow(PipelineError);
    expect(() => buildArgv(tool, ["echo", 3])).toThrow(PipelineError);
  });

  test("paths stay inside the pipeline's folder or the files folder", () => {
    const files = join(root, "files");
    expect(() => buildArgv(tool, ["echo", "/etc/passwd"])).toThrow(/outside/);
    expect(() => buildArgv(tool, ["echo", "--to=/tmp/x.glb"])).toThrow(/outside/);
    expect(() => buildArgv(tool, ["echo", "~/x"])).toThrow(/outside/);
    expect(() => buildArgv(tool, ["echo", "../../x"])).toThrow(/outside/);
    expect(buildArgv(tool, ["echo", join(toolDir, "sub/file.png"), "a/b", "wait.. ok"])).toContain("a/b");
    expect(buildArgv(tool, ["deliver", "--from", "{files}"], files)).toContain(files);
    expect(() => buildArgv(tool, ["deliver", "--from", "{files}"])).toThrow(/needs files/);
    expect(() => buildArgv({ ...tool, dir: homedir() }, ["echo", "~/x"])).not.toThrow();
  });
});

describe("thread files", () => {
  const data = join(root, "data-threads");

  test("keeps images per chat, hands back the last reply, the user's last, or by message", () => {
    const upload = join(root, "upload.png");
    writeFileSync(upload, "u");
    recordThreadFiles(data, "chat", "m1", "user", [{ path: upload }, { path: join(root, "notes.txt") }], 1000);
    recordThreadFiles(data, "chat", "m2", "brain", [{ name: "a.png", data: new Uint8Array([1]) }, { name: "a.png", data: new Uint8Array([2]) }], 2000);
    recordThreadFiles(data, "chat", "m3", "brain", [{ name: "doc.pdf", data: new Uint8Array([1]) }], 3000);
    const names = (spec: Parameters<typeof resolveThreadFiles>[2], dest: string) =>
      resolveThreadFiles(data, "chat", spec, join(root, dest)).map((p) => p.split("/").pop());
    expect(names("last_reply", "d1")).toEqual(["a.png", "2-a.png"]);
    expect(names("last_mine", "d2")).toEqual(["upload.png"]);
    expect(names(["m2", "m1"], "d3")).toEqual(["upload.png", "a.png", "2-a.png"]);
    expect(() => resolveThreadFiles(data, "other", "last_reply", join(root, "d4"))).toThrow(PipelineError);
    expect(() => resolveThreadFiles(data, "chat", ["nope"], join(root, "d5"))).toThrow(PipelineError);
  });

  test("old entries are pruned", () => {
    const now = 10 * 24 * 60 * 60_000;
    recordThreadFiles(data, "old", "m", "user", [{ name: "x.png", data: new Uint8Array([1]) }], 1);
    recordThreadFiles(data, "new", "m", "user", [{ name: "y.png", data: new Uint8Array([1]) }], now);
    expect(existsSync(join(data, "thread-files", "old"))).toBe(false);
    const dir = join(root, "prune");
    mkdirSync(join(dir, "a"), { recursive: true });
    utimesSync(join(dir, "a"), 1, 1);
    mkdirSync(join(dir, "b"));
    pruneByAge(dir);
    expect(readdirSync(dir)).toEqual(["b"]);
  });
});

describe("PipelineRunner", () => {
  const logs = join(root, "logs");
  const run = (r: PipelineRunner, args: string[]) => r.start(tool, buildArgv(tool, args), args, "chat");

  test("a quick job: JSON result from stdout, progress in the log", async () => {
    const r = new PipelineRunner(logs);
    const job = run(r, ["echo", "hi"]);
    expect(await r.wait(job, 5000)).toBe(true);
    expect(job.state).toBe("done");
    expect(job.result).toMatchObject({ ok: true, cmd: "echo", rest: ["hi"] });
    expect(r.logTail(job)).toContain("progress for echo");
  });

  test("a failure carries the tool's problem", async () => {
    const r = new PipelineRunner(logs);
    const job = run(r, ["fail"]);
    await r.wait(job, 5000);
    expect(job.state).toBe("failed");
    expect(job.error).toBe("bad thing");
  });

  test("one at a time per pipeline; a slow one goes to the background; stop", async () => {
    const ended: string[] = [];
    const r = new PipelineRunner(logs, (j) => void ended.push(`${j.args[0]}:${j.state}:${j.background ? "bg" : "fg"}`));
    const slow = run(r, ["sleep", "5000"]);
    const quick = run(r, ["echo"]);
    expect(quick.state).toBe("queued");
    expect(await r.wait(slow, 50)).toBe(false);
    expect(slow.background).toBe(true);
    expect(r.stop(slow.id)).toBe(true);
    expect(await r.wait(quick, 5000)).toBe(true);
    expect(ended).toEqual(["sleep:stopped:bg", "echo:done:fg"]);
    expect(r.stop(quick.id)).toBe(false);
  });

  test("parseResult: whole stdout, or its last JSON line", () => {
    expect(parseResult('{"ok":true}')).toEqual({ ok: true });
    expect(parseResult('noise\n{"ok":false}\n')).toEqual({ ok: false });
    expect(parseResult("no json")).toBeUndefined();
  });
});

describe("chat notes", () => {
  test("delivered once, as one block", () => {
    addChatNote("c", "job 1 done");
    addChatNote("c", "job 2 failed");
    const block = takeChatNotes("c")!;
    expect(block).toContain("- job 1 done\n- job 2 failed");
    expect(block).toContain("not the user");
    expect(takeChatNotes("c")).toBeUndefined();
  });
});

type Sent = { content?: string; files?: { name: string }[] };
const fakeChannel = () => {
  const sent: Sent[] = [];
  return { sent, channel: { send: async (m: Sent) => (sent.push(m), { id: "x" }) } };
};

describe("announceJob", () => {
  beforeEach(() => _resetPosted());
  const pic = join(root, "shown.png");
  writeFileSync(pic, "p");
  const job = (over: Partial<Job>): Job =>
    ({ id: "j", pipeline: "tool", args: ["pic"], argv: [], chatId: "c", state: "done", queuedAt: 0, logPath: "", result: { ok: true, show: [pic], next: { say: "Pick one." } }, ...over }) as Job;

  test("new pictures are posted once, with the next step", async () => {
    const { sent, channel } = fakeChannel();
    await announceJob(channel, job({}));
    await announceJob(channel, job({}));
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toBe("Pick one.");
    expect(sent[0].files?.map((f) => f.name)).toEqual(["shown.png"]);
  });

  test("a background job's end is always posted", async () => {
    const { sent, channel } = fakeChannel();
    await announceJob(channel, job({ background: true, result: { ok: true }, startedAt: 0, endedAt: 61_000 }));
    expect(sent[0].content).toBe("✅ tool `pic` finished in 1m 1s");
  });
});

describe("pipeline tools", () => {
  const data = join(root, "data-tools");
  mkdirSync(data, { recursive: true });
  const { sent, channel } = fakeChannel();
  const ctx = {
    DATA_DIR: data,
    config: { getPipelines: () => new Map([["tool", tool]]) },
    discord: { channels: { fetch: async () => channel } },
  } as unknown as AppContext;
  const call = (action: string, args: Record<string, unknown>) => pipelineTools[0].handler({ action, chat_id: "c1", ...args }, ctx, { via: "local" });
  const textOf = (r: Awaited<ReturnType<typeof call>>) => (r.content[0] as { text: string }).text;

  beforeEach(() => {
    _resetTurns();
    _resetPosted();
    _setRunner(null);
    sent.length = 0;
    recordTurn({ chat_id: "c1", role: "owner" });
  });
  afterEach(() => _setRunner(null));

  test("runs inline, returns the result, posts the pictures", async () => {
    const r = await call("run", { pipeline: "tool", args: ["pic"] });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('"cmd": "pic"');
    expect(sent[0].files?.map((f) => f.name)).toEqual(["sheet.png"]);
  });

  test("hands the chat's pictures over with {files}", async () => {
    recordThreadFiles(data, "c1", "m9", "brain", [{ name: "v1.png", data: new Uint8Array([1]) }]);
    const t = textOf(await call("run", { pipeline: "tool", args: ["deliver", "--from", "{files}"], files: "last_reply" }));
    expect(t).toContain(join(data, "pipeline-files"));
  });

  test("refuses: not the owner, unknown pipeline, disallowed command", async () => {
    recordTurn({ chat_id: "c1", role: "user" });
    expect(textOf(await call("run", { pipeline: "tool", args: ["echo"] }))).toContain("owner only");
    recordTurn({ chat_id: "c1", role: "owner" });
    expect((await call("run", { pipeline: "nope", args: ["echo"] })).isError).toBe(true);
    expect((await call("run", { pipeline: "tool", args: ["rm"] })).isError).toBe(true);
  });

  test("status lists the configured pipelines and recent jobs", async () => {
    await call("run", { pipeline: "tool", args: ["echo"] });
    const t = textOf(await call("status", {}));
    expect(t).toContain("pipelines: tool");
    expect(t).toContain("✅ tool `echo` finished");
  });
});

describe("pipelineToolsFor", () => {
  const ctxWith = (names: string[]) =>
    ({ config: { getPipelines: () => new Map(names.map((name) => [name, { name }])) } }) as unknown as AppContext;

  test("no pipelines configured: no tool (its name would sit in every session)", () => {
    expect(pipelineToolsFor(ctxWith([]))).toEqual([]);
  });

  test("configured: one tool, the pipelines as its choices", () => {
    const tools = pipelineToolsFor(ctxWith(["lochara", "render"]));
    expect(tools.map((t) => t.definition.name)).toEqual(["pipeline"]);
    expect(tools[0].definition.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false }); // changes things, asks once
    expect((tools[0].definition.inputSchema as { properties: { pipeline: { enum: string[] } } }).properties.pipeline.enum).toEqual(["lochara", "render"]);
  });

  test("an unknown action is refused", async () => {
    recordTurn({ chat_id: "c1", role: "owner" });
    const r = await pipelineTools[0].handler({ action: "explode", chat_id: "c1" }, ctxWith(["x"]), { via: "local" });
    expect(r.isError).toBe(true);
  });
});

describe("thread pipeline note", () => {
  const chats = new ChatStore(new Database(":memory:"));
  const ctx = { chats, config: { getPipelines: () => new Map([["tool", { ...tool, about: "Makes things." }]]) } } as unknown as AppContext;

  test("told once per chat, again in a new chat, never off a pipeline", () => {
    expect(pipelineNote(ctx, "thread", "chat-a")).toBeUndefined();
    chats.setPipeline("thread", "tool");
    const note = pipelineNote(ctx, "thread", "chat-a")!;
    expect(note).toContain("the owner ran /pipeline tool here");
    expect(note).toContain("Makes things.");
    expect(note).toContain("`pipeline` tool on the choomfie connector");
    expect(note).toContain('chat_id "thread"'); // a web brain never sees the Discord id otherwise
    expect(note).not.toContain("not the user"); // read as an injection and ignored
    expect(pipelineNote(ctx, "thread", "chat-a")).toBeUndefined();
    expect(pipelineNote(ctx, "thread", "chat-b")).toBeDefined();
    chats.setPipeline("thread", "tool"); // put on again: told again
    expect(pipelineNote(ctx, "thread", "chat-b")).toBeDefined();
    chats.setPipeline("thread", null);
    expect(pipelineNote(ctx, "thread", "chat-c")).toBeUndefined();
  });

  test("a pipeline since removed from the config says nothing", () => {
    chats.setPipeline("other", "gone");
    expect(pipelineNote(ctx, "other", "chat-a")).toBeUndefined();
  });
});
