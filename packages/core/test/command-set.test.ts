import { beforeAll, describe, expect, test } from "bun:test";
import { ApplicationIntegrationType as IT, InteractionContextType as CT } from "discord.js";
import { commands, getCommandDefs, messageMenus, registerBrain, unregisterBrain } from "@choomfie/shared";
import { registerAllHandlers } from "../lib/interactions.ts";

beforeAll(async () => {
  await registerAllHandlers();
});

type Json = {
  name: string;
  description: string;
  options?: Json[];
  type?: number;
  integration_types?: number[];
  contexts?: number[];
};
const slash = () => (getCommandDefs() as Json[]).filter((c) => (c.type ?? 1) === 1);

describe("slash command set", () => {
  // Other test files register throwaway commands in the same shared registry,
  // so pin what must exist and what must be gone rather than the exact list.
  const EXPECTED = [
    "access", "brain", "choomfie", "clear", "compact", "config", "github", "help", "memory",
    "model", "persona", "plugins", "remind", "status", "stop", "usage", "voice",
  ];
  const REMOVED = ["reminders", "cancel", "savememory", "newpersona", "allow", "revoke"];

  test("is the consolidated set — fewer commands to remember", () => {
    const names = new Set(slash().map((c) => c.name));
    for (const n of EXPECTED) expect(names.has(n)).toBe(true);
    for (const n of REMOVED) expect(names.has(n)).toBe(false);
    expect(EXPECTED).toHaveLength(17);
  });

  test("merged commands expose their verbs as subcommands", () => {
    const subs = (name: string) =>
      ((getCommandDefs().find((c) => c.name === name) as Json).options ?? []).map((o) => o.name).sort();
    expect(subs("remind")).toEqual(["add", "cancel", "list"]);
    expect(subs("memory")).toEqual(["forget", "list", "save", "search"]);
    expect(subs("persona")).toEqual(["list", "new", "switch"]);
    expect(subs("access")).toEqual(["allow", "list", "revoke"]);
  });

  test("every name and description fits Discord's limits", () => {
    const walk = (o: Json) => {
      expect(o.name).toMatch(/^[a-z0-9_-]{1,32}$/);
      expect(o.description.length).toBeGreaterThan(0);
      expect(o.description.length).toBeLessThanOrEqual(100);
      for (const c of o.options ?? []) walk(c);
    };
    for (const c of slash()) walk(c);
  });

  test("only /choomfie, /access, /brain, /clear, /mode, /resume, /stop and the Ask Choomfie menu work outside the bot's servers", () => {
    const anywhere = (getCommandDefs() as Json[])
      .filter((c) => c.integration_types?.includes(IT.UserInstall))
      .map((c) => c.name)
      .sort();
    expect(anywhere).toEqual(["Ask Choomfie", "access", "brain", "choomfie", "clear", "mode", "resume", "stop"]);
    for (const c of getCommandDefs() as Json[]) {
      expect(c.integration_types?.length).toBeGreaterThan(0);
      if (anywhere.includes(c.name)) expect(c.contexts).toContain(CT.PrivateChannel);
      else expect(c.contexts).toEqual([CT.Guild, CT.BotDM]);
    }
  });

  test("Ask Choomfie is a message menu command", () => {
    const menu = messageMenus.get("Ask Choomfie");
    expect(menu?.data.type).toBe(3);
  });
});

function fakeInteraction(over: Record<string, unknown> = {}) {
  const replies: { content?: string; embeds?: unknown[] }[] = [];
  const opts: Record<string, unknown> = (over.opts as Record<string, unknown>) ?? {};
  const interaction = {
    channelId: "chan1",
    channel: { isThread: () => false },
    user: { id: "owner", username: "owner" },
    options: {
      getSubcommand: () => opts.sub,
      getString: (k: string) => (opts[k] as string | undefined) ?? null,
      getBoolean: (k: string) => (opts[k] as boolean | undefined) ?? null,
      getUser: (k: string) => opts[k] ?? null,
      getInteger: (k: string) => opts[k] ?? null,
    },
    reply: async (o: unknown) => void replies.push(typeof o === "string" ? { content: o } : (o as never)),
    deferReply: async () => {},
    editReply: async (o: unknown) => void replies.push(typeof o === "string" ? { content: o } : (o as never)),
    ...over,
  };
  return { interaction, replies };
}

