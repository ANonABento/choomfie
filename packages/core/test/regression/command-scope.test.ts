/**
 * Regression tests for slash command deployment scope.
 *
 * Choomfie used to deploy commands per-guild. Discord keeps guild-scoped and
 * global commands as separate lists and a guild command *shadows* a global one
 * with the same name, so once the bot switched to global the old guild copies
 * would have kept winning — that guild silently pinned to a stale definition
 * while `/help` and every other surface described the new one.
 *
 * These tests pin the two things that make the switch actually work: the routes
 * used, and that a global deploy also clears the guild-scoped leftovers.
 */
import { describe, expect, test } from "bun:test";
import { Routes, type REST } from "discord.js";
import {
  clearGuildCommands,
  deployGlobalCommands,
  deployGuildCommands,
  type CommandBody,
} from "../../lib/command-deploy.ts";

type Put = { route: string; body: unknown };

/** Minimal stand-in for discord.js REST — records the calls the deploy makes. */
function fakeRest(): { rest: REST; puts: Put[] } {
  const puts: Put[] = [];
  const rest = {
    put: async (route: string, options: { body: unknown }) => {
      puts.push({ route, body: options.body });
      return {};
    },
  } as unknown as REST;
  return { rest, puts };
}

const APP = "app-123";
const COMMANDS = [{ name: "status", description: "Bot status" }] as CommandBody[];

describe("global command deployment", () => {
  test("deploys to the application-wide route, not a guild one", async () => {
    const { rest, puts } = fakeRest();
    await deployGlobalCommands(rest, APP, COMMANDS);

    expect(puts).toHaveLength(1);
    expect(puts[0].route).toBe(Routes.applicationCommands(APP));
    expect(puts[0].body).toEqual(COMMANDS);
    // The global route must not be a guild route with an empty guild id.
    expect(puts[0].route).not.toContain("/guilds/");
  });

  test("clearing a guild PUTs an empty list, removing every guild-scoped command", async () => {
    const { rest, puts } = fakeRest();
    const cleared = await clearGuildCommands(rest, APP, ["g1", "g2"]);

    expect(cleared).toBe(2);
    expect(puts.map((p) => p.route)).toEqual([
      Routes.applicationGuildCommands(APP, "g1"),
      Routes.applicationGuildCommands(APP, "g2"),
    ]);
    // An empty body is what actually deletes them; anything else leaves
    // shadowing copies in place.
    for (const put of puts) expect(put.body).toEqual([]);
  });

  test("clearing no guilds is a no-op rather than an error", async () => {
    const { rest, puts } = fakeRest();
    expect(await clearGuildCommands(rest, APP, [])).toBe(0);
    expect(puts).toHaveLength(0);
  });

  test("guild deploy still exists for the --guild dev escape hatch", async () => {
    const { rest, puts } = fakeRest();
    const deployed = await deployGuildCommands(rest, APP, ["g1"], COMMANDS);

    expect(deployed).toBe(1);
    expect(puts[0].route).toBe(Routes.applicationGuildCommands(APP, "g1"));
    expect(puts[0].body).toEqual(COMMANDS);
  });

  test("the two scopes address genuinely different routes", () => {
    // Guard against a refactor collapsing them into one helper by accident.
    expect(Routes.applicationCommands(APP)).not.toBe(
      Routes.applicationGuildCommands(APP, "g1"),
    );
  });
});
