/**
 * Interaction handler — routes button clicks, slash commands, and modal submissions.
 *
 * Button customId format: "action:data" (e.g. "reminder:ack:42", "reminder:snooze:42:1h")
 * All interactions are handled directly (no Claude roundtrip) for instant response.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type Interaction,
} from "discord.js";
import type { AppContext } from "./types.ts";

/** Button handler signature */
type ButtonHandler = (
  interaction: ButtonInteraction,
  parts: string[],
  ctx: AppContext
) => Promise<void>;

/** Registry of button handlers by prefix */
const buttonHandlers = new Map<string, ButtonHandler>();

/** Register a button handler for a prefix */
export function registerButtonHandler(prefix: string, handler: ButtonHandler) {
  buttonHandlers.set(prefix, handler);
}

/** Main interaction router — called from discord.ts */
export async function handleInteraction(
  interaction: Interaction,
  ctx: AppContext
) {
  // Let plugins handle first
  for (const plugin of ctx.plugins) {
    if (plugin.onInteraction) {
      try {
        await plugin.onInteraction(interaction, ctx);
      } catch (e) {
        console.error(`Plugin ${plugin.name} onInteraction error: ${e}`);
      }
    }
  }

  if (interaction.isButton()) {
    const parts = interaction.customId.split(":");
    const prefix = parts[0];
    const handler = buttonHandlers.get(prefix);

    if (handler) {
      try {
        await handler(interaction, parts, ctx);
      } catch (e) {
        console.error(`Button handler error (${prefix}): ${e}`);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: "Something went wrong.",
            flags: MessageFlags.Ephemeral,
          });
        }
      }
    }
  }
}

// --- Reminder button builders ---

/** Build action row with Done/Snooze buttons for a reminder */
export function buildReminderButtons(
  reminderId: number
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`reminder:ack:${reminderId}`)
      .setLabel("Done")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅"),
    new ButtonBuilder()
      .setCustomId(`reminder:snooze:${reminderId}:30m`)
      .setLabel("30min")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`reminder:snooze:${reminderId}:1h`)
      .setLabel("1 hour")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`reminder:snooze:${reminderId}:tomorrow`)
      .setLabel("Tomorrow")
      .setStyle(ButtonStyle.Secondary)
  );
}

/** Parse snooze duration string into milliseconds */
function parseSnoozeDuration(duration: string): number | null {
  switch (duration) {
    case "30m":
      return 30 * 60 * 1000;
    case "1h":
      return 60 * 60 * 1000;
    case "tomorrow":
      return 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}

// --- Register reminder button handlers ---

registerButtonHandler(
  "reminder",
  async (interaction, parts, ctx) => {
    const action = parts[1]; // "ack" or "snooze"
    const reminderId = parseInt(parts[2], 10);

    if (isNaN(reminderId)) {
      await interaction.reply({
        content: "Invalid reminder.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const reminder = ctx.memory.getReminder(reminderId);
    if (!reminder) {
      await interaction.reply({
        content: "Reminder not found.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Only the reminder's user or the owner can interact
    const userId = interaction.user.id;
    if (userId !== reminder.userId && userId !== ctx.ownerUserId) {
      await interaction.reply({
        content: "Not your reminder~",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (action === "ack") {
      const success = ctx.memory.ackReminder(reminderId);
      if (success) ctx.reminderScheduler.clearNagTimer(reminderId);

      // Update the original message — remove buttons, add checkmark
      await interaction.update({
        content: `~~${interaction.message.content}~~\n✅ Done!`,
        components: [],
      });
    } else if (action === "snooze") {
      const duration = parts[3] || "1h";
      const ms = parseSnoozeDuration(duration);

      if (!ms) {
        await interaction.reply({
          content: "Unknown snooze duration.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const newDueAt = new Date(Date.now() + ms).toISOString();
      const success = ctx.memory.snoozeReminder(reminderId, newDueAt);

      if (success) {
        const updated = ctx.memory.getReminder(reminderId);
        if (updated) ctx.reminderScheduler.scheduleReminder(updated);
      }

      const label =
        duration === "30m"
          ? "30 minutes"
          : duration === "1h"
            ? "1 hour"
            : "tomorrow";

      await interaction.update({
        content: `${interaction.message.content}\n⏰ Snoozed for ${label}`,
        components: [],
      });
    }
  }
);
