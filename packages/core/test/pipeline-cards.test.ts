import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buttonHandlers, modalHandlers } from "@choomfie/shared";
import { _resetPosted } from "../lib/pipelines/announce.ts";
import { _resetCards, actionsFor, buttonRows, cardText, newCharacterActions, type CardAction, type Step } from "../lib/pipelines/cards.ts";
import type { PipelineConfig } from "../lib/pipelines/config.ts";
import { _setRunner, pipelineRunner, startCardJob } from "../lib/pipelines/index.ts";
import { recordThreadFiles } from "../lib/pipelines/thread-files.ts";
import { pipelineNoteText } from "../lib/pipelines/thread-mode.ts";
import type { AppContext } from "../lib/types.ts";

/** Real `lochara next --json` results (and hand-made ones in its format for stages no character is at). */
const FIXTURES = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "lochara-steps.json"), "utf-8")) as Record<string, { next: Step }>;
const step = (name: string) => FIXTURES[name].next;
const summary = (actions: CardAction[]) => actions.map((a) => [a.label, a.args.join(" "), a.files ?? a.modal ?? ""]);
const BOTH = { last_mine: true, last_reply: true };

describe("actionsFor (lochara steps)", () => {
  test("start: a button per character, New asks for a name", () => {
    expect(summary(actionsFor(step("start")))).toEqual([
      ["aiko", "next aiko", ""],
      ["mika", "next mika", ""],
      ["mika2", "next mika2", ""],
      ["basic", "next basic", ""],
      ["robot-maid", "next robot-maid", ""],
      ["➕ New", "new <name>", "name"],
      ["🔄 Check again", "next", ""],
    ]);
    expect(summary(actionsFor(step("start-empty")))).toEqual([["➕ New", "new <name>", "name"], ["🔄 Check again", "next", ""]]);
  });

  test("base pick: the options filled in; designs from the thread when it has pictures", () => {
    const a = actionsFor(step("base-pick"), { last_reply: true });
    expect(summary(a)).toEqual([
      ["sample-d", "base mika2 sample-d", ""],
      ["sample-d-dark", "base mika2 sample-d-dark", ""],
      ["sample-e", "base mika2 sample-e", ""],
      ["sample-f", "base mika2 sample-f", ""],
      ["sample-g", "base mika2 sample-g", ""],
      ["🖼 Add designs: bot's pictures", "concept mika2 --from {files}", "last_reply"],
      ["🔄 Check again", "next mika2", ""],
    ]);
  });

  test("run steps: one button with the command", () => {
    expect(summary(actionsFor(step("render-run")))[0]).toEqual(["▶ render basic", "render basic", ""]);
    expect(summary(actionsFor(step("build-run")))[0]).toEqual(["▶ build aiko", "build aiko", ""]);
    expect(summary(actionsFor(step("missing")))[0]).toEqual(["▶ new zz-nobody", "new zz-nobody", ""]);
  });

  test("approve: export when there are targets, always check again", () => {
    expect(summary(actionsFor(step("approve-export")))).toEqual([["📦 Export", "export aiko", ""], ["🔄 Check again", "next aiko", ""]]);
    expect(summary(actionsFor(step("approve-no-export")))).toEqual([["🔄 Check again", "next aiko", ""]]);
  });

  test("part pick: options, then Redraw", () => {
    expect(summary(actionsFor(step("part-pick"))).slice(0, 3)).toEqual([
      ["h1", "part pick aiko visor h1", ""],
      ["s12", "part pick aiko visor s12", ""],
      ["🔁 Redraw", "part draw aiko visor", ""],
    ]);
  });

  test("pictures: deliver from each kind of picture the thread has, <folder> as {files}", () => {
    expect(summary(actionsFor(step("pictures")))).toEqual([["🔄 Check again", "next aiko", ""]]);
    expect(summary(actionsFor(step("pictures"), BOTH))).toEqual([
      ["📎 My pictures → deliver", "deliver aiko part-visor-1 --from {files}", "last_mine"],
      ["🎨 Bot's pictures → deliver", "deliver aiko part-visor-1 --from {files}", "last_reply"],
      ["🔄 Check again", "next aiko", ""],
    ]);
    expect(cardText(step("pictures"))).toContain("> a sci-fi visor, front view");
  });

  test("input and done: check again only", () => {
    expect(summary(actionsFor(step("part-input")))).toEqual([["🔄 Check again", "next aiko", ""]]);
    expect(summary(actionsFor(step("done")))).toEqual([["🔄 Check again", "next aiko", ""]]);
  });

  test("every fixture: no placeholder left but a <name> behind a pop-up", () => {
    for (const [name, f] of Object.entries(FIXTURES)) {
      for (const a of actionsFor(f.next, BOTH)) {
        for (const arg of a.args) {
          if (/^<[^>]+>$/.test(arg)) expect([name, arg, a.modal]).toEqual([name, "<name>", "name"]);
        }
      }
    }
  });

  test("a template nobody can fill gets no button", () => {
    expect(summary(actionsFor({ waiting: "run", run: { next: ["x", "<who>"] } }))).toEqual([["🔄 Check again", "next", ""]]);
  });

  test("Discord limits: 20 options, 25 buttons, 80-char labels, 1900-char text", () => {
    const many: Step = { character: "a", waiting: "pick", say: "x".repeat(3000), options: Array.from({ length: 30 }, (_, i) => `o${i}`), run: { pick: ["p", "<option>"] } };
    const a = actionsFor(many, BOTH);
    expect(a.filter((x) => x.style === "primary")).toHaveLength(20);
    expect(a.length).toBeLessThanOrEqual(25);
    const text = cardText({ ...many, say: "Pick." });
    expect(text).toContain("+10 more not shown");
    expect(cardText(many).length).toBeLessThanOrEqual(1900);
    expect(actionsFor({ waiting: "run", run: { next: ["x".repeat(200)] } })[0].label).toHaveLength(80);
  });

  test("buttons: lc:<card>:<i>, five a row", () => {
    const rows = buttonRows("k1", actionsFor(step("start"))).map((r) => r.toJSON());
    expect(rows.map((r) => r.components.length)).toEqual([5, 2]);
    expect((rows[1].components[0] as { custom_id: string }).custom_id).toBe("lc:k1:5");
  });

  test("a new character: from the thread's pictures, or without designs", () => {
    expect(summary(newCharacterActions(["new", "<name>"], "mika3", { last_reply: true }))).toEqual([
      ["🎨 Bot's pictures as designs", "new mika3 --from {files}", "last_reply"],
      ["⏭ No designs", "new mika3", ""],
    ]);
  });
});

