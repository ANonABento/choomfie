# Plugin API

Choomfie plugins are workspace packages under `plugins/<name>` that default-export a `Plugin` object from `index.ts`. The worker loads enabled plugins, registers their tools with MCP, appends their instructions to the system prompt, and invokes lifecycle hooks from the Discord runtime.

## Contract

```ts
import type { GatewayIntentBits, Interaction, Message } from "discord.js";
import type { PluginContext } from "@choomfie/shared";

export interface Plugin {
  name: string;
  tools?: ToolDef[];
  instructions?: string[];
  intents?: GatewayIntentBits[];
  userTools?: string[];
  init?(ctx: PluginContext): Promise<void>;
  onMessage?(message: Message, ctx: PluginContext): Promise<void>;
  onInteraction?(interaction: Interaction, ctx: PluginContext): Promise<void>;
  destroy?(): Promise<void>;
}
```

### Fields

- `name`: Stable unique plugin identifier. It should match the plugin package name, for example `voice` for `@choomfie/voice`.
- `tools`: MCP tool definitions exposed by the plugin. Tool names must be unique across all enabled plugins.
- `instructions`: Lines appended to the MCP system prompt when the plugin is enabled.
- `intents`: Additional Discord gateway intents required by the plugin.
- `userTools`: Tool names that non-owner Discord users may call. Tools omitted here are owner-only.
- `init(ctx)`: Runs once after Discord is ready. Initialize clients, schedulers, caches, and module-level state here.
- `onMessage(message, ctx)`: Runs for every non-bot Discord message before the default Choomfie message handler.
- `onInteraction(interaction, ctx)`: Runs for every Discord interaction before the default interaction handler.
- `destroy()`: Runs during worker shutdown. Stop timers, close clients, disconnect sessions, and release global state.

## Tool Definition

```ts
export interface ToolDef {
  definition: {
    name: string;
    description: string;
    inputSchema: object;
  };
  handler: (
    args: Record<string, unknown>,
    ctx: PluginContext,
  ) => Promise<ToolResult>;
}
```

Handlers receive parsed JSON arguments and the current `PluginContext`. Return `text("...")` for success and `err("...")` for expected user-facing failures.

## PluginContext

Plugins should depend only on `PluginContext` from `@choomfie/shared`.

```ts
export interface PluginContext {
  DATA_DIR: string;
  config: PluginConfig;
  mcp?: McpTransport;
  discord?: Client;
  ownerUserId?: string | null;
}
```

`ctx.mcp` is a duck-typed transport. In the worker it is an `McpProxy`; in tests or standalone scripts it may be a minimal object with `notification`, `requestRestart`, or `setNotificationHandler`.

## Example

```ts
import type { Plugin } from "@choomfie/shared";
import { text } from "@choomfie/shared";

const examplePlugin: Plugin = {
  name: "example",
  tools: [
    {
      definition: {
        name: "example_ping",
        description: "Check whether the example plugin is loaded.",
        inputSchema: { type: "object", properties: {} },
      },
      async handler(_args, ctx) {
        return text(`pong from ${ctx.DATA_DIR}`);
      },
    },
  ],
  instructions: ["## Example", "Use `example_ping` to verify the example plugin."],
  userTools: ["example_ping"],
  async init(ctx) {
    await Bun.write(`${ctx.DATA_DIR}/example.ready`, "ok");
  },
  async destroy() {
    // Close clients and clear timers here.
  },
};

export default examplePlugin;
```

## Lifecycle Rules

- `init` runs after Discord client readiness. Do not assume it runs when a plugin is merely imported.
- `onMessage` and `onInteraction` failures are logged and isolated so one plugin cannot stop later plugins or core handlers.
- `destroy` is best-effort during worker shutdown. It should be idempotent and tolerate partially initialized state.
- Plugin tools are registered once at worker startup. Changing tool definitions requires a worker restart.

## Common Pitfalls

- Do not import core-only worker classes from `packages/shared`; shared must stay lightweight and safe for plugins.
- Avoid module-level side effects that start network clients, timers, browser sessions, or voice connections on import. Put them in `init`.
- Do not assume `ctx.discord` or `ctx.mcp` exists in smoke tests or standalone scripts; guard optional capabilities.
- Keep tool names globally unique. Prefix broad names with the plugin domain when collisions are likely.
- Clean up module-level singletons in `destroy`, especially intervals, browser sessions, provider clients, and voice connections.
- Do not store user data outside `ctx.DATA_DIR`.
