import type { Interaction, Message } from "discord.js";
import { errorMessage, type Plugin, type PluginContext } from "@choomfie/shared";

async function runPluginHook(
  plugin: Plugin,
  hookName: string,
  hook: () => Promise<void>,
  successMessage?: string,
): Promise<void> {
  try {
    await hook();
    if (successMessage) console.error(successMessage);
  } catch (e) {
    console.error(`Plugin ${plugin.name} ${hookName} failed: ${errorMessage(e)}`);
  }
}

export async function initializePlugins(
  plugins: Plugin[],
  ctx: PluginContext,
): Promise<void> {
  for (const plugin of plugins) {
    const init = plugin.init;
    if (!init) continue;
    await runPluginHook(
      plugin,
      "init",
      () => init(ctx),
      `Plugin initialized: ${plugin.name}`,
    );
  }
}

export async function dispatchPluginMessage(
  plugins: Plugin[],
  message: Message,
  ctx: PluginContext,
): Promise<void> {
  for (const plugin of plugins) {
    const onMessage = plugin.onMessage;
    if (!onMessage) continue;
    await runPluginHook(plugin, "onMessage", () => onMessage(message, ctx));
  }
}

export async function dispatchPluginInteraction(
  plugins: Plugin[],
  interaction: Interaction,
  ctx: PluginContext,
): Promise<void> {
  for (const plugin of plugins) {
    const onInteraction = plugin.onInteraction;
    if (!onInteraction) continue;
    await runPluginHook(plugin, "onInteraction", () =>
      onInteraction(interaction, ctx)
    );
  }
}

export async function destroyPlugins(plugins: Plugin[]): Promise<void> {
  for (const plugin of plugins) {
    const destroy = plugin.destroy;
    if (!destroy) continue;
    await runPluginHook(plugin, "destroy", () => destroy());
  }
}
