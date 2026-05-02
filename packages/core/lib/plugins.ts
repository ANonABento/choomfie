/**
 * Plugin loader — loads plugins from workspace packages.
 */

import type { Plugin } from "./types.ts";

/** Explicit mapping of plugin names to workspace packages. */
const PLUGIN_PACKAGES: Record<string, string> = {
  voice: "@choomfie/voice",
  browser: "@choomfie/browser",
  "reaction-roles": "@choomfie/reaction-roles",
  tutor: "@choomfie/tutor",
  socials: "@choomfie/socials",
  rss: "@choomfie/rss",
};

export interface PluginConfigSource {
  getEnabledPlugins(): string[];
}

/** Return names of all available plugins. */
export function discoverPlugins(_projectRoot?: string): string[] {
  return Object.keys(PLUGIN_PACKAGES);
}

export async function loadPlugins(
  config: PluginConfigSource,
  _projectRoot?: string
): Promise<Plugin[]> {
  const enabled = config.getEnabledPlugins();
  if (enabled.length === 0) return [];

  const plugins: Plugin[] = [];
  const seenTools = new Set<string>();

  for (const name of enabled) {
    const pkgName = PLUGIN_PACKAGES[name];
    if (!pkgName) {
      console.error(`Plugin ${name}: unknown plugin, skipping`);
      continue;
    }

    try {
      const mod = await import(pkgName);
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
