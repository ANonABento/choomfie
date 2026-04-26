/**
 * Birthday tools — add, remove, list, and show upcoming birthdays.
 */

import type { ToolDef } from "../types.ts";
import { err, text } from "../types.ts";
import {
  type BirthdayOccurrence,
  formatBirthdayOccurrence,
  getUpcomingBirthdayOccurrences,
  parseBirthdayInput,
  sortBirthdayOccurrences,
} from "../birthdays.ts";

function stringArg(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function yearArg(value: unknown): number | null | undefined {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  const currentYear = new Date().getFullYear();
  if (value < 1 || value > currentYear) return undefined;
  return value;
}

function formatBirthdayList(items: BirthdayOccurrence[]): string {
  return items.map(formatBirthdayOccurrence).join("\n");
}

export const birthdayTools: ToolDef[] = [
  {
    definition: {
      name: "birthday_add",
      description:
        "Owner only. Add or update a birthday. birthday should be MM-DD; YYYY-MM-DD is also accepted and will infer year if year is omitted.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Display name for the person" },
          birthday: {
            type: "string",
            description: "Birthday as MM-DD, or YYYY-MM-DD to also infer birth year",
          },
          year: {
            type: "number",
            description: "Optional birth year for age calculations",
          },
          user_id: {
            type: "string",
            description: "Optional Discord user ID to mention on reminders",
          },
          notes: {
            type: "string",
            description: "Optional notes such as gift preferences",
          },
        },
        required: ["name", "birthday"],
      },
    },
    handler: async (args, ctx) => {
      const name = stringArg(args.name);
      if (!name) return err("name is required.");

      const parsed = parseBirthdayInput(args.birthday);
      if (!parsed) {
        return err('Invalid birthday. Use "MM-DD" such as "04-25", or "YYYY-MM-DD".');
      }

      const explicitYear = yearArg(args.year);
      if (explicitYear === undefined) {
        return err("Invalid year. Use a whole birth year that is not in the future.");
      }

      const userId = stringArg(args.user_id);
      const notes = stringArg(args.notes);
      const year = explicitYear ?? parsed.year;

      const id = ctx.memory.addBirthday(name, parsed.birthday, {
        userId,
        year,
        notes,
      });

      const parts = [`Birthday saved for ${name}: ${parsed.birthday}`];
      if (year) parts.push(`Year: ${year}`);
      if (userId) parts.push(`Discord user: <@${userId}>`);
      if (notes) parts.push(`Notes: ${notes}`);
      return text(`Birthday #${id}\n${parts.join("\n")}`);
    },
  },
  {
    definition: {
      name: "birthday_remove",
      description: "Owner only. Remove a birthday by name.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Birthday entry name to remove" },
        },
        required: ["name"],
      },
    },
    handler: async (args, ctx) => {
      const name = stringArg(args.name);
      if (!name) return err("name is required.");
      const removed = ctx.memory.removeBirthday(name);
      return removed ? text(`Removed birthday for ${name}.`) : err(`No birthday found for ${name}.`);
    },
  },
  {
    definition: {
      name: "birthday_list",
      description: "Owner only. List all birthdays, sorted by next occurrence.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    handler: async (_args, ctx) => {
      const birthdays = ctx.memory.listBirthdays();
      if (birthdays.length === 0) return text("No birthdays saved.");
      return text(`**Birthdays (${birthdays.length}):**\n${formatBirthdayList(sortBirthdayOccurrences(birthdays))}`);
    },
  },
  {
    definition: {
      name: "birthday_upcoming",
      description:
        "Owner only. Show birthdays coming up soon. Defaults to the next 30 days.",
      inputSchema: {
        type: "object" as const,
        properties: {
          days: {
            type: "number",
            description: "Look ahead this many days (default 30, max 366)",
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const rawDays = args.days == null ? 30 : args.days;
      if (typeof rawDays !== "number" || !Number.isFinite(rawDays)) {
        return err("days must be a number.");
      }
      const days = Math.min(Math.max(Math.floor(rawDays), 1), 366);
      const upcoming = getUpcomingBirthdayOccurrences(ctx.memory.listBirthdays(), days);
      if (upcoming.length === 0) return text(`No birthdays in the next ${days} days.`);
      return text(`**Upcoming birthdays (${days} days):**\n${formatBirthdayList(upcoming)}`);
    },
  },
];
