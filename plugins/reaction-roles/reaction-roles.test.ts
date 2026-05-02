import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReactionRoleDB, type ReactionRole } from "./db.ts";
import { emojiKeyFromInput, emojiKeyFromReaction } from "./emoji.ts";
import { applyReactionRole } from "./index.ts";

type ReactionRoleStore = Parameters<typeof applyReactionRole>[0];
type ReactionRoleEvent = Parameters<typeof applyReactionRole>[1];
type ReactionRoleUser = Parameters<typeof applyReactionRole>[2];
type ReactionRoleGuild = NonNullable<ReactionRoleEvent["message"]["guild"]>;

function mappedStore(roleId = "role-1"): ReactionRoleStore {
  return {
    get(
      guildId: string,
      channelId: string,
      messageId: string,
      emojiKey: string
    ): ReactionRole {
      expect([guildId, channelId, messageId, emojiKey]).toEqual([
        "guild-1",
        "channel-1",
        "message-1",
        "✅",
      ]);
      return {
        guildId,
        channelId,
        messageId,
        emojiKey,
        roleId,
      };
    },
  };
}

function user(overrides: Partial<ReactionRoleUser> = {}): ReactionRoleUser {
  return {
    partial: false,
    bot: false,
    id: "user-1",
    ...overrides,
  };
}

test("emojiKeyFromInput normalizes custom emoji markup to IDs", () => {
  expect(emojiKeyFromInput("✅")).toBe("✅");
  expect(emojiKeyFromInput("<:party:123456789012345678>")).toBe(
    "123456789012345678"
  );
  expect(emojiKeyFromInput("<a:dance:123456789012345678>")).toBe(
    "123456789012345678"
  );
  expect(emojiKeyFromInput("  <a:party:123456789012345678>  ")).toBe(
    "123456789012345678"
  );
  expect(emojiKeyFromInput("123456789012345678")).toBe(
    "123456789012345678"
  );
});

test("emojiKeyFromReaction matches unicode and custom emoji keys", () => {
  expect(emojiKeyFromReaction({ emoji: { id: null, name: "✅" } })).toBe("✅");
  expect(
    emojiKeyFromReaction({
      emoji: { id: "123456789012345678", name: "party" },
    })
  ).toBe("123456789012345678");
});

test("ReactionRoleDB persists and updates mappings", () => {
  const dir = mkdtempSync(join(tmpdir(), "choomfie-reaction-roles-"));
  const dbPath = join(dir, "reaction-roles.db");
  const db = new ReactionRoleDB(dbPath);

  db.upsert({
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "message-1",
    emojiKey: "✅",
    roleId: "role-1",
  });

  expect(db.get("guild-1", "channel-1", "message-1", "✅")?.roleId).toBe(
    "role-1"
  );
  expect(db.get("guild-1", "channel-2", "message-1", "✅")).toBeNull();

  db.upsert({
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "message-1",
    emojiKey: "✅",
    roleId: "role-2",
  });

  expect(db.get("guild-1", "channel-1", "message-1", "✅")?.roleId).toBe(
    "role-2"
  );
  db.close();
  rmSync(dir, { force: true, recursive: true });
});

test("applyReactionRole adds and removes the configured role", async () => {
  const actions: string[] = [];
  const guild: ReactionRoleGuild = {
    id: "guild-1",
    members: {
      async fetch(userId: string) {
        expect(userId).toBe("user-1");
        return {
          roles: {
            async add(roleId: string, reason: string) {
              actions.push(`add:${roleId}:${reason}`);
            },
            async remove(roleId: string, reason: string) {
              actions.push(`remove:${roleId}:${reason}`);
            },
          },
        };
      },
    },
  };
  const reaction: ReactionRoleEvent = {
    partial: false,
    emoji: { id: null, name: "✅" },
    message: { id: "message-1", channelId: "channel-1", guild },
  };

  await applyReactionRole(mappedStore(), reaction, user(), "add");
  await applyReactionRole(mappedStore(), reaction, user(), "remove");

  expect(actions).toEqual([
    "add:role-1:Reaction role added",
    "remove:role-1:Reaction role removed",
  ]);
});

test("applyReactionRole ignores bots and unmapped reactions", async () => {
  let lookups = 0;
  let memberFetches = 0;
  const store: ReactionRoleStore = {
    get(
      guildId: string,
      channelId: string,
      messageId: string,
      emojiKey: string
    ): null {
      expect([guildId, channelId, messageId, emojiKey]).toEqual([
        "guild-1",
        "channel-1",
        "message-1",
        "✅",
      ]);
      lookups++;
      return null;
    },
  };
  const reaction: ReactionRoleEvent = {
    partial: false,
    emoji: { id: null, name: "✅" },
    message: {
      id: "message-1",
      channelId: "channel-1",
      guild: {
        id: "guild-1",
        members: {
          async fetch() {
            memberFetches++;
            throw new Error("member fetch should not run");
          },
        },
      },
    },
  };

  await applyReactionRole(
    store,
    reaction,
    user({ bot: true, id: "bot-1" }),
    "add"
  );
  await applyReactionRole(store, reaction, user(), "add");

  expect(lookups).toBe(1);
  expect(memberFetches).toBe(0);
});

test("applyReactionRole removes roles from partial reactions when fetch fails", async () => {
  const actions: string[] = [];
  const guild: ReactionRoleGuild = {
    id: "guild-1",
    members: {
      async fetch(userId: string) {
        expect(userId).toBe("user-1");
        return {
          roles: {
            async add() {
              throw new Error("role add should not run");
            },
            async remove(roleId: string, reason: string) {
              actions.push(`remove:${roleId}:${reason}`);
            },
          },
        };
      },
    },
  };
  const reaction: ReactionRoleEvent = {
    partial: true,
    async fetch() {
      throw new Error("removed reaction is no longer fetchable");
    },
    emoji: { id: null, name: "✅" },
    message: {
      id: "message-1",
      channelId: "channel-1",
      guild: null,
      guildId: "guild-1",
      client: {
        guilds: {
          async fetch(guildId: string) {
            expect(guildId).toBe("guild-1");
            return guild;
          },
        },
      },
    },
  };

  await applyReactionRole(mappedStore(), reaction, user(), "remove");

  expect(actions).toEqual(["remove:role-1:Reaction role removed"]);
});
