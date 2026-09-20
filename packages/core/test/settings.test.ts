/**
 * Tests for the adjustable-settings registry behind `/config`.
 *
 * The registry exists because ConfigManager's setters had no callers for a long
 * time — settings were only changeable by hand-editing config.json. These tests
 * guard the two properties that made that possible: every declared setting is
 * actually wired to the config, and a bad value is rejected rather than stored.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigManager } from "../lib/config.ts";
import { SETTINGS, findSetting } from "../lib/settings.ts";

const dirs: string[] = [];
function newConfig(): { config: ConfigManager; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "choomfie-settings-"));
  dirs.push(dir);
  return { config: new ConfigManager(dir), dir };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("settings registry", () => {
  test("every setting reads a real value and has a unique key", () => {
    const { config } = newConfig();
    const keys = SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThan(0);

    for (const setting of SETTINGS) {
      expect(setting.read(config)).toBeString();
      expect(setting.read(config).length).toBeGreaterThan(0);
      expect(setting.description.length).toBeGreaterThan(0);
      expect(setting.example.length).toBeGreaterThan(0);
    }
  });

  test("Discord's 25-choice cap on a slash command option is respected", () => {
    expect(SETTINGS.length).toBeLessThanOrEqual(25);
  });

  test("findSetting is case-insensitive and rejects unknown keys", () => {
    expect(findSetting("rateLimitMs")?.key).toBe("rateLimitMs");
    expect(findSetting("RATELIMITMS")?.key).toBe("rateLimitMs");
    expect(findSetting("  daemon.model  ")?.key).toBe("daemon.model");
    expect(findSetting("nope")).toBeUndefined();
  });

  test("every write is persisted to config.json, not just held in memory", () => {
    // The whole point: a setting changed from Discord must survive a restart.
    const { config, dir } = newConfig();
    findSetting("rateLimitMs")!.write(config, "12s");
    findSetting("daemon.turnThreshold")!.write(config, "42");

    const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"));
    expect(onDisk.rateLimitMs).toBe(12_000);
    expect(onDisk.daemon.turnThreshold).toBe(42);

    const reloaded = new ConfigManager(dir);
    expect(reloaded.getRateLimitMs()).toBe(12_000);
    expect(reloaded.getDaemonConfig().turnThreshold).toBe(42);
  });
});

describe("duration settings", () => {
  test("accepts bare milliseconds and suffixed durations", () => {
    const { config } = newConfig();
    const rateLimit = findSetting("rateLimitMs")!;

    expect(rateLimit.write(config, "3000").ok).toBe(true);
    expect(config.getRateLimitMs()).toBe(3000);

    expect(rateLimit.write(config, "8s").ok).toBe(true);
    expect(config.getRateLimitMs()).toBe(8000);

    expect(rateLimit.write(config, "2m").ok).toBe(true);
    expect(config.getRateLimitMs()).toBe(120_000);
  });

  test("rejects junk and out-of-range values without writing", () => {
    const { config } = newConfig();
    const rateLimit = findSetting("rateLimitMs")!;
    rateLimit.write(config, "5s");

    for (const bad of ["soon", "-5", "5 seconds", "1e9", ""]) {
      expect(rateLimit.write(config, bad).ok).toBe(false);
    }
    // An hour-long per-user cooldown is a typo, not a preference.
    expect(rateLimit.write(config, "1h").ok).toBe(false);

    // None of the rejects changed anything.
    expect(config.getRateLimitMs()).toBe(5000);
  });

  test("formats durations back in the unit they were given", () => {
    const { config } = newConfig();
    const rateLimit = findSetting("rateLimitMs")!;
    expect(rateLimit.write(config, "8s").value).toBe("8s");
    expect(rateLimit.write(config, "2m").value).toBe("2m");
    expect(rateLimit.write(config, "1500").value).toBe("1500ms");
    expect(rateLimit.write(config, "0").value).toBe("0ms (off)");
  });
});

describe("model settings", () => {
  test("stores an alias or a full model id", () => {
    const { config } = newConfig();
    const model = findSetting("daemon.model")!;

    expect(model.write(config, "opus").ok).toBe(true);
    expect(config.getDaemonConfig().model).toBe("opus");

    expect(model.write(config, "claude-opus-5").ok).toBe(true);
    expect(config.getDaemonConfig().model).toBe("claude-opus-5");
  });

  test("`default` clears it back to Claude Code's own default", () => {
    const { config, dir } = newConfig();
    const model = findSetting("daemon.model")!;
    model.write(config, "haiku");

    expect(model.write(config, "default").ok).toBe(true);
    expect(config.getDaemonConfig().model).toBeUndefined();
    expect(model.read(config)).toBe("Claude Code default");

    // An unset model must be absent from the file, not written as null —
    // createSession omits the SDK option entirely when it is undefined.
    const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"));
    expect("model" in onDisk.daemon).toBe(false);
  });

  test("rejects values that cannot be a model id", () => {
    const { config } = newConfig();
    const model = findSetting("daemon.model")!;
    expect(model.write(config, "claude opus 5").ok).toBe(false);
    expect(model.write(config, "  ").ok).toBe(false);
    expect(model.write(config, "x".repeat(200)).ok).toBe(false);
    expect(config.getDaemonConfig().model).toBeUndefined();
  });
});

describe("count settings", () => {
  test("accepts digit grouping and rejects out-of-range values", () => {
    const { config } = newConfig();
    const tokens = findSetting("daemon.tokenThreshold")!;

    expect(tokens.write(config, "200,000").ok).toBe(true);
    expect(config.getDaemonConfig().tokenThreshold).toBe(200_000);

    // Below the floor a session would cycle before it could do anything.
    expect(tokens.write(config, "500").ok).toBe(false);
    expect(config.getDaemonConfig().tokenThreshold).toBe(200_000);
  });

  test("`default` restores the shipped threshold", () => {
    const { config } = newConfig();
    const turns = findSetting("daemon.turnThreshold")!;
    turns.write(config, "10");
    expect(turns.write(config, "default").ok).toBe(true);
    expect(config.getDaemonConfig().turnThreshold).toBe(80);
  });
});
