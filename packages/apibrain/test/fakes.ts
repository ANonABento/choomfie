import type { FetchLike } from "../client.ts";

export interface FakeCall {
  url: string;
  body: Record<string, unknown> | null;
  auth: string | null;
}

/** A fetch that answers from a queue (or a function), recording each request. */
export function fakeFetch(answer: (call: FakeCall, n: number) => Response | Promise<Response>): FetchLike & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call = { url, body: init?.body ? JSON.parse(String(init.body)) : null, auth: headers.get("authorization") };
    calls.push(call);
    return answer(call, calls.length - 1);
  }) as FetchLike & { calls: FakeCall[] };
  f.calls = calls;
  return f;
}

export const ok = (text: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ model: "m", choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, ...extra }), {
    status: 200,
    headers,
  });

export const fail = (status: number, body = "", headers: Record<string, string> = {}) => new Response(body, { status, headers });
