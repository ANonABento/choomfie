#!/usr/bin/env bun
import type { Plugin, PluginContext } from "@choomfie/shared";
import type { Message } from "discord.js";
import { mkdir } from "node:fs/promises";

const PLUGINS = ["voice", "browser", "tutor", "socials"] as const;
const DATA_DIR = "/tmp/choomfie-plugin-smoke";

const ctx: PluginContext = {
  DATA_DIR,
  config: {
    getConfig: () => ({}),
    getEnabledPlugins: () => [...PLUGINS],
    getVoiceConfig: () => ({ stt: "mock", tts: "mock" }),
    getSocialsConfig: () => undefined,
  },
  mcp: {
    notification: () => {},
  },
};

const message = {
  author: { bot: false, id: "smoke-user", username: "smoke" },
  content: "plugin smoke test",
  reply: async () => {},
} as unknown as Message;

await mkdir(DATA_DIR, { recursive: true });

for (const name of PLUGINS) {
  const mod = await import(`@choomfie/${name}`);
  const plugin = mod.default as Plugin;

  if (plugin.name !== name) {
    throw new Error(`${name}: expected plugin.name=${name}, got ${plugin.name}`);
  }
  if (plugin.tools !== undefined && !Array.isArray(plugin.tools)) {
    throw new Error(`${name}: plugin.tools must be an array when provided`);
  }

  const tools = plugin.tools ?? [];
  for (const tool of tools) {
    if (!tool.definition?.name || !tool.definition.description || !tool.definition.inputSchema) {
      throw new Error(`${name}: malformed tool definition`);
    }
    if (typeof tool.handler !== "function") {
      throw new Error(`${name}: ${tool.definition.name} handler is not a function`);
    }
  }

  await plugin.onMessage?.(message, ctx);
  console.log(`${name}: ok (${tools.length} tools)`);
}

console.log("plugin smoke test passed");
