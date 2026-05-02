import {
  commands,
  type AutomodAction,
  type AutomodConfig,
  type PluginConfig,
  type PluginContext,
} from "@choomfie/shared";
import { afterEach, expect, test } from "bun:test";
import automodPlugin from ".";

type FakeAutomodConfig = PluginConfig;

interface FakeMessage {
  guild: {
    id: string;
    members: {
      fetch: (userId: string) => Promise<FakeGuildMember | null>;
    };
  };
  member: FakeGuildMember | null;
  author: {
    id: string;
    bot?: boolean;
  };
  content: string;
  reply: (payload: { content: string }) => Promise<void>;
}

interface FakeGuildMember {
  timeout: (durationMs?: number, reason?: string) => Promise<void>;
  kick: (reason?: string) => Promise<void>;
}

interface FakeCommandInteraction {
  user: {
    id: string;
  };
  options: {
    getInteger: (name: string) => number | null;
    getString: (name: string) => string | null;
  };
  reply: (payload: { content: string; flags?: unknown }) => Promise<void>;
}

type FakePluginContext = Pick<PluginContext, "DATA_DIR" | "ownerUserId" | "config">;

const OWNER_USER_ID = "owner-user";
const TEST_DATA_DIR = "/tmp/choomfie-automod-test";

afterEach(async () => {
  await automodPlugin.destroy?.();
});

function createFakeAutomodConfig(
  seed: Omit<AutomodConfig, "action"> & {
    action: AutomodAction;
  }
): FakeAutomodConfig {
  let state: AutomodConfig = {
    ...seed,
    bannedWords: [...seed.bannedWords],
  };

  return {
    getConfig() {
      return { automod: this.getAutomodConfig() };
    },
    getEnabledPlugins() {
      return ["automod"];
    },
    getVoiceConfig() {
      return { stt: "auto", tts: "auto" };
    },
    getSocialsConfig() {
      return undefined;
    },
    getAutomodConfig() {
      return { ...state, bannedWords: [...state.bannedWords] };
    },
    setAutomodConfig(next) {
      state = { ...state, ...next };
    },
  };
}

function fakePluginContext(overrides: {
  config: FakeAutomodConfig;
  ownerUserId?: string;
}): FakePluginContext {
  return {
    DATA_DIR: TEST_DATA_DIR,
    ownerUserId: overrides.ownerUserId ?? OWNER_USER_ID,
    config: overrides.config,
  };
}

function makeCommandInteraction(overrides: {
  userId?: string;
  integers?: Record<string, number | null>;
  strings?: Record<string, string | null>;
  onReply: (content: string) => void;
}): FakeCommandInteraction {
  return {
    user: { id: overrides.userId ?? OWNER_USER_ID },
    options: {
      getInteger: (name) => overrides.integers?.[name] ?? null,
      getString: (name) => overrides.strings?.[name] ?? null,
    },
    reply: async ({ content }) => {
      overrides.onReply(content);
    },
  };
}

function makeMessage(
  member: FakeGuildMember | null,
  authorId: string,
  content: string,
  onFetch?: (userId: string) => void,
  fetchResult?: FakeGuildMember | null,
  guildId = "guild-1"
): FakeMessage {
  return {
    guild: {
      id: guildId,
      members: {
        fetch: async (userId) => {
          onFetch?.(userId);
          return fetchResult ?? member;
        },
      },
    },
    member,
    author: { id: authorId },
    content,
    reply: async () => undefined,
  };
}

test("automod command is owner-only", async () => {
  const replies: string[] = [];
  const cfg = createFakeAutomodConfig({
    maxMessagesPerMinute: 20,
    bannedWords: ["bad"],
    action: "warn",
  });

  await automodPlugin.init(fakePluginContext({ config: cfg }));

  const handler = commands.get("automod_config")?.handler;
  expect(handler).toBeDefined();

  const denied = makeCommandInteraction({
    userId: "other-user",
    onReply: (content) => replies.push(content),
  });

  await handler!(
    denied as never,
    fakePluginContext({ config: cfg, ownerUserId: OWNER_USER_ID })
  );
  expect(replies.at(-1)).toContain("owner-only");
});

test("automod command updates all configurable settings", async () => {
  const replies: string[] = [];
  const cfg = createFakeAutomodConfig({
    maxMessagesPerMinute: 20,
    bannedWords: [],
    action: "warn",
  });

  await automodPlugin.init(fakePluginContext({ config: cfg }));

  const handler = commands.get("automod_config")?.handler;
  expect(handler).toBeDefined();

  const interaction = makeCommandInteraction({
    integers: { max_messages_per_minute: 3 },
    strings: {
      banned_words: "Spam, scam\nSPAM",
      action: "kick",
    },
    onReply: (content) => replies.push(content),
  });

  await handler!(interaction as never, fakePluginContext({ config: cfg }));

  expect(cfg.getAutomodConfig()).toEqual({
    maxMessagesPerMinute: 3,
    bannedWords: ["spam", "scam"],
    action: "kick",
  });
  expect(replies.at(-1)).toContain("Automod updated");
});

