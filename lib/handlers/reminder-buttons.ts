/**
 * Reminder button builders + click handlers.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from "discord.js";
import { registerButtonHandler } from "../interactions.ts";
import { MS_PER_MIN, MS_PER_HOUR, MS_PER_DAY } from "../time.ts";

/** Snooze option: label shown to user + duration in ms */
const SNOOZE_OPTIONS: Record<string, { label: string; ms: number }> = {
  "30m": { label: "30 minutes", ms: 30 * MS_PER_MIN },
  "1h": { label: "1 hour", ms: MS_PER_HOUR },
  tomorrow: { label: "tomorrow", ms: MS_PER_DAY },
};

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
    ...Object.entries(SNOOZE_OPTIONS).map(([key, { label }]) =>
      new ButtonBuilder()
        .setCustomId(`reminder:snooze:${reminderId}:${key}`)
        .setLabel(label === "tomorrow" ? "Tomorrow" : label.replace(" minutes", "min"))
        .setStyle(ButtonStyle.Secondary)
    )
  );
}

// --- Button click handler ---

registerButtonHandler("reminder", async (interaction, parts, ctx) => {
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

    await interaction.update({
      content: `~~${interaction.message.content}~~\n✅ Done!`,
      components: [],
    });
  } else if (action === "snooze") {
    const duration = parts[3] || "1h";
    const option = SNOOZE_OPTIONS[duration];

    if (!option) {
      await interaction.reply({
        content: "Unknown snooze duration.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const newDueAt = new Date(Date.now() + option.ms).toISOString();
    const success = ctx.memory.snoozeReminder(reminderId, newDueAt);

    if (success) {
      const updated = ctx.memory.getReminder(reminderId);
      if (updated) ctx.reminderScheduler.scheduleReminder(updated);
    }

    await interaction.update({
      content: `${interaction.message.content}\n⏰ Snoozed for ${option.label}`,
      components: [],
    });
  }
});
