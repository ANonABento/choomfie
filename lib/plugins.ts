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

      // Check for tool name collisions before registering anything from this plugin
      const pluginToolNames = new Set<string>();
      let hasCollision = false;
      for (const tool of plugin.tools ?? []) {
        const toolName = tool.definition.name;
        if (pluginToolNames.has(toolName)) {
          console.error(
            `Plugin ${name}: duplicate tool "${toolName}" inside plugin, skipping plugin`
          );
          hasCollision = true;
          break;
        }
        if (seenTools.has(toolName)) {
          console.error(
            `Plugin ${name}: tool "${toolName}" conflicts with existing tool, skipping plugin`
          );
          hasCollision = true;
          break;
        }
        pluginToolNames.add(toolName);
      }
      if (hasCollision) continue;

      for (const toolName of pluginToolNames) {
        seenTools.add(toolName);
      }

      plugins.push(plugin);
      console.error(`Plugin loaded: ${plugin.name}`);
    } catch (e) {
      console.error(`Plugin ${name}: failed to load — ${e}`);
    }
  }

  return plugins;
}
