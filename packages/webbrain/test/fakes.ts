/** A browser context and pages that only track open/closed — enough for the tab pool. */

export class FakePage {
  closed = false;
  gotoCalls: string[] = [];
  constructor(readonly n: number) {}
  isClosed() {
    return this.closed;
  }
  async close() {
    this.closed = true;
  }
  async goto(url: string) {
    this.gotoCalls.push(url);
  }
}

export class FakeContext {
  opened: FakePage[] = [];
  closed = false;
  private listeners: Array<() => void> = [];
  constructor(initialPage = true) {
    if (initialPage) this.opened.push(new FakePage(0));
  }
  pages() {
    return this.opened.filter((p) => !p.closed);
  }
  async newPage() {
    const p = new FakePage(this.opened.length);
    this.opened.push(p);
    return p;
  }
  async close() {
    this.closed = true;
    for (const p of this.opened) p.closed = true;
    for (const l of this.listeners) l();
  }
  on(_event: "close", listener: () => void) {
    this.listeners.push(listener);
  }
  get openPages() {
    return this.opened.filter((p) => !p.closed).length;
  }
}

/** A promise you resolve from outside. */
export function gate<T = void>() {
  let open!: (v: T) => void;
  const promise = new Promise<T>((r) => (open = r));
  return { promise, open };
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
