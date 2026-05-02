import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatGeneratedImageMessage, generateImage } from "../lib/image-generation.ts";

let tempDir: string | null = null;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
const originalFetch = globalThis.fetch;

afterEach(async () => {
  process.env.OPENAI_API_KEY = originalOpenAiKey;
  process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  globalThis.fetch = originalFetch;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

test("generateImage writes a local SVG fallback when image APIs are not configured", async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  tempDir = await mkdtemp(join(tmpdir(), "choomfie-image-test-"));

  const result = await generateImage("a cozy desk with a tiny robot lamp", tempDir);

  expect(result.provider).toBe("local-svg");
  expect(result.fallbackReason).toContain("OPENAI_API_KEY");
  expect(result.filePath.endsWith(".svg")).toBe(true);
  expect(result.filePath.startsWith(join(tempDir, "inbox"))).toBe(true);
  expect(existsSync(result.filePath)).toBe(true);

  const content = await readFile(result.filePath, "utf-8");
  expect(content).toContain("<svg");
  expect(content).toContain("a cozy desk");
  expect(formatGeneratedImageMessage(result)).toContain("Fallback render used because");
});

test("generateImage writes OpenAI image bytes when the API returns base64 data", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.ANTHROPIC_API_KEY;
  tempDir = await mkdtemp(join(tmpdir(), "choomfie-image-test-"));
  const imageBytes = Buffer.from("fake-png-bytes");
  const calls: unknown[] = [];

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify({
      data: [{ b64_json: imageBytes.toString("base64") }],
    }), { status: 200 });
  }) as typeof fetch;

  const result = await generateImage("a neon synth desk", tempDir);

  expect(result.provider).toBe("openai");
  expect(result.fallbackReason).toBeUndefined();
  expect(result.filePath.endsWith(".png")).toBe(true);
  expect(await readFile(result.filePath)).toEqual(imageBytes);
  expect(calls).toEqual([
    {
      model: "gpt-image-1",
      prompt: "a neon synth desk",
      size: "1024x1024",
      n: 1,
    },
  ]);
});

test("generateImage uses unique inbox names for simultaneous same-prompt calls", async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  tempDir = await mkdtemp(join(tmpdir(), "choomfie-image-test-"));

  const [first, second] = await Promise.all([
    generateImage("same prompt", tempDir),
    generateImage("same prompt", tempDir),
  ]);

  expect(first.filePath).not.toBe(second.filePath);
  expect(existsSync(first.filePath)).toBe(true);
  expect(existsSync(second.filePath)).toBe(true);
});
