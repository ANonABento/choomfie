import { expect, test } from "bun:test";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { queryOptions, usageFromResult } from "../lib/openai/agent-sdk-adapter.ts";
import type { ChatBackendInput } from "../lib/openai/chat.ts";

function makeInput(): ChatBackendInput {
  return {
    model: "sonnet",
    backendModel: "sonnet",
    messages: [{ role: "user", content: "hi" }],
  };
}

// Shape only needs the usage fields usageFromResult reads.
function makeResult(usage: Record<string, number>): SDKResultMessage {
  return { usage } as unknown as SDKResultMessage;
}

test("query options do not load filesystem settings", () => {
  // ["user","project"] pulled the global + project CLAUDE.md into every Discord
  // message (~36.6k cache-creation tokens for a one-word reply). Empty array is
  // the SDK's isolation mode; 'project' is specifically what loads CLAUDE.md.
  for (const partial of [false, true]) {
    const options = queryOptions(makeInput(), partial);
    expect(options.settingSources).toEqual([]);
    expect(options.settingSources).not.toContain("project");
    expect(options.settingSources).not.toContain("user");
  }
});

test("query options allow enough turns for a tool call to complete", () => {
  // maxTurns:1 turned any tool use into "Reached maximum number of turns (1)"
  // instead of a reply — a hard error, not a degraded answer.
  const options = queryOptions(makeInput(), false);
  expect(options.maxTurns).toBeGreaterThan(1);
});

test("query options carry the requested backend model and stream flag", () => {
  const input = { ...makeInput(), backendModel: "opus" };
  expect(queryOptions(input, false).model).toBe("opus");
  expect(queryOptions(input, false).includePartialMessages).toBe(false);
  expect(queryOptions(input, true).includePartialMessages).toBe(true);
});

test("usage counts cache tokens as input tokens", () => {
  // The real shape of the regression: a "BRAIN_OK" reply reported 3 prompt
  // tokens while actually consuming 36,584 cache-creation tokens.
  const usage = usageFromResult(
    makeResult({
      input_tokens: 3,
      output_tokens: 7,
      cache_creation_input_tokens: 36_584,
      cache_read_input_tokens: 0,
    }),
  );

  expect(usage?.prompt_tokens).toBe(36_587);
  expect(usage?.completion_tokens).toBe(7);
  expect(usage?.total_tokens).toBe(36_594);
});

test("usage counts cache reads too", () => {
  const usage = usageFromResult(
    makeResult({
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1_000,
    }),
  );

  expect(usage?.prompt_tokens).toBe(1_010);
  expect(usage?.total_tokens).toBe(1_015);
});

test("usage tolerates missing cache fields", () => {
  const usage = usageFromResult(makeResult({ input_tokens: 12, output_tokens: 4 }));

  expect(usage?.prompt_tokens).toBe(12);
  expect(usage?.completion_tokens).toBe(4);
  expect(usage?.total_tokens).toBe(16);
});
