/**
 * Plugin loader — discovers and loads plugins from the plugins/ directory.
 */

import type { Plugin } from "./types.ts";
import type { ConfigManager } from "./config.ts";
import { join } from "node:path";

export async function loadPlugins(
  config: ConfigManager,
  projectRoot: string
): Promise<Plugin[]> {
  const enabled = config.getEnabledPlugins();
  if (enabled.length === 0) return [];

  const plugins: Plugin[] = [];
  const seenTools = new Set<string>();

  for (const name of enabled) {
    const pluginPath = join(projectRoot, "plugins", name, "index.ts");
    try {
      const mod = await import(pluginPath);
      const plugin: Plugin = mod.default;

      if (!plugin?.name) {
        console.error(`Plugin ${name}: missing name, skipping`);
        continue;
      }

      // Check for tool name collisions
      for (const tool of plugin.tools ?? []) {
        if (seenTools.has(tool.definition.name)) {
          console.error(
            `Plugin ${name}: tool "${tool.definition.name}" conflicts with existing tool, skipping plugin`
          );
          continue;
        }
        seenTools.add(tool.definition.name);
      }

      plugins.push(plugin);
      console.error(`Plugin loaded: ${plugin.name}`);
    } catch (e) {
      console.error(`Plugin ${name}: failed to load — ${e}`);
    }
  }

  return plugins;
}
