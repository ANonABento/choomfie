import { EmbedBuilder } from "discord.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppContext } from "./types.ts";
import { formatDuration } from "./time.ts";
import { VERSION } from "./version.ts";

interface DaemonState {
  pid?: number;
  tokenUsageToday?: {
    date?: string;
    inputTokens?: number;
  };
}

const toolCallsByContext = new WeakMap<AppContext, Map<string, number>>();

function getToolCalls(ctx: AppContext): Map<string, number> {
  let calls = toolCallsByContext.get(ctx);
  if (!calls) {
    calls = new Map();
    toolCallsByContext.set(ctx, calls);
  }
  return calls;
}

export function trackToolCall(ctx: AppContext, name: string) {
  const calls = getToolCalls(ctx);
  calls.set(name, (calls.get(name) ?? 0) + 1);
}

export function getTopTools(ctx: AppContext, limit = 5): Array<{ name: string; count: number }> {
  return [...getToolCalls(ctx).entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

export async function getTokenUsageToday(ctx: Pick<AppContext, "DATA_DIR">): Promise<number> {
  try {
    const daemonState = JSON.parse(
      await readFile(join(ctx.DATA_DIR, "meta", "daemon-state.json"), "utf-8")
    ) as DaemonState;

    const today = new Date().toISOString().slice(0, 10);
    if (daemonState.tokenUsageToday?.date === today) {
      const inputTokens = Number(daemonState.tokenUsageToday.inputTokens ?? 0);
      if (!Number.isFinite(inputTokens) || inputTokens < 0) return 0;
      return inputTokens;
    }

    return 0;
  } catch {
    return 0;
  }
}

export async function buildStatsEmbed(ctx: AppContext): Promise<EmbedBuilder> {
  const uptime = ctx.startedAt ? formatDuration(Date.now() - ctx.startedAt) : "unknown";
  const persona = ctx.config.getActivePersona();
  const personaKey = ctx.config.getActivePersonaKey();
  const botUser = ctx.discord.user;
  const messagesHandled = ctx.messageStats.received + ctx.messageStats.sent;
  const tokenUsageToday = await getTokenUsageToday(ctx);
  const configuredPlugins =
    typeof ctx.config.getEnabledPlugins === "function"
      ? ctx.config.getEnabledPlugins()
      : ctx.plugins.map((plugin) => plugin.name);
  const activePlugins = configuredPlugins.length
    ? configuredPlugins
        .map((pluginName) => {
          const plugin = ctx.plugins.find((candidate) => candidate.name === pluginName);
          if (!plugin) return `${pluginName} (not loaded)`;

          const tools = plugin.tools?.length ?? 0;
          return tools > 0 ? `${pluginName} (${tools} tools)` : `${pluginName}`;
        })
        .join("\n")
    : "none";
  const topTools = getTopTools(ctx);
  const topToolsText = topTools.length
    ? topTools.map((tool, index) => `${index + 1}. \`${tool.name}\` - ${tool.count}`).join("\n")
    : "No tools used yet.";

  return new EmbedBuilder()
    .setColor(0x57f287)
    .setAuthor({
      name: `${botUser?.username ?? "Choomfie"} v${VERSION}`,
      iconURL: botUser?.displayAvatarURL() ?? undefined,
    })
    .setTitle("Stats")
    .addFields(
      { name: "Uptime", value: uptime, inline: true },
      { name: "Messages Handled", value: `${messagesHandled} total (${ctx.messageStats.received} in / ${ctx.messageStats.sent} out)`, inline: true },
      { name: "Current Persona", value: `**${persona.name}** (\`${personaKey}\`)`, inline: true },
      { name: "Token Usage Today", value: `${tokenUsageToday.toLocaleString()} input tokens`, inline: true },
      { name: "Active Plugins", value: activePlugins.slice(0, 1024), inline: false },
      { name: "Top Tools", value: topToolsText.slice(0, 1024), inline: false },
    )
    .setTimestamp(new Date());
}
