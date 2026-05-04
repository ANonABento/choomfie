/**
 * Slash commands for Choomfie Local mode.
 *
 * `/model list` — show available local models + active selections
 * `/model swap chat <name>` / `/model swap coding <name>` — change active model
 * `/model bench <name>` — quick TPS benchmark
 * `/local status` — provider, models, queue, resource usage
 *
 * All commands are owner-only (model swaps affect everyone).
 */

import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import { registerCommand } from "./interactions.ts";
import { requireOwner } from "./handlers/shared.ts";
import { formatDuration } from "./time.ts";
import type { ModelMetadata } from "./orchestrator/index.ts";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

function formatModel(m: ModelMetadata, sel: { chat: string; coding: string }): string {
  const role =
    m.name === sel.chat && m.name === sel.coding
      ? " · chat+coding"
      : m.name === sel.chat
        ? " · chat"
        : m.name === sel.coding
          ? " · coding"
          : "";
  const params = m.paramSize ? ` ${m.paramSize}` : "";
  const quant = m.quant ? ` ${m.quant}` : "";
  const vram = m.vramGB ? ` · ~${m.vramGB}GB` : "";
  return `\`${m.name}\`${params}${quant} (${m.speedTier})${vram}${role}`;
}

// /model — list, swap, bench
registerCommand("model", {
  data: new SlashCommandBuilder()
    .setName("model")
    .setDescription("Manage local LLM models (Choomfie Local)")
    .addSubcommand((s) =>
      s.setName("list").setDescription("Show available models and current selections"),
    )
    .addSubcommand((s) =>
      s
        .setName("swap")
        .setDescription("Switch the chat or coding model")
        .addStringOption((o) =>
          o
            .setName("role")
            .setDescription("Which slot to swap")
            .setRequired(true)
            .addChoices(
              { name: "chat", value: "chat" },
              { name: "coding", value: "coding" },
            ),
        )
        .addStringOption((o) =>
          o.setName("name").setDescription("Model tag (e.g. llama3.1:8b)").setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("bench")
        .setDescription("Quick TPS benchmark for a model")
        .addStringOption((o) =>
          o.setName("name").setDescription("Model tag (defaults to active chat model)"),
        ),
    )
    .toJSON(),
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;
    const runtime = ctx.localRuntime;
    if (!runtime) {
      await interaction.reply({
        content:
          "Local runtime is not active. Start Choomfie with `--local` (or `bun run start:local`).",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "list") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const models = await runtime.registry.list(true);
      const sel = runtime.getSelection();
      if (models.length === 0) {
        await interaction.editReply({
          content:
            "No Ollama models found. Pull some first: `ollama pull llama3.1:8b`.",
        });
        return;
      }
      const sorted = [...models].sort((a, b) => (b.paramsB ?? 0) - (a.paramsB ?? 0));
      const lines = sorted.map((m) => formatModel(m, sel));
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("Local Models")
        .setDescription(lines.join("\n").slice(0, 4000))
        .setFooter({
          text: `chat=${sel.chat} · coding=${sel.coding} · ${models.length} pulled`,
        });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "swap") {
      const role = interaction.options.getString("role", true) as "chat" | "coding";
      const name = interaction.options.getString("name", true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const ok = await runtime.registry.swap(role, name);
      if (!ok) {
        await interaction.editReply({
          content: `Model \`${name}\` is not pulled. Run \`ollama pull ${name}\` first.`,
        });
        return;
      }
      // Persist to config so the swap survives restart.
      const local = ctx.config.getLocalConfig();
      ctx.config.setLocalConfig({
        ...local,
        ...(role === "chat" ? { chatModel: name } : { codingModel: name }),
      });
      // Pre-warm the new pick in the background — don't block the reply.
      void runtime.provider.prewarm(name).catch(() => {});
      const sel = runtime.getSelection();
      await interaction.editReply({
        content: `Swapped ${role} model → \`${name}\` (chat=${sel.chat}, coding=${sel.coding}). Pre-warming...`,
      });
      return;
    }

    if (sub === "bench") {
      const name = interaction.options.getString("name") ?? runtime.getSelection().chat;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const result = await runtime.benchmark(name);
        const tps = result.tps ? `${result.tps.toFixed(1)} tok/s` : "n/a";
        const ttft = result.firstTokenMs ? `${result.firstTokenMs.toFixed(0)}ms` : "n/a";
        const total = `${result.totalMs.toFixed(0)}ms`;
        const embed = new EmbedBuilder()
          .setColor(0x9b59b6)
          .setTitle(`Bench: ${name}`)
          .addFields(
            { name: "TPS", value: tps, inline: true },
            { name: "TTFT", value: ttft, inline: true },
            { name: "Total", value: total, inline: true },
          )
          .setFooter({ text: result.text.slice(0, 80) || "(no text)" });
        await interaction.editReply({ embeds: [embed] });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await interaction.editReply({ content: `Benchmark failed: ${message}` });
      }
      return;
    }
  },
});

// /local status
registerCommand("local", {
  data: new SlashCommandBuilder()
    .setName("local")
    .setDescription("Choomfie Local mode controls")
    .addSubcommand((s) =>
      s.setName("status").setDescription("Provider, models, queue, resource usage"),
    )
    .toJSON(),
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;
    const runtime = ctx.localRuntime;
    if (!runtime) {
      await interaction.reply({
        content: "Local runtime is not active.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const sel = runtime.getSelection();
    const models = await runtime.registry.list();
    const chatMeta = models.find((m) => m.name === sel.chat);
    const codingMeta = models.find((m) => m.name === sel.coding);
    const idle = await runtime.idle.snapshot();
    const bg = runtime.background.status();
    const cfg = runtime.config;
    const ping = await runtime.provider.ping();

    const embed = new EmbedBuilder()
      .setColor(ping ? 0x57f287 : 0xed4245)
      .setTitle("Choomfie Local")
      .addFields(
        {
          name: "Provider",
          value: `Ollama @ ${cfg.ollamaUrl} ${ping ? "✅" : "❌"}`,
          inline: false,
        },
        {
          name: "Chat",
          value: chatMeta
            ? `${sel.chat} · ${chatMeta.paramSize ?? "?"} ${chatMeta.quant ?? ""}`.trim()
            : `${sel.chat} (not pulled)`,
          inline: true,
        },
        {
          name: "Coding",
          value: codingMeta
            ? `${sel.coding} · ${codingMeta.paramSize ?? "?"} ${codingMeta.quant ?? ""}`.trim()
            : `${sel.coding} (not pulled)`,
          inline: true,
        },
        {
          name: "Idle",
          value:
            `${formatDuration(idle.idleMs)} ` +
            (idle.isIdle ? "(idle ✓)" : "(active)") +
            ` · load=${idle.systemLoadAvg.toFixed(2)} (${idle.cpuCount} cpu)`,
          inline: false,
        },
        {
          name: "Background",
          value:
            (bg.running ? "running" : "stopped") +
            ` · in-flight=${bg.inFlight}` +
            ` · ${bg.apiUrl}`,
          inline: false,
        },
        {
          name: "Resource budget",
          value: `${cfg.resourceManagement.vramBudgetGB}GB VRAM · pause-on-gpu=${cfg.resourceManagement.pauseWhenGpuBusy}`,
          inline: false,
        },
      )
      .setFooter({
        text: `${models.length} model(s) pulled · disk: ${formatBytes(
          models.reduce((sum, m) => sum + m.size, 0),
        )}`,
      });

    await interaction.editReply({ embeds: [embed] });
  },
});
