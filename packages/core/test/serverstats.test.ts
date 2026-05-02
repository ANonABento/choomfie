import {
  Collection,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { expect, test } from "bun:test";
import { commands, type CommandDef, type PluginContext } from "@choomfie/shared";

await import("../lib/commands.ts");

type MockMessage = { id: string; createdAt: Date };
type MockMessageCollection = Collection<string, MockMessage>;
type MockMessageFetchArgs = { limit: number; before?: string };
type MockChannel = {
  id: string;
  name: string | null;
  isTextBased: () => boolean;
  messages: {
    fetch: (args: MockMessageFetchArgs) => Promise<MockMessageCollection>;
  };
};
type MockGuildStats = {
  approximateMemberCount: number;
  memberCount: number;
  approximatePresenceCount: number;
};
type MockServerStatsEmbed = {
  data: { title?: string; fields?: Array<{ name: string; value: string }> };
};
type MockGuildResponse = {
  id: string;
  name: string;
  approximateMemberCount: number;
  memberCount: number;
  approximatePresenceCount: number;
};
type MockEditPayload = { embeds?: MockServerStatsEmbed[]; content?: string };
type MockGuildFetchOptions = {
  guild: string;
  withCounts: boolean;
  force: boolean;
};
type MockInteraction = {
  guild?: {
    id: string;
    name: string;
    channels: { fetch: () => Promise<Collection<string, MockChannel>> };
  };
  client?: {
    guilds: {
      fetch: (options: MockGuildFetchOptions) => Promise<MockGuildResponse>;
    };
  };
  deferReply?: (opts?: { flags?: number }) => Promise<void> | void;
  editReply?: (payload: MockEditPayload) => Promise<void> | void;
  reply?: (payload: { content: string; flags?: number }) => Promise<void> | void;
};

const ONE_MINUTE = 60_000;

function makeMessage(id: string, createdAt: Date): MockMessage {
  return { id, createdAt };
}

function startOfCurrentDay(reference: Date): Date {
  const current = new Date(reference);
  current.setHours(0, 0, 0, 0);
  return current;
}

function safeRecentMessage(reference: Date, minutesAgo: number): Date {
  const min = startOfCurrentDay(reference).getTime() + ONE_MINUTE;
  const target = reference.getTime() - minutesAgo * ONE_MINUTE;
  return new Date(Math.max(target, min));
}

function makeMessageBatch(
  prefix: string,
  reference: Date,
  count: number
): MockMessageCollection {
  const rows: Array<[string, MockMessage]> = [];
  for (let i = 0; i < count; i += 1) {
    const id = `${prefix}-${i}`;
    rows.push([
      id,
      { id, createdAt: new Date(reference.getTime() - i * ONE_MINUTE) },
    ]);
  }
  return new Collection<string, MockMessage>(rows);
}

function makePagedTextChannel(
  id: string,
  name: string | null,
  pages: Array<MockMessageCollection>
): MockChannel {
  let index = 0;

  return {
    id,
    name,
    isTextBased: () => true,
    messages: {
      fetch: async () => {
        const page = pages[index] ?? new Collection<string, MockMessage>();
        index += 1;
        return page;
      },
    },
  };
}

function makeDiscordApiError(
  message: string,
  code: number
): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

function makeTextChannel(
  id: string,
  name: string | null,
  fetchMessages: (args: MockMessageFetchArgs) => Promise<MockMessageCollection>
): MockChannel {
  return {
    id,
    name,
    isTextBased: () => true,
    messages: { fetch: fetchMessages },
  };
}

function makeVoiceChannel(id: string, name: string): MockChannel {
  return {
    id,
    name,
    isTextBased: () => false,
    messages: { fetch: async () => new Collection() },
  };
}

function makeMockGuildInteraction(
  channels: Collection<string, MockChannel>,
  counts: MockGuildStats
) {
  const state: {
    deferred: boolean;
    deferredFlags?: number;
    editPayload?: MockEditPayload;
    guildFetchOptions?: MockGuildFetchOptions;
  } = { deferred: false };

  const interaction: MockInteraction = {
    guild: {
      id: "guild-id",
      name: "Guild",
      channels: {
        fetch: async () => channels,
      },
    },
    client: {
      guilds: {
        fetch: async (options: MockGuildFetchOptions) => {
          state.guildFetchOptions = options;
          return {
            id: "guild-id",
            name: "Guild",
            ...counts,
          };
        },
      },
    },
    deferReply: async ({ flags } = {}) => {
      state.deferred = true;
      state.deferredFlags = flags;
    },
    editReply: async (payload: MockEditPayload) => {
      state.editPayload = payload;
    },
  };

  return { interaction, state };
}

function makeMockDmInteraction() {
  const state: {
    replied: boolean;
    flags?: number;
    content?: string;
  } = { replied: false };

  const interaction: MockInteraction = {
    reply: async ({ content, flags }) => {
      state.replied = true;
      state.content = content;
      state.flags = flags;
    },
  };

  return { interaction, state };
}

function getEmbedData(state: { editPayload?: MockEditPayload }) {
  return state.editPayload?.embeds?.[0]?.data;
}

function getEmbedField(
  state: { editPayload?: MockEditPayload },
  name: string
) {
  return state.editPayload?.embeds?.[0]?.data?.fields?.find(
    (field) => field.name === name
  );
}

function getServerstatsCommand(): CommandDef {
  const def = commands.get("serverstats");
  expect(def).toBeDefined();
  return def!;
}

async function runServerstats(def: CommandDef, interaction: MockInteraction) {
  await def.handler(
    interaction as unknown as ChatInputCommandInteraction,
    {} as PluginContext
  );
}

test("/serverstats command is registered with guild-only visibility", () => {
  const def = commands.get("serverstats");
  expect(def).toBeDefined();
  expect(def!.data.name).toBe("serverstats");
  expect(def!.data.dm_permission).toBe(false);
  expect(def!.data.description).toBe(
    "Show guild statistics and today's activity"
  );
});

test("/serverstats handler builds an embed payload with expected sections", async () => {
  const def = getServerstatsCommand();
  const referenceNow = new Date();
  const recentMessages = new Collection<string, MockMessage>([
    ["m1", makeMessage("m1", safeRecentMessage(referenceNow, 60))],
    ["m2", makeMessage("m2", safeRecentMessage(referenceNow, 5))],
  ]);
  const oldMessage = new Collection<string, MockMessage>([
    [
      "m3",
      makeMessage(
        "m3",
        new Date(startOfCurrentDay(referenceNow).getTime() - ONE_MINUTE)
      ),
    ],
  ]);
  const channels = new Collection<string, MockChannel>([
    [
      "c1",
      makeTextChannel("c1", "general", async ({ before }) =>
        before ? new Collection() : recentMessages
      ),
    ],
    [
      "c2",
      makeTextChannel("c2", null, async ({ before }) =>
        before ? new Collection() : oldMessage
      ),
    ],
    ["c3", makeVoiceChannel("c3", "voice")],
  ]);

  const { interaction, state } = makeMockGuildInteraction(channels, {
    approximateMemberCount: 128,
    memberCount: 0,
    approximatePresenceCount: 64,
  });

  await runServerstats(def, interaction);

  expect(state.deferred).toBe(true);
  expect(state.deferredFlags).toBe(MessageFlags.Ephemeral);
  expect(state.guildFetchOptions).toEqual({
    guild: "guild-id",
    withCounts: true,
    force: true,
  });
  const embedData = getEmbedData(state);
  expect(embedData).toBeDefined();
  expect(embedData!.title).toBe("Server Stats — Guild");
  expect(embedData!.fields).toHaveLength(2);

  const current = getEmbedField(state, "Current Stats");
  expect(current?.value).toContain("**Members:** 128");
  expect(current?.value).toContain("**Online:** 64");
  expect(current?.value).toContain("**Channels:** 3");
  expect(current?.value).toContain("**Messages today:** 2");

  const top = getEmbedField(state, "Top 5 Active Channels");
  expect(top?.value).toContain("<#c1>");
  expect(top?.value).toContain("2 messages");
});

test("/serverstats handler returns no-message message when history is empty", async () => {
  const def = getServerstatsCommand();
  const channels = new Collection<string, MockChannel>([
    [
      "c1",
      makeTextChannel("c1", "general", async () => new Collection()),
    ],
    ["c2", makeVoiceChannel("c2", "voice")],
  ]);

  const { interaction, state } = makeMockGuildInteraction(channels, {
    approximateMemberCount: 2,
    memberCount: 2,
    approximatePresenceCount: 1,
  });

  await runServerstats(def, interaction);

  const current = getEmbedField(state, "Current Stats");
  expect(current?.value).toContain("**Messages today:** 0");
  const top = getEmbedField(state, "Top 5 Active Channels");
  expect(top?.value).toContain("No messages were sent today.");
});

test("/serverstats handler keeps only top 5 channels by message count", async () => {
  const def = getServerstatsCommand();
  const referenceNow = new Date();

  const channels = new Collection<string, MockChannel>([
    [
      "c1",
      makeTextChannel("c1", "one", async () =>
        makeMessageBatch("c1", referenceNow, 12)
      ),
    ],
    [
      "c2",
      makeTextChannel("c2", "two", async () =>
        makeMessageBatch("c2", referenceNow, 11)
      ),
    ],
    [
      "c3",
      makeTextChannel("c3", "three", async () =>
        makeMessageBatch("c3", referenceNow, 10)
      ),
    ],
    [
      "c4",
      makeTextChannel("c4", "four", async () =>
        makeMessageBatch("c4", referenceNow, 9)
      ),
    ],
    [
      "c5",
      makeTextChannel("c5", "five", async () =>
        makeMessageBatch("c5", referenceNow, 8)
      ),
    ],
    [
      "c6",
      makeTextChannel("c6", "six", async () =>
        makeMessageBatch("c6", referenceNow, 7)
      ),
    ],
  ]);

  const { interaction, state } = makeMockGuildInteraction(channels, {
    approximateMemberCount: 128,
    memberCount: 0,
    approximatePresenceCount: 64,
  });

  await runServerstats(def, interaction);

  const top = getEmbedField(state, "Top 5 Active Channels")?.value ?? "";
  expect(top).toContain("<#c1>");
  expect(top).toContain("<#c2>");
  expect(top).toContain("<#c3>");
  expect(top).toContain("<#c4>");
  expect(top).toContain("<#c5>");
  expect(top).not.toContain("<#c6>");
});

test("/serverstats handler paginates message history to count messages from today", async () => {
  const def = getServerstatsCommand();
  const since = startOfCurrentDay(new Date());
  const reference = new Date(since.getTime() + 2 * 60 * 60 * 1000);

  const pagedChannel = makePagedTextChannel("c1", "active", [
    makeMessageBatch("page1", reference, 100),
    new Collection<string, MockMessage>([
      [
        "page2-new",
        makeMessage("page2-new", new Date(since.getTime() + 60 * 1000)),
      ],
      [
        "page2-old",
        makeMessage("page2-old", new Date(since.getTime() - ONE_MINUTE)),
      ],
    ]),
  ]);

  const channels = new Collection<string, MockChannel>([
    ["c1", pagedChannel],
  ]);

  const { interaction, state } = makeMockGuildInteraction(channels, {
    approximateMemberCount: 1,
    memberCount: 1,
    approximatePresenceCount: 1,
  });

  await runServerstats(def, interaction);

  const current = getEmbedField(state, "Current Stats");
  expect(current?.value).toContain("**Messages today:** 101");
});

test("/serverstats handler tolerates unreadable channels and still returns stats", async () => {
  const def = getServerstatsCommand();
  const referenceNow = new Date();
  const channels = new Collection<string, MockChannel>([
    [
      "c1",
      makeTextChannel("c1", "visible", async () =>
        makeMessageBatch("visible", referenceNow, 2)
      ),
    ],
    [
      "c2",
      {
        id: "c2",
        name: "restricted",
        isTextBased: () => true,
        messages: {
          fetch: async () => {
            throw makeDiscordApiError("Missing Access", 50001);
          },
        },
      },
    ],
    [
      "c3",
      {
        id: "c3",
        name: "no-history",
        isTextBased: () => true,
        messages: {
          fetch: async () => {
            throw makeDiscordApiError("Missing Permissions", 50013);
          },
        },
      },
    ],
  ]);

  const { interaction, state } = makeMockGuildInteraction(channels, {
    approximateMemberCount: 4,
    memberCount: 4,
    approximatePresenceCount: 1,
  });

  await runServerstats(def, interaction);

  const current = getEmbedField(state, "Current Stats");
  const top = getEmbedField(state, "Top 5 Active Channels");
  expect(current?.value).toContain("**Messages today:** 2");
  expect(top?.value).toContain("<#c1>");
  expect(top?.value).not.toContain("restricted");
});

test("/serverstats handler replies ephemerally when used in DMs", async () => {
  const def = getServerstatsCommand();
  const { interaction, state } = makeMockDmInteraction();

  await runServerstats(def, interaction);

  expect(state.replied).toBe(true);
  expect(state.flags).toBe(MessageFlags.Ephemeral);
  expect(state.content).toBe("Server stats can only be used in a guild.");
});
