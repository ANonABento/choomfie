/**
 * Notes from Choomfie for a chat's next message: things that happened while
 * the brain wasn't looking (a pipeline job finished, …). Whichever brain
 * answers the chat next, Claude or another, gets them appended to that message,
 * so it knows without polling.
 *
 * In memory: a restart drops notes that weren't delivered yet.
 */

const MAX_NOTES = 10;
const notes = new Map<string, string[]>();

export function addChatNote(chatKey: string, note: string): void {
  const list = [...(notes.get(chatKey) ?? []), note].slice(-MAX_NOTES);
  notes.set(chatKey, list);
}

/** The chat's notes as one block (and forget them), or undefined when there are none. */
export function takeChatNotes(chatKey: string): string | undefined {
  const list = notes.get(chatKey);
  if (!list?.length) return undefined;
  notes.delete(chatKey);
  return ["[From Choomfie (not the user), since your last message:", ...list.map((n) => `- ${n}`), "]"].join("\n");
}
