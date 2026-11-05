import { describe, expect, test } from "bun:test";
import { ApplicationIntegrationType as IT, InteractionContextType as CT, MessageFlags } from "discord.js";
import {
  RELAY_WINDOW_MS,
  botIsAbsent,
  getAskRelay,
  getBrainRelay,
  interactionChannel,
  isAskChatId,
  openAskRelay,
  rememberBrainRelay,
} from "../lib/ask-relay.ts";
import { postBrainReply } from "../lib/brain-router.ts";
import { menuPrompt, replyExcerpt, replyPrompt } from "../lib/handlers/ask-command.ts";
import { NO_ANSWER, REPLY_BUTTON_ID, questionHeader, settleAskRelays } from "../lib/ask-relay.ts";
import { MODAL_MAX_FILES, askModal } from "../lib/handlers/ask-command.ts";
import { jest } from "bun:test";
import { discordTools } from "../lib/tools/discord-tools.ts";

function fakeInteraction() {
  const calls: { kind: "edit" | "followUp"; body: Record<string, unknown> }[] = [];
  let n = 0;
  return {
    calls,
    editReply: async (body: never) => (calls.push({ kind: "edit", body }), { id: `m${++n}` }),
    followUp: async (body: never) => (calls.push({ kind: "followUp", body }), { id: `m${++n}` }),
  };
}

describe("botIsAbsent", () => {
  test("a guild that installed the bot can be posted to", () => {
    expect(botIsAbsent({ authorizingIntegrationOwners: { [IT.GuildInstall]: "g1", [IT.UserInstall]: "u1" }, context: CT.Guild })).toBe(false);
  });
  test("the bot's own DM can be posted to", () => {
    expect(botIsAbsent({ authorizingIntegrationOwners: { [IT.UserInstall]: "u1" }, context: CT.BotDM })).toBe(false);
  });
  test("a group DM through the user install can't", () => {
    expect(botIsAbsent({ authorizingIntegrationOwners: { [IT.UserInstall]: "u1" }, context: CT.PrivateChannel })).toBe(true);
  });
  test("a server without the bot can't", () => {
    expect(botIsAbsent({ authorizingIntegrationOwners: { [IT.UserInstall]: "u1" }, context: CT.Guild })).toBe(true);
  });
});

describe("interactionChannel", () => {
  test("first send replaces the thinking placeholder, the rest follow up; no message references", async () => {
    const i = fakeInteraction();
    const ch = interactionChannel(i);
    await ch.send({ content: "one", reply: { messageReference: "x" } });
    await ch.send({ content: "two" });
    expect(i.calls.map((c) => c.kind)).toEqual(["edit", "followUp"]);
    expect(i.calls[0].body.reply).toBeUndefined();
  });

  test("private answers keep their follow-ups private", async () => {
    const i = fakeInteraction();
    const ch = interactionChannel(i, { ephemeral: true });
    await ch.send({ content: "one" });
    await ch.send({ content: "two" });
    expect(i.calls[0].body.flags).toBeUndefined(); // the deferred reply already is
    expect(i.calls[1].body.flags).toBe(MessageFlags.Ephemeral);
  });

  test("after a button update, everything is a follow-up", async () => {
    const i = fakeInteraction();
    await interactionChannel(i, { first: "followUp" }).send({ content: "x" });
    expect(i.calls.map((c) => c.kind)).toEqual(["followUp"]);
  });

  test("refuses once Discord's 15 minutes are up", async () => {
    let t = 0;
    const ch = interactionChannel(fakeInteraction(), { now: () => t });
    expect(ch.alive()).toBe(true);
    t = RELAY_WINDOW_MS + 1;
    expect(ch.alive()).toBe(false);
    await expect(ch.send({ content: "late" })).rejects.toThrow("15-minute");
  });

  test("brain replies (chunks + quick replies) go through it unchanged", async () => {
    const i = fakeInteraction();
    await postBrainReply(interactionChannel(i), "tb", "gdm1", { text: "pick", choices: ["a", "b"] }, "orig");
    expect(i.calls).toHaveLength(1);
    expect(i.calls[0].kind).toBe("edit");
    expect((i.calls[0].body.components as unknown[]).length).toBe(1);
  });
});

describe("relay registries", () => {
  test("ask chat ids resolve to their relay until it expires", () => {
    let t = 0;
    const relay = interactionChannel(fakeInteraction(), { now: () => t });
    const id = openAskRelay("123", relay);
    expect(id).toBe("ask:123");
    expect(isAskChatId(id)).toBe(true);
    expect(isAskChatId("1485889678996406395")).toBe(false);
    expect(getAskRelay(id)).toBe(relay);
    t = RELAY_WINDOW_MS + 1;
    expect(getAskRelay(id)).toBeUndefined();
  });

  test("brain relays are kept per chat for late results", () => {
    const relay = interactionChannel(fakeInteraction());
    rememberBrainRelay("gdm1", relay);
    expect(getBrainRelay("gdm1")).toBe(relay);
    expect(getBrainRelay("other")).toBeUndefined();
  });
});

