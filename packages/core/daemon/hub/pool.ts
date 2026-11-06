/**
 * Live Claude sessions, one per location (thread, channel, DM, group DM).
 *
 * The worker owns which chat is bound where (`chat_bindings` in SQLite): it
 * binds or creates the chat before a message reaches the daemon, and `/clear`
 * and `/resume` just rebind. The pool reconciles on each message — if the chat
 * bound here isn't the one this location's session holds, that session closes
 * and the bound chat's session opens (resumed when it has one). A chat is live
 * in one place only, so opening it closes it anywhere else first: two
 * processes appending to one transcript would fork it.
 *
 * At most `max` sessions run; the least recently active idle one closes to
 * make room. If every session is mid-turn the cap is exceeded rather than
 * cutting one off. Idle sessions close after `idleMs`; their chat resumes
 * next time.
 */

export interface PoolChat {
  id: string;
  /** SDK session id to resume, if the chat has had a session. */
  backendRef: string | null;
  cwd: string | null;
  title: string;
}

/** What the pool needs from a running session. */
export interface LiveSession {
  readonly chatId: string;
  /** A turn is in flight. */
  busy(): boolean;
  /** Gave up (unrecoverable error) — replace it on the next message. */
  dead(): boolean;
  lastActivityAt(): number;
  push(content: string): void;
  interrupt(): Promise<boolean>;
  compact(announceTo?: string): Promise<void>;
  close(): Promise<void>;
}

export interface PoolDeps {
  /** The chat bound at a location, or null if the worker bound none. */
  boundChat(location: string): PoolChat | null;
  open(location: string, chat: PoolChat): LiveSession;
  max: number;
  idleMs: number;
  log(message: string): void;
  now?: () => number;
}

export class SessionPool {
  readonly sessions = new Map<string, LiveSession>();
  constructor(private readonly deps: PoolDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private async closeAt(location: string, why: string) {
    const s = this.sessions.get(location);
    if (!s) return;
    this.sessions.delete(location);
    this.deps.log(`closing session at ${location} (${why})`);
    await s.close();
  }

  /** Deliver a prompt to the session for `location`, opening it as needed. */
  async deliver(location: string, content: string): Promise<boolean> {
    const chat = this.deps.boundChat(location);
    if (!chat) {
      this.deps.log(`no chat bound at ${location} — message dropped`);
      return false;
    }

    const live = this.sessions.get(location);
    if (live && (live.chatId !== chat.id || live.dead())) {
      await this.closeAt(location, live.dead() ? "dead" : "another chat is bound here now");
    }

    let session = this.sessions.get(location);
    if (!session) {
      for (const [other, s] of this.sessions) {
        if (s.chatId === chat.id) await this.closeAt(other, "its chat moved");
      }
      await this.makeRoom();
      this.deps.log(`opening session for "${chat.title}" at ${location}${chat.backendRef ? " (resume)" : ""}`);
      session = this.deps.open(location, chat);
      this.sessions.set(location, session);
    }
    session.push(content);
    return true;
  }

  private async makeRoom() {
    while (this.sessions.size >= this.deps.max) {
      const idle = [...this.sessions].filter(([, s]) => !s.busy());
      if (!idle.length) {
        this.deps.log(`all ${this.sessions.size} sessions busy — going over the cap of ${this.deps.max}`);
        return;
      }
      idle.sort((a, b) => a[1].lastActivityAt() - b[1].lastActivityAt());
      await this.closeAt(idle[0][0], "making room");
    }
  }

  /** Interrupt the turn in flight at `location`. */
  async stop(location: string): Promise<boolean> {
    return (await this.sessions.get(location)?.interrupt()) ?? false;
  }

  /** Summarise and restart the session at `location` (same chat). */
  async compact(location: string, announceTo?: string): Promise<boolean> {
    const s = this.sessions.get(location);
    if (!s) return false;
    await s.compact(announceTo);
    return true;
  }

  /** The chat here changed (`/clear`, `/resume`): close now; the next message opens the bound one. */
  async release(location: string): Promise<void> {
    const s = this.sessions.get(location);
    const chat = this.deps.boundChat(location);
    if (s && s.chatId !== chat?.id) await this.closeAt(location, "chat changed");
  }

  async evictIdle(): Promise<void> {
    const cutoff = this.now() - this.deps.idleMs;
    for (const [location, s] of [...this.sessions]) {
      if (s.dead() || (!s.busy() && s.lastActivityAt() < cutoff)) await this.closeAt(location, s.dead() ? "dead" : "idle");
    }
  }

  async closeAll(): Promise<void> {
    for (const location of [...this.sessions.keys()]) await this.closeAt(location, "shutdown");
  }
}