test("owner messages are skipped", async () => {
  const replies: string[] = [];
  const member: FakeGuildMember = {
    timeout: async () => {},
    kick: async () => {},
  };
  const config = createFakeAutomodConfig({
    maxMessagesPerMinute: 1,
    bannedWords: ["forbidden"],
    action: "warn",
  });

  const message = makeMessage(member, OWNER_USER_ID, "forbidden");
  message.reply = async ({ content }) => {
    replies.push(content);
  };

  await automodPlugin.onMessage!(
    message as never,
    fakePluginContext({ config })
  );

  expect(replies).toHaveLength(0);
});

test("bot messages are skipped", async () => {
  const replies: string[] = [];
  const member: FakeGuildMember = {
    timeout: async () => {},
    kick: async () => {},
  };
  const config = createFakeAutomodConfig({
    maxMessagesPerMinute: 1,
    bannedWords: ["forbidden"],
    action: "warn",
  });

  const message = makeMessage(member, "bot-user", "this has forbidden content");
  message.author = { id: "bot-user", bot: true };
  message.reply = async ({ content }) => {
    replies.push(content);
  };

  await automodPlugin.onMessage!(
    message as never,
    fakePluginContext({ config })
  );

  expect(replies).toHaveLength(0);
});

test("rate limit and cooldown apply warn action", async () => {
  let fetchCalls = 0;
  const replies: string[] = [];
  const member: FakeGuildMember = {
    timeout: async () => {},
    kick: async () => {},
  };
  const config = createFakeAutomodConfig({
    maxMessagesPerMinute: 1,
    bannedWords: [],
    action: "warn",
  });

  const ctx = fakePluginContext({ config, ownerUserId: OWNER_USER_ID });
  const message = makeMessage(null, "spammer", "hello", () => {
    fetchCalls += 1;
  }, member);
  message.reply = async ({ content }) => {
    replies.push(content);
  };

  await automodPlugin.onMessage!(message as never, ctx);
  await automodPlugin.onMessage!(message as never, ctx);
  await automodPlugin.onMessage!(message as never, ctx);

  expect(fetchCalls).toBe(0);
  expect(replies).toHaveLength(1);
  expect(replies[0]).toContain("⚠️ Moderation triggered");
});

test("rate limit buckets are scoped by guild and user", async () => {
  const replies: string[] = [];
  const member: FakeGuildMember = {
    timeout: async () => {},
    kick: async () => {},
  };
  const config = createFakeAutomodConfig({
    maxMessagesPerMinute: 1,
    bannedWords: [],
    action: "warn",
  });
  const ctx = fakePluginContext({ config, ownerUserId: OWNER_USER_ID });

  const firstGuildMessage = makeMessage(
    member,
    "same-user",
    "first guild first",
    undefined,
    undefined,
    "guild-a"
  );
  firstGuildMessage.reply = async ({ content }) => {
    replies.push(content);
  };

  const secondGuildMessage = makeMessage(
    member,
    "same-user",
    "second guild first",
    undefined,
    undefined,
    "guild-b"
  );
  secondGuildMessage.reply = async ({ content }) => {
    replies.push(content);
  };

  const firstGuildRepeat = makeMessage(
    member,
    "same-user",
    "first guild second",
    undefined,
    undefined,
    "guild-a"
  );
  firstGuildRepeat.reply = async ({ content }) => {
    replies.push(content);
  };

  await automodPlugin.onMessage!(firstGuildMessage as never, ctx);
  await automodPlugin.onMessage!(secondGuildMessage as never, ctx);
  await automodPlugin.onMessage!(firstGuildRepeat as never, ctx);

  expect(replies).toHaveLength(1);
  expect(replies[0]).toContain("Rate limit exceeded");
});

test("banned words trigger the configured timeout action", async () => {
  const timeoutCalls: string[] = [];
  const replies: string[] = [];
  const member: FakeGuildMember = {
    timeout: async () => {
      timeoutCalls.push("timeout");
    },
    kick: async () => {},
  };
  const config = createFakeAutomodConfig({
    maxMessagesPerMinute: 100,
    bannedWords: ["forbidden"],
    action: "timeout",
  });

  const ctx = fakePluginContext({ config, ownerUserId: OWNER_USER_ID });

  const message = makeMessage(
    member,
    "spammer-timeout",
    "This contains FORBIDDEN text",
    () => {
      timeoutCalls.push("fetch");
    },
    member
  );
  message.reply = async ({ content }) => {
    replies.push(content);
  };

  await automodPlugin.onMessage!(message as never, ctx);

  expect(timeoutCalls).toHaveLength(1);
  expect(timeoutCalls).toEqual(["timeout"]);
  expect(replies.join("")).toContain("User timed out for 1 minute");
});

