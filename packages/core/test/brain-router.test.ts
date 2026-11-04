import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Brain } from "@choomfie/shared";
import {
  chunkForDiscord,
  decideRoute,
  dispatchToBrain,
  postBrainReply,
  takeChoices,
  resolveBrainId,
  type RouteInput,
} from "../lib/brain-router.ts";
import { ConfigManager } from "../lib/config.ts";
import { findSetting } from "../lib/settings.ts";

const fake = (id = "waymond", send: Brain["send"] = async (m) => ({ text: `echo ${m.content}` })): Brain => ({
  id,
  label: "Waymond",
  send,
});

function route(over: Partial<RouteInput> = {}) {
  const map: Record<string, string> = { brainchan: "waymond", ghost: "gone" };
  return decideRoute({
    channelId: "brainchan",
    isOwner: true,
    isConversationMode: false,
    access: "owner",
    channelBrain: (id) => map[id],
    lookup: (id) => (id === "waymond" ? fake() : undefined),
    ...over,
  });
}

describe("decideRoute", () => {
  test("unset channels go to claude", () => {
    expect(route({ channelId: "plain" }).kind).toBe("claude");
  });

  test("owner reaches the channel's brain", () => {
    const r = route();
    expect(r.kind).toBe("brain");
  });

  test("non-owner gets claude under owner access, the brain under allowlist", () => {
    expect(route({ isOwner: false }).kind).toBe("claude");
    expect(route({ isOwner: false, access: "allowlist" }).kind).toBe("brain");
  });

  test("ambient conversation-mode messages are not answered by a brain", () => {
    expect(route({ isConversationMode: true }).kind).toBe("ignore");
  });

  test("a configured but unloaded brain is reported, not silently swapped", () => {
    expect(route({ channelId: "ghost" })).toEqual({ kind: "unavailable", brainId: "gone" });
  });

  test("threads inherit the parent's brain unless set directly", () => {
    const map: Record<string, string> = { parent: "waymond", own: "other" };
    expect(resolveBrainId("thread", "parent", (id) => map[id])).toBe("waymond");
    expect(resolveBrainId("own", "parent", (id) => map[id])).toBe("other");
    expect(resolveBrainId("thread", null, (id) => map[id])).toBe("claude");
  });
});

describe("chunkForDiscord", () => {
  test("keeps short text whole and splits long text under the limit", () => {
    expect(chunkForDiscord("hi")).toEqual(["hi"]);
    const long = Array.from({ length: 50 }, (_, i) => `line ${i} `.repeat(10)).join("\n");
    const chunks = chunkForDiscord(long, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
    expect(chunks.join("\n").replace(/\s+/g, " ")).toBe(long.replace(/\s+/g, " ").trim());
  });
});

describe("dispatchToBrain", () => {
  const msg = (content: string) => ({ chatKey: "c1", messageId: "m-" + content, content, meta: {}, filePaths: [] });

  test("replies in order, threaded to the source message", async () => {
    const sent: { content?: string; reply?: { messageReference: string } }[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const brain = fake("waymond", async (m) => {
      if (m.content === "first") await gate;
      return { text: `re ${m.content}` };
    });
    const channel = { send: async (o: (typeof sent)[number]) => void sent.push(o) };
    const a = dispatchToBrain({} as never, brain, channel, msg("first"));
    const b = dispatchToBrain({} as never, brain, channel, msg("second"));
    release();
    await Promise.all([a, b]);
    expect(sent.map((s) => s.content)).toEqual(["re first", "re second"]);
    expect(sent[0].reply?.messageReference).toBe("m-first");
  });

  test("a failing brain posts the reason instead of going silent", async () => {
    const sent: string[] = [];
    const brain = fake("waymond", async () => {
      throw new Error("login expired");
    });
    await dispatchToBrain({} as never, brain, { send: async (o: { content?: string }) => void sent.push(o.content!) }, msg("x"));
    expect(sent[0]).toContain("Waymond didn't answer: login expired");
  });
});

describe("brain config", () => {
  test("channel brains and brainAccess persist, and claude clears the override", () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-cfg-"));
    const cfg = new ConfigManager(dir);
    expect(cfg.getBrainAccess()).toBe("owner");
    cfg.setChannelBrain("c1", "waymond");
    const setting = findSetting("brainAccess")!;
    expect(setting.write(cfg, "everyone").ok).toBe(false);
    expect(setting.write(cfg, "allowlist")).toEqual({ ok: true, value: "allowlist" });

    const reloaded = new ConfigManager(dir);
    expect(reloaded.getChannelBrain("c1")).toBe("waymond");
    expect(reloaded.getBrainAccess()).toBe("allowlist");
    reloaded.setChannelBrain("c1", undefined);
    expect(reloaded.getConfig().brainChannels).toBeUndefined();
    expect(setting.write(reloaded, "default")).toEqual({ ok: true, value: "owner" });
  });
});

describe("quick-reply buttons", () => {
  test("choices ride on the last chunk and can be taken once", async () => {
    const sent: { content?: string; components?: unknown[] }[] = [];
    const channel = { send: async (o: (typeof sent)[number]) => (sent.push(o), { id: `msg${sent.length}` }) };
    await postBrainReply(channel, "waymond", "c1", { text: "Pizza or tacos?", choices: ["Pizza", "Tacos"] }, "src");
    expect(sent).toHaveLength(1);
    const row = (sent[0].components![0] as { toJSON(): { components: { custom_id: string; label: string }[] } }).toJSON();
    expect(row.components.map((c) => [c.custom_id, c.label])).toEqual([
      ["brain:choice:0", "Pizza"],
      ["brain:choice:1", "Tacos"],
    ]);
    expect(takeChoices("msg1")).toEqual({ brainId: "waymond", chatKey: "c1", choices: ["Pizza", "Tacos"] });
    expect(takeChoices("msg1")).toBeUndefined();
  });

  test("long labels are trimmed to Discord's 80 characters and rows hold 5", async () => {
    const sent: { components?: unknown[] }[] = [];
    const channel = { send: async (o: (typeof sent)[number]) => (sent.push(o), { id: "m" }) };
    const choices = Array.from({ length: 7 }, (_, i) => `option ${i} ` + "x".repeat(100));
    await postBrainReply(channel, "waymond", "c1", { text: "pick", choices });
    const rows = sent[0].components!.map((r) => (r as { toJSON(): { components: { label: string }[] } }).toJSON());
    expect(rows.map((r) => r.components.length)).toEqual([5, 2]);
    for (const r of rows) for (const c of r.components) expect(c.label.length).toBeLessThanOrEqual(80);
  });
});