// --- Clicks, against a stand-in pipeline ---

const root = mkdtempSync(join(tmpdir(), "cards-"));
const toolDir = join(root, "tool");
mkdirSync(toolDir);
writeFileSync(
  join(toolDir, "tool.ts"),
  `const [cmd, ...rest] = process.argv.slice(2).filter((a) => a !== "--json");
const out = (o) => console.log(JSON.stringify({ ok: true, cmd, rest, ...o }));
if (cmd === "next") out({ next: { character: "a", waiting: "pick", say: "Pick one.", options: ["x", "y"], run: { pick: ["pick", "<option>"], new: ["new", "<name>"] } } });
else if (cmd === "pick") out({ next: { character: "a", waiting: "run", say: "Build it.", run: { next: ["sleep", "3000"] } } });
else if (cmd === "sleep") { await Bun.sleep(Number(rest[0])); out({}); }
else if (cmd === "new") out({ next: { character: rest[0], waiting: "done", say: "Made " + rest.join(" ") + "." } });
else { console.log(JSON.stringify({ ok: false, problem: "bad thing" })); process.exit(1); }
`
);
const tool: PipelineConfig = { name: "tool", dir: toolDir, command: [process.execPath, "tool.ts"], allow: ["next", "pick", "sleep", "new", "fail", "concept"], json: "--json" };

type Msg = { content?: string; components?: { toJSON(): { components: { custom_id: string; label: string }[] } }[] };
const sent: Msg[] = [];
const edits: { id: string; edit: Msg }[] = [];
const channel = {
  send: async (m: Msg) => (sent.push(m), { id: `m${sent.length}` }),
  messages: { edit: async (id: string, edit: Msg) => edits.push({ id, edit }) },
};
const data = join(root, "data");
mkdirSync(data);
const ctx = {
  DATA_DIR: data,
  ownerUserId: "owner",
  config: { getPipelines: () => new Map([["tool", tool]]) },
  discord: { channels: { fetch: async () => channel } },
  chats: { pipelineAt: () => ({ pipeline: "tool" }) },
} as unknown as AppContext;

