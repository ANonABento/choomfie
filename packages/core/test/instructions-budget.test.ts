/**
 * MCP instruction budgeting.
 *
 * Claude Code truncates a server's `instructions` at 2048 characters and
 * reports it only in its own log. Choomfie appended `## Security` near the end
 * of that string, so a long persona pushed the non-owner tool allowlist and the
 * "NEVER use Bash, Read, Write…" boundary past the cut — silently, on a running
 * bot. Found live: the `mahiro` persona (1,179 chars) produced 2,515 and lost
 * the whole Security section.
 *
 * These tests pin the property that matters: whatever else is shed, the rules
 * and the security boundary stay.
 */
import { describe, expect, test } from "bun:test";
import {
  MCP_INSTRUCTIONS_LIMIT,
  buildInstructions,
} from "../lib/mcp-server.ts";
import type { AppContext } from "../lib/types.ts";

const SECURITY_MARKERS = [
  "## Security",
  "NEVER use Bash, Read, Write, Edit, Glob, Grep, Agent",
  "Only the owner can approve/deny permission requests",
  "choomfie_status",
];

function ctxWith(opts: {
  personality?: string;
  name?: string;
  memories?: string;
  pluginInstructions?: string[];
}): AppContext {
  const { personality = "Be casual.", name = "Choomfie" } = opts;
  return {
    config: {
      getActivePersona: () => ({ name, personality }),
      getActivePersonaKey: () => "test",
    },
    memory: { buildMemoryContext: () => opts.memories ?? "" },
    plugins: opts.pluginInstructions
      ? [{ name: "p", instructions: opts.pluginInstructions }]
      : [],
  } as unknown as AppContext;
}

/** The real thing, verbatim from config.json when this bug was found. */
const MAHIRO = "A" .repeat(1179);

describe("instruction budgeting", () => {
  test("a short persona is left completely alone", () => {
    const out = buildInstructions(ctxWith({ personality: "Be casual, friendly, and fun." }));
    expect(out.length).toBeLessThanOrEqual(MCP_INSTRUCTIONS_LIMIT);
    expect(out).toContain("Be casual, friendly, and fun.");
    for (const marker of SECURITY_MARKERS) expect(out).toContain(marker);
  });

  test("the persona that broke it now fits, with security intact", () => {
    const out = buildInstructions(ctxWith({ name: "Mahiro Oyama", personality: MAHIRO }));

    // The bug: this was 2515, so Claude Code cut 467 chars off the end.
    expect(out.length).toBeLessThanOrEqual(MCP_INSTRUCTIONS_LIMIT);
    for (const marker of SECURITY_MARKERS) expect(out).toContain(marker);
    // The name survives even when the personality cannot.
    expect(out).toContain("You are Mahiro Oyama.");
  });

  test("security survives no matter how absurd the persona gets", () => {
    for (const size of [700, 1179, 5_000, 100_000]) {
      const out = buildInstructions(ctxWith({ personality: "x".repeat(size) }));
      expect(out.length).toBeLessThanOrEqual(MCP_INSTRUCTIONS_LIMIT);
      for (const marker of SECURITY_MARKERS) {
        expect(`${size}: ${out.includes(marker)}`).toBe(`${size}: true`);
      }
    }
  });

  test("core memories are shed before the persona is cut into", () => {
    // 20 core memories are allowed, and nothing bounds their length — memory
    // can blow the budget on its own, with no persona involved.
    const out = buildInstructions(
      ctxWith({ personality: "Be terse.", memories: "## Current Memories\n" + "- k: v\n".repeat(400) }),
    );
    expect(out.length).toBeLessThanOrEqual(MCP_INSTRUCTIONS_LIMIT);
    expect(out).toContain("Be terse.");
    for (const marker of SECURITY_MARKERS) expect(out).toContain(marker);
  });

  test("plugin instructions go first, before anything else is touched", () => {
    const memories = "## Current Memories\n- favourite: ramen";
    const out = buildInstructions(
      ctxWith({
        personality: "Be terse.",
        memories,
        pluginInstructions: ["z".repeat(1500)],
      }),
    );
    expect(out.length).toBeLessThanOrEqual(MCP_INSTRUCTIONS_LIMIT);
    expect(out).not.toContain("zzz");
    // Memory and persona were cheap enough to keep, so they were kept.
    expect(out).toContain("favourite: ramen");
    expect(out).toContain("Be terse.");
  });

  test("everything fits when nothing needs shedding", () => {
    const out = buildInstructions(
      ctxWith({
        personality: "Be brief.",
        memories: "## Current Memories\n- favourite: ramen",
        pluginInstructions: ["Use the browse tool for URLs."],
      }),
    );
    expect(out).toContain("favourite: ramen");
    expect(out).toContain("Use the browse tool for URLs.");
    expect(out).toContain("Be brief.");
  });

  test("a truncated personality is marked, not silently clipped mid-word", () => {
    const out = buildInstructions(ctxWith({ personality: "y".repeat(3000) }));
    expect(out).toContain("…");
  });

  test("the limit is a parameter, so a future cap change is one edit", () => {
    const out = buildInstructions(ctxWith({ personality: "z".repeat(3000) }), 1600);
    expect(out.length).toBeLessThanOrEqual(1600);
  });

  test("the rules are a floor: below it, they are kept and the cap is missed", () => {
    // The fixed rules are ~1330 chars and there is nothing sensible to drop
    // from them, so a limit under that cannot be honoured. Keeping the security
    // boundary and overrunning is the right failure — the alternative is
    // returning a string that satisfies a number and licenses nothing.
    const floor = buildInstructions(ctxWith({ personality: "" }), 10);
    expect(floor.length).toBeGreaterThan(10);
    for (const marker of SECURITY_MARKERS) expect(floor).toContain(marker);

    // Documents where that floor sits, so a rules edit that doubles it is
    // visible here rather than in production.
    expect(floor.length).toBeLessThan(1500);
  });
});
