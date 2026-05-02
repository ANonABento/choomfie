import { expect, test } from "bun:test";
import { commands } from "@choomfie/shared";
import type { ChatInputCommandInteraction } from "discord.js";
import type { AppContext } from "../lib/types.ts";
import {
  handleGuildMemberAdd,
  renderWelcomeTemplate,
  type WelcomeGuildMember,
} from "../lib/handlers/welcome.ts";
import type { WelcomeConfig } from "../lib/config.ts";

type Spy = ((...args: unknown[]) => unknown) & { calls: unknown[][] };
function spy(): Spy {
  const fn: Spy = (...args: unknown[]) => {
    fn.calls.push(args);
  };
  fn.calls = [];
  return fn;
}

function spyWithImpl<TArgs extends unknown[], TReturn>(
  impl: (...args: TArgs) => TReturn
): Spy & ((...args: TArgs) => TReturn) {
  const fn = ((...args: TArgs) => {
    fn.calls.push(args);
    return impl(...args);
  }) as Spy & ((...args: TArgs) => TReturn);
  fn.calls = [];
  return fn;
}

function getWelcomeCommand() {
  const command = commands.get("welcome_config");
  expect(command).toBeTruthy();
  return command!;
}

function makeTextChannel() {
  const send = spyWithImpl(async (_payload: unknown) => {});
  const channel = {
    isTextBased: () => true,
    send,
  };
  const fetch = spyWithImpl(async () => channel);
  return { fetch, send };
}

function makeMember(
  overrides: Partial<WelcomeGuildMember> = {}
): WelcomeGuildMember {
  return {
    guild: {
      channels: {
        fetch: async () => null,
      },
      name: "Choomfie",
      memberCount: 5,
    },
    id: "user-1",
    displayName: "Bento",
    user: { username: "user" },
    ...overrides,
  };
}

test("handleGuildMemberAdd sends welcome content to configured channel", async () => {
  const { fetch, send } = makeTextChannel();

  const ctx = {
    config: {
      getWelcomeConfig: () => ({
        channelId: "channel-id",
        template: "Welcome {username}!",
      }),
    },
    messageStats: { sent: 0 },
  } as unknown as AppContext;

  await handleGuildMemberAdd(
    makeMember({
      guild: {
        channels: { fetch },
        name: "Choomfie",
        memberCount: 5,
      },
    }),
    ctx
  );

  expect(fetch.calls).toHaveLength(1);
  expect(fetch.calls[0][0]).toBe("channel-id");
  expect(send.calls).toHaveLength(1);
  expect(send.calls[0][0]).toEqual({
    content: "Welcome user!",
    allowedMentions: { users: ["user-1"], roles: [], parse: [] },
  });
  expect(ctx.messageStats.sent).toBe(1);
});

test("handleGuildMemberAdd keeps rendered welcome content within Discord limit", async () => {
  const { fetch, send } = makeTextChannel();

  const ctx = {
    config: {
      getWelcomeConfig: () => ({
        channelId: "channel-id",
        template: "{user}".repeat(500),
      }),
    },
    messageStats: { sent: 0 },
  } as unknown as AppContext;

  await handleGuildMemberAdd(
    makeMember({
      guild: {
        channels: { fetch },
        name: "Choomfie",
        memberCount: 5,
      },
      id: "123456789012345678",
    }),
    ctx
  );

  const payload = send.calls[0][0] as { content: string };
  expect(payload.content.length).toBeLessThanOrEqual(2000);
  expect(payload.content.endsWith("...")).toBe(true);
  expect(ctx.messageStats.sent).toBe(1);
});

