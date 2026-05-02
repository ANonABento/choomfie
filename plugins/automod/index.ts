import type { Plugin, PluginContext, AutomodAction } from "@choomfie/shared";
import {
  MessageFlags,
  SlashCommandBuilder,
  GatewayIntentBits,
  type GuildMember,
} from "discord.js";
import { registerCommand } from "@choomfie/shared";

const WINDOW_MS = 60_000;
const ACTION_COOLDOWN_MS = 10_000;
const TIMEOUT_MS = 60_000;

const rateBuckets = new Map<string, number[]>();
const lastActionAt = new Map<string, number>();
const DEFAULT_BANNED_WORDS_MESSAGE = "No banned words configured.";

function parseBannedWords(raw: string | null): string[] {
  if (!raw) return [];

  return raw
    .split(/[\n,;]+/)
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean)
    .filter((word, index, list) => list.indexOf(word) === index);
}

function findBannedWord(content: string, words: string[]): string | null {
  for (const word of words) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `(^|[^\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
      "iu"
    );
    if (word && pattern.test(content)) return word;
  }
  return null;
}

function parseAutomodAction(raw: string | null): AutomodAction | null {
  if (raw === "warn" || raw === "timeout" || raw === "kick") {
    return raw;
  }
  return null;
}

function isOwner(ctx: PluginContext, userId: string): boolean {
  return !!ctx.ownerUserId && ctx.ownerUserId === userId;
}

function isModerationTarget(
  message: { author: { id: string; bot?: boolean } },
  ctx: PluginContext
): boolean {
  return !message.author.bot && !isOwner(ctx, message.author.id);
}

function moderationKey(message: {
  guild?: { id: string } | null;
  author: { id: string };
}): string {
  return `${message.guild?.id ?? "dm"}:${message.author.id}`;
}

function shouldRateLimit(key: string, maxPerMinute: number): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || [];
  while (bucket.length > 0 && now - bucket[0] > WINDOW_MS) bucket.shift();

  bucket.push(now);
  rateBuckets.set(key, bucket);

  return bucket.length > maxPerMinute;
}

function isActionCoolingDown(key: string): boolean {
  const last = lastActionAt.get(key) || 0;
  return Date.now() - last < ACTION_COOLDOWN_MS;
}

function markActionCoolingDown(key: string): void {
  lastActionAt.set(key, Date.now());
}

function buildConfigSummary(config: {
  maxMessagesPerMinute: number;
  bannedWords: string[];
  action: string;
}) {
  const bannedWords =
    config.bannedWords.length > 0
      ? config.bannedWords.join(", ")
      : DEFAULT_BANNED_WORDS_MESSAGE;
  return [
    `Max messages/minute: ${config.maxMessagesPerMinute}`,
    `Action: ${config.action}`,
    `Banned words: ${bannedWords}`,
    "Owner-only command: `/automod_config`",
  ].join("\n");
}

const automodPlugin: Plugin = {
  name: "automod",

  intents: [GatewayIntentBits.GuildMembers],

  async init(ctx) {
    registerCommand("automod_config", {
      data: new SlashCommandBuilder()
        .setName("automod_config")
        .setDescription("Configure automod settings (owner-only)")
        .addIntegerOption((o) =>
          o
            .setName("max_messages_per_minute")
            .setDescription("Maximum messages per minute per user")
            .setMinValue(1)
            .setMaxValue(120)
        )
        .addStringOption((o) =>
          o
            .setName("banned_words")
            .setDescription(
              "Comma/newline-separated banned words (leave empty to clear)"
            )
        )
        .addStringOption((o) =>
          o
            .setName("action")
            .setDescription("Action when rate limit or banned word is triggered")
            .addChoices(
              { name: "Warn", value: "warn" },
              { name: "Timeout", value: "timeout" },
              { name: "Kick", value: "kick" }
            )
        )
        .toJSON(),

      handler: async (interaction, pluginCtx) => {
        if (!pluginCtx.ownerUserId || pluginCtx.ownerUserId !== interaction.user.id) {
          await interaction.reply({
            content: "This command is owner-only.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const maxMessagesPerMinute = interaction.options.getInteger(
          "max_messages_per_minute"
        );
        const bannedWordsRaw = interaction.options.getString("banned_words");
        const action = parseAutomodAction(interaction.options.getString("action"));
        const cfg = pluginCtx.config.getAutomodConfig();

        if (
          maxMessagesPerMinute === null &&
          bannedWordsRaw === null &&
          action === null
        ) {
          await interaction.reply({
            content: buildConfigSummary(cfg),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const nextCfg: {
          maxMessagesPerMinute?: number;
          bannedWords?: string[];
          action?: AutomodAction;
        } = {};

        if (maxMessagesPerMinute !== null) {
          nextCfg.maxMessagesPerMinute = maxMessagesPerMinute;
        }
        if (bannedWordsRaw !== null) {
          nextCfg.bannedWords = parseBannedWords(bannedWordsRaw);
        }
        if (action) {
          nextCfg.action = action;
        }

        pluginCtx.config.setAutomodConfig(nextCfg);
        const updated = pluginCtx.config.getAutomodConfig();

        await interaction.reply({
          content: `Automod updated:\n${buildConfigSummary(updated)}`,
          flags: MessageFlags.Ephemeral,
        });
      },
    });
  },

  async onMessage(message, ctx) {
    if (!message.guild) return;
    if (!isModerationTarget(message, ctx)) return;

    const cfg = ctx.config.getAutomodConfig();
    const userId = message.author.id;
    const key = moderationKey(message);
    const shouldAct = shouldRateLimit(key, cfg.maxMessagesPerMinute);
    const bannedWord = findBannedWord(message.content, cfg.bannedWords);

    if (!shouldAct && !bannedWord) return;

    let action: AutomodAction = cfg.action;
    let reason: string;

    if (bannedWord) {
      reason = `Banned word detected (${bannedWord})`;
    } else {
      reason = `Rate limit exceeded: ${cfg.maxMessagesPerMinute}/min`;
    }

    try {
      if (action === "warn") {
        if (isActionCoolingDown(key)) return;
        markActionCoolingDown(key);
        await message.reply({
          content: `⚠️ Moderation triggered: ${reason}.`,
        });
        return;
      }

      let member: GuildMember | null = message.member ?? null;
      if (!member) {
        member = await message.guild.members.fetch(userId).catch(() => null);
      }
      if (!member) return;
      if (isActionCoolingDown(key)) return;
      markActionCoolingDown(key);

      if (action === "timeout") {
        await member.timeout(TIMEOUT_MS, `Automod action: ${reason}`);
        await message.reply({
          content: `⏱️ User timed out for 1 minute for: ${reason}.`,
        });
        return;
      }

      if (action === "kick") {
        await member.kick(`Automod action: ${reason}`);
        return;
      }
    } catch {
      await message.reply({
        content: `⚠️ Automod ${action} failed. Check bot permissions.`,
      });
      return;
    }
  },

  async destroy() {
    rateBuckets.clear();
    lastActionAt.clear();
  },
};

export default automodPlugin;
