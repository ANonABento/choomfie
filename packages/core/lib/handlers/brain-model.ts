/**
 * `/model` for a brain other than Claude: each brain lists its own models
 * (`Brain.models()`), and the pick is stored on the chat here, like Claude's
 * per-chat model. No command registration, so tests can import it.
 */

import { getBrain } from "@choomfie/shared";
import type { AppContext } from "../types.ts";

/** `/model` in a chat answered by a brain other than Claude: show or set the chat's model. */
export function brainModelReply(ctx: Pick<AppContext, "chats">, locationId: string, brainId: string, requested: string | null): string {
  const brain = getBrain(brainId);
  if (!brain) return `The \`${brainId}\` brain isn't loaded right now.`;
  const models = brain.models?.() ?? [];
  if (!models.length) return `**${brain.label}** picks its own model — there's nothing to choose here.`;
  const fallback = models[0].id;
  if (requested === null) {
    const chat = ctx.chats.bound(locationId, brainId);
    return (
      (chat?.model ? `This chat runs on **${chat.model}** (default: ${fallback}).` : `This chat runs on **${fallback}** (the default).`) +
      `\n\`/model <name>\` picks another; autocomplete lists what ${brain.label} has.`
    );
  }
  const want = requested.trim().toLowerCase();
  const match = want === "default" ? models[0] : models.find((m) => m.id.toLowerCase() === want);
  if (!match) {
    const some = models.slice(0, 8).map((m) => `\`${m.id}\``).join(", ");
    return `${brain.label} has no model \`${requested.trim()}\`. Some it has: ${some}${models.length > 8 ? ", …" : ""}`;
  }
  // An untitled chat if nobody has spoken here yet; the first message names it.
  const chat = ctx.chats.current(locationId, brainId);
  const isDefault = match.id === fallback;
  ctx.chats.setModel(chat.id, isDefault ? null : match.id);
  return isDefault
    ? `This chat is back on the default (**${fallback}**) from your next message, with its history kept.`
    : `This chat now runs on **${match.id}** from your next message, with its history kept.`;
}
