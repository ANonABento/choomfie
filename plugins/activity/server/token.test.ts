import { describe, expect, test } from "bun:test";
import { discordTokenVerifier, handleTokenRequest } from "./token.ts";

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}

const post = (body: unknown) =>
  new Request("http://x/api/token", { method: "POST", body: JSON.stringify(body) });

describe("token exchange", () => {
  test("code is exchanged server-side with the client secret", async () => {
    let sent: URLSearchParams | null = null;
    const oauth = {
      clientId: "app",
      clientSecret: "shh",
      fetch: fakeFetch((url, init) => {
        expect(url).toBe("https://discord.com/api/oauth2/token");
        sent = init!.body as URLSearchParams;
        return Response.json({ access_token: "at" });
      }),
    };
    const res = await handleTokenRequest(post({ code: "c1" }), oauth);
    expect(await res.json()).toEqual({ access_token: "at" });
    expect(sent!.get("client_secret")).toBe("shh");
    expect(sent!.get("code")).toBe("c1");
  });

  test("missing code is 400, Discord failure is 502", async () => {
    const oauth = { clientId: "a", clientSecret: "b", fetch: fakeFetch(() => new Response("bad", { status: 400 })) };
    expect((await handleTokenRequest(post({}), oauth)).status).toBe(400);
    expect((await handleTokenRequest(post({ code: "c" }), oauth)).status).toBe(502);
  });

  test("verifier resolves user id, null on 401", async () => {
    const verify = discordTokenVerifier(
      fakeFetch((_url, init) =>
        new Headers(init!.headers).get("authorization") === "Bearer good"
          ? Response.json({ id: "111" })
          : new Response("no", { status: 401 }),
      ),
    );
    expect(await verify("good")).toBe("111");
    expect(await verify("bad")).toBeNull();
  });
});
