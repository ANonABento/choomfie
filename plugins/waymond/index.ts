/**
 * Waymond plugin — registers Ambition's Waymond as a Choomfie brain.
 *
 * Enable with `/plugins`, log in once with `bun run waymond:login`, then
 * `/brain set waymond` in a channel. No tools and no instructions: it costs
 * the Claude session nothing.
 */

import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import {
  errorMessage,
  pushBrainReply,
  registerBrain,
  unregisterBrain,
  type Brain,
  type BrainApproval,
  type Plugin,
  type PluginContext,
} from "@choomfie/shared";
import { chatUrl, lateMessages, openOffers, type Offer, type TurnState } from "./api.ts";
import { WaymondDriver } from "./driver.ts";
import { chatMapPath, profileDir, waymondDir } from "./paths.ts";
import { ChatMap } from "./store.ts";

const BRAIN_ID = "waymond";
const WATCH_EVERY_MS = 60_000;
const WATCH_FOR_MS = 3 * 60 * 60_000;

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
export function framePrompt(content: string, meta: Record<string, string>): string {
  const from = meta.role === "owner" ? "" : `[Discord message from ${meta.user ?? "someone"}]\n`;
  return `${from}${content}`;
}

/** Discord inbox files are named `<ts>_<rand>_<name>`; give Waymond the original name. */
export function originalName(inboxPath: string): string {
  return basename(inboxPath).replace(/^\d+_[a-z0-9]+_/, "") || basename(inboxPath);
}

function progressLine(turn: TurnState, elapsedMs: number): string {
  const what = turn.running.length ? turn.running.slice(0, 3).join(", ") : (turn.intent ?? "thinking");
  return `⏳ Waymond is working (${Math.round(elapsedMs / 1000)}s): ${what.slice(0, 180)}`;
}

let driver: WaymondDriver | null = null;

export function toApproval(o: Offer): BrainApproval {
  return {
    id: o.id,
    title: [o.title, o.subtitle].filter(Boolean).join(" · ") || o.kind,
    detail: o.detail,
    approveLabel: o.primary,
    declineLabel: o.secondary,
  };
}

/**
 * After an answer that started a background job, poll for the results and
 * post them when they land. In memory: a worker restart drops the watch (the
 * results are still in the Ambition chat).
 */
class Watchers {
  private watches = new Map<
    string,
    { convId: string; afterId: string; posted: Set<string>; until: number; timer: ReturnType<typeof setInterval> }
  >();

  start(chatKey: string, convId: string, afterId: string) {
    const existing = this.watches.get(chatKey);
    if (existing) {
      // Another job in the same chat: keep the older watermark so neither result is skipped.
      existing.until = Date.now() + WATCH_FOR_MS;
      return;
    }
    const timer = setInterval(() => void this.tick(chatKey), WATCH_EVERY_MS);
    this.watches.set(chatKey, { convId, afterId, posted: new Set(), until: Date.now() + WATCH_FOR_MS, timer });
  }

  /** Messages a normal send already delivered — never post them again. */
  delivered(chatKey: string, ids: string[]) {
    const w = this.watches.get(chatKey);
    if (w) for (const id of ids) w.posted.add(id);
  }

  stop(chatKey: string) {
    const w = this.watches.get(chatKey);
    if (w) clearInterval(w.timer);
    this.watches.delete(chatKey);
  }

  stopAll() {
    for (const key of [...this.watches.keys()]) this.stop(key);
  }

  private async tick(chatKey: string) {
    const w = this.watches.get(chatKey);
    if (!w || !driver) return;
    if (Date.now() > w.until) {
      this.stop(chatKey);
      return;
    }
    try {
      const late = lateMessages(await driver.readMessages(w.convId), w.afterId, w.posted);
      if (!late.length) return;
      for (const m of late) w.posted.add(m.id);
      const text = late.map((m) => m.content.trim()).filter(Boolean).join("\n\n");
      const choices = [...late].reverse().find((m) => m.options.length)?.options ?? [];
      const approvals = openOffers(late).map(toApproval);
      if (text || choices.length || approvals.length) await pushBrainReply(BRAIN_ID, chatKey, { text, choices, approvals });
      // Keep watching only if the results themselves kicked off more work.
      if (!late.some((m) => m.startsTask)) this.stop(chatKey);
    } catch (e) {
      console.error(`[waymond] background watch for ${chatKey}: ${errorMessage(e)}`);
    }
  }
}

let watchers: Watchers | null = null;

function createBrain(ctx: PluginContext): Brain {
  const chats = new ChatMap(chatMapPath(ctx.DATA_DIR));
  const outbox = join(waymondDir(ctx.DATA_DIR), "outbox");
  driver = new WaymondDriver({
    profileDir: profileDir(ctx.DATA_DIR),
    headless: process.env.CHOOMFIE_WAYMOND_HEADED !== "1",
  });
  watchers = new Watchers();

  return {
    id: BRAIN_ID,
    label: "Waymond",
    async reset(chatKey) {
      watchers?.stop(chatKey);
      chats.delete(chatKey);
    },
    async resolveApproval(chatKey, approvalId, approve) {
      const convId = chats.get(chatKey);
      if (!convId || !driver) throw new Error("no Waymond conversation for this channel");
      return driver.resolveOffer(convId, approvalId, approve ? "send" : "decline");
    },
    async stop(chatKey) {
      const convId = chats.get(chatKey);
      return convId && driver ? driver.stop(convId) : false;
    },
    async send(message) {
      const channel = await channelFor(ctx, message.chatKey);
      let status: Awaited<ReturnType<StatusChannel["send"]>> | null = null;
      let lastEdit = 0;
      let lastTyping = 0;
      let statusBusy = false;

      // Copy attachments under their original names so Waymond sees "photo.png".
      const batch = join(outbox, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
      const files = message.filePaths.map((p) => {
        mkdirSync(batch, { recursive: true });
        const dest = join(batch, originalName(p));
        copyFileSync(p, dest);
        return dest;
      });

      try {
        const result = await driver!.send(
          framePrompt(message.content, message.meta),
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
          },
          files
        );
        chats.set(message.chatKey, result.conversationId);
        watchers!.delivered(message.chatKey, result.messageIds);
        if (result.background && result.lastMessageId) {
          watchers!.start(message.chatKey, result.conversationId, result.lastMessageId);
        }
        const text = result.stopped
          ? `${result.reply ? `${result.reply}\n\n` : ""}⏹️ Stopped.`
          : result.background
            ? `${result.reply}\n\n-# I'll post the results here when Waymond finishes.`
            : result.reply;
        return { text, choices: result.options, approvals: result.offers.map(toApproval) };
      } catch (e) {
        throw new Error(errorMessage(e));
      } finally {
        await (status as { delete(): Promise<unknown> } | null)?.delete().catch(() => {});
        rmSync(batch, { recursive: true, force: true });
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
    unregisterBrain(BRAIN_ID);
    watchers?.stopAll();
    watchers = null;
    await driver?.close();
    driver = null;
  },
};

export default waymondPlugin;