test("banned words match whole words only", async () => {
  const replies: string[] = [];
  const member: FakeGuildMember = {
    timeout: async () => {},
    kick: async () => {},
  };
  const config = createFakeAutomodConfig({
    maxMessagesPerMinute: 100,
    bannedWords: ["ass"],
    action: "warn",
  });

  const classMessage = makeMessage(member, "word-boundary-user", "classic");
  classMessage.reply = async ({ content }) => {
    replies.push(content);
  };

  await automodPlugin.onMessage!(
    classMessage as never,
    fakePluginContext({ config })
  );

  expect(replies).toHaveLength(0);

  const bannedMessage = makeMessage(member, "word-boundary-user", "bad ass.");
  bannedMessage.reply = async ({ content }) => {
    replies.push(content);
  };

  await automodPlugin.onMessage!(
    bannedMessage as never,
    fakePluginContext({ config })
  );

  expect(replies).toHaveLength(1);
  expect(replies[0]).toContain("Banned word detected");
});

test("missing member does not consume action cooldown", async () => {
  const timeoutCalls: string[] = [];
  const member: FakeGuildMember = {
    timeout: async () => {
      timeoutCalls.push("timeout");
    },
    kick: async () => {},
  };
  const config = createFakeAutomodConfig({
    maxMessagesPerMinute: 100,
    bannedWords: ["blocked"],
    action: "timeout",
  });
  const ctx = fakePluginContext({ config, ownerUserId: OWNER_USER_ID });

  const missingMemberMessage = makeMessage(
    null,
    "lookup-flake-user",
    "blocked",
    undefined,
    null
  );
  await automodPlugin.onMessage!(missingMemberMessage as never, ctx);

  const foundMemberMessage = makeMessage(
    null,
    "lookup-flake-user",
    "blocked",
    undefined,
    member
  );
  await automodPlugin.onMessage!(foundMemberMessage as never, ctx);

  expect(timeoutCalls).toEqual(["timeout"]);
});

test("banned words trigger the configured kick action", async () => {
  const kickCalls: string[] = [];
  const member: FakeGuildMember = {
    timeout: async () => {},
    kick: async () => {
      kickCalls.push("kick");
    },
  };
  const config = createFakeAutomodConfig({
    maxMessagesPerMinute: 100,
    bannedWords: ["scam"],
    action: "kick",
  });

  const message = makeMessage(member, "spammer-kick", "obvious scam");

  await automodPlugin.onMessage!(
    message as never,
    fakePluginContext({ config })
  );

  expect(kickCalls).toEqual(["kick"]);
});

test("automod command with no args returns current config", async () => {
  const replies: string[] = [];
  const cfg = createFakeAutomodConfig({
    maxMessagesPerMinute: 20,
    bannedWords: ["nope"],
    action: "warn",
  });

  await automodPlugin.init(fakePluginContext({ config: cfg }));

  const handler = commands.get("automod_config")?.handler;
  expect(handler).toBeDefined();

  const interaction = makeCommandInteraction({
    onReply: (content) => replies.push(content),
  });

  await handler!(
    interaction as never,
    fakePluginContext({ config: cfg })
  );

  expect(replies.at(-1)).toContain("Max messages/minute: 20");
  expect(replies.at(-1)).toContain("Action: warn");
  expect(replies.at(-1)).toContain("Banned words: nope");
  expect(replies.at(-1)).toContain("Owner-only command: `/automod_config`");
});

test("destroy clears in-memory automod state", async () => {
  const replies: string[] = [];
  const member: FakeGuildMember = {
    timeout: async () => {},
    kick: async () => {},
  };
  const config = createFakeAutomodConfig({
    maxMessagesPerMinute: 1,
    bannedWords: [],
    action: "warn",
  });
  const ctx = fakePluginContext({ config, ownerUserId: OWNER_USER_ID });

  const message = makeMessage(member, "spammer-reset", "hello");
  message.reply = async ({ content }) => {
    replies.push(content);
  };

  await automodPlugin.onMessage!(message as never, ctx);
  await automodPlugin.onMessage!(message as never, ctx);
  expect(replies).toHaveLength(1);

  await automodPlugin.destroy!();

  const freshMessage = makeMessage(member, "spammer-reset", "after-reset");
  freshMessage.reply = async ({ content }) => {
    replies.push(content);
  };
  await automodPlugin.onMessage!(freshMessage as never, ctx);

  expect(replies).toHaveLength(1);
});
