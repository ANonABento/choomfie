import { describe, expect, test } from "bun:test";
import { chatCompletion, classifyFailure, listModels, parseDuration, parseRateHeaders, stripThinking } from "../client.ts";
import { ProviderError } from "../errors.ts";
import { fail, fakeFetch, ok } from "./fakes.ts";

describe("parseDuration", () => {
  test("provider formats", () => {
    expect(parseDuration("2m59.5s")).toBe(179_500);
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("30")).toBe(30_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration(String(10_000 + 5_000), 0)).toBe(15_000_000); // plain seconds
    expect(parseDuration(String(2e12 + 5_000), 2e12)).toBe(5_000); // epoch ms
    expect(parseDuration(undefined)).toBeUndefined();
  });

  test("rate headers", () => {
    const snap = parseRateHeaders(new Headers({ "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "12s", "retry-after": "3" }));
    expect(snap).toEqual({ remainingRequests: 0, resetRequestsMs: 12_000, retryAfterMs: 3_000 });
  });
});

describe("classifyFailure", () => {
  const kind = (status: number, body = "") => classifyFailure(status, body).kind;
  test("maps statuses and bodies to kinds", () => {
    expect(kind(401)).toBe("auth");
    expect(kind(429, "Rate limit reached for requests per minute")).toBe("rate_limit");
    expect(kind(429, "Rate limit exceeded: free-models-per-day")).toBe("quota");
    expect(kind(429, "Request too large for model: tokens per minute (TPM) limit")).toBe("rate_limit");
    expect(kind(400, "The model `llama3-8b` has been decommissioned")).toBe("model_gone");
    expect(kind(404)).toBe("model_gone");
    expect(kind(400, "This model's maximum context length is 8192 tokens")).toBe("too_large");
    expect(kind(503)).toBe("server");
    expect(kind(402, "Insufficient credits")).toBe("quota");
    expect(kind(400, "temperature must be <= 2")).toBe("bad_request");
  });

  test("retry-after rides along on rate limits", () => {
    expect(classifyFailure(429, "", { retryAfterMs: 7_000 }).retryAfterMs).toBe(7_000);
  });
});

describe("chatCompletion", () => {
  test("posts an OpenAI request and reads the answer", async () => {
    const f = fakeFetch(() => ok("<think>hmm</think>Hello!", {}, { "x-ratelimit-remaining-requests": "9" }));
    const r = await chatCompletion({ baseURL: "https://x/v1", apiKey: "k", model: "m1", messages: [{ role: "user", content: "hi" }], maxTokens: 50 }, f);
    expect(r.text).toBe("Hello!");
    expect(r.usage).toEqual({ prompt: 10, completion: 5 });
    expect(r.rate.remainingRequests).toBe(9);
    expect(f.calls[0].url).toBe("https://x/v1/chat/completions");
    expect(f.calls[0].auth).toBe("Bearer k");
    expect(f.calls[0].body).toMatchObject({ model: "m1", max_tokens: 50, stream: false });
  });

  test("an error inside a 200 is still an error", async () => {
    const f = fakeFetch(() => new Response(JSON.stringify({ error: { code: 429, message: "Rate limit exceeded" } })));
    const e = await chatCompletion({ baseURL: "u", model: "m", messages: [] }, f).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.kind).toBe("rate_limit");
  });

  test("network failures and timeouts are typed", async () => {
    const boom = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect((await chatCompletion({ baseURL: "u", model: "m", messages: [] }, boom).catch((x) => x)).kind).toBe("network");
    const slow = fakeFetch(() => new Promise<Response>(() => {}));
    const hang = (async (url: string, init?: RequestInit) => {
      await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
      return slow(url, init);
    }) as typeof fetch;
    expect((await chatCompletion({ baseURL: "u", model: "m", messages: [], timeoutMs: 20 }, hang).catch((x) => x)).kind).toBe("timeout");
  });

  test("4xx bodies are classified", async () => {
    const f = fakeFetch(() => fail(401, "invalid api key"));
    expect((await chatCompletion({ baseURL: "u", model: "m", messages: [] }, f).catch((x) => x)).kind).toBe("auth");
  });
});

test("listModels reads OpenAI and Gemini shapes", async () => {
  const f = fakeFetch(() =>
    new Response(JSON.stringify({ data: [{ id: "a:free", pricing: { prompt: "0", completion: "0" }, context_length: 1000 }, { id: "models/gemini-x" }] }))
  );
  expect(await listModels("u", "k", undefined, f)).toEqual([
    { id: "a:free", pricing: { prompt: 0, completion: 0 }, contextLength: 1000 },
    { id: "gemini-x" },
  ]);
});

test("stripThinking", () => {
  expect(stripThinking("<think>\nplan\n</think>\n\nAnswer")).toBe("Answer");
});
