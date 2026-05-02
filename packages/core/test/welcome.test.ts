import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigManager } from "../lib/config.ts";
import { renderWelcomeTemplate } from "../lib/handlers/welcome.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {}))
  );
});

async function makeConfig(): Promise<ConfigManager> {
  const dir = await mkdtemp(join(tmpdir(), "choomfie-welcome-"));
  tempDirs.push(dir);
  return new ConfigManager(dir);
}

test("renderWelcomeTemplate replaces supported placeholders", () => {
  const rendered = renderWelcomeTemplate(
    "Hi {user} ({username}/{displayName}) - welcome to {server} member #{memberCount}",
    {
      id: "123",
      displayName: "Bento",
      user: { username: "user" },
      guild: { name: "Choomfie Lab", memberCount: 42 },
    }
  );

  expect(rendered).toBe("Hi <@123> (user/Bento) - welcome to Choomfie Lab member #42");
});

test("ConfigManager persists welcome config", async () => {
  const config = await makeConfig();

  expect(config.getWelcomeConfig()).toEqual({
    channelId: null,
    template: "Welcome {user} to {server}!",
  });

  config.setWelcomeConfig({
    channelId: "456",
    template: "Welcome {displayName}",
  });

  expect(config.getWelcomeConfig()).toEqual({
    channelId: "456",
    template: "Welcome {displayName}",
  });
});

test("ConfigManager normalizes invalid welcome config values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "choomfie-welcome-"));
  tempDirs.push(dir);
  await writeFile(
    join(dir, "config.json"),
    JSON.stringify({
      welcome: {
        channelId: 123,
        template: null,
      },
    })
  );

  const config = new ConfigManager(dir);
  expect(config.getWelcomeConfig()).toEqual({
    channelId: null,
    template: "Welcome {user} to {server}!",
  });
});
