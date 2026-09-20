/**
 * Regression tests for autocomplete routing.
 *
 * Autocomplete is the one interaction kind that cannot go through
 * `safeHandle()`: an AutocompleteInteraction has no `reply()` or `editReply()`,
 * only `respond()`, and Discord accepts exactly one response within 3 seconds.
 * Routing it down the command path — or letting an error fall into the generic
 * "Something went wrong" reply — throws inside the error handler and leaves the
 * user staring at a spinner that never resolves.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import type { AppContext } from "../../lib/types.ts";
import { handleInteraction, registerAllHandlers } from "../../lib/interactions.ts";
import { registerCommand } from "../../lib/register.ts";

beforeAll(async () => {
  await registerAllHandlers();
});

type Recorded = {
  responded: unknown[][];
  replied: unknown[];
};

/** Minimal stand-in for an AutocompleteInteraction. */
function fakeAutocomplete(
  commandName: string,
  options: { focused?: string; strings?: Record<string, string> } = {},
) {
  const recorded: Recorded = { responded: [], replied: [] };
  const interaction = {
    commandName,
    isAutocomplete: () => true,
    isChatInputCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => false,
    options: {
      getFocused: () => options.focused ?? "",
      getString: (name: string) => options.strings?.[name] ?? null,
    },
    respond: async (choices: unknown[]) => {
      recorded.responded.push(choices);
    },
    // Present so that a wrong route is caught rather than crashing the test.
    reply: async (payload: unknown) => {
      recorded.replied.push(payload);
    },
  };
  return { interaction, recorded };
}

const ctx = { plugins: [] } as unknown as AppContext;

describe("autocomplete routing", () => {
  test("reaches the command's suggester and never the reply path", async () => {
    const { interaction, recorded } = fakeAutocomplete("config", {
      strings: { setting: "daemon.model" },
      focused: "op",
    });

    await handleInteraction(interaction as never, ctx);

    expect(recorded.responded).toHaveLength(1);
    expect(recorded.replied).toHaveLength(0);
    expect(recorded.responded[0]).toContainEqual({ name: "opus", value: "opus" });
  });

  test("responds with an empty list when no setting is selected yet", async () => {
    // Discord shows a spinner until something responds, so "nothing to suggest"
    // still has to be an explicit empty response.
    const { interaction, recorded } = fakeAutocomplete("config", { focused: "x" });

    await handleInteraction(interaction as never, ctx);

    expect(recorded.responded).toEqual([[]]);
  });

  test("a suggester that throws still responds, rather than hanging the picker", async () => {
    registerCommand("autocomplete-boom", {
      data: { name: "autocomplete-boom", description: "test" } as never,
      handler: async () => {},
      autocomplete: async () => {
        throw new Error("boom");
      },
    });

    const { interaction, recorded } = fakeAutocomplete("autocomplete-boom");
    await handleInteraction(interaction as never, ctx);

    // Empty list, not the generic "Something went wrong" reply — which would
    // throw, since respond() is the only response an autocomplete accepts.
    expect(recorded.responded).toEqual([[]]);
    expect(recorded.replied).toHaveLength(0);
  });

  test("a command without a suggester is ignored, not errored", async () => {
    const { interaction, recorded } = fakeAutocomplete("status");
    await handleInteraction(interaction as never, ctx);
    expect(recorded.responded).toHaveLength(0);
    expect(recorded.replied).toHaveLength(0);
  });

  test("an unknown command name is ignored", async () => {
    const { interaction, recorded } = fakeAutocomplete("no-such-command");
    await handleInteraction(interaction as never, ctx);
    expect(recorded.responded).toHaveLength(0);
  });

  test("/model suggests without needing another option selected first", async () => {
    const { interaction, recorded } = fakeAutocomplete("model", { focused: "" });
    await handleInteraction(interaction as never, ctx);

    expect(recorded.responded).toHaveLength(1);
    expect(recorded.responded[0]).toContainEqual({
      name: "default",
      value: "default",
    });
  });
});
