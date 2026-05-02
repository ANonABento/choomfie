import { expect, test } from "bun:test";
import { loadPlugins, type PluginConfigSource } from "../lib/plugins.ts";

function makePluginConfig(enabled: string[]): PluginConfigSource {
  return {
    getEnabledPlugins() {
      return enabled;
    },
  };
}

test("loadPlugins returns empty array when no plugins enabled", async () => {
  const config = makePluginConfig([]);

  const plugins = await loadPlugins(config);
  expect(plugins).toEqual([]);
});

test("loadPlugins skips unknown plugin names", async () => {
  const config = makePluginConfig(["nonexistent"]);

  const plugins = await loadPlugins(config);
  expect(plugins).toEqual([]);
});

test("loadPlugins loads real workspace plugins", async () => {
  const config = makePluginConfig(["voice", "browser", "socials"]);

  const plugins = await loadPlugins(config);
  expect(plugins.map((p) => p.name)).toEqual(["voice", "browser", "socials"]);
}, 30_000);

test("loadPlugins loads rss workspace plugin", async () => {
  const config = makePluginConfig(["rss"]);

  const plugins = await loadPlugins(config);
  expect(plugins.map((p) => p.name)).toEqual(["rss"]);
}, 10_000);
