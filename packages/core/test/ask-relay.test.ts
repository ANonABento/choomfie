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
import { menuPrompt } from "../lib/handlers/ask-command.ts";
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

test("menu prompt names who said it", () => {
  expect(menuPrompt("alice", "is this right?", 0)).toBe("alice said:\nis this right?");
  expect(menuPrompt("bob", "  ", 2)).toBe("bob said:\n(attachments only)");
});
