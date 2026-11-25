import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAdapters, landedInChat, needsLogin, siteStatus } from "../sites.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "webbrain-sites-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const fake = (id: string) => ({ id, label: id, loginUrl: "https://x", chatUrl: () => "https://app.example/chat/new", turn: async () => ({ text: "", ref: "" }) });

describe("webbrain sites", () => {
  test("only plugins that export an adapter are imported", async () => {
    const plugins = tmp();
    for (const [id, src] of [
      ["site", 'export { siteAdapter as adapter } from "./adapter.ts";'],
      ["voice", "export default {};"],
    ]) {
      mkdirSync(join(plugins, id));
      writeFileSync(join(plugins, id, "index.ts"), src);
    }
    const loaded: string[] = [];
    const found = await discoverAdapters(plugins, async (id) => (loaded.push(id), { adapter: fake(id) }));
    expect(loaded).toEqual(["site"]);
    expect(found.map((a) => a.id)).toEqual(["site"]);
  });

  test("logged in = the chat URL kept us in the app's chat", () => {
    const a = fake("x");
    expect(landedInChat(a, "https://app.example/chat/abc")).toBe(true);
    expect(landedInChat(a, "https://app.example/login?next=/chat")).toBe(false);
    expect(landedInChat(a, "https://auth.example/chat")).toBe(false);
  });

  test("a profile never created needs a login, without opening a browser", async () => {
    const s = await siteStatus(tmp(), fake("x") as never);
    expect(s.state).toBe("never");
    expect(needsLogin(s)).toBe(true);
  });
});
