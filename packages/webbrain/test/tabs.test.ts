import { describe, expect, test } from "bun:test";
import { TabPool } from "../tabs.ts";
import { FakeContext, FakePage, gate, tick } from "./fakes.ts";

function pool(maxTabs = 3, idleCloseMs = 60_000) {
  const contexts: FakeContext[] = [];
  const p = new TabPool<FakePage>({
    launch: async () => {
      const c = new FakeContext();
      contexts.push(c);
      return c;
    },
    maxTabs,
    idleCloseMs,
  });
  return { p, contexts };
}

describe("TabPool", () => {
  test("work for the same chat runs one at a time, in order", async () => {
    const { p } = pool();
    const order: string[] = [];
    const g = gate();
    const a = p.run("chat", async () => {
      order.push("a start");
      await g.promise;
      order.push("a end");
    });
    const b = p.run("chat", async () => void order.push("b"));
    await tick();
    expect(order).toEqual(["a start"]);
    g.open();
    await Promise.all([a, b]);
    expect(order).toEqual(["a start", "a end", "b"]);
  });

  test("different chats run side by side, in their own tabs", async () => {
    const { p, contexts } = pool();
    const g = gate();
    const running = new Set<string>();
    let maxTogether = 0;
    const job = (key: string) =>
      p.run(key, async (page) => {
        running.add(key);
        maxTogether = Math.max(maxTogether, running.size);
        await g.promise;
        running.delete(key);
        return page;
      });
    const both = Promise.all([job("a"), job("b")]);
    await tick();
    await tick();
    g.open();
    const [pa, pb] = await both;
    expect(maxTogether).toBe(2);
    expect(pa).not.toBe(pb);
    expect(contexts.length).toBe(1);
  });

  test("a chat keeps its tab between turns", async () => {
    const { p } = pool();
    const first = await p.run("a", async (page) => page);
    const second = await p.run("a", async (page) => page);
    expect(second).toBe(first);
  });

  test("never more than maxTabs; an extra chat waits for a busy one to finish", async () => {
    const { p, contexts } = pool(2);
    const g = gate();
    const started: string[] = [];
    const job = (key: string) =>
      p.run(key, async () => {
        started.push(key);
        await g.promise;
      });
    const all = Promise.all([job("a"), job("b"), job("c")]);
    await tick();
    await tick();
    expect(started.sort()).toEqual(["a", "b"]);
    expect(contexts[0].openPages).toBeLessThanOrEqual(2);
    g.open();
    await all;
    expect(started).toContain("c");
    expect(contexts[0].openPages).toBeLessThanOrEqual(2);
  });

  test("a new chat takes the least recently used idle tab", async () => {
    const { p } = pool(1);
    const pa = await p.run("a", async (page) => page);
    const pb = await p.run("b", async (page) => page);
    expect(pa.isClosed()).toBe(true);
    expect(pb.isClosed()).toBe(false);
  });

  test("an error releases the tab", async () => {
    const { p } = pool(1);
    await expect(p.run("a", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await p.run("b", async () => "ok")).toBe("ok");
  });

  test("the browser is launched once, however many chats start together", async () => {
    const { p, contexts } = pool();
    await Promise.all(["a", "b", "c"].map((k) => p.run(k, async () => {})));
    expect(contexts.length).toBe(1);
  });

  test("closes the browser after going idle, and relaunches on the next turn", async () => {
    const { p, contexts } = pool(3, 20);
    await p.run("a", async () => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(contexts[0].closed).toBe(true);
    await p.run("a", async () => {});
    expect(contexts.length).toBe(2);
  });

  test("peek finds a chat's open tab only", async () => {
    const { p } = pool();
    expect(p.peek("a")).toBeUndefined();
    const page = await p.run("a", async (pg) => pg);
    expect(p.peek("a")).toBe(page);
  });
});
