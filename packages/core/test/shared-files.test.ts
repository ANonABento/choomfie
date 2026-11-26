import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeName, shareFile, sharedFilePath, sweepSharedFiles } from "@choomfie/shared";
import { parseRemoteMcpConfig, serveSharedFile } from "../lib/remote-mcp.ts";
import { postBrainReply, setFileLinks } from "../lib/brain-router.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "shared-files-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  setFileLinks(null);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("shared files", () => {
  test("a shared file is found by its token and name until it expires, then swept", () => {
    const dir = tmp();
    const { urlPath, expiresAt } = shareFile(dir, { name: "song.mp4", data: new Uint8Array([1, 2]) }, 1000, 0);
    const [, token, name] = urlPath.split("/");
    expect(token).toMatch(/^[\w-]{32}$/);
    expect(sharedFilePath(dir, token, name, 500)).toBeTruthy();
    expect(sharedFilePath(dir, token, "other.mp4", 500)).toBeNull();
    expect(sharedFilePath(dir, "x".repeat(32), name, 500)).toBeNull();
    expect(sharedFilePath(dir, token, name, expiresAt + 1)).toBeNull();
    expect(sweepSharedFiles(dir, expiresAt + 1)).toBe(1);
    expect(existsSync(join(dir, "shared-files", token))).toBe(false);
  });

  test("names can't climb out of their folder", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("my song (final).mp4")).toBe("my_song_final_.mp4");
    expect(safeName("..")).toBe("file");
  });

  test("the endpoint serves /f/<token>/<name> with no bearer, and 404s anything else", async () => {
    const dir = tmp();
    const { urlPath } = shareFile(dir, { name: "clip.mp4", data: new Uint8Array([7, 8, 9]) });
    const ok = serveSharedFile(new Request(`http://x/${urlPath}`), dir)!;
    expect(ok.status).toBe(200);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]));
    expect(serveSharedFile(new Request(`http://x/f/${"a".repeat(32)}/clip.mp4`), dir)!.status).toBe(404);
    expect(serveSharedFile(new Request("http://x/mcp"), dir)).toBeNull();
  });

  test("publicUrl must be https; trailing slash dropped", () => {
    expect(parseRemoteMcpConfig({ publicUrl: "https://mac.tail.ts.net/" }).publicUrl).toBe("https://mac.tail.ts.net");
    expect(parseRemoteMcpConfig({ publicUrl: "http://mac" }).publicUrl).toBeUndefined();
  });

  test("a reply's file too big for Discord becomes a link when links are on", async () => {
    const dir = tmp();
    setFileLinks({ dataDir: dir, base: "https://mac.tail.ts.net" });
    const sent: { content?: string; files?: unknown[] }[] = [];
    const channel = { send: async (o: (typeof sent)[number]) => (sent.push(o), { id: "m" }) };
    await postBrainReply(channel, "gemini-web", "c1", { text: "here", files: [{ name: "dump.zip", data: new Uint8Array(11 * 1024 * 1024) }] });
    expect(sent[0].content).toMatch(/📎 dump\.zip \(11\.0 MB, too big for Discord\): https:\/\/mac\.tail\.ts\.net\/f\/[\w-]{32}\/dump\.zip/);
    expect(sent.flatMap((m) => m.files ?? [])).toHaveLength(0);
  });
});
