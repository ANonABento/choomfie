import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Brain } from "@choomfie/shared";
import {
  chunkForDiscord,
  decideRoute,
  dispatchToBrain,
  getPendingApproval,
  postBrainReply,
  takeChoices,
  resolveBrainId,
  type RouteInput,
} from "../lib/brain-router.ts";
import { ConfigManager } from "../lib/config.ts";
import { takePatch } from "../lib/patch-pr.ts";
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

describe("files", () => {
  test("ride on the last chunk as attachments; files alone still get a message", async () => {
    const sent: { content?: string; files?: { attachment: Buffer; name: string }[] }[] = [];
    const channel = { send: async (o: (typeof sent)[number]) => (sent.push(o), { id: "m" }) };
    const file = { name: "card.png", data: new Uint8Array([1, 2, 3]) };
    await postBrainReply(channel, "waymond", "c1", { text: "a\n\n" + "x".repeat(2500), files: [file] });
    expect(sent.map((m) => m.files?.length ?? 0)).toEqual([0, 1]);
    expect(sent[1].files![0]).toEqual({ attachment: Buffer.from([1, 2, 3]), name: "card.png" });

    sent.length = 0;
    await postBrainReply(channel, "waymond", "c1", { text: "", files: [file] });
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toBe("");
  });
});

describe("patches", () => {
  test("a reply with a .patch file and a repo line gets an Open draft PR button", async () => {
    const sent: { content?: string; components?: unknown[] }[] = [];
    const channel = { send: async (o: (typeof sent)[number]) => (sent.push(o), { id: `p${sent.length}` }) };
    const file = { name: "fix.patch", data: new TextEncoder().encode("diff --git a/x b/x\n") };
    await postBrainReply(channel, "waymond", "c1", { text: "Fixed the split.\nrepo: owner/name", files: [file] });
    expect(sent).toHaveLength(2);
    expect(sent[1].content).toContain("owner/name");
    const ids = (sent[1].components![0] as { toJSON(): { components: { custom_id: string }[] } }).toJSON().components;
    expect(ids.map((c) => c.custom_id)).toEqual(["brain:pr"]);
    expect(takePatch("p2")).toMatchObject({ repo: "owner/name", title: "Fixed the split." });
    expect(takePatch("p2")).toBeUndefined(); // one use

    sent.length = 0;
    await postBrainReply(channel, "waymond", "c1", { text: "no repo line", files: [file] });
    expect(sent).toHaveLength(1);
  });
});

describe("approval cards", () => {
  test("each approval is its own message with approve/decline buttons, tracked until resolved", async () => {
    const sent: { content?: string; embeds?: unknown[]; components?: unknown[] }[] = [];
    const channel = { send: async (o: (typeof sent)[number]) => (sent.push(o), { id: `m${sent.length}` }) };
    const approval = { id: "offer-1", title: "RedTeam · New message", detail: "Bridge test", approveLabel: "Send", declineLabel: "Not now" };
    await postBrainReply(channel, "waymond", "c1", { text: "Drafted it.", approvals: [approval] });
    expect(sent).toHaveLength(2);
    const buttons = (sent[1].components![0] as { toJSON(): { components: { custom_id: string; label: string }[] } })
      .toJSON()
      .components.map((c) => [c.custom_id, c.label]);
    expect(buttons).toEqual([
      ["brain:approval:yes", "Send"],
      ["brain:approval:no", "Not now"],
    ]);
    expect(getPendingApproval("m2")).toEqual({ brainId: "waymond", chatKey: "c1", approval });
  });

  test("an approval-only reply doesn't post a stray '(no reply)'", async () => {
    const sent: { content?: string }[] = [];
    const channel = { send: async (o: (typeof sent)[number]) => (sent.push(o), { id: `m${sent.length}` }) };
    await postBrainReply(channel, "waymond", "c1", {
      text: "",
      approvals: [{ id: "x", title: "t", detail: "d", approveLabel: "Send", declineLabel: "No" }],
    });
    expect(sent).toHaveLength(1);
  });
});