/** The buttons of a sent card: [custom id, label]. */
const buttons = (m: Msg) => (m.components ?? []).flatMap((r) => r.toJSON().components.map((c) => [c.custom_id, c.label] as const));
const lastCard = () => sent.findLast((m) => m.components?.length)!;
const idFor = (m: Msg, label: string) => buttons(m).find(([, l]) => l === label)![0];

function interaction(customId: string, message: Msg & { id: string }, user = "owner") {
  const calls: Record<string, unknown[]> = { update: [], reply: [], followUp: [], editReply: [], showModal: [], deferUpdate: [] };
  const i = {
    customId,
    channelId: "c",
    user: { id: user },
    message: { ...message, components: [] },
    replied: false,
    deferred: false,
    calls,
    update: async (o: unknown) => (calls.update.push(o), (i.replied = true)),
    reply: async (o: unknown) => (calls.reply.push(o), (i.replied = true)),
    followUp: async (o: unknown) => calls.followUp.push(o),
    editReply: async (o: unknown) => calls.editReply.push(o),
    showModal: async (o: unknown) => calls.showModal.push(o),
    deferUpdate: async () => (calls.deferUpdate.push(1), (i.deferred = true)),
    isFromMessage: () => true,
    fields: { getTextInputValue: () => "" },
  };
  return i;
}

async function click(customId: string, message: Msg & { id: string }, user?: string) {
  const i = interaction(customId, message, user);
  await buttonHandlers.get(customId.split(":")[0])!(i as never, customId.split(":"), ctx as never);
  return i;
}

async function submitName(customId: string, name: string, message: Msg & { id: string }) {
  const i = interaction(customId, message);
  i.fields.getTextInputValue = () => name;
  await modalHandlers.get("lcname")!(i as never, customId.split(":"), ctx as never);
  return i;
}

/** Wait for every job to end (and post what it posts). */
async function settle() {
  const r = pipelineRunner(ctx);
  for (const j of r.list()) await r.wait(j, 10_000);
}

const ephemeralText = (i: ReturnType<typeof interaction>) => [...i.calls.reply, ...i.calls.followUp].map((o) => (o as { content: string }).content).join(" ");

