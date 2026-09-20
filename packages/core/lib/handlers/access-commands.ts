/**
 * `/allow` and `/revoke` — allowlist management from Discord (owner only).
 *
 * The `allow_user` / `remove_user` / `list_allowed_users` tools have always
 * existed, but reaching them meant asking Choomfie in prose and hoping it
 * picked the right one. These are the same three operations as commands, which
 * matters most on a phone.
 *
 * Choomfie-native names: Claude Code's `/permissions` governs tool access, not
 * who may talk to the bot, so borrowing that name would mislead.
 */

import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { registerCommand } from "../register.ts";
import { saveAccess } from "../context.ts";
import { requireOwner } from "./shared.ts";
import type { AppContext } from "../types.ts";

function allowlistEmbed(ctx: AppContext): EmbedBuilder {
  // An empty allowlist is bootstrap mode — Choomfie answers everyone. That is
  // a meaningfully different state from "one user allowed", so it gets said
  // outright rather than rendered as an empty list.
  if (ctx.allowedUsers.size === 0) {
    return new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle("Allowlist: empty")
      .setDescription(
        "**Bootstrap mode — I'll talk to anyone who can see me.**\n" +
          "Add yourself with `/allow` to lock this down.",
      );
  }

  const users = [...ctx.allowedUsers]
    .map((id) => `<@${id}>${id === ctx.ownerUserId ? " — owner" : ""}`)
    .join("\n");

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`Allowlist (${ctx.allowedUsers.size})`)
    .setDescription(users.slice(0, 4000))
    .setFooter({ text: "/allow <user> to add · /revoke <user> to remove" });
}

// /allow [user] — add a user, or list the allowlist when no user is given
registerCommand("allow", {
  data: new SlashCommandBuilder()
    .setName("allow")
    .setDescription("Let a user talk to Choomfie, or list who can (owner only)")
    .addUserOption((o) =>
      o.setName("user").setDescription("User to allow (omit to list the allowlist)"),
    )
    .toJSON(),
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;

    const user = interaction.options.getUser("user");
    if (!user) {
      await interaction.reply({
        embeds: [allowlistEmbed(ctx)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (user.bot) {
      await interaction.reply({
        content: `${user} is a bot — Choomfie ignores bots regardless.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (ctx.allowedUsers.has(user.id)) {
      await interaction.reply({
        content: `${user} is already on the allowlist.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // In-memory set first, then persisted — same order as the allow_user tool,
    // so the change is live without a restart.
    ctx.allowedUsers.add(user.id);
    await saveAccess(ctx);

    await interaction.reply({
      content: `Added ${user} to the allowlist — they can talk to me now.`,
      flags: MessageFlags.Ephemeral,
    });
  },
});

// /revoke <user> — remove a user from the allowlist
registerCommand("revoke", {
  data: new SlashCommandBuilder()
    .setName("revoke")
    .setDescription("Stop a user from talking to Choomfie (owner only)")
    .addUserOption((o) =>
      o.setName("user").setDescription("User to remove").setRequired(true),
    )
    .toJSON(),
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;

    const user = interaction.options.getUser("user", true);

    // Removing the owner would lock the allowlist against the only person who
    // can edit it — and with a non-empty list, bootstrap mode won't save you.
    if (user.id === ctx.ownerUserId) {
      await interaction.reply({
        content: "Can't revoke the owner — that would lock you out of your own bot.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!ctx.allowedUsers.has(user.id)) {
      await interaction.reply({
        content: `${user} isn't on the allowlist.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    ctx.allowedUsers.delete(user.id);
    await saveAccess(ctx);

    const remaining = ctx.allowedUsers.size;
    await interaction.reply({
      content:
        `Removed ${user} from the allowlist.` +
        // Emptying the list silently re-opens the bot to everyone. Say so.
        (remaining === 0
          ? "\n⚠️ The allowlist is now empty, which means **bootstrap mode** — " +
            "I'll answer anyone again. `/allow` yourself to lock it back down."
          : ""),
      flags: MessageFlags.Ephemeral,
    });
  },
});
