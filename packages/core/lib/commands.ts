/**
 * Slash commands — definition + handlers.
 *
 * Commands are registered once via `deployCommands()` (run separately or on startup).
 * Handlers are called from interactions.ts when a ChatInputCommand interaction arrives.
 *
 * All commands respond directly (no Claude roundtrip) for instant response.
 */

import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type GuildTextBasedChannel,
} from "discord.js";
import { errorMessage } from "@choomfie/shared";
import { VERSION } from "./version.ts";
import { registerCommand, registerButtonHandler } from "./interactions.ts";
import { McpProxy } from "./mcp-proxy.ts";
import { formatDuration, fromSQLiteDatetime } from "./time.ts";
import { isOwner, requireOwner } from "./handlers/shared.ts";
import { buildGhArgs, runGh } from "./handlers/github.ts";
import { discoverPlugins } from "./plugins.ts";
import {
  buildReminderModal,
  buildPersonaModal,
  buildMemoryModal,
} from "./handlers/modals.ts";
import { formatGeneratedImageMessage, generateImage } from "./image-generation.ts";

type ServerStatsChannel = Pick<
  GuildTextBasedChannel,
  "id" | "name" | "messages"
>;
type ServerStatsChannelStat = { id: string; name: string; count: number };

const SERVERSTATS_TOP_CHANNEL_LIMIT = 5;
const MISSING_ACCESS_ERROR_CODE = 50001;
const MISSING_PERMISSIONS_ERROR_CODE = 50013;

function isSkippableChannelFetchError(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: number }).code;
    return (
      code === MISSING_ACCESS_ERROR_CODE ||
      code === MISSING_PERMISSIONS_ERROR_CODE
    );
  }
  return false;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}

function startOfCurrentDay(): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

async function countMessagesToday(
  channel: ServerStatsChannel,
  since: Date
): Promise<number> {
  let count = 0;
  let before: string | undefined;

  while (true) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    });
    if (batch.size === 0) break;

    for (const message of batch.values()) {
      if (message.createdAt < since) {
        return count;
      }
      count += 1;
    }

    const oldest = batch.last();
    if (!oldest || batch.size < 100 || oldest.createdAt < since) break;
    before = oldest.id;
  }

  return count;
}

function formatTopChannel({ id, name, count }: ServerStatsChannelStat): string {
  return `#${name} <#${id}> — ${count} messages`;
}

// --- Command definitions ---

// /remind — opens a modal form
registerCommand("remind", {
  data: new SlashCommandBuilder()
    .setName("remind")
    .setDescription("Set a reminder via form")
    .toJSON(),
  handler: async (interaction) => {
    await interaction.showModal(buildReminderModal());
  },
});

