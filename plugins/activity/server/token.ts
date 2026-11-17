/**
 * Discord OAuth for the Activity: exchange the SDK's authorize `code` for an
 * access token (POST /api/token), and resolve a bearer token to a user ID
 * (backs the bus's `verifyToken`). The client secret never leaves the server.
 */

const DISCORD_API = "https://discord.com/api";

export interface DiscordOAuth {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}

export async function exchangeCode(code: string, oauth: DiscordOAuth): Promise<string> {
  const doFetch = oauth.fetch ?? fetch;
  const res = await doFetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      grant_type: "authorization_code",
      code,
    }),
  });
  if (!res.ok) throw new Error(`activity token exchange: Discord answered ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string") throw new Error("activity token exchange: no access_token in Discord reply");
  return body.access_token;
}

/** POST /api/token { code } → { access_token } */
export async function handleTokenRequest(req: Request, oauth: DiscordOAuth): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
  if (typeof body?.code !== "string" || !body.code) return new Response("missing code", { status: 400 });
  try {
    return Response.json({ access_token: await exchangeCode(body.code, oauth) });
  } catch (err: unknown) {
    console.error(err);
    return new Response("token exchange failed", { status: 502 });
  }
}

/** verifyToken for the bus: Discord user ID for a valid token, null otherwise */
export function discordTokenVerifier(doFetch: typeof fetch = fetch): (token: string) => Promise<string | null> {
  return async (token) => {
    const res = await doFetch(`${DISCORD_API}/users/@me`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) return null;
    if (!res.ok) throw new Error(`activity auth: Discord /users/@me answered ${res.status}`);
    const user = (await res.json()) as { id?: unknown };
    return typeof user.id === "string" ? user.id : null;
  };
}
