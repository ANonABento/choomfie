# Plugin Development Guide

Choomfie uses a plugin architecture — the core handles Discord bridging, memory, personas, and basic tools. Plugins add specialized capabilities (voice, language learning, web browsing, social media, etc.) without touching the core.

> Last updated: 2026-04-30

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Hello-World Plugin (Step-by-Step)](#hello-world-plugin-step-by-step)
3. [Plugin Interface](#plugin-interface)
4. [Lifecycle Hooks](#lifecycle-hooks)
5. [Registering Tools](#registering-tools)
6. [Registering Discord Interactions](#registering-discord-interactions)
   - [Slash Commands](#slash-commands)
   - [Button Handlers](#button-handlers)
   - [Modal Handlers](#modal-handlers)
7. [PluginContext Reference](#plugincontext-reference)
8. [Plugin State](#plugin-state)
9. [Error Handling](#error-handling)
10. [Existing Plugin Reference](#existing-plugin-reference)
11. [File Structure](#file-structure)
12. [Key Files](#key-files)

---

## Quick Start

### Enable a plugin

1. Make sure the plugin exists as a workspace package in `plugins/<name>/`
2. Register it in the plugin loader map at `packages/core/lib/plugins.ts`
3. Add it to `config.json`:
   ```json
   { "plugins": ["my-plugin"] }
   ```
4. Restart the bot

### Disable a plugin

Remove it from the `plugins` array in `config.json` and restart.

---

## Hello-World Plugin (Step-by-Step)

This walkthrough creates a minimal working plugin called `hello` that registers one MCP tool and one slash command.

### Step 1 — Create the package directory

```
plugins/
  hello/
    package.json
    index.ts
```

### Step 2 — Write `package.json`

```json
{
  "name": "@choomfie/hello",
  "version": "1.0.0",
  "type": "module",
  "main": "index.ts",
  "dependencies": {
    "@choomfie/shared": "workspace:*"
  }
}
```

Every plugin is a Bun workspace package that depends on `@choomfie/shared`. All packages share `node_modules` at the root — no `bun install` needed inside the plugin directory.

### Step 3 — Write `index.ts`

```typescript
// plugins/hello/index.ts
import type { Plugin, ToolDef } from "@choomfie/shared";
import { text, err, registerCommand } from "@choomfie/shared";
import { SlashCommandBuilder } from "discord.js";

// ── MCP Tool ────────────────────────────────────────────────────────────────

const tools: ToolDef[] = [
  {
    definition: {
      name: "hello",
      description: "Greet a user by name",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Name to greet" },
        },
        required: ["name"],
      },
    },
    handler: async (args, _ctx) => {
      const name = args.name as string;
      if (!name.trim()) return err("Name cannot be empty");
      return text(`Hello, ${name}! 👋`);
    },
  },
];

// ── Plugin Definition ────────────────────────────────────────────────────────

const helloPlugin: Plugin = {
  name: "hello",
  tools,
  instructions: [
    "## Hello Plugin",
    "Use the `hello` tool to greet someone by name.",
  ],
  userTools: ["hello"],

  async init(_ctx) {
    // Register the /greet slash command on startup
    registerCommand("greet", {
      data: new SlashCommandBuilder()
        .setName("greet")
        .setDescription("Greet someone")
        .addStringOption((opt) =>
          opt.setName("name").setDescription("Who to greet").setRequired(true),
        ),
      handler: async (interaction, _ctx) => {
        const name = interaction.options.getString("name", true);
        await interaction.reply(`Hello, ${name}! 👋`);
      },
    });

    console.error("[hello] Plugin initialized");
  },

  async destroy() {
    console.error("[hello] Plugin destroyed");
  },
};

export default helloPlugin;
```

### Step 4 — Register in the plugin loader

Open `packages/core/lib/plugins.ts` and add the entry:

```typescript
const PLUGIN_PACKAGES: Record<string, string> = {
  voice: "@choomfie/voice",
  browser: "@choomfie/browser",
  tutor: "@choomfie/tutor",
  socials: "@choomfie/socials",
  hello: "@choomfie/hello",      // ← add this
};
```

Also add a TypeScript path alias in `tsconfig.json`:

```json
"paths": {
  "@choomfie/hello": ["plugins/hello/index.ts"]
}
```

### Step 5 — Enable and test

```json
// config.json
{ "plugins": ["hello"] }
```

Restart the bot, then ask Claude: *"Use hello tool to greet Alice"*. You should get back `Hello, Alice! 👋`.

---

## Plugin Interface

Every plugin exports a single default object implementing the `Plugin` interface from `@choomfie/shared`:

```typescript
import type { Plugin } from "@choomfie/shared";

const myPlugin: Plugin = {
  // Required
  name: "my-plugin",

  // Optional — MCP tools callable by Claude
  tools: [...],

  // Optional — lines appended to the MCP system prompt
  instructions: ["## My Plugin", "Use my_tool to do X."],

  // Optional — extra Discord gateway intents
  intents: [GatewayIntentBits.GuildVoiceStates],

  // Optional — tool names non-owner users may call
  userTools: ["my_tool"],

  // Optional — runs once after Discord connects
  async init(ctx) { /* setup */ },

  // Optional — runs on every Discord message (before default handler)
  async onMessage(message, ctx) { /* hook */ },

  // Optional — runs on every Discord interaction (before default handler)
  async onInteraction(interaction, ctx) { /* hook */ },

  // Optional — cleanup on shutdown
  async destroy() { /* teardown */ },
};

export default myPlugin;
```

### Field Reference

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `name` | `string` | Yes | Unique identifier (e.g. `"voice"`) |
| `tools` | `ToolDef[]` | No | MCP tools — auto-registered, callable by Claude |
| `instructions` | `string[]` | No | Lines appended to the MCP system prompt |
| `intents` | `GatewayIntentBits[]` | No | Extra Discord intents merged into the client |
| `userTools` | `string[]` | No | Plugin tools that non-owner users can call |
| `init` | `(ctx) => Promise<void>` | No | Called once after Discord ready |
| `onMessage` | `(msg, ctx) => Promise<void>` | No | Hook into every message |
| `onInteraction` | `(interaction, ctx) => Promise<void>` | No | Hook into every interaction |
| `destroy` | `() => Promise<void>` | No | Cleanup on shutdown |

---

## Lifecycle Hooks

```
Startup:
  createContext()              → loads env, config, memory
  loadPlugins(config)          → reads plugins array, imports each plugin
  createMcpServer(ctx)         → registers core + plugin tools, builds instructions
  createDiscordClient(ctx)     → merges plugin intents into Discord client
  discord.login()              → connects to Discord
  ClientReady event            → calls plugin.init(ctx) for each plugin

Runtime:
  MessageCreate event          → calls plugin.onMessage(msg, ctx) for each plugin
  InteractionCreate event      → calls plugin.onInteraction(interaction, ctx) for each plugin
  Tool calls from Claude       → plugin tools dispatched via same Map lookup as core tools

Shutdown:
  SIGINT / stdin close         → calls plugin.destroy() for each plugin
```

### `init(ctx: PluginContext)`

Called once after `ClientReady`. Use it to:
- Open databases (`new Database(ctx.DATA_DIR + "/mydata.db")`)
- Start background timers
- Register slash commands via `registerCommand()`
- Wire up any long-lived connections

### `onMessage(message: Message, ctx: PluginContext)`

Called for every `MessageCreate` event, *before* the default Discord handler. Return early if the message is not relevant to your plugin. Example (from the tutor plugin):

```typescript
async onMessage(message, ctx) {
  if (message.author.bot) return;
  if (!hasActiveExercise(message.author.id)) return;
  // handle the answer...
},
```

### `onInteraction(interaction: Interaction, ctx: PluginContext)`

Called for every `InteractionCreate` event, *before* the default interaction dispatcher. Useful when you need low-level control. For most cases, prefer `registerButtonHandler` / `registerModalHandler` / `registerCommand` instead — they handle routing automatically.

### `destroy()`

Called on `SIGINT`, `SIGTERM`, or stdin close. Clean up open handles: close databases, disconnect sockets, clear timers.

---

## Registering Tools

Tools are the primary way plugins expose functionality to Claude via MCP. Define them as `ToolDef` objects:

```typescript
import type { ToolDef } from "@choomfie/shared";
import { text, err } from "@choomfie/shared";

export const myTools: ToolDef[] = [
  {
    definition: {
      name: "tool_name",           // snake_case, globally unique
      description: "What it does", // shown to Claude
      inputSchema: {
        type: "object" as const,
        properties: {
          param1: { type: "string", description: "..." },
          param2: { type: "number", description: "..." },
        },
        required: ["param1"],
      },
    },
    handler: async (args, ctx) => {
      const p1 = args.param1 as string;
      if (!p1) return err("param1 is required");
      // do work...
      return text(`Result: ${p1}`);
    },
  },
];
```

Use `text()` for success responses and `err()` for error responses — both are re-exported from `@choomfie/shared`.

**Tool name collisions:** The plugin loader detects duplicate tool names (within a plugin or across plugins) and skips the entire offending plugin with an error. Always use namespaced names like `voice_join`, `tutor_quiz`, etc.

---

## Registering Discord Interactions

Interaction handlers live in `@choomfie/shared/interactions.ts` and are registered from `init()`. They bypass Claude entirely — Discord requires a response within 3 seconds, so interactions are handled directly for instant response.

### Slash Commands

```typescript
import { registerCommand } from "@choomfie/shared";
import { SlashCommandBuilder } from "discord.js";

// Call from init()
registerCommand("mycommand", {
  data: new SlashCommandBuilder()
    .setName("mycommand")
    .setDescription("Does something useful")
    .addStringOption((opt) =>
      opt.setName("input").setDescription("Input value").setRequired(true),
    ),
  handler: async (interaction, ctx) => {
    const input = interaction.options.getString("input", true);
    await interaction.reply({ content: `Got: ${input}`, ephemeral: true });
  },
});
```

Commands are deployed to Discord automatically on startup when definitions change (hash-based check). Force a manual deploy:

```bash
bun packages/core/scripts/deploy-commands.ts
```

### Button Handlers

Button `customId` format: `prefix:action:data` (e.g. `my-btn:confirm:42`).

```typescript
import { registerButtonHandler } from "@choomfie/shared";

// Register in the module body (not inside init) so it's active on load
registerButtonHandler("my-btn", async (interaction, parts, ctx) => {
  // parts = interaction.customId.split(":")
  // e.g. customId="my-btn:confirm:42" → parts=["my-btn", "confirm", "42"]
  const [, action, id] = parts;

  if (action === "confirm") {
    await interaction.update({ content: `Confirmed item ${id}`, components: [] });
  } else if (action === "cancel") {
    await interaction.update({ content: "Cancelled", components: [] });
  }
});
```

Send a button from a tool or command:

```typescript
import { ButtonBuilder, ButtonStyle, ActionRowBuilder } from "discord.js";

const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder()
    .setCustomId("my-btn:confirm:42")
    .setLabel("Confirm")
    .setStyle(ButtonStyle.Primary),
  new ButtonBuilder()
    .setCustomId("my-btn:cancel:42")
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Secondary),
);

await interaction.reply({ content: "Are you sure?", components: [row] });
```

### Modal Handlers

Modals are multi-field input forms. `showModal()` must be the *first* response to an interaction — you cannot defer before showing a modal.

```typescript
import { registerModalHandler, registerCommand } from "@choomfie/shared";
import {
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  SlashCommandBuilder,
} from "discord.js";

// Register modal handler
registerModalHandler("my-modal", async (interaction, parts, ctx) => {
  const title = interaction.fields.getTextInputValue("title");
  const body = interaction.fields.getTextInputValue("body");
  await interaction.reply({ content: `Saved: **${title}**\n${body}`, ephemeral: true });
});

// Trigger modal from a slash command
registerCommand("create", {
  data: new SlashCommandBuilder().setName("create").setDescription("Create something"),
  handler: async (interaction, _ctx) => {
    const modal = new ModalBuilder()
      .setCustomId("my-modal:create")
      .setTitle("Create Item");

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("Title")
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("body")
          .setLabel("Description")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false),
      ),
    );

    await interaction.showModal(modal);
  },
});
```

---

## PluginContext Reference

All lifecycle hooks and tool handlers receive a `PluginContext`:

```typescript
interface PluginContext {
  DATA_DIR: string;          // Persistent storage directory (~/.claude/plugins/data/choomfie-inline/)
  config: PluginConfig;      // Config interface (not the class)
  mcp?: McpTransport;        // Send MCP notifications to Claude
  discord?: Client;          // Discord.js client
  ownerUserId?: string|null; // Bot owner's Discord user ID
}

interface PluginConfig {
  getConfig(): ChoomfieConfig;
  getEnabledPlugins(): string[];
  getVoiceConfig(): { stt: string; tts: string; ttsSpeed?: number };
  getSocialsConfig(): SocialsConfig | undefined;
}

interface McpTransport {
  notification?(msg: { method: string; params: Record<string, unknown> }): void;
  requestRestart?(reason: string, chat_id?: string): void;
}
```

**Send a notification to Claude from a plugin:**

```typescript
ctx.mcp?.notification?.({
  method: "notifications/message",
  params: { content: "Something happened!" },
});
```

**Use persistent storage:**

```typescript
import { Database } from "bun:sqlite";

// In init():
const db = new Database(`${ctx.DATA_DIR}/myplugin.db`);
```

**Check owner permissions:**

```typescript
if (interaction.user.id !== ctx.ownerUserId) {
  await interaction.reply({ content: "Owner only.", ephemeral: true });
  return;
}
```

---

## Plugin State

Plugins manage their own state at module scope. Do **not** add fields to `AppContext` — it belongs to core.

```typescript
// Module-scoped state — tools close over this directly
let manager: MyManager | null = null;

export const getManager = () => manager;

const plugin: Plugin = {
  name: "my-plugin",
  tools: [...],

  async init(ctx) {
    manager = new MyManager(ctx);
    await manager.start();
  },

  async destroy() {
    manager?.stop();
    manager = null;
  },
};

export default plugin;
```

Tool handlers call `getManager()` which always reflects the current value of `manager`.

---

## Error Handling

Plugin errors are caught and logged — a failing plugin won't crash the bot:

| Hook | Failure behavior |
|------|-----------------|
| `init()` | Logged to stderr, plugin skipped for this session |
| `onMessage()` | Logged, message processing continues |
| `onInteraction()` | Logged, interaction processing continues |
| `destroy()` | Logged, shutdown continues |
| Tool handler | Returned as MCP error response to Claude |

Wrap external calls in try/catch and return `err("...")` for tool failures:

```typescript
handler: async (args, ctx) => {
  try {
    const result = await externalApi.fetch(args.id as string);
    return text(JSON.stringify(result));
  } catch (e) {
    return err(`API call failed: ${e instanceof Error ? e.message : String(e)}`);
  }
},
```

---

## Existing Plugin Reference

Study these for real-world patterns:

| Plugin | Package | Demonstrates |
|--------|---------|--------------|
| **browser** | `@choomfie/browser` | Minimal plugin with tools + init/destroy. Session cleanup in destroy. |
| **voice** | `@choomfie/voice` | Manager pattern, extra Discord intents (`GuildVoiceStates`), module-scoped state. |
| **tutor** | `@choomfie/tutor` | `onMessage` hook for exercise handling, multiple databases, button interactions, SRS timers, sub-module init/destroy. |
| **socials** | `@choomfie/socials` | MCP notification forwarding, provider initialization from config, polling loops. |

### Browser — minimal plugin

```typescript
// plugins/browser/index.ts
const browserPlugin: Plugin = {
  name: "browser",
  tools: browserTools,
  userTools: ["browse", "browser_click", "browser_type", "browser_screenshot", "browser_press_key", "browser_close"],
  instructions: ["## Browser", "You can browse the web using Playwright.", ...],

  async init() { console.error("Browser plugin initialized"); },
  async destroy() {
    await closeAll(); // close all Playwright sessions
  },
};
```

### Voice — manager + intents

```typescript
// plugins/voice/index.ts
const voicePlugin: Plugin = {
  name: "voice",
  tools: voiceTools,
  intents: [GatewayIntentBits.GuildVoiceStates], // required to receive voice events
  instructions: [...],

  async init(ctx) {
    manager = new VoiceManager(ctx);
    await manager.init();
    setVoiceManager(manager); // tools access via getVoiceManager()
  },

  async destroy() {
    manager?.disconnectAll();
    manager = null;
  },
};
```

### Tutor — onMessage hook + interactions

```typescript
// plugins/tutor/index.ts
const tutorPlugin: Plugin = {
  name: "tutor",
  tools: getAllTutorTools(),
  instructions: [...],

  async onMessage(message, ctx) {
    if (message.author.bot) return;
    if (!hasActiveTypingExercise(message.author.id)) return;

    const result = handleTypedAnswer(message.author.id, message.content);
    if (!result) return;
    // send feedback embed, advance to next exercise...
  },

  async init(ctx) {
    const srs = new SRSManager(`${ctx.DATA_DIR}/srs.db`);
    setSRS(srs);
    // ... register lessons, set up timers
  },
};
```

---

## File Structure

```
plugins/
  <name>/
    package.json       # Workspace package: name "@choomfie/<name>", dep "@choomfie/shared"
    index.ts           # Required — exports default Plugin
    tools.ts           # Optional — ToolDef[] array (for organization)
    *.ts               # Optional — internal modules, managers, providers
```

For complex plugins with many tools, split into subdirectories:

```
plugins/my-plugin/
  index.ts
  tools/
    index.ts           # Aggregates all tools
    search.ts
    post.ts
  lib/
    manager.ts
    provider.ts
```

---

## Key Files

| File | Purpose |
|------|---------|
| `packages/shared/types.ts` | `Plugin`, `ToolDef`, `ToolResult` interfaces |
| `packages/shared/plugin-context.ts` | `PluginContext`, `PluginConfig`, `McpTransport` |
| `packages/shared/interactions.ts` | `registerButtonHandler`, `registerModalHandler`, `registerCommand` |
| `packages/shared/index.ts` | Everything exported from `@choomfie/shared` |
| `packages/core/lib/plugins.ts` | Plugin loader (explicit workspace package map) |
| `packages/core/lib/types.ts` | `AppContext` (full runtime context, extends `PluginContext`) |
| `packages/core/lib/interactions.ts` | `handleInteraction()` — dispatches to registered handlers |
| `packages/core/lib/tools/index.ts` | Merges plugin tools into core tool registry |
| `packages/core/lib/discord.ts` | Merges intents, calls `init`/`onMessage`/`onInteraction` hooks |
| `tsconfig.json` | Add path alias for new plugin packages here |
