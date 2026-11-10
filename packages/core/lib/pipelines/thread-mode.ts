/**
 * A thread put on a pipeline (`/pipeline <name>`): its brain, Claude or
 * another, is told once per chat what the thread is for and which tool runs
 * it. Nothing is added anywhere else, so chats that never use a pipeline pay
 * nothing for it (the tool itself is deferred: only its name is listed).
 *
 * Told again when the thread starts a new chat (`/new`, `/resume`), since that
 * session hasn't seen it.
 */

import type { PipelineConfig } from "./config.ts";
import type { AppContext } from "../types.ts";

/**
 * Worded for a brain that rightly ignores instructions it can't trace to the
 * user (Waymond did, to "From Choomfie (not the user)"): it says the owner set
 * this up and how.
 *
 * - Claude, on this machine, may run the tool itself: the note names it and
 *   carries the chat_id.
 * - A brain elsewhere (Waymond) doesn't: its tool calls wait for an approval
 *   that ends its turn, so it never saw a result and couldn't follow the steps.
 *   The owner runs the steps with the step cards' buttons; that brain draws.
 */
export function pipelineNoteText(p: PipelineConfig, chatId: string, remote = false): string {
  const intro = `[Choomfie, the bot relaying this Discord thread: the owner ran /pipeline ${p.name} here, so this thread is for ` +
    `the ${p.name} pipeline on their Mac.${p.about ? ` ${p.about}` : ""}`;
  if (remote) {
    return (
      `${intro} Choomfie posts each step here with buttons, and the owner runs the steps by clicking them: don't call the ` +
      `pipeline tool or ask for commands. Your part is the creative work: when asked to design or draw a character, post the ` +
      `pictures in your reply, and the owner hands them over with a button.]`
    );
  }
  return (
    `${intro} Choomfie posts each step here with buttons the owner can click. To run a step for them, use the \`pipeline\` ` +
    `tool on the choomfie connector with action "run", pipeline "${p.name}" and chat_id "${chatId}"; follow each result's ` +
    `next step, and show the user its pictures and choices before going on.]`
  );
}

/**
 * The note for this location's chat if it's on a pipeline and this chat hasn't been told. Marks it told.
 * `remote`: the brain isn't Claude on this machine (see pipelineNoteText).
 */
export function pipelineNote(ctx: AppContext, location: string, chatId: string, remote = false): string | undefined {
  const at = ctx.chats.pipelineAt(location);
  if (!at || at.toldChat === chatId) return undefined;
  const p = ctx.config.getPipelines().get(at.pipeline);
  if (!p) return undefined;
  ctx.chats.markPipelineTold(location, chatId);
  return pipelineNoteText(p, location, remote);
}
