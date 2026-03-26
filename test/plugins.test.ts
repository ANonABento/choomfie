import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugins } from "../lib/plugins.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {}
    })
  );
});

test("loadPlugins skips a plugin when one of its tools collides", async () => {
  const root = await mkdtemp(join(tmpdir(), "choomfie-plugins-"));
  tempDirs.push(root);

  const pluginADir = join(root, "plugins", "a");
  const pluginBDir = join(root, "plugins", "b");

  await mkdir(pluginADir, { recursive: true });
  await mkdir(pluginBDir, { recursive: true });

  await Bun.write(
    join(pluginADir, "index.ts"),
    `
export default {
  name: "a",
  tools: [{
    definition: { name: "shared_tool", description: "a", inputSchema: {} },
    handler: async () => ({ content: [{ type: "text", text: "a" }] }),
  }],
};
`
  );

  await Bun.write(
    join(pluginBDir, "index.ts"),
    `
export default {
  name: "b",
  tools: [{
    definition: { name: "shared_tool", description: "b", inputSchema: {} },
    handler: async () => ({ content: [{ type: "text", text: "b" }] }),
  }],
};
`
  );

  const config = {
    getEnabledPlugins() {
      return ["a", "b"];
    },
  };

  const plugins = await loadPlugins(config as any, root);

  expect(plugins.map((plugin) => plugin.name)).toEqual(["a"]);
});
