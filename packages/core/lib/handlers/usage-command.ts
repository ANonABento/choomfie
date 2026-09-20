/**
 * `/usage` — plan limits and what this session has spent.
 *
 * Mirrors Claude Code's `/usage`, which reports plan rate-limit windows. The
 * numbers come from the SDK's `rate_limit_event`, normalised by the daemon into
 * `meta/daemon-state.json` — the same data the CLI shows, not an estimate.
 *
 * Daemon mode only, for the same reason `/compact` is: in foreground mode the
 * session belongs to the `claude` CLI, and nothing in Discord observes it.
 */

import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { registerCommand } from "../register.ts";
import {
  isDaemonMode,
  readDaemonStatus,
  type DaemonSnapshot,
  type ModelUsageSnapshot,
  type RateLimitSnapshot,
} from "../daemon-status.ts";
import type { AppContext } from "../types.ts";

/** Order the windows people actually care about first; anything new lands after. */
const WINDOW_ORDER = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"];

const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly (Opus)",
  seven_day_sonnet: "Weekly (Sonnet)",
};

const BAR_WIDTH = 12;

/** Utilization as a bar. Never renders empty at >0%, so "barely used" still shows. */
function bar(utilization: number): string {
  const clamped = Math.max(0, Math.min(1, utilization));
  const filled = clamped === 0 ? 0 : Math.max(1, Math.round(clamped * BAR_WIDTH));
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

function windowLabel(name: string): string {
  return WINDOW_LABELS[name] ?? name.replace(/_/g, " ");
}

function orderedWindows(rateLimit: RateLimitSnapshot): Array<[string, number, number | null]> {
  const entries = Object.entries(rateLimit.windows ?? {});
  const rank = (name: string) => {
    const index = WINDOW_ORDER.indexOf(name);
    return index === -1 ? WINDOW_ORDER.length : index;
  };
  return entries
    .filter(([, w]) => typeof w.utilization === "number")
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([name, w]) => [name, w.utilization!, w.resetsAt ?? null]);
}

/** Green under 60%, amber under 85%, red above — matched to the status text. */
function colorFor(rateLimit: RateLimitSnapshot | null | undefined): number {
  if (!rateLimit) return 0x5865f2;
  if (rateLimit.status === "rejected") return 0xed4245;
  const peak = Math.max(
    0,
    ...Object.values(rateLimit.windows ?? {}).map((w) => w.utilization ?? 0),
  );
  if (peak >= 0.85) return 0xed4245;
  if (peak >= 0.6) return 0xfee75c;
  return 0x57f287;
}

function formatModelUsage(modelUsage: Record<string, ModelUsageSnapshot>): string {
  const entries = Object.entries(modelUsage).filter(
    ([, u]) => (u.inputTokens ?? 0) > 0 || (u.outputTokens ?? 0) > 0,
  );
  if (entries.length === 0) return "Nothing yet this session.";

  return entries
    .sort((a, b) => (b[1].costUSD ?? 0) - (a[1].costUSD ?? 0))
    .map(([model, u]) => {
      // Cache reads are most of the input on a long session and are billed
      // differently, so they are called out rather than folded into "in".
      const cached = u.cacheReadInputTokens ?? 0;
      const cachedText = cached > 0 ? ` · ${cached.toLocaleString()} cached` : "";
      return (
        `**${model.replace(/-\d{8}$/, "")}**\n` +
        `${(u.inputTokens ?? 0).toLocaleString()} in · ` +
        `${(u.outputTokens ?? 0).toLocaleString()} out${cachedText} · ` +
        `$${(u.costUSD ?? 0).toFixed(4)}`
      );
    })
    .join("\n");
}