test("welcome_config updates config and requires owner", async () => {
  const cmd = getWelcomeCommand();

  const cfg = { channelId: "old-channel", template: "Welcome {user}!" };
  const setWelcomeConfig = spyWithImpl(() => {});
  const ctx = {
    ownerUserId: "owner",
    config: {
      getWelcomeConfig: () => ({ ...cfg }),
      setWelcomeConfig: (next: Partial<WelcomeConfig>) => {
        Object.assign(cfg, next);
        setWelcomeConfig(next);
      },
    },
  } as unknown as AppContext;

  const ownerReply = spy();
  const ownerInteraction = {
    user: { id: "owner" },
    guildId: "guild-1",
    guild: { name: "Guild", memberCount: 12 },
    member: { displayName: "Owner" },
    options: {
      getChannel: () => ({ id: "channel-new" }),
      getString: () => "Welcome {displayName} to {server}!",
      getBoolean: () => true,
    },
    reply: ownerReply,
  } as unknown as ChatInputCommandInteraction;

  await cmd!.handler(ownerInteraction, ctx);
  expect(cfg.channelId).toBe("channel-new");
  expect(cfg.template).toBe("Welcome {displayName} to {server}!");
  expect(setWelcomeConfig.calls).toHaveLength(1);
  expect(ownerReply.calls).toHaveLength(1);
  expect((ownerReply.calls[0][0] as { content: string }).content).toContain(
    "Welcome messages are **enabled"
  );

  const intruderReply = spy();
  const intruderInteraction = {
    user: { id: "intruder" },
    guildId: "guild-1",
    options: { getChannel: () => null, getString: () => null, getBoolean: () => null },
    reply: intruderReply,
  } as unknown as ChatInputCommandInteraction;
  await cmd!.handler(intruderInteraction, ctx);
  expect(intruderReply.calls).toHaveLength(1);
  expect((intruderReply.calls[0][0] as { content: string }).content).toBe(
    "This command is owner-only~"
  );
});

test("welcome_config blocks enabling without channel configured", async () => {
  const cmd = getWelcomeCommand();

  const cfg = { channelId: null as string | null, template: "Welcome {user}!" };
  const setWelcomeConfig = spyWithImpl(() => {});
  const ctx = {
    ownerUserId: "owner",
    config: {
      getWelcomeConfig: () => ({ ...cfg }),
      setWelcomeConfig: (next: Partial<WelcomeConfig>) => {
        Object.assign(cfg, next);
        setWelcomeConfig(next);
      },
    },
  } as unknown as AppContext;

  const ownerReply = spy();
  const ownerInteraction = {
    user: { id: "owner" },
    guildId: "guild-1",
    guild: { name: "Guild", memberCount: 3 },
    member: { displayName: "Owner" },
    options: {
      getChannel: () => null,
      getString: () => null,
      getBoolean: () => true,
    },
    reply: ownerReply,
  } as unknown as ChatInputCommandInteraction;

  await cmd!.handler(ownerInteraction, ctx);

  expect(cfg.channelId).toBeNull();
  expect(cfg.template).toBe("Welcome {user}!");
  expect(setWelcomeConfig.calls).toHaveLength(0);
  expect(ownerReply.calls).toHaveLength(1);
  expect((ownerReply.calls[0][0] as { content: string }).content).toBe(
    "Choose a channel before enabling welcome messages."
  );
});

test("handleGuildMemberAdd ignores bot users", async () => {
  const { fetch, send } = makeTextChannel();

  const ctx = {
    config: {
      getWelcomeConfig: () => ({
        channelId: "channel-id",
        template: "Welcome {username}!",
      }),
    },
    messageStats: { sent: 0 },
  } as unknown as AppContext;

  await handleGuildMemberAdd(
    makeMember({
      guild: {
        channels: { fetch },
        name: "Choomfie",
        memberCount: 5,
      },
      displayName: "BentoBot",
      user: { username: "bot-user", bot: true },
    }),
    ctx
  );

  expect(fetch.calls).toHaveLength(0);
  expect(send.calls).toHaveLength(0);
  expect(ctx.messageStats.sent).toBe(0);
});

test("renderWelcomeTemplate keeps placeholders intact when values are missing", () => {
  const rendered = renderWelcomeTemplate(
    "Hi {user} {username} {displayName} {server} #{memberCount} {missing}",
    {
      id: "123",
      displayName: "Bento",
      user: { username: "user" },
      guild: { name: "Choomfie", memberCount: 1 },
    }
  );
  expect(rendered).toBe("Hi <@123> user Bento Choomfie #1 {missing}");
});