describe("step card clicks", () => {
  beforeAll(async () => {
    await import("../lib/handlers/pipeline-cards.ts");
  });
  beforeEach(() => {
    _setRunner(null);
    _resetCards();
    _resetPosted();
    sent.length = 0;
    edits.length = 0;
  });
  afterEach(() => _setRunner(null));

  test("start → pick → run, each click edits its card and posts the next", async () => {
    startCardJob(ctx, "tool", "c", ["next"]);
    await settle();
    const first = { ...sent[0], id: "m1" };
    expect(first.content).toBe("Pick one.");
    expect(buttons(first).map(([, l]) => l)).toEqual(["x", "y", "➕ New", "🔄 Check again"]);

    const i = await click(idFor(first, "y"), first);
    const update = i.calls.update[0] as Msg;
    expect(update.content).toBe("Pick one.\n⏳ `pick y`");
    expect(buttons(update).map(([, l]) => l)).toEqual(["⏹ Stop"]);
    await settle();
    expect(edits[0].id).toBe("m1");
    expect(edits[0].edit.content).toMatch(/^Pick one\.\n✅ tool `pick y` finished in \d+s$/);
    expect(edits[0].edit.components).toEqual([]);
    expect(lastCard().content).toBe("Build it.");
    expect(buttons(lastCard())[0][1]).toBe("▶ sleep 3000");

    const again = await click(idFor(first, "x"), first); // the old card
    expect(ephemeralText(again)).toContain("older card");
  });

  test("Stop stops the job a click started; the card says so", async () => {
    startCardJob(ctx, "tool", "c", ["pick", "x"]);
    await settle();
    const card = { ...lastCard(), id: `m${sent.length}` };
    const run = await click(idFor(card, "▶ sleep 3000"), card);
    const stopId = buttons(run.calls.update[0] as Msg)[0][0];
    const stop = await click(stopId, card);
    expect(stop.calls.deferUpdate).toHaveLength(1);
    // stop() marks the job stopped before it has ended: wait for its end to be posted.
    for (let n = 0; n < 200 && !edits.length; n++) await Bun.sleep(10);
    expect(edits.at(-1)!.edit.content).toContain("⏹️ tool `sleep 3000` stopped");
  });

  test("only the owner", async () => {
    startCardJob(ctx, "tool", "c", ["next"]);
    await settle();
    const i = await click(idFor(sent[0], "x"), { ...sent[0], id: "m1" }, "someone");
    expect(ephemeralText(i)).toContain("Only the owner");
    expect(i.calls.update).toHaveLength(0);
  });

  test("a card from before a restart shows where things stand", async () => {
    const i = await click("lc:gone:0", { id: "m0", content: "old" });
    expect(i.calls.update).toEqual([{ components: [] }]);
    expect(ephemeralText(i)).toContain("before a restart");
    await settle();
    expect(lastCard().content).toBe("Pick one.");
  });

  test("a command that can't run gives the buttons back, with why", async () => {
    startCardJob(ctx, "tool", "c", ["next"]);
    await settle();
    const first = { ...sent[0], id: "m1" };
    const { getCard } = await import("../lib/pipelines/cards.ts");
    const card = getCard(idFor(first, "x").split(":")[1])!;
    card.actions[0] = { label: "x", style: "primary", args: ["rm", "-rf"] };
    const i = await click(idFor(first, "x"), first);
    expect((i.calls.editReply[0] as Msg).content).toContain("isn't allowed");
    const retry = await click(idFor(first, "y"), first); // still the newest card
    expect(retry.calls.update).toHaveLength(1);
    await settle();
  });

  test("New: a name, then straight on when the thread has no pictures", async () => {
    startCardJob(ctx, "tool", "c", ["next"]);
    await settle();
    const first = { ...sent[0], id: "m1" };
    const newId = idFor(first, "➕ New");
    const i = await click(newId, first);
    expect(i.calls.showModal).toHaveLength(1);
    const [, card, index] = newId.split(":");
    expect(ephemeralText(await submitName(`lcname:${card}:${index}`, "3d!", first))).toContain("won't do");
    const ok = await submitName(`lcname:${card}:${index}`, "Mika3", first);
    expect((ok.calls.update[0] as Msg).content).toContain("⏳ `new mika3`");
    await settle();
    expect(lastCard().content).toBe("Made mika3.");
  });

  test("New with pictures in the thread: start from them, or without designs", async () => {
    recordThreadFiles(data, "c", "m9", "brain", [{ name: "d1.png", data: new Uint8Array([1]) }]);
    startCardJob(ctx, "tool", "c", ["next"]);
    await settle();
    const first = { ...lastCard(), id: `m${sent.length}` };
    const [, card, index] = idFor(first, "➕ New").split(":");
    await submitName(`lcname:${card}:${index}`, "mika4", first);
    const design = { ...lastCard(), id: `m${sent.length}` };
    expect(design.content).toContain("New character **mika4**");
    expect(buttons(design).map(([, l]) => l)).toEqual(["🎨 Bot's pictures as designs", "⏭ No designs"]);
    await click(idFor(design, "🎨 Bot's pictures as designs"), design);
    await settle();
    expect(lastCard().content).toMatch(/^Made mika4 --from .*pipeline-files.*\.$/);
  });

  test("a step run by a brain's tool call in the thread ends in a card too", async () => {
    const r = pipelineRunner(ctx);
    r.start(tool, [...tool.command, "pick", "y", "--json"], ["pick", "y"], "c");
    await settle();
    expect(lastCard().content).toMatch(/^✅ tool `pick y` finished in \d+s\nBuild it\.$/);
  });
});

describe("pipeline note for a brain elsewhere", () => {
  test("Waymond is told the owner clicks the steps, and to draw", () => {
    const note = pipelineNoteText({ ...tool, about: "Makes things." }, "t1", true);
    expect(note).toContain("the owner ran /pipeline tool here");
    expect(note).toContain("don't call the pipeline tool");
    expect(note).toContain("post the pictures in your reply");
    expect(note).not.toContain("chat_id");
  });
});
