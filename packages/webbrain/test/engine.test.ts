import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineFor, profileName } from "../engine/launch.ts";
import { profileDir } from "../paths.ts";
import { rowsFrom } from "../detect.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const dataDir = () => {
  const d = mkdtempSync(join(tmpdir(), "engine-"));
  dirs.push(d);
  return d;
};

describe("engine choice", () => {
  test("config.json wins, then the adapter, then patchright; junk is ignored", () => {
    const d = dataDir();
    expect(engineFor(d, { id: "gemini" })).toBe("patchright");
    expect(engineFor(d, { id: "gemini", engine: "cloak" })).toBe("cloak");
    writeFileSync(join(d, "config.json"), JSON.stringify({ webbrain: { gemini: { engine: "cloak" }, waymond: { engine: "firefox" } } }));
    expect(engineFor(d, { id: "gemini" })).toBe("cloak");
    expect(engineFor(d, { id: "waymond" })).toBe("patchright");
  });

  test("each engine keeps its own profile; patchright keeps the original folder", () => {
    const d = dataDir();
    expect(profileName()).toBe("profile");
    expect(profileDir(d, "w").endsWith("/webbrain/w/profile")).toBe(true);
    expect(profileDir(d, "w", "cloak").endsWith("/webbrain/w/profile-cloak")).toBe(true);
  });
});

describe("detect rows", () => {
  const clean = {
    webdriver: false,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    platform: "MacIntel",
    chPlatform: "macOS",
    chBrands: "Chromium, Google Chrome",
    plugins: 5,
    languages: "en-US",
    hasChrome: true,
    outer: "1200x800",
    gpu: "ANGLE (Apple, ANGLE Metal Renderer: Apple M5)",
    permissionsConsistent: true,
    timezone: "America/Los_Angeles",
  };
  test("a clean browser has no tells", () => {
    expect(rowsFrom(clean).filter((r) => !r.ok)).toEqual([]);
  });
  test("the usual headless tells are caught", () => {
    const bad = rowsFrom({
      ...clean,
      webdriver: true,
      userAgent: clean.userAgent.replace("Chrome/", "HeadlessChrome/"),
      chPlatform: "Linux",
      gpu: "Google SwiftShader",
      plugins: 0,
      outer: "0x0",
      permissionsConsistent: false,
    });
    expect(bad.filter((r) => !r.ok).map((r) => r.check)).toEqual([
      "navigator.webdriver",
      "user agent",
      "UA platform vs client hints",
      "GPU",
      "plugins",
      "outer window",
      "notification permission",
    ]);
  });
});
