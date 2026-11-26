/**
 * The Discord status line a brain shows while a long turn runs: typing every
 * few seconds, then one self-updating "-#" line (after 45s, at most every
 * 20s), deleted when the turn ends. In a chat the bot isn't a member of
 * (`/choomfie`, a group DM), lines go to the interaction's "thinking…" reply
 * instead (`relay`), sooner, since it's already on screen.
 *
 * Used by web brains and harnesses; status lines quote a site's or agent's
 * own words, so they never ping anyone.
 */

import type { PluginContext } from "./plugin-context.ts";

type Quiet = { content: string; allowedMentions: { parse: never[] } };
export const quiet = (content: string): Quiet => ({ content, allowedMentions: { parse: [] } });

interface StatusChannel {
  send(options: Quiet): Promise<{ edit(options: Quiet): Promise<unknown>; delete(): Promise<unknown> }>;
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

export interface StatusLine {
  /** The work started (after any queue): the line's clock starts here. */
  begin(): void;
  /** What's happening now; shown only on a long turn, throttled. */
  progress(line: string): void;
  /** Something the owner should see now, as its own quiet message. */
  notice(line: string): void;
  /** The turn is over: the status line goes. */
  close(): Promise<void>;
}

export async function statusLine(ctx: PluginContext, chatKey: string, relay?: (line: string) => Promise<unknown>): Promise<StatusLine> {
  const channel = relay ? null : await channelFor(ctx, chatKey);
  let status: Awaited<ReturnType<StatusChannel["send"]>> | null = null;
  let lastEdit = 0;
  let lastTyping = 0;
  let busy = false;
  let started = 0;
  return {
    begin() {
      started ||= Date.now();
    },
    progress(line) {
      const now = Date.now();
      const elapsed = now - (started || now);
      if (channel?.sendTyping && now - lastTyping > 8_000) {
        lastTyping = now;
        void channel.sendTyping().catch(() => {});
      }
      if (relay) {
        if (busy || elapsed < 10_000 || now - lastEdit < 15_000) return;
        lastEdit = now;
        busy = true;
        void relay(line)
          .catch(() => {})
          .finally(() => (busy = false));
        return;
      }
      if (!channel || busy || elapsed < 45_000 || now - lastEdit < 20_000) return;
      lastEdit = now;
      busy = true;
      void (status ? status.edit(quiet(line)) : channel.send(quiet(line)).then((m) => (status = m)))
        .catch(() => {})
        .finally(() => (busy = false));
    },
    notice(line) {
      void (relay ? relay(line) : channel?.send(quiet(line)))?.catch(() => {});
    },
    async close() {
      await status?.delete().catch(() => {});
    },
  };
}