// /reminders — list active reminders
registerCommand("reminders", {
  data: new SlashCommandBuilder()
    .setName("reminders")
    .setDescription("List your active reminders")
    .toJSON(),
  handler: async (interaction, ctx) => {
    const active = ctx.memory.getActiveReminders(interaction.user.id);
    const unacked = ctx.memory.getUnackedReminders(interaction.user.id);

    if (active.length === 0 && unacked.length === 0) {
      await interaction.reply({
        content: "No active reminders.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const embed = new EmbedBuilder().setColor(0xf0883e).setTitle("Your Reminders");

    if (unacked.length > 0) {
      const lines = unacked.map((r) => `⚠️ **#${r.id}** — ${r.message}`);
      embed.addFields({ name: "Nagging", value: lines.join("\n") });
    }
    if (active.length > 0) {
      const lines = active.map((r) => {
        const ts = Math.floor(fromSQLiteDatetime(r.dueAt).getTime() / 1000);
        const cron = r.cron ? ` · ${r.cron}` : "";
        const timezone = r.timezone ? ` · ${r.timezone}` : "";
        return `⏰ **#${r.id}** — ${r.message} · <t:${ts}:R>${timezone}${cron}`;
      });
      embed.addFields({ name: "Pending", value: lines.join("\n") });
    }

    embed.setFooter({ text: `${active.length + unacked.length} total · /cancel <id> to remove` });

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
    });
  },
});

// /cancel <id> — quick cancel a reminder
registerCommand("cancel", {
  data: new SlashCommandBuilder()
    .setName("cancel")
    .setDescription("Cancel a reminder by ID")
    .addIntegerOption((o) =>
      o.setName("id").setDescription("Reminder ID (from /reminders)").setRequired(true)
    )
    .toJSON(),
  handler: async (interaction, ctx) => {
    const id = interaction.options.getInteger("id", true);
    const reminder = ctx.memory.getReminder(id);

    if (!reminder) {
      await interaction.reply({
        content: `Reminder #${id} not found.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (reminder.userId !== interaction.user.id && !isOwner(ctx, interaction.user.id)) {
      await interaction.reply({
        content: "That's not your reminder.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    ctx.memory.cancelReminder(id);
    ctx.reminderScheduler.clearTimer(id);
    ctx.reminderScheduler.clearNagTimer(id);

    await interaction.reply({
      content: `Cancelled reminder **#${id}**: ${reminder.message}`,
      flags: MessageFlags.Ephemeral,
    });
  },
});

// /memory [search] — list or search memories
registerCommand("memory", {
  data: new SlashCommandBuilder()
    .setName("memory")
    .setDescription("View or search memories")
    .addStringOption((o) =>
      o.setName("search").setDescription("Search term (omit to list all core memories)")
    )
    .toJSON(),
  handler: async (interaction, ctx) => {
    const search = interaction.options.getString("search");

    if (search) {
      const core = ctx.memory.getCoreMemory().filter(
        (m) => m.key.includes(search) || m.value.toLowerCase().includes(search.toLowerCase())
      );
      const archival = ctx.memory.searchArchival(search, 5);

      if (core.length === 0 && archival.length === 0) {
        await interaction.reply({
          content: `No memories matching "${search}".`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`Memory Search: "${search}"`);

      if (core.length > 0) {
        const lines = core.map((m) => `**${m.key}** — ${m.value.slice(0, 100)}`);
        embed.addFields({ name: "Core", value: lines.join("\n").slice(0, 1024) });
      }
      if (archival.length > 0) {
        const lines = archival.map((m) => `${m.content.slice(0, 100)}`);
        embed.addFields({ name: "Archival", value: lines.join("\n").slice(0, 1024) });
      }

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } else {
      const core = ctx.memory.getCoreMemory();
      if (core.length === 0) {
        await interaction.reply({
          content: "No core memories saved yet.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("Core Memories")
        .setDescription(
          core.map((m) => `**${m.key}** — ${m.value.slice(0, 80)}`).join("\n").slice(0, 4000)
        )
        .setFooter({ text: `${core.length} memories · /memory <search> to search` });

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  },
});

// /help — show all commands and capabilities
registerCommand("help", {
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show all commands and what I can do")
    .toJSON(),
  handler: async (interaction) => {
    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle("Choomfie Commands")
      .addFields(
        {
          name: "Reminders",
          value: [
            "`/remind` — set a reminder (form)",
            "`/reminders` — list active reminders",
            "`/cancel <id>` — cancel a reminder",
          ].join("\n"),
          inline: false,
        },
        {
          name: "Memory",
          value: [
            "`/memory` — list core memories",
            "`/memory <search>` — search memories",
            "`/savememory` — save a memory (form)",
          ].join("\n"),
          inline: false,
        },
        {
          name: "Personas",
          value: [
            "`/persona` — list all personas",
            "`/persona switch:<key>` — switch persona",
            "`/newpersona` — create a persona (form)",
          ].join("\n"),
          inline: false,
        },
        {
          name: "Plugins",
          value: [
            "`/plugins` — list available plugins",
            "`/plugins enable:<name>` — enable a plugin",
            "`/plugins disable:<name>` — disable a plugin",
            "`/voice` — voice provider setup wizard",
          ].join("\n"),
          inline: false,
        },
        {
          name: "Other",
          value: [
            "`/imagine <prompt>` — generate an image",
            "`/github <check>` — PRs, issues, notifications",
            "`/status` — bot status and stats",
            "`/serverstats` — server stats (members, channels, messages, top channels)",
          ].join("\n"),
          inline: false,
        },
        {
          name: "In Chat",
          value:
            "You can also just talk to me! Ask me to set reminders, remember things, check GitHub, switch personas, or anything else.",
          inline: false,
        }
      )
      .setFooter({ text: "@ me in a server or DM me directly" });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
});

// /imagine <prompt> — generate an image and attach it
registerCommand("imagine", {
  data: new SlashCommandBuilder()
    .setName("imagine")
    .setDescription("Generate an image from a prompt")
    .addStringOption((o) =>
      o
        .setName("prompt")
        .setDescription("What to generate")
        .setRequired(true)
        .setMaxLength(1000)
    )
    .toJSON(),
  handler: async (interaction, ctx) => {
    const prompt = interaction.options.getString("prompt", true).trim();
    await interaction.deferReply();

    try {
      const image = await generateImage(prompt, ctx.DATA_DIR);
      const attachment = new AttachmentBuilder(image.filePath);

      await interaction.editReply({
        content: formatGeneratedImageMessage(image),
        files: [attachment],
        allowedMentions: { parse: [] },
      });
      ctx.messageStats.sent++;
    } catch (error: unknown) {
      await interaction.editReply({
        content: `I couldn't generate that image: ${errorMessage(error)}`,
        allowedMentions: { parse: [] },
      });
    }
  },
});

// /serverstats — show live guild statistics
registerCommand("serverstats", {
  data: new SlashCommandBuilder()
    .setName("serverstats")
    .setDescription("Show guild statistics and today's activity")
    .setDMPermission(false)
    .toJSON(),
  handler: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "Server stats can only be used in a guild.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const since = startOfCurrentDay();

    try {
      const sourceGuild = interaction.guild;
      const guild = await interaction.client.guilds.fetch({
        guild: sourceGuild.id,
        withCounts: true,
        force: true,
      });
      const channels = await sourceGuild.channels.fetch();
      const channelCount = channels.size;
      const memberCount = guild.approximateMemberCount ?? guild.memberCount;
      const onlineCount = guild.approximatePresenceCount ?? 0;

      const channelStats: ServerStatsChannelStat[] = [];
      let messagesToday = 0;

      for (const channel of channels.values()) {
        if (!channel?.isTextBased()) continue;

        let count = 0;
        try {
          count = await countMessagesToday(channel, since);
        } catch (error) {
          if (isSkippableChannelFetchError(error)) {
            continue;
          }
          throw error;
        }
        if (count > 0) {
          channelStats.push({
            id: channel.id,
            name: channel.name ?? "unknown",
            count,
          });
        }
        messagesToday += count;
      }

      channelStats.sort((a, b) => b.count - a.count);
      const topChannels = channelStats
        .slice(0, SERVERSTATS_TOP_CHANNEL_LIMIT)
        .map(formatTopChannel);

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`Server Stats — ${guild.name}`)
        .addFields(
          {
            name: "Current Stats",
            value: [
              `**Members:** ${memberCount.toLocaleString("en-US")}`,
              `**Online:** ${onlineCount.toLocaleString("en-US")}`,
              `**Channels:** ${channelCount.toLocaleString("en-US")}`,
              `**Messages today:** ${messagesToday.toLocaleString("en-US")}`,
            ].join("\n"),
          },
          {
            name: `Top ${SERVERSTATS_TOP_CHANNEL_LIMIT} Active Channels`,
            value: topChannels.length
              ? topChannels.join("\n")
              : "No messages were sent today.",
          }
        )
        .setFooter({ text: `Today since ${since.toISOString()}` });

      await interaction.editReply({ embeds: [embed] });
    } catch (error: unknown) {
      await interaction.editReply({
        content: `Failed to fetch server stats: ${formatErrorMessage(error)}`,
      });
    }
  },
});

// /github <subcommand>
registerCommand("github", {
  data: new SlashCommandBuilder()
    .setName("github")
    .setDescription("Check GitHub status")
    .addStringOption((o) =>
      o
        .setName("check")
        .setDescription("What to check")
        .setRequired(true)
        .addChoices(
          { name: "Open PRs", value: "prs" },
          { name: "Open Issues", value: "issues" },
          { name: "Notifications", value: "notifications" },
          { name: "Current PR Status", value: "pr_status" }
        )
    )
    .addStringOption((o) =>
      o.setName("repo").setDescription("Repository (owner/repo format, optional)")
    )
    .toJSON(),
  handler: async (interaction) => {
    await interaction.deferReply();

    const command = interaction.options.getString("check", true);
    const repo = interaction.options.getString("repo");
    const ghArgs = buildGhArgs(command, repo);

    if (!ghArgs) {
      await interaction.editReply({ content: `Unknown command: ${command}` });
      return;
    }

    try {
      const output = await runGh(ghArgs);
      await interaction.editReply({ content: `\`\`\`\n${output.slice(0, 1900)}\n\`\`\`` });
    } catch (error: unknown) {
      await interaction.editReply({
        content: `GitHub CLI error: ${formatErrorMessage(error)}`,
      });
    }
  },
});

// /status
registerCommand("status", {
  data: new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show bot status and stats")
    .toJSON(),
  handler: async (interaction, ctx) => {
    const stats = ctx.memory.getStats();
    const uptime = ctx.startedAt ? formatDuration(Date.now() - ctx.startedAt) : "unknown";
    const persona = ctx.config.getActivePersona();
    const personas = ctx.config.listPersonas();
    const botUser = ctx.discord.user;

    // Plugin info (voice details folded in when enabled)
    const enabledPlugins = ctx.config.getEnabledPlugins();
    const voiceConfig = ctx.config.getVoiceConfig();
    const pluginStatus = enabledPlugins.length > 0
      ? enabledPlugins.map((p) => {
          const loaded = ctx.plugins.find((pl) => pl.name === p);
          const tools = loaded?.tools?.length ?? 0;
          if (p === "voice" && loaded) {
            return `voice (${tools}t) STT=${voiceConfig.stt} TTS=${voiceConfig.tts}`;
          }
          return loaded ? `${p} (${tools}t)` : `${p} ⚠️`;
        }).join("\n")
      : "none";

    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setAuthor({
        name: `${botUser?.username ?? "Choomfie"} v${VERSION}`,
        iconURL: botUser?.displayAvatarURL() ?? undefined,
      })
      .addFields(
        { name: "Uptime", value: uptime, inline: true },
        { name: "Persona", value: `**${persona.name}**`, inline: true },
        { name: "Messages", value: `${ctx.messageStats.received} in / ${ctx.messageStats.sent} out`, inline: true },
        { name: "Memory", value: `${stats.coreCount} core · ${stats.archivalCount} archival`, inline: true },
        { name: "Reminders", value: `${stats.reminderCount} active`, inline: true },
        { name: "Access", value: `${ctx.allowedUsers.size} users`, inline: true },
        { name: "Plugins", value: pluginStatus, inline: true },
      )
      .setFooter({
        text: `Personas: ${personas.map((p) => p.active ? `[${p.key}]` : p.key).join(", ")}`,
      });

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
    });
  },
});

// /persona [switch]
registerCommand("persona", {
  data: new SlashCommandBuilder()
    .setName("persona")
    .setDescription("View or switch personas")
    .addStringOption((o) =>
      o.setName("switch").setDescription("Persona key to switch to (omit to list all)")
    )
    .toJSON(),
  handler: async (interaction, ctx) => {
    const switchTo = interaction.options.getString("switch");

    if (switchTo) {
      if (await requireOwner(interaction, ctx)) return;
      const persona = ctx.config.switchPersona(switchTo);
      if (!persona) {
        const available = ctx.config
          .listPersonas()
          .map((p) => `\`${p.key}\``)
          .join(", ");
        await interaction.reply({
          content: `Persona "${switchTo}" not found. Available: ${available}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (ctx.mcp instanceof McpProxy) {
        ctx.mcp.requestRestart(`persona switch: ${switchTo}`, interaction.channelId);
      }
      await interaction.reply({
        content: `Switched to **${persona.name}**. Restarting...`,
      });
    } else {
      const personas = ctx.config.listPersonas();
      const lines = personas.map(
        (p) => `${p.active ? "→ " : "  "}\`${p.key}\` — **${p.persona.name}**`
      );
      await interaction.reply({
        content: `**Personas:**\n${lines.join("\n")}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
});

// /newpersona — opens a modal form (owner only)
registerCommand("newpersona", {
  data: new SlashCommandBuilder()
    .setName("newpersona")
    .setDescription("Create a new persona via form (owner only)")
    .toJSON(),
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;
    await interaction.showModal(buildPersonaModal());
  },
});

// /savememory — opens a modal form (owner only)
registerCommand("savememory", {
  data: new SlashCommandBuilder()
    .setName("savememory")
    .setDescription("Save something to memory via form (owner only)")
    .toJSON(),
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;
    await interaction.showModal(buildMemoryModal());
  },
});

// /plugins — list, enable, disable plugins (owner only)
registerCommand("plugins", {
  data: new SlashCommandBuilder()
    .setName("plugins")
    .setDescription("Manage plugins (owner only)")
    .addStringOption((o) =>
      o
        .setName("action")
        .setDescription("Action to perform (omit to list)")
        .addChoices(
          { name: "enable", value: "enable" },
          { name: "disable", value: "disable" }
        )
    )
    .addStringOption((o) =>
      o.setName("name").setDescription("Plugin name (e.g. voice, tutor, socials)")
    )
    .toJSON(),
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;

    const action = interaction.options.getString("action");
    const name = interaction.options.getString("name");

    const available = discoverPlugins();
    const enabled = ctx.config.getEnabledPlugins();

    if (!action) {
      // List plugins with status
      const lines = available.map((p) => {
        const inConfig = enabled.includes(p);
        const loadedPlugin = ctx.plugins.find((pl) => pl.name === p);
        const toolCount = loadedPlugin?.tools?.length;
        const tools = toolCount ? ` · ${toolCount} tools` : "";

        let status: string;
        if (loadedPlugin && inConfig) {
          status = `🟢 active${tools}`;
        } else if (inConfig && !loadedPlugin) {
          status = "🔴 enabled but failed to load";
        } else if (!inConfig && loadedPlugin) {
          status = "🟠 disabled (pending restart)";
        } else {
          status = "⚪ disabled";
        }
        return `${inConfig ? "→ " : "  "}\`${p}\` — ${status}`;
      });

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("Plugins")
        .setDescription(lines.join("\n") || "No plugins found.")
        .setFooter({ text: `/plugins action:enable name:<plugin> to enable` });

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    if (!name) {
      await interaction.reply({
        content: `Specify a plugin name: ${available.map((p) => `\`${p}\``).join(", ")}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!available.includes(name)) {
      await interaction.reply({
        content: `Plugin "${name}" not found. Available: ${available.map((p) => `\`${p}\``).join(", ")}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (action === "enable") {
      if (enabled.includes(name)) {
        await interaction.reply({
          content: `\`${name}\` is already enabled.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      ctx.config.setEnabledPlugins([...enabled, name]);
      if (ctx.mcp instanceof McpProxy) {
        ctx.mcp.requestRestart(`plugin enable: ${name}`, interaction.channelId);
      }
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle(`Plugin Enabled: ${name}`)
        .setDescription("Restarting to activate...")
        .setFooter({ text: `Enabled: ${[...enabled, name].join(", ")}` });
      await interaction.reply({ embeds: [embed] });
    } else {
      if (!enabled.includes(name)) {
        await interaction.reply({
          content: `\`${name}\` is already disabled.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const remaining = enabled.filter((p) => p !== name);
      ctx.config.setEnabledPlugins(remaining);
      if (ctx.mcp instanceof McpProxy) {
        ctx.mcp.requestRestart(`plugin disable: ${name}`, interaction.channelId);
      }
      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle(`Plugin Disabled: ${name}`)
        .setDescription("Restarting to deactivate...")
        .setFooter({ text: remaining.length ? `Enabled: ${remaining.join(", ")}` : "No plugins enabled" });
      await interaction.reply({ embeds: [embed] });
    }
  },
});

// /voice setup — interactive provider wizard (owner only)
registerCommand("voice", {
  data: new SlashCommandBuilder()
    .setName("voice")
    .setDescription("Voice plugin setup and status (owner only)")
    .toJSON(),
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Dynamically import to avoid loading voice code when plugin isn't enabled
    const { detectAllProviders } = await import(
      "../../../plugins/voice/providers/index.ts"
    );

    let reports;
    try {
      reports = await detectAllProviders();
    } catch (error: unknown) {
      await interaction.editReply({
        content: [
          `Provider detection failed: ${formatErrorMessage(error)}.`,
          "Check that ffmpeg and python3 are installed.",
        ].join(" "),
      });
      return;
    }
    const voiceConfig = ctx.config.getVoiceConfig();

    const sttReports = reports.filter((r) => r.kind === "stt");
    const ttsReports = reports.filter((r) => r.kind === "tts");

    const formatReport = (items: typeof reports) =>
      items
        .map((r) => {
          const icon = r.status.available ? "✅" : "❌";
          const active =
            voiceConfig.stt === r.name || voiceConfig.tts === r.name
              ? " ← active"
              : "";
          const install = r.status.install ? ` · \`${r.status.install}\`` : "";
          return `${icon} **${r.name}** — ${r.status.reason}${install}${active}`;
        })
        .join("\n");

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("Voice Setup")
      .setDescription(
        `Current: STT=\`${voiceConfig.stt}\` TTS=\`${voiceConfig.tts}\`\nPick providers below.`
      )
      .addFields(
        { name: "STT Providers", value: formatReport(sttReports) },
        { name: "TTS Providers", value: formatReport(ttsReports) }
      )
      .setFooter({ text: "Select a provider or use Auto to let the bot choose" });

    // STT buttons
    const sttRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("voice-setup:stt:auto")
        .setLabel("Auto")
        .setStyle(voiceConfig.stt === "auto" ? ButtonStyle.Success : ButtonStyle.Secondary),
      ...sttReports.map((r) =>
        new ButtonBuilder()
          .setCustomId(`voice-setup:stt:${r.name}`)
          .setLabel(r.name)
          .setStyle(
            voiceConfig.stt === r.name ? ButtonStyle.Success : ButtonStyle.Primary
          )
          .setDisabled(!r.status.available)
      )
    );

    // TTS buttons
    const ttsRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("voice-setup:tts:auto")
        .setLabel("Auto")
        .setStyle(voiceConfig.tts === "auto" ? ButtonStyle.Success : ButtonStyle.Secondary),
      ...ttsReports.map((r) =>
        new ButtonBuilder()
          .setCustomId(`voice-setup:tts:${r.name}`)
          .setLabel(r.name)
          .setStyle(
            voiceConfig.tts === r.name ? ButtonStyle.Success : ButtonStyle.Primary
          )
          .setDisabled(!r.status.available)
      )
    );

    await interaction.editReply({
      embeds: [embed],
      components: [sttRow, ttsRow],
    });
  },
});

// --- Voice setup button handler ---
registerButtonHandler("voice-setup", async (interaction, parts, ctx) => {
  if (!isOwner(ctx, interaction.user.id)) {
    await interaction.reply({
      content: "Only the owner can change voice settings.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const [, kind, provider] = parts; // voice-setup:stt:whisper or voice-setup:tts:edge-tts
  if (kind !== "stt" && kind !== "tts") return;

  ctx.config.setVoiceConfig({ [kind]: provider });
  if (ctx.mcp instanceof McpProxy) {
    ctx.mcp.requestRestart(`voice config: ${kind}=${provider}`, interaction.channelId);
  }
  const voiceConfig = ctx.config.getVoiceConfig();

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("Voice Config Updated")
    .addFields(
      { name: "STT", value: `\`${voiceConfig.stt}\``, inline: true },
      { name: "TTS", value: `\`${voiceConfig.tts}\``, inline: true }
    )
    .setFooter({ text: "Restarting to apply..." });

  await interaction.update({
    embeds: [embed],
    components: [],
  });
});