describe("tools on an ask chat", () => {
  const ctx = { DATA_DIR: "/nonexistent", messageStats: { sent: 0 } } as never;
  const tool = (name: string) => discordTools.find((t) => t.definition.name === name)!;

  test("reply answers through the relay", async () => {
    const i = fakeInteraction();
    const id = openAskRelay("456", interactionChannel(i));
    const res = await tool("reply").handler({ chat_id: id, text: "hi", reply_to: "zzz" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(i.calls[0]).toEqual({ kind: "edit", body: { content: "hi" } });
  });

  test("reply to an expired ask says why", async () => {
    const res = await tool("reply").handler({ chat_id: "ask:gone", text: "hi" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("15 minutes");
  });

  test("channel tools explain they can't work there", async () => {
    for (const name of ["react", "fetch_messages", "create_poll"]) {
      const res = await tool(name).handler({ chat_id: "ask:1", message_id: "1", emoji: "x" }, ctx);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("only `reply` works");
    }
  });
});

describe("keeping a group-DM conversation going", () => {
  const ids = (body: Record<string, unknown>) =>
    ((body.components as { toJSON(): { components: { custom_id: string }[] } }[]) ?? []).flatMap((r) =>
      r.toJSON().components.map((c) => c.custom_id)
    );

  test("the question is quoted above the first message only, and can't ping", async () => {
    const i = fakeInteraction();
    const ch = interactionChannel(i, { header: questionHeader("alice", "what's @everyone up to") });
    await ch.send({ content: "answer" });
    await ch.send({ content: "more" });
    expect(i.calls[0].body.content).toBe("> **alice:** what's @everyone up to\nanswer");
    expect(i.calls[0].body.allowedMentions).toEqual({ parse: [] });
    expect(i.calls[1].body.content).toBe("more");
  });

  test("a header that won't fit goes in its own message", async () => {
    const i = fakeInteraction();
    await interactionChannel(i, { header: questionHeader("a", "q") }).send({ content: "x".repeat(1999) });
    expect(i.calls.map((c) => c.body.content)).toEqual(["> **a:** q", "x".repeat(1999)]);
  });

  test("long questions are shortened in the header", () => {
    const h = questionHeader("a", "word ".repeat(100));
    expect(h.length).toBeLessThan(220);
    expect(h.endsWith("…")).toBe(true);
  });

  test("💬 Reply goes on every message without buttons of its own, not on quick replies", async () => {
    const i = fakeInteraction();
    await postBrainReply(interactionChannel(i, { replyButton: true }), "tb", "gdm", { text: "pick", choices: ["a"] });
    await interactionChannel(i, { replyButton: true }).send({ content: "plain" });
    expect(ids(i.calls[0].body)).toEqual(["brain:choice:0"]);
    expect(ids(i.calls[1].body)).toEqual([REPLY_BUTTON_ID]);
  });

  test("progress fills the placeholder, and never overwrites the answer", async () => {
    const i = fakeInteraction();
    const ch = interactionChannel(i);
    await ch.progress("⏳ working");
    const late = ch.progress("⏳ still working"); // queued...
    await ch.send({ content: "answer" });
    await late;
    await ch.progress("⏳ too late");
    expect(i.calls.map((c) => [c.kind, c.body.content])).toEqual([
      ["edit", "⏳ working"],
      ["edit", "⏳ still working"],
      ["edit", "answer"],
    ]);
  });

  test("a reply quotes the answer it replies to, without our header", () => {
    const ex = replyExcerpt("> **alice:** what's 2+2\nIt's 4.");
    expect(ex).toBe("It's 4.");
    expect(replyPrompt(ex, " and 3+3? ")).toBe('[Replying to your earlier answer: "It\'s 4."]\nand 3+3?');
    expect(replyPrompt("", "hi")).toBe("hi");
    expect(replyExcerpt("y".repeat(900)).length).toBe(500);
  });

  test("menu prompt names who said it, with the optional instruction first", () => {
    expect(menuPrompt("alice", "is this right?", 0)).toBe("alice said:\nis this right?");
    expect(menuPrompt("bob", "  ", 2)).toBe("bob said:\n(attachments only)");
    expect(menuPrompt("alice", "the sky is green", 0, "fact check")).toBe("fact check\n\nalice said:\nthe sky is green");
  });
});

test("a placeholder nobody answers says so before Discord gives up", async () => {
  jest.useFakeTimers();
  try {
    const i = fakeInteraction();
    interactionChannel(i);
    const answered = fakeInteraction();
    await interactionChannel(answered).send({ content: "hi" });
    jest.advanceTimersByTime(RELAY_WINDOW_MS);
    await new Promise((r) => queueMicrotask(() => r(null)));
    await Promise.resolve();
    expect(i.calls).toEqual([{ kind: "edit", body: { content: NO_ANSWER, allowedMentions: { parse: [] } } }]);
    expect(answered.calls).toHaveLength(1);
  } finally {
    jest.useRealTimers();
  }
});

test("/stop closes that chat's unanswered asks now, and leaves answered ones and other chats alone", async () => {
  const waiting = fakeInteraction();
  const answered = fakeInteraction();
  const elsewhere = fakeInteraction();
  openAskRelay("s1", interactionChannel(waiting), "gdmA");
  const done = interactionChannel(answered);
  openAskRelay("s2", done, "gdmA");
  await done.send({ content: "already said" });
  openAskRelay("s3", interactionChannel(elsewhere), "gdmB");

  await settleAskRelays("gdmA", "⏹️ Stopped.");
  expect(waiting.calls.map((c) => c.body.content)).toEqual(["⏹️ Stopped."]);
  expect(answered.calls.map((c) => c.body.content)).toEqual(["already said"]);
  expect(elsewhere.calls).toHaveLength(0);
});

test("the Reply and menu boxes take files as well as text", () => {
  const json = askModal("ask:reply", "Reply to Choomfie", { label: "Your reply", required: true, placeholder: "…" }).toJSON() as {
    custom_id: string;
    components: { type: number; label: string; component: { type: number; custom_id: string; required?: boolean; max_values?: number } }[];
  };
  expect(json.custom_id).toBe("ask:reply");
  const [text, files] = json.components;
  expect(text.component).toMatchObject({ custom_id: "text", required: true });
  expect(files.label).toBe("Attach files (optional)");
  expect(files.component).toMatchObject({ type: 19, custom_id: "files", required: false, max_values: MODAL_MAX_FILES });
});
