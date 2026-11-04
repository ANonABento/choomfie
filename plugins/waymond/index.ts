/**
 * Waymond plugin — registers Ambition's Waymond as a Choomfie brain.
 *
 * Enable with `/plugins`, log in once with `bun run waymond:login`, then
 * `/brain set waymond` in a channel. No tools and no instructions: it costs
 * the Claude session nothing.
 */

import {
  errorMessage,
  registerBrain,
  unregisterBrain,
  type Brain,
  type Plugin,
  type PluginContext,
} from "@choomfie/shared";
import { chatUrl, type TurnState } from "./api.ts";
import { WaymondDriver } from "./driver.ts";
import { chatMapPath, profileDir } from "./paths.ts";
import { ChatMap } from "./store.ts";

interface StatusChannel {
  send(content: string): Promise<{ edit(content: string): Promise<unknown>; delete(): Promise<unknown> }>;
  sendTyping?(): Promise<unknown>;
}

async function channelFor(ctx: PluginContext, chatKey: string): Promise<StatusChannel | null> {
  try {
    const ch = await ctx.discord?.channels.fetch(chatKey);
    return ch && "send" in ch ? (ch as unknown as StatusChannel) : null;
  } catch {
    return null;
  }
}

/** Waymond only ever sees one account, so say who's talking when it isn't the owner. */
export function framePrompt(content: string, meta: Record<string, string>, attachmentNames: string[]): string {
  const from = meta.role === "owner" ? "" : `[Discord message from ${meta.user ?? "someone"}]\n`;
  const files = attachmentNames.length ? `\n\n(Attached on Discord, not forwarded: ${attachmentNames.join(", ")})` : "";
  return `${from}${content}${files}`;
}

function progressLine(turn: TurnState, elapsedMs: number): string {
  const what = turn.running.length ? turn.running.slice(0, 3).join(", ") : (turn.intent ?? "thinking");
  return `⏳ Waymond is working (${Math.round(elapsedMs / 1000)}s): ${what.slice(0, 180)}`;
}

let driver: WaymondDriver | null = null;

function createBrain(ctx: PluginContext): Brain {
  const chats = new ChatMap(chatMapPath(ctx.DATA_DIR));
  driver = new WaymondDriver({
    profileDir: profileDir(ctx.DATA_DIR),
    headless: process.env.CHOOMFIE_WAYMOND_HEADED !== "1",
  });

  return {
    id: "waymond",
    label: "Waymond",
    async reset(chatKey) {
      chats.delete(chatKey);
    },
    async send(message) {
      const channel = await channelFor(ctx, message.chatKey);
      let status: Awaited<ReturnType<StatusChannel["send"]>> | null = null;
      let lastEdit = 0;
      let lastTyping = 0;
      let statusBusy = false;

      const names = (message.meta.attachments ?? "").split("; ").filter(Boolean);
      try {
        const { reply, conversationId } = await driver!.send(
          framePrompt(message.content, message.meta, names),
          chats.get(message.chatKey),
          {
            onProgress(turn, elapsed) {
              const now = Date.now();
              if (channel?.sendTyping && now - lastTyping > 8_000) {
                lastTyping = now;
                void channel.sendTyping().catch(() => {});
              }
              // Quiet for short answers; one self-updating status line for long tasks.
              if (!channel || statusBusy || elapsed < 45_000 || now - lastEdit < 20_000) return;
              lastEdit = now;
              statusBusy = true;
              const line = progressLine(turn, elapsed);
              void (status ? status.edit(line) : channel.send(line).then((m) => (status = m)))
                .catch(() => {})
                .finally(() => (statusBusy = false));
            },
            onApprovalNeeded(convId) {
              void channel
                ?.send(`🔐 Waymond is waiting for your OK on something. Approve or decline it here: ${chatUrl(convId)}`)
                .catch(() => {});
            },
          }
        );
        chats.set(message.chatKey, conversationId);
        return { text: reply };
      } catch (e) {
        throw new Error(errorMessage(e));
      } finally {
        await (status as { delete(): Promise<unknown> } | null)?.delete().catch(() => {});
      }
    },
  };
}

const waymondPlugin: Plugin = {
  name: "waymond",

  async init(ctx) {
    registerBrain(createBrain(ctx));
    console.error("Waymond plugin initialized — brain `waymond` registered");
  },

  async destroy() {
    unregisterBrain("waymond");
    await driver?.close();
    driver = null;
  },
};

export default waymondPlugin;