const baseCtx = (brainMap: Record<string, string> = {}) => ({
  ownerUserId: "owner",
  allowedUsers: new Set(["owner"]),
  DATA_DIR: "/nonexistent-choomfie-test",
  config: {
    getChannelBrain: (id: string) => brainMap[id],
    getBrainAccess: () => "owner",
    setChannelBrain: (id: string, b: string | undefined) => {
      if (b) brainMap[id] = b;
      else delete brainMap[id];
    },
  },
});

describe("/stop and /brain", () => {
  test("/stop stops the channel's brain", async () => {
    const stops: string[] = [];
    registerBrain({ id: "tb", label: "TB", send: async () => ({ text: "" }), stop: async (k) => (stops.push(k), true) });
    try {
      const { interaction, replies } = fakeInteraction();
      await commands.get("stop")!.handler(interaction as never, baseCtx({ chan1: "tb" }) as never);
      expect(stops).toEqual(["chan1"]);
      expect(replies.at(-1)?.content).toContain("Asked **TB** to stop");
    } finally {
      unregisterBrain("tb");
    }
  });

  test("/stop in a Claude channel outside daemon mode says where it works, instead of pretending", async () => {
    const { interaction, replies } = fakeInteraction();
    await commands.get("stop")!.handler(interaction as never, baseCtx() as never);
    expect(replies[0].content).toContain("daemon mode");
    expect(replies[0].content).toContain("Esc");
  });

  test("/brain with no name reports; /brain <name> switches; /brain claude clears", async () => {
    registerBrain({ id: "tb", label: "TB", send: async () => ({ text: "" }) });
    try {
      const map: Record<string, string> = {};
      const ctx = baseCtx(map);
      const show = fakeInteraction();
      await commands.get("brain")!.handler(show.interaction as never, ctx as never);
      expect(show.replies[0].content).toContain("**Claude** answers here");

      const set = fakeInteraction({ opts: { name: "tb" } });
      await commands.get("brain")!.handler(set.interaction as never, ctx as never);
      expect(map.chan1).toBe("tb");
      expect(set.replies[0].content).toBe(
        "**TB** answers you in this channel. Others on your allowlist get Claude. " +
          "To let them use TB too: `/config setting:brainAccess value:allowlist`"
      );

      const back = fakeInteraction({ opts: { name: "claude" } });
      await commands.get("brain")!.handler(back.interaction as never, ctx as never);
      expect(map.chan1).toBeUndefined();
    } finally {
      unregisterBrain("tb");
    }
  });
});

describe("/access", () => {
  test("list and the owner guard go through one owner-only command", async () => {
    const run = async (opts: Record<string, unknown>) => {
      const f = fakeInteraction({ opts });
      await commands.get("access")!.handler(f.interaction as never, baseCtx() as never);
      return f.replies;
    };
    const list = await run({ sub: "list" });
    expect(JSON.stringify(list[0].embeds)).toContain("Allowlist (1)");
    const refuseOwner = await run({ sub: "revoke", user: { id: "owner", bot: false } });
    expect(refuseOwner[0].content).toContain("Can't revoke the owner");
  });

  test("non-owners are refused", async () => {
    const f = fakeInteraction({ user: { id: "rando", username: "rando" }, opts: { sub: "list" } });
    await commands.get("access")!.handler(f.interaction as never, baseCtx() as never);
    expect(f.replies[0].content).toContain("owner-only");
  });
});
