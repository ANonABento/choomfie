import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buttonHandlers, modalHandlers } from "@choomfie/shared";
import { _resetPosted } from "../lib/pipelines/announce.ts";
import { _resetCards, actionsFor, buttonRows, cardText, type CardAction, type Step } from "../lib/pipelines/cards.ts";
import type { PipelineConfig } from "../lib/pipelines/config.ts";
import { _setRunner, pipelineRunner, startCardJob } from "../lib/pipelines/index.ts";
import { recordThreadFiles } from "../lib/pipelines/thread-files.ts";
import { pipelineNoteText } from "../lib/pipelines/thread-mode.ts";
import type { AppContext } from "../lib/types.ts";

/** Real `lochara next --json` results (and hand-made ones in its format for stages no character is at). */
const FIXTURES = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "lochara-steps.json"), "utf-8")) as Record<string, { next: Step }>;
const step = (name: string) => FIXTURES[name].next;
const summary = (actions: CardAction[]) => actions.map((a) => [a.label, a.args.join(" "), a.pictures ? "pictures" : (a.modal ?? "")]);

describe("actionsFor (lochara steps)", () => {
  test("start: a button per character, then New (asks for a name)", () => {
    const a = summary(actionsFor(step("start")));
    expect(a.at(-1)).toEqual(["➕ New character", "new <name>", "name"]);
    expect(a.slice(0, -1).every(([l, args]) => args === `next ${l}`)).toBe(true);
    expect(summary(actionsFor(step("start-empty")))).toEqual([["➕ New character", "new <name>", "name"]]);
  });

  test("art: choose pictures (a pop-up), or skip to the body", () => {
    expect(summary(actionsFor(step("art")))).toEqual([
      ["🖼 Choose pictures", "concept mika3 --from {files}", "pictures"],
      ["⏭ Skip: pick a sample body", "next mika3 --at base", ""],
    ]);
    expect(cardText(step("art"))).toStartWith("**mika3** · **Art** › Body › Build › Review\n");
  });

  test("base pick: the options filled in, then back to the art", () => {
    const a = summary(actionsFor(step("base-pick")));
    expect(a[0]).toEqual(["sample-d", "base mika3 sample-d", ""]);
    expect(a.at(-1)).toEqual(["← Art", "next mika3 --at art", ""]);
  });

  test("run steps: the pipeline's label, then the way back", () => {
    expect(summary(actionsFor(step("build-run")))).toEqual([
      ["▶ Build the 3D model", "build aiko", ""],
      ["← Art", "next aiko --at art", ""],
      ["← Body", "next aiko --at base", ""],
    ]);
    expect(summary(actionsFor(step("render-run")))[0]).toEqual(["▶ Make preview pictures", "render aiko", ""]);
    expect(summary(actionsFor(step("missing")))).toEqual([["➕ Make zz-nobody", "new zz-nobody", ""]]);
    expect(actionsFor({ waiting: "run", run: { next: ["x", "y"] } })[0].label).toBe("▶ x y"); // no label given
  });

  test("approve: what approves is green; without targets only the way back", () => {
    const a = actionsFor(step("approve-export"));
    expect(a.map((x) => [x.label, x.style])).toEqual([["📦 Export", "success"], ["← Art", "secondary"], ["← Body", "secondary"]]);
    expect(summary(actionsFor(step("approve-no-export"))).map(([l]) => l)).toEqual(["← Art", "← Body"]);
    expect(cardText(step("done"))).toContain("✓ Art › ✓ Body › ✓ Build › ✓ Review");
  });

  test("part pick: options, then draw new ones", () => {
    expect(summary(actionsFor(step("part-pick"))).slice(0, 3)).toEqual([
      ["h1", "part pick aiko visor h1", ""],
      ["s12", "part pick aiko visor s12", ""],
      ["🔁 Draw new options", "part draw aiko visor", ""],
    ]);
  });

  test("a picture request: choose pictures for it; its prompt is quoted", () => {
    expect(summary(actionsFor(step("pictures")))).toEqual([["🖼 Choose pictures", `deliver aiko ${(step("pictures").request as { id: string }).id} --from {files}`, "pictures"]]);
    expect(cardText(step("pictures"))).toContain("> a sci-fi visor, front view");
  });

  test("input: done, continue (and the way back)", () => {
    expect(summary(actionsFor(step("part-input")))[0]).toEqual(["✅ Placed it, continue", "next aiko", ""]);
  });

  test("every fixture: no placeholder left but a <name> behind a pop-up", () => {
    for (const [name, f] of Object.entries(FIXTURES)) {
      for (const a of actionsFor(f.next)) {
        for (const arg of a.args) {
          if (/^<[^>]+>$/.test(arg)) expect([name, arg, a.modal]).toEqual([name, "<name>", "name"]);
        }
      }
    }
  });

  test("a template nobody can fill gets no button", () => {
    expect(actionsFor({ waiting: "run", run: { next: ["x", "<who>"] } })).toEqual([]);
  });

  test("Discord limits: 20 options, 25 buttons, 80-char labels, 1900-char text", () => {
    const many: Step = { character: "a", waiting: "pick", say: "x".repeat(3000), options: Array.from({ length: 30 }, (_, i) => `o${i}`), run: { pick: ["p", "<option>"] } };
    const a = actionsFor(many);
    expect(a.filter((x) => x.style === "primary")).toHaveLength(20);
    expect(a.length).toBeLessThanOrEqual(25);
    const text = cardText({ ...many, say: "Pick." });
    expect(text).toContain("+10 more not shown");
    expect(cardText(many).length).toBeLessThanOrEqual(1900);
    expect(actionsFor({ waiting: "run", run: { next: ["x".repeat(200)] } })[0].label).toHaveLength(80);
  });

  test("buttons: lc:<card>:<i>, five a row", () => {
    const acts = actionsFor(step("part-pick")).concat(actionsFor(step("build-run")));
    const rows = buttonRows("k1", acts).map((r) => r.toJSON());
    expect(rows.map((r) => r.components.length)).toEqual([5, 3]);
    expect((rows[1].components[0] as { custom_id: string }).custom_id).toBe("lc:k1:5");
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
if (cmd === "next") out({ next: { character: "a", waiting: "pick", say: "Pick one.", options: ["x", "y"], run: { pick: ["pick", "<option>"], new: ["new", "<name>"], art: ["concept", "a", "--from", "<folder>"] }, labels: { new: "➕ New", art: "🖼 Art" } } });
else if (cmd === "concept") { const { readdirSync } = await import("node:fs"); out({ next: { character: "a", waiting: "done", say: "Got " + readdirSync(rest[2]).sort().join(", ") + "." } }); }
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
  discord: { channels: { fetch: async () => channel }, user: { displayName: "Mahiro" } },
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
    fields: {
      getTextInputValue: () => "",
      getStringSelectValues: (): readonly string[] => [],
      getUploadedFiles: (): Map<string, { name: string; url: string }> | null => null,
    },
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
    await startCardJob(ctx, "tool", "c", ["next"]);
    await settle();
    const first = { ...sent[0], id: "m1" };
    expect(first.content).toBe("Pick one.");
    expect(buttons(first).map(([, l]) => l)).toEqual(["x", "y", "➕ New", "🖼 Art"]);

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
    expect(lastCard().components).toHaveLength(1);

    const again = await click(idFor(first, "x"), first); // the old card
    expect(ephemeralText(again)).toContain("older card");
  });

  test("Stop stops the job a click started; the card says so", async () => {
    await startCardJob(ctx, "tool", "c", ["pick", "x"]);
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
    await startCardJob(ctx, "tool", "c", ["next"]);
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
    await startCardJob(ctx, "tool", "c", ["next"]);
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

  test("New: a name, then its command runs", async () => {
    await startCardJob(ctx, "tool", "c", ["next"]);
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
    expect(sent.at(-1)!.content).toBe("Made mika3.");
  });

  test("pictures: the pop-up lists the thread's posts (newest picked); posts and uploads both go", async () => {
    recordThreadFiles(data, "c", "m8", "user", [{ name: "mine.png", data: new Uint8Array([1]) }], Date.now() - 3 * 60_000);
    recordThreadFiles(data, "c", "m9", "brain", [{ name: "a.png", data: new Uint8Array([1]) }, { name: "b.png", data: new Uint8Array([2]) }]);
    await startCardJob(ctx, "tool", "c", ["next"]);
    await settle();
    const first = { ...lastCard(), id: `m${sent.length}` };
    const artId = idFor(first, "🖼 Art");
    const opened = await click(artId, first);
    const modal = (opened.calls.showModal[0] as { toJSON(): { components: { component: { options?: { label: string; default?: boolean }[] } }[] } }).toJSON();
    expect(modal.components).toHaveLength(2);
    expect(modal.components[0].component.options!.map((o) => [o.label, !!o.default])).toEqual([
      ["Mahiro · 2 pictures · just now", true],
      ["You · 1 picture · 3 min ago", false],
    ]);

    const [, card, index] = artId.split(":");
    const none = interaction(`lcpics:${card}:${index}`, first);
    await modalHandlers.get("lcpics")!(none as never, ["lcpics", card, index], ctx as never);
    expect(ephemeralText(none)).toContain("Nothing chosen");

    const i = interaction(`lcpics:${card}:${index}`, first);
    i.fields.getStringSelectValues = () => ["m8", "m9"];
    i.fields.getUploadedFiles = () => new Map([["u1", { name: "ref photo.png", url: "data:image/png;base64,AA==" }]]);
    await modalHandlers.get("lcpics")!(i as never, ["lcpics", card, index], ctx as never);
    expect((i.calls.update[0] as Msg).content).toContain("⏳ `concept a --from {files}`");
    await settle();
    expect(sent.at(-1)!.content).toBe("Got a.png, b.png, mine.png, upload-1-ref_photo.png.");
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
