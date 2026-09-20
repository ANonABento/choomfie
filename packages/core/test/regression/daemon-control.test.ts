/**
 * The worker→daemon control channel behind `/compact` and `/clear`.
 *
 * The worker cannot talk to the daemon directly — it sits two processes below
 * it — so a file in the data dir carries the request. These tests guard the
 * three properties that keep that file from misfiring: a malformed file reads
 * as "no request" rather than throwing, an old request is never acted on, and
 * a request is consumed exactly once.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_REQUEST_STALE_MS,
  daemonControlPath,
  isControlRequestStale,
  parseDaemonControlRequest,
} from "@choomfie/shared";
import { requestDaemonControl } from "../../lib/daemon-status.ts";
import { consumeControlRequest } from "../../daemon/control.ts";

const dirs: string[] = [];
function newDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "choomfie-control-"));
  mkdirSync(join(dir, "meta"), { recursive: true });
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("control request parsing", () => {
  test("accepts the two real commands and nothing else", () => {
    const base = { requestedAt: Date.now() };
    expect(parseDaemonControlRequest({ ...base, command: "compact" })?.command).toBe(
      "compact",
    );
    expect(parseDaemonControlRequest({ ...base, command: "clear" })?.command).toBe(
      "clear",
    );

    // A command the daemon has no handler for must not reach cycleSession.
    expect(parseDaemonControlRequest({ ...base, command: "restart" })).toBeNull();
    expect(parseDaemonControlRequest({ ...base, command: "" })).toBeNull();
  });

  test("a half-written or junk file reads as no request", () => {
    // The worker writes atomically, but a reader must still never throw on a
    // file it did not write.
    for (const junk of [null, undefined, 42, "compact", [], {}, { command: "clear" }]) {
      expect(parseDaemonControlRequest(junk)).toBeNull();
    }
  });

  test("drops optional fields that are the wrong type rather than passing them on", () => {
    const parsed = parseDaemonControlRequest({
      command: "compact",
      requestedAt: Date.now(),
      requestedBy: 12345,
      chatId: { id: "nope" },
    });
    expect(parsed?.command).toBe("compact");
    expect(parsed?.requestedBy).toBeUndefined();
    expect(parsed?.chatId).toBeUndefined();
  });
});

describe("staleness", () => {
  test("a request made while the daemon was down is not acted on later", () => {
    // Otherwise a `/compact` from yesterday would cycle a session seconds after
    // it started, for a request nobody remembers making.
    const old = {
      command: "compact" as const,
      requestedAt: Date.now() - CONTROL_REQUEST_STALE_MS - 1,
    };
    expect(isControlRequestStale(old)).toBe(true);

    const fresh = { command: "compact" as const, requestedAt: Date.now() };
    expect(isControlRequestStale(fresh)).toBe(false);
  });
});

describe("worker side", () => {
  test("writes a request the daemon's parser accepts", async () => {
    const dir = newDataDir();
    await requestDaemonControl(dir, "clear", {
      requestedBy: "1234",
      chatId: "5678",
    });

    const parsed = parseDaemonControlRequest(
      JSON.parse(await readFile(daemonControlPath(dir), "utf-8")),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.command).toBe("clear");
    expect(parsed!.requestedBy).toBe("1234");
    expect(parsed!.chatId).toBe("5678");
    expect(isControlRequestStale(parsed!)).toBe(false);
  });

  test("a second request replaces the first rather than queueing", async () => {
    // Pressing /compact then /clear should clear, not compact-then-clear.
    const dir = newDataDir();
    await requestDaemonControl(dir, "compact", {});
    await requestDaemonControl(dir, "clear", {});

    const parsed = parseDaemonControlRequest(
      JSON.parse(await readFile(daemonControlPath(dir), "utf-8")),
    );
    expect(parsed!.command).toBe("clear");
  });
});

describe("daemon side", () => {
  test("no file pending is not an error", async () => {
    const dir = newDataDir();
    expect(await consumeControlRequest(daemonControlPath(dir))).toBeNull();
  });

  test("a request is consumed exactly once", async () => {
    const dir = newDataDir();
    const path = daemonControlPath(dir);
    await requestDaemonControl(dir, "compact", { chatId: "42" });

    const first = await consumeControlRequest(path);
    expect(first?.command).toBe("compact");
    expect(first?.chatId).toBe("42");

    // The file is gone before the caller cycles, so a crash mid-cycle can't
    // replay the request against the session that replaces it.
    expect(existsSync(path)).toBe(false);
    expect(await consumeControlRequest(path)).toBeNull();
  });

  test("garbage is consumed too, not re-read every poll", async () => {
    const dir = newDataDir();
    const path = daemonControlPath(dir);
    writeFileSync(path, "{not json");

    expect(await consumeControlRequest(path)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  test("a stale request is deleted and never returned", async () => {
    const dir = newDataDir();
    const path = daemonControlPath(dir);
    writeFileSync(
      path,
      JSON.stringify({
        command: "clear",
        requestedAt: Date.now() - CONTROL_REQUEST_STALE_MS - 1000,
      }),
    );

    expect(await consumeControlRequest(path)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });
});
