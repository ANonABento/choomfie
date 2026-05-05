/**
 * Modal builders + submit handlers.
 */

import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { registerModalHandler } from "../interactions.ts";
import { parseNaturalTime, isValidCron, normalizeTimeZone } from "../time.ts";
import { createAndScheduleReminder, isOwner } from "./shared.ts";

// --- Modal builders ---

/** Build a reminder creation modal */
export function buildReminderModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("modal-remind")
    .setTitle("Set a Reminder")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("message")
          .setLabel("What to remind you about")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. Deploy the new build")
          .setRequired(true)
          .setMaxLength(200)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("time")
          .setLabel("When")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 30m, 2h, in 30 min, tomorrow 9am")
          .setRequired(true)
          .setMaxLength(50)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("recurring")
          .setLabel("Recurring? (leave empty for one-off)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("hourly, daily, weekly, monthly, every 2h")
          .setRequired(false)
          .setMaxLength(20)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("nag")
          .setLabel("Nag until done? (yes/no, default: no)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("yes or no")
          .setRequired(false)
          .setMaxLength(3)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("timezone")
          .setLabel("Timezone (optional)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. America/New_York")
          .setRequired(false)
          .setMaxLength(64)
      )
    );
}

/** Build a persona creation modal */
export function buildPersonaModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("modal-persona")
    .setTitle("Create a Persona")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("key")
          .setLabel("Key (lowercase, no spaces)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. pirate, yoda, chill")
          .setRequired(true)
          .setMaxLength(20)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("name")
          .setLabel("Display Name")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. Captain Jack")
          .setRequired(true)
          .setMaxLength(50)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("personality")
          .setLabel("Personality Description")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("Describe how this persona talks, acts, and thinks...")
          .setRequired(true)
          .setMaxLength(1000)
      )
    );
}

/** Build a memory save modal */
export function buildMemoryModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("modal-memory")
    .setTitle("Save a Memory")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("key")
          .setLabel("Memory Key")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. favorite_language, timezone, project")
          .setRequired(true)
          .setMaxLength(50)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("value")
          .setLabel("What to Remember")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("The information to store...")
          .setRequired(true)
          .setMaxLength(500)
      )
    );
}

// --- Modal submit handlers ---

registerModalHandler("modal-remind", async (interaction, _parts, ctx) => {
  const message = interaction.fields.getTextInputValue("message");
  const timeStr = interaction.fields.getTextInputValue("time");
  const recurring = interaction.fields.getTextInputValue("recurring") || null;
  const nagRaw = interaction.fields.getTextInputValue("nag")?.toLowerCase() || "";
  let timezoneRaw = "";
  try {
    timezoneRaw = interaction.fields.getTextInputValue("timezone") || "";
  } catch {
    timezoneRaw = "";
  }
  const timezone = timezoneRaw.trim() ? normalizeTimeZone(timezoneRaw) : null;
  const nag = nagRaw === "yes" || nagRaw === "y";

  if (timezoneRaw.trim() && !timezone) {
    await interaction.reply({
      content: `Invalid timezone: "${timezoneRaw}". Use an IANA timezone such as America/New_York.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const dueAt = parseNaturalTime(timeStr, { timeZone: timezone });
  if (!dueAt) {
    await interaction.reply({
      content: `Couldn't parse time: "${timeStr}". Try "in 30 min", "tomorrow 9am", etc.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (recurring && !isValidCron(recurring)) {
    await interaction.reply({
      content: `Invalid recurring pattern: "${recurring}". Use hourly, daily, weekly, monthly, or "every Xh".`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.channelId) {
    await interaction.reply({
      content: "Could not determine channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const response = createAndScheduleReminder(ctx, {
    userId: interaction.user.id,
    channelId: interaction.channelId,
    message,
    dueAt,
    cron: recurring ?? undefined,
    timezone,
    nagInterval: nag ? 15 : undefined,
  });

  await interaction.reply({ content: response });
});

registerModalHandler("modal-persona", async (interaction, _parts, ctx) => {
  // Defense-in-depth: the slash command is owner-gated, but a future code
  // path that surfaces this modal must not accidentally grant write access.
  if (!isOwner(ctx, interaction.user.id)) {
    await interaction.reply({
      content: "Only the owner can create personas.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const key = interaction.fields
    .getTextInputValue("key")
    .toLowerCase()
    .replace(/\s+/g, "-");
  const name = interaction.fields.getTextInputValue("name");
  const personality = interaction.fields.getTextInputValue("personality");

  ctx.config.savePersona(key, name, personality);

  await interaction.reply({
    content: `**Persona created:** \`${key}\` — **${name}**\n${personality}\n\nSwitch with \`/persona switch:${key}\` or ask me to switch.`,
  });
});

registerModalHandler("modal-memory", async (interaction, _parts, ctx) => {
  if (!isOwner(ctx, interaction.user.id)) {
    await interaction.reply({
      content: "Only the owner can save memories.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const key = interaction.fields.getTextInputValue("key");
  const value = interaction.fields.getTextInputValue("value");

  ctx.memory.setCoreMemory(key, value);

  await interaction.reply({
    content: `**Memory saved:** \`${key}\` = ${value}`,
    flags: MessageFlags.Ephemeral,
  });
});