function buildEmbed(daemon: DaemonSnapshot): EmbedBuilder {
  const rateLimit = daemon.rateLimit ?? null;
  const embed = new EmbedBuilder()
    .setColor(colorFor(rateLimit))
    .setTitle("Usage");

  if (rateLimit && Object.keys(rateLimit.windows ?? {}).length > 0) {
    const lines = orderedWindows(rateLimit).map(([name, utilization, resetsAt]) => {
      // resetsAt is unix *seconds* from the SDK — Discord's <t:> wants the same,
      // so it passes through unscaled.
      const resets = resetsAt ? ` · resets <t:${Math.floor(resetsAt)}:R>` : "";
      return (
        `${windowLabel(name)} — **${(utilization * 100).toFixed(0)}%**${resets}\n` +
        `\`${bar(utilization)}\``
      );
    });
    // Some CLI builds send every window (`unifiedWindows`), others only the
    // binding one. Showing a single bar without saying so would read as "this
    // is your whole usage picture", which it isn't.
    const partial =
      Object.keys(rateLimit.windows ?? {}).length === 1 && rateLimit.tightest;
    embed.addFields({
      name: partial ? "Plan limits (binding window only)" : "Plan limits",
      value:
        lines.join("\n") +
        (partial
          ? "\n-# Only the limit you're closest to was reported. Others aren't visible from here."
          : ""),
      inline: false,
    });

    if (rateLimit.status === "rejected") {
      embed.setDescription("**Rate limited right now** — requests are being refused until the window resets.");
    } else if (rateLimit.status === "allowed_warning") {
      embed.setDescription("Approaching a limit. Still working, but worth pacing.");
    }

    if (rateLimit.isUsingOverage) {
      embed.addFields({
        name: "Overage",
        value: `Currently on overage credits (${rateLimit.overageStatus ?? "active"}).`,
        inline: false,
      });
    }
  } else {
    // An API-key account has no plan windows at all, and a session that has
    // only just started hasn't received its first event. Saying "0%" for either
    // would be a lie.
    embed.addFields({
      name: "Plan limits",
      value:
        "No rate-limit data yet — either the session just started, or this account " +
        "bills by API key rather than a plan (no windows to report).",
      inline: false,
    });
  }

  embed.addFields(
    {
      name: "This session",
      value:
        `$${(daemon.costUsd ?? 0).toFixed(4)} · ` +
        `${plural(daemon.turns?.current ?? 0, "turn")} · ` +
        `${plural(daemon.totalCycles ?? 0, "cycle")}\n` +
        `Model: **${daemon.model ?? "Claude Code default"}**`,
      inline: true,
    },
    {
      name: "Today",
      value: `${(daemon.tokenUsageToday?.inputTokens ?? 0).toLocaleString()} input tokens`,
      inline: true,
    },
    {
      name: "By model (this session)",
      value: formatModelUsage(daemon.modelUsage ?? {}).slice(0, 1024),
      inline: false,
    },
  );

  if (rateLimit?.updatedAt) {
    embed.setFooter({ text: "Plan limits as of" }).setTimestamp(new Date(rateLimit.updatedAt));
  }

  return embed;
}

registerCommand("usage", {
  data: new SlashCommandBuilder()
    .setName("usage")
    .setDescription("Show plan usage limits and what this session has spent")
    .toJSON(),
  handler: async (interaction, ctx: AppContext) => {
    if (!(await isDaemonMode(ctx.DATA_DIR))) {
      await interaction.reply({
        content:
          "Usage is only visible in **daemon mode** — in foreground mode the session " +
          "belongs to the `claude` CLI, which doesn't report its limits here.\n" +
          "Type `/usage` in that terminal instead.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const daemon = await readDaemonStatus(ctx.DATA_DIR);
    if (!daemon) {
      await interaction.reply({
        content: "The daemon is up but hasn't written its state yet — try again in a moment.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      embeds: [buildEmbed(daemon)],
      flags: MessageFlags.Ephemeral,
    });
  },
});

export { bar, buildEmbed, orderedWindows, colorFor, formatModelUsage };
