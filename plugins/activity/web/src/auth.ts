/**
 * Embedded App SDK sign-in: ready → authorize → server token exchange →
 * authenticate. Refuses to run outside a guild voice channel.
 */

import type { DiscordSDK } from "@discord/embedded-app-sdk";

export type ActivitySDK = Pick<DiscordSDK, "ready" | "guildId"> & {
  commands: Pick<DiscordSDK["commands"], "authorize" | "authenticate" | "openExternalLink">;
};

export interface Session {
  accessToken: string;
  userId: string;
  guildId: string;
}

export class NotInGuildVoiceError extends Error {
  constructor() {
    super("Choomfie runs only in a server voice channel. Launch the Activity from a voice call.");
  }
}

export async function signIn(sdk: ActivitySDK, clientId: string, doFetch: typeof fetch = fetch): Promise<Session> {
  await sdk.ready();
  const guildId = sdk.guildId;
  if (!guildId) throw new NotInGuildVoiceError();
  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify", "applications.commands"],
  });
  const res = await doFetch("/api/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const { access_token } = (await res.json()) as { access_token: string };
  const auth = await sdk.commands.authenticate({ access_token });
  return { accessToken: access_token, userId: auth.user.id, guildId };
}
