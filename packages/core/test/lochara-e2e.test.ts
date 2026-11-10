/**
 * The whole lochara flow by clicking, against a real lochara checkout: start →
 * ➕ New (a name) → a base → Build → Render → review. Each card's buttons must
 * be exactly what `lochara next` offers at that point. Slow (it builds), so
 * opt-in:
 *
 *   LOCHARA_E2E=~/lochara bun test packages/core/test/lochara-e2e.test.ts
 *
 * Makes and then deletes characters/zz-cardtest in that checkout.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buttonHandlers, modalHandlers } from "@choomfie/shared";
import { actionsFor, type Step } from "../lib/pipelines/cards.ts";
import type { PipelineConfig } from "../lib/pipelines/config.ts";
import { _setRunner, pipelineRunner, startCardJob } from "../lib/pipelines/index.ts";
import type { AppContext } from "../lib/types.ts";

const DIR = process.env.LOCHARA_E2E?.replace(/^~/, process.env.HOME ?? "");
const NAME = "zz-cardtest";
const BUILD_MS = 15 * 60_000;

const lochara: PipelineConfig = {
  name: "lochara",
  dir: DIR ?? "",
  command: ["./lochara"],
  allow: ["new", "base", "next", "requests", "concept", "part", "deliver", "build", "check", "render", "export"],
  json: "--json",
};

type Msg = { content?: string; components?: { toJSON(): { components: { custom_id: string; label: string }[] } }[] };
const sent: Msg[] = [];
const channel = { send: async (m: Msg) => (sent.push(m), { id: `m${sent.length}` }), messages: { edit: async () => {} } };
const ctx = {
  DATA_DIR: mkdtempSync(join(tmpdir(), "lochara-e2e-")),
  ownerUserId: "owner",
  config: { getPipelines: () => new Map([["lochara", lochara]]) },
  discord: { channels: { fetch: async () => channel } },
  chats: { pipelineAt: () => ({ pipeline: "lochara" }) },
} as unknown as AppContext;

const buttons = (m: Msg) => (m.components ?? []).flatMap((r) => r.toJSON().components.map((c) => [c.custom_id, c.label] as const));
const card = () => {
  const m = sent.findLast((x) => x.components?.length)!;
  return { ...m, id: `m${sent.lastIndexOf(m) + 1}` };
};
const idFor = (m: Msg, label: string) => {
  const b = buttons(m).find(([, l]) => l === label);
  if (!b) throw new Error(`no "${label}" button on: ${m.content}\n${buttons(m).map(([, l]) => l).join(" | ")}`);
  return b[0];
};

function interaction(customId: string, message: Msg & { id: string }, name = "") {
  return {
    customId,
    channelId: "c",
    user: { id: "owner" },
    message: { ...message, components: [] },
    replied: false,
    deferred: false,
    update: async () => {},
    reply: async (o: { content: string }) => {
      throw new Error(`refused: ${o.content}`);
    },
    followUp: async (o: { content: string }) => {
      throw new Error(`refused: ${o.content}`);
    },
    editReply: async (o: { content: string }) => {
      throw new Error(`couldn't run: ${o.content}`);
    },
    showModal: async () => {},
    deferUpdate: async () => {},
    isFromMessage: () => true,
    fields: { getTextInputValue: () => name },
  };
}

async function settle() {
  const r = pipelineRunner(ctx);
  for (const j of r.list()) await r.wait(j, BUILD_MS);
}

async function press(label: string) {
  const m = card();
  const id = idFor(m, label);
  await buttonHandlers.get("lc")!(interaction(id, m) as never, id.split(":"), ctx as never);
  await settle();
}

/** What `lochara next` says now, straight from the tool. */
function next(name?: string): Step {
  const r = Bun.spawnSync(["./lochara", "next", ...(name ? [name] : []), "--json"], { cwd: DIR });
  return JSON.parse(r.stdout.toString()).next;
}

/** The newest card offers exactly what lochara does (no thread pictures here, so no picture buttons). */
function matchesNext(name?: string) {
  expect(buttons(card()).map(([, l]) => l)).toEqual(actionsFor(next(name)).map((a) => a.label));
}

beforeAll(async () => {
  await import("../lib/handlers/pipeline-cards.ts");
  _setRunner(null);
});
afterAll(() => {
  if (DIR) rmSync(join(DIR, "characters", NAME), { recursive: true, force: true });
});

test.skipIf(!DIR)(
  "lochara by clicking: new character → base → build → render → review",
  async () => {
    rmSync(join(DIR!, "characters", NAME), { recursive: true, force: true });
    startCardJob(ctx, "lochara", "c", ["next"]);
    await settle();
    matchesNext();

    const start = card();
    const newId = idFor(start, "➕ New");
    const [, cardId, index] = newId.split(":");
    await modalHandlers.get("lcname")!(interaction(`lcname:${cardId}:${index}`, start, NAME) as never, ["lcname", cardId, index], ctx as never);
    await settle();
    expect(next(NAME).stage).toBe("base");
    matchesNext(NAME);

    await press("sample-e");
    expect(next(NAME).run?.next).toEqual(["build", NAME]);
    matchesNext(NAME);

    await press(`▶ build ${NAME}`);
    expect(next(NAME).run?.next).toEqual(["render", NAME]);
    matchesNext(NAME);

    await press(`▶ render ${NAME}`);
    expect(next(NAME).waiting).toBe("approve");
    matchesNext(NAME);
    console.log(sent.map((m) => m.content).filter(Boolean).join("\n---\n"));
  },
  BUILD_MS * 2
);
