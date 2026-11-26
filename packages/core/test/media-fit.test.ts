import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFfmpeg, fitFile, fitForDiscord, parseDuration, videoBitrates } from "@choomfie/shared";

describe("media fit: the arithmetic", () => {
  test("reads ffmpeg's Duration line", () => {
    expect(parseDuration("  Duration: 00:02:35.93, start: 0.000000, bitrate: 403 kb/s")).toBeCloseTo(155.93);
    expect(parseDuration("no duration here")).toBeNull();
  });

  test("bitrates fit the size; too long to watch is null", () => {
    const r = videoBitrates(60, 9 * 1024 * 1024)!;
    expect(((r.video + r.audio) * 1000 * 60) / 8).toBeLessThan(9 * 1024 * 1024);
    expect(r.height).toBe(720);
    expect(videoBitrates(3600, 9 * 1024 * 1024)).toBeNull();
  });
});

describe("media fit: files", () => {
  test("under the limit is untouched; an unknown kind over it is dropped with a note", async () => {
    const small = { name: "a.zip", data: new Uint8Array(10) };
    expect((await fitFile(small, 100)).file).toBe(small);
    const r = await fitForDiscord([small, { name: "b.zip", data: new Uint8Array(200) }], 100);
    expect(r.files).toEqual([small]);
    expect(r.dropped.map((d) => d.file.name)).toEqual(["b.zip"]);
    expect(r.dropped[0].note).toContain("b.zip is too big for Discord");
  });

  test.skipIf(!findFfmpeg())("a song over the limit is sent as audio only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fit-test-"));
    try {
      const src = join(dir, "song.mp4");
      const p = Bun.spawn([findFfmpeg()!, "-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "8", "-c:v", "libx264", "-b:v", "2000k", "-c:a", "aac", "-b:a", "192k", src], { stdout: "ignore", stderr: "ignore" });
      await p.exited;
      const data = new Uint8Array(readFileSync(src));
      const limit = Math.floor(data.length / 2);
      const r = await fitFile({ name: "gemini-song-1.mp4", data }, limit);
      expect(r.file?.name).toBe("gemini-song-1.m4a");
      expect(r.file!.data.length).toBeLessThanOrEqual(limit);
      expect(r.note).toContain("audio only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