describe("brain output never pings", () => {
  test("replies, approvals and errors all go out with mentions disabled", async () => {
    const sent: { allowedMentions?: { parse: unknown[] } }[] = [];
    const channel = { send: async (o: (typeof sent)[number]) => (sent.push(o), { id: `m${sent.length}` }) };
    await postBrainReply(channel, "waymond", "c1", {
      text: "@everyone <@&123> hi",
      approvals: [{ id: "x", title: "t", detail: "@everyone", approveLabel: "Send", declineLabel: "No" }],
    });
    await dispatchToBrain({} as never, fake("waymond", async () => { throw new Error("@everyone boom"); }), channel, {
      chatKey: "c9", messageId: "m", content: "x", meta: {}, filePaths: [],
    });
    expect(sent).toHaveLength(3);
    for (const s of sent) expect(s.allowedMentions?.parse).toEqual([]);
  });
});

describe("/clear and /compact follow the channel's brain", () => {
  async function run(command: "clear" | "compact", channelBrain: string | undefined, reset = true, cwd: string | null = null) {
    const { commands, registerBrain, unregisterBrain } = await import("@choomfie/shared");
    await import("../lib/handlers/session-commands.ts");
    const resets: string[] = [];
    registerBrain({ id: "testbrain", label: "TestBrain", send: async () => ({ text: "" }), ...(reset ? { reset: async (k: string) => void resets.push(k) } : {}) });
    const replies: { content?: string; embeds?: unknown[] }[] = [];
    const interaction = {
      channelId: "chan1",
      channel: { isThread: () => false },
      user: { id: "owner" },
      options: { getString: (name: string) => (name === "cwd" ? cwd : null) },
      reply: async (o: (typeof replies)[number]) => void replies.push(o),
    };
    const { Database } = await import("bun:sqlite");
    const { ChatStore } = await import("../lib/chats/store.ts");
    const chats = new ChatStore(new Database(":memory:"));
    const before = chats.current("chan1", "testbrain", "old chat");
    const ctx = {
      ownerUserId: "owner",
      DATA_DIR: "/nonexistent-choomfie-test",
      chats,
      config: { getChannelBrain: (id: string) => (id === "chan1" ? channelBrain : undefined) },
    };
    try {
      await commands.get(command)!.handler(interaction as never, ctx as never);
    } finally {
      unregisterBrain("testbrain");
    }
    return { replies, resets, chats, before };
  }

  test("/clear in a brain channel starts a new chat for this channel only, keeping the old one", async () => {
    const { replies, resets, chats, before } = await run("clear", "testbrain");
    expect(resets).toEqual(["chan1"]);
    expect(JSON.stringify(replies[0].embeds)).toContain("New TestBrain chat");
    const now = chats.bound("chan1", "testbrain");
    expect(now?.id).not.toBe(before.id);
    expect(chats.get(before.id)).not.toBeNull();
  });

  test("/clear works for a brain without a reset hook", async () => {
    const { replies, chats, before } = await run("clear", "testbrain", false);
    expect(JSON.stringify(replies[0].embeds)).toContain("New TestBrain chat");
    expect(chats.bound("chan1", "testbrain")?.id).not.toBe(before.id);
  });

  test("/clear cwd: is refused in a brain channel, changing nothing", async () => {
    const { replies, resets, chats, before } = await run("clear", "testbrain", true, "~/x");
    expect(replies[0].content).toContain("only apply to Claude chats");
    expect(resets).toEqual([]);
    expect(chats.bound("chan1", "testbrain")?.id).toBe(before.id);
  });

  test("/compact in a brain channel explains instead of touching Claude", async () => {
    const { replies, resets } = await run("compact", "testbrain");
    expect(resets).toEqual([]);
    expect(replies[0].content).toContain("manages its own context");
  });

  test("Claude channels keep the daemon behaviour (foreground notice here)", async () => {
    const { replies } = await run("clear", undefined);
    expect(replies[0].content).toContain("foreground mode");
  });
});
