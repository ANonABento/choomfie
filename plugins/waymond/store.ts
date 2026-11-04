/** Discord chat key (channel/thread id) → Waymond conversation id. */

import { readFileSync } from "node:fs";
import { writeJsonAtomicSync } from "@choomfie/shared";

export class ChatMap {
  private map: Record<string, string> = {};

  constructor(private path: string) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      if (raw && typeof raw === "object") this.map = raw;
    } catch {
      // First run or unreadable — start empty.
    }
  }

  get(chatKey: string): string | undefined {
    return this.map[chatKey];
  }

  set(chatKey: string, conversationId: string) {
    this.map[chatKey] = conversationId;
    writeJsonAtomicSync(this.path, this.map);
  }

  delete(chatKey: string) {
    if (!(chatKey in this.map)) return;
    delete this.map[chatKey];
    writeJsonAtomicSync(this.path, this.map);
  }
}
