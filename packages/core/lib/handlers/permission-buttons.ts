/**
 * Permission button builders + click handlers.
 * Adds Approve/Deny buttons to permission request DMs.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type MessageCreateOptions,
} from "discord.js";
import { registerButtonHandler } from "../interactions.ts";

export type PermissionRequestParams = {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
};

/** Build an embed + action row for a permission request (button path) */
export function buildPermissionMessage(
  params: PermissionRequestParams
): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle("Permission Request")
    .setColor(0xf0b232)
    .addFields(
      { name: "Tool", value: `\`${params.tool_name}\``, inline: true },
      { name: "Code", value: `\`${params.request_id}\``, inline: true },
      { name: "Action", value: params.description },
      {
        name: "Preview",
        value: `\`\`\`\n${params.input_preview.slice(0, 1000)}\n\`\`\``,
      }
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`permission:allow:${params.request_id}`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅"),
    new ButtonBuilder()
      .setCustomId(`permission:deny:${params.request_id}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("❌")
  );

  return { embeds: [embed], components: [row] };
}

/** Plain-text fallback used when the embed/component send fails. Must keep the
 * `yes <code>` / `no <code>` hint so PERMISSION_REPLY_RE in discord.ts still matches. */
export function buildPermissionTextFallback(
  params: PermissionRequestParams
): string {
  return [
    `**Permission request** \`${params.request_id}\``,
    `**Tool:** ${params.tool_name}`,
    `**Action:** ${params.description}`,
    `\`\`\`\n${params.input_preview.slice(0, 1000)}\n\`\`\``,
    "",
    `Reply \`yes ${params.request_id}\` to allow or \`no ${params.request_id}\` to deny.`,
  ].join("\n");
}

// --- Button click handler ---

registerButtonHandler("permission", async (interaction, parts, ctx) => {
  const action = parts[1];
  const requestId = parts[2];

  if (!requestId || (action !== "allow" && action !== "deny")) {
    await interaction.reply({
      content: "Invalid permission button.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Reject if no owner is configured (bootstrap mode) — there is no one
  // authorized to approve. Permission requests should fail closed, not open.
  if (!ctx.ownerUserId || interaction.user.id !== ctx.ownerUserId) {
    await interaction.reply({
      content: "Only the owner can approve permission requests.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  ctx.mcp.notification({
    method: "notifications/claude/channel/permission",
    params: {
      request_id: requestId.toLowerCase(),
      behavior: action,
    },
  });

  const label = action === "allow" ? "Approved" : "Denied";
  const sourceEmbed = interaction.message.embeds[0];
  const updatedEmbed = sourceEmbed
    ? EmbedBuilder.from(sourceEmbed)
        .setColor(action === "allow" ? 0x57f287 : 0xed4245)
        .setTitle(`Permission ${label}`)
    : new EmbedBuilder()
        .setColor(action === "allow" ? 0x57f287 : 0xed4245)
        .setTitle(`Permission ${label}`);

  await interaction.update({
    embeds: [updatedEmbed],
    components: [],
  });
});
