import { afterEach, expect, test } from "bun:test";
import { ConfigManager } from "../lib/config.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {}))
  );
});

async function makeDataDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `choomfie-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

test("loadConfig normalizes saved automod values", async () => {
  const dataDir = await makeDataDir("automod-config");
  const configPath = join(dataDir, "config.json");

  await writeFile(
    configPath,
    JSON.stringify({
      automod: {
        maxMessagesPerMinute: 0,
        bannedWords: [" foo ", 123, "BAR", "foo"],
        action: "nuke",
      },
    })
  );

  const manager = new ConfigManager(dataDir);
  const automod = manager.getAutomodConfig();

  expect(automod.maxMessagesPerMinute).toBe(1);
  expect(automod.bannedWords).toEqual(["foo", "bar"]);
  expect(automod.action).toBe("warn");
});

test("setAutomodConfig normalizes input and persists it", async () => {
  const dataDir = await makeDataDir("automod-config");
  const manager = new ConfigManager(dataDir);

  manager.setAutomodConfig({
    maxMessagesPerMinute: 500,
    bannedWords: ["spam", "  Spam ", "ban", ""],
    action: "timeout",
  });

  const first = manager.getAutomodConfig();
  expect(first.maxMessagesPerMinute).toBe(120);
  expect(first.bannedWords).toEqual(["spam", "ban"]);
  expect(first.action).toBe("timeout");

  const reloaded = new ConfigManager(dataDir);
  expect(reloaded.getAutomodConfig()).toEqual(first);
});

test("getAutomodConfig returns copies of mutable values", async () => {
  const dataDir = await makeDataDir("automod-config");
  const manager = new ConfigManager(dataDir);

  const snapshot = manager.getAutomodConfig();
  snapshot.bannedWords.push("mutated");

  expect(manager.getAutomodConfig().bannedWords).not.toContain("mutated");
});
