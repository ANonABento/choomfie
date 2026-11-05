import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions } from "../../daemon/cli-version.ts";

/**
 * The daemon's model depends on the Agent SDK version: aliases like "opus" are
 * resolved by the Claude Code build bundled inside it. The SDK was once
 * declared in both the root and packages/core manifests; bumping only the root
 * left core — the package that actually imports it — on an old copy that
 * resolved "opus" to Opus 4.7. One declaration, one resolved copy.
 */

const SDK = "@anthropic-ai/claude-agent-sdk";
const ROOT = join(import.meta.dir, "../../../..");

function workspaceManifests(): string[] {
  const manifests = [join(ROOT, "package.json")];
  for (const group of ["packages", "plugins"]) {
    for (const entry of readdirSync(join(ROOT, group), { withFileTypes: true })) {
      if (entry.isDirectory()) manifests.push(join(ROOT, group, entry.name, "package.json"));
    }
  }
  return manifests;
}

function declaresSdk(path: string): boolean {
  let pkg: Record<string, Record<string, string> | undefined>;
  try {
    pkg = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return false;
  }
  return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some(
    (field) => pkg[field]?.[SDK] !== undefined,
  );
}

describe("Agent SDK single copy", () => {
  test("declared only by @choomfie/core, the package that imports it", () => {
    const declaring = workspaceManifests()
      .filter(declaresSdk)
      .map((path) => path.slice(ROOT.length + 1));
    expect(declaring).toEqual(["packages/core/package.json"]);
  });

  test("bun.lock resolves exactly one version", () => {
    const lock = readFileSync(join(ROOT, "bun.lock"), "utf-8");
    // Entries look like: "<key>": ["@anthropic-ai/claude-agent-sdk@<version>", ...
    const versions = new Set(
      [...lock.matchAll(/\["@anthropic-ai\/claude-agent-sdk@([^"]+)"/g)].map((m) => m[1]),
    );
    expect([...versions]).toHaveLength(1);
  });
});

describe("compareVersions", () => {
  test("orders numerically, not lexically", () => {
    expect(compareVersions("2.1.141", "2.1.283")).toBe(-1);
    expect(compareVersions("2.1.283", "2.1.283")).toBe(0);
    expect(compareVersions("2.10.0", "2.9.9")).toBe(1);
    expect(compareVersions("2.1.283 (Claude Code)", "2.1.283")).toBe(0);
  });
});
