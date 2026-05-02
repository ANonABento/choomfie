/**
 * Welcome message handler + owner-only slash command.
 */

import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import {
  normalizeWelcomeTemplate,
  type WelcomeConfig,
} from "../config.ts";
import { registerCommand } from "../interactions.ts";
import type { AppContext } from "../types.ts";
import { requireOwner } from "./shared.ts";

const WELCOME_TEMPLATE_MAX_LENGTH = 1000;
const DISCORD_MESSAGE_MAX_LENGTH = 2000;
const CONFIG_DISPLAY_MAX_LENGTH = 700;

interface WelcomeTextChannel {
  isTextBased(): boolean;
  send(payload: {
    content: string;
    allowedMentions: { users: string[]; roles: string[]; parse: string[] };
  }): Promise<unknown>;
}

export interface WelcomeTemplateMember {
  id: string;
  displayName: string;
  user: {
    username: string;
  };
  guild: {
    name: string;
    memberCount: number;
  };
}

export interface WelcomeGuildMember {
  id: string;
  displayName: string;
  user: {
    username: string;
    bot?: boolean;
  };
  guild: {
    name: string;
    memberCount: number;
    channels: {
      fetch(channelId: string): Promise<unknown>;
    };
  };
}

function isWelcomeTextChannel(channel: unknown): channel is WelcomeTextChannel {
  return (
    Boolean(channel) &&
    typeof channel === "object" &&
    "isTextBased" in channel &&
    typeof channel.isTextBased === "function" &&
    "send" in channel &&
    typeof channel.send === "function" &&
    channel.isTextBased()
  );
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

export function renderWelcomeTemplate(
  template: string,
  member: WelcomeTemplateMember
): string {
  return template
    .replaceAll("{user}", `<@${member.id}>`)
    .replaceAll("{username}", member.user.username)
    .replaceAll("{displayName}", member.displayName)
    .replaceAll("{server}", member.guild.name)
    .replaceAll("{memberCount}", String(member.guild.memberCount));
}

export async function handleGuildMemberAdd(
  member: WelcomeGuildMember,
  ctx: AppContext
): Promise<void> {
  if (member.user.bot) return;

  const welcome = ctx.config.getWelcomeConfig();
  if (!welcome.channelId) return;

  const template = normalizeWelcomeTemplate(welcome.template);
  const content = truncateText(
    renderWelcomeTemplate(template, member),
    DISCORD_MESSAGE_MAX_LENGTH
  );

  try {
    const channel = await member.guild.channels.fetch(welcome.channelId);
    if (!isWelcomeTextChannel(channel)) return;

    await channel.send({
      content,
      allowedMentions: { users: [member.id], roles: [], parse: [] },
    });
    ctx.messageStats.sent++;
  } catch (e) {
    console.error(`Welcome message failed: ${e}`);
  }
}

registerCommand("welcome_config", {
  data: new SlashCommandBuilder()
    .setName("welcome_config")
    .setDescription("Configure new member welcome messages (owner only)")
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Channel where welcome messages should be sent")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    )
    .addStringOption((o) =>
      o
        .setName("template")
        .setDescription("Message template. Supports {user}, {username}, {displayName}, {server}, {memberCount}")
        .setMaxLength(WELCOME_TEMPLATE_MAX_LENGTH)
    )
    .addBooleanOption((o) =>
      o
        .setName("enabled")
        .setDescription("Turn welcome messages on or off")
    )
    .toJSON(),
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;
    if (!interaction.guildId) {
      await interaction.reply({
        content: "Welcome messages can only be configured in a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const channel = interaction.options.getChannel("channel");
    const template = interaction.options.getString("template");
    const enabled = interaction.options.getBoolean("enabled");
    const current = ctx.config.getWelcomeConfig();

    const next: WelcomeConfig = {
      channelId: current.channelId,
      template: normalizeWelcomeTemplate(current.template),
    };

    if (channel) next.channelId = channel.id;
    if (template !== null) next.template = normalizeWelcomeTemplate(template);
    if (enabled === false) next.channelId = null;

    const hasChanges = channel !== null || template !== null || enabled !== null;
    if (hasChanges) {
      if (enabled === true && !next.channelId) {
        await interaction.reply({
          content: "Choose a channel before enabling welcome messages.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      ctx.config.setWelcomeConfig(next);
    }

    const updated = ctx.config.getWelcomeConfig();
    const status = updated.channelId ? `enabled in <#${updated.channelId}>` : "disabled";
    const previewMember = {
      id: interaction.user.id,
      displayName: interaction.member && "displayName" in interaction.member
        ? String(interaction.member.displayName)
        : interaction.user.username,
      user: { username: interaction.user.username },
      guild: {
        name: interaction.guild?.name ?? "this server",
        memberCount: interaction.guild?.memberCount ?? 0,
      },
    };
    const savedTemplate = normalizeWelcomeTemplate(updated.template);
    const preview = truncateText(
      renderWelcomeTemplate(savedTemplate, previewMember),
      CONFIG_DISPLAY_MAX_LENGTH
    );

    await interaction.reply({
      content: [
        `Welcome messages are **${status}**.`,
        `Template: \`${truncateText(savedTemplate, CONFIG_DISPLAY_MAX_LENGTH)}\``,
        `Preview: ${preview}`,
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
  },
});
