/**
 * Tab pool — one logged-in browser per site, one tab per chat.
 *
 * Work for the same chat runs one at a time (a conversation can't take two
 * messages at once); different chats run side by side, each in its own tab,
 * all sharing the profile's cookies. Before this, one page and one global
 * lock meant a 10-minute task in one channel held up every other channel.
 *
 * Bounded: at most `maxTabs` tabs (each is a renderer, ~hundreds of MB). A new
 * chat takes an idle chat's tab (least recently used); if every tab is busy it
 * waits. The whole browser closes after `idleCloseMs` with nothing running.
 *
 * Generic over the page type so it can be tested without a browser.
 */

export interface PageLike {
  isClosed(): boolean;
  close(): Promise<void>;
}

export interface ContextLike<P extends PageLike> {
  pages(): P[];
  newPage(): Promise<P>;
  close(): Promise<void>;
  on(event: "close", listener: () => void): unknown;
}

export interface TabPoolOptions<P extends PageLike> {
  launch(): Promise<ContextLike<P>>;
  maxTabs?: number;
  idleCloseMs?: number;
}

interface Tab<P> {
  page: P;
  busy: boolean;
  lastUsed: number;
}

export class TabPool<P extends PageLike> {
  private context: ContextLike<P> | null = null;
  private launching: Promise<ContextLike<P>> | null = null;
  private tabs = new Map<string, Tab<P>>();
  /** Per-key promise tails: same key runs in order. */
  private queues = new Map<string, Promise<unknown>>();
  private waiters: Array<() => void> = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  readonly maxTabs: number;
  private readonly idleCloseMs: number;

  constructor(private opts: TabPoolOptions<P>) {
    this.maxTabs = Math.max(1, opts.maxTabs ?? 3);
    this.idleCloseMs = opts.idleCloseMs ?? 10 * 60_000;
  }

  /** Run `fn` on `key`'s tab, after any earlier work for the same key. */
  run<T>(key: string, fn: (page: P) => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const job = prev.then(async () => {
      const page = await this.acquire(key);
      try {
        return await fn(page);
      } finally {
        this.release(key);
      }
    });
    const tail = job.catch(() => {});
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return job;
  }

  /** `key`'s tab if it is open — for a stop that must reach a turn in flight. */
  peek(key: string): P | undefined {
    const tab = this.tabs.get(key);
    return tab && !tab.page.isClosed() ? tab.page : undefined;
  }

  get openTabs(): number {
    return this.tabs.size;
  }

  async close(): Promise<void> {
    this.clearIdle();
    const ctx = this.context;
    this.context = null;
    this.launching = null;
    this.tabs.clear();
    await ctx?.close().catch(() => {});
  }

  private async acquire(key: string): Promise<P> {
    this.clearIdle();
    const existing = this.tabs.get(key);
    if (existing && !existing.page.isClosed()) {
      existing.busy = true;
      return existing.page;
    }
    this.tabs.delete(key);

    // Make room: evict the least recently used idle tab, or wait for one.
    while (this.tabs.size >= this.maxTabs) {
      const idle = [...this.tabs.entries()].filter(([, t]) => !t.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (idle) {
        this.tabs.delete(idle[0]);
        await idle[1].page.close().catch(() => {});
      } else {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
    }

    // Reserve the slot before awaiting anything else, so concurrent acquires can't overshoot.
    const tab: Tab<P> = { page: null as unknown as P, busy: true, lastUsed: Date.now() };
    this.tabs.set(key, tab);
    try {
      const ctx = await this.ensureContext();
      const owned = new Set([...this.tabs.values()].map((t) => t.page));
      // A fresh persistent context opens with one blank page: use it.
      tab.page = ctx.pages().find((p) => !p.isClosed() && !owned.has(p)) ?? (await ctx.newPage());
      return tab.page;
    } catch (e) {
      this.tabs.delete(key);
      this.wakeOne();
      throw e;
    }
  }

  private release(key: string) {
    const tab = this.tabs.get(key);
    if (tab) {
      tab.busy = false;
      tab.lastUsed = Date.now();
      if (tab.page?.isClosed()) this.tabs.delete(key);
    }
    this.wakeOne();
    if (![...this.tabs.values()].some((t) => t.busy)) this.scheduleIdle();
  }

  private wakeOne() {
    this.waiters.shift()?.();
  }

  private async ensureContext(): Promise<ContextLike<P>> {
    if (this.context) return this.context;
    this.launching ??= this.opts.launch().then((ctx) => {
      this.context = ctx;
      this.launching = null;
      ctx.on("close", () => {
        if (this.context !== ctx) return;
        this.context = null;
        this.tabs.clear();
      });
      return ctx;
    });
    try {
      return await this.launching;
    } catch (e) {
      this.launching = null;
      throw e;
    }
  }

  private scheduleIdle() {
    this.clearIdle();
    this.idleTimer = setTimeout(() => void this.close(), this.idleCloseMs);
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
