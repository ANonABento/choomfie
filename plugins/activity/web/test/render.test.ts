import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ActivitySDK } from "../src/auth.ts";
import { NotInGuildVoiceError, signIn } from "../src/auth.ts";
import { startActivity } from "../src/app.ts";
import { AvatarController, BLINK_MAX_S, BLINK_MIN_S, loadVrm } from "../src/avatar.ts";
import type { BusMessage, ClientEvent } from "../src/protocol.ts";
import { sampleVrm } from "./sample-vrm.ts";

function mockSdk(guildId: string | null) {
  const calls: string[] = [];
  const sdk = {
    guildId,
    ready: async () => void calls.push("ready"),
    commands: {
      authorize: async (args: { scope: string[] }) => {
        calls.push(`authorize:${args.scope.join(",")}`);
        return { code: "code-1" };
      },
      authenticate: async (args: { access_token?: string | null }) => {
        calls.push(`authenticate:${args.access_token}`);
        return { user: { id: "111" } };
      },
      openExternalLink: async (args: { url: string }) => {
        calls.push(`open:${args.url}`);
        return { opened: true };
      },
    },
  } as unknown as ActivitySDK;
  return { sdk, calls };
}

const tokenFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  expect(String(url)).toBe("/api/token");
  expect(JSON.parse(String(init!.body))).toEqual({ code: "code-1" });
  return Response.json({ access_token: "tok" });
}) as typeof fetch;

describe("sign-in", () => {
  test("refuses outside a guild voice channel", async () => {
    const { sdk, calls } = mockSdk(null);
    await expect(signIn(sdk, "app", tokenFetch)).rejects.toBeInstanceOf(NotInGuildVoiceError);
    expect(calls).toEqual(["ready"]);
  });
});

describe("headless render", () => {
  test("mocked SDK + sample VRM: signs in, renders, follows the bus without errors", async () => {
    const { document } = new Window();
    const root = document.createElement("div");
    const canvas = document.createElement("canvas");
    root.append(canvas);
    const { sdk, calls } = mockSdk("guild-1");
    let onMessage: (msg: BusMessage) => void = () => {};
    const sent: ClientEvent[] = [];
    let renders = 0;

    const activity = await startActivity({
      sdk,
      clientId: "app",
      fetch: tokenFetch,
      root: root as unknown as HTMLElement,
      canvas: canvas as unknown as HTMLElement,
      renderer: { render: () => void renders++ },
      loadModel: async () => sampleVrm(),
      connectBus: (token, cb) => {
        expect(token).toBe("tok");
        onMessage = cb;
        return { send: (e) => void sent.push(e) };
      },
      aspect: 16 / 9,
    });
    expect(calls).toEqual(["ready", "authorize:identify,applications.commands", "authenticate:tok"]);

    onMessage({ type: "emotion", name: "happy", intensity: 0.8 });
    onMessage({ type: "mouth", value: 1 });
    for (let i = 0; i < 30; i++) activity.tick(1 / 60);
    const expressions = activity.avatar.vrm.expressionManager!;
    expect(renders).toBe(30);
    expect(expressions.getValue("happy")).toBeCloseTo(0.8);
    expect(expressions.getValue("aa")!).toBeGreaterThan(0.9);

    onMessage({ type: "room", action: "watch_together", args: { url: "https://youtu.be/x" } });
    (root.querySelector(".card button") as unknown as { click(): void }).click();
    expect(calls).toContain("open:https://youtu.be/x");
  });

  test("blinks every 2–6 s and sways while idle", async () => {
    const vrm = await loadVrm(sampleVrm());
    let r = 0;
    const avatar = new AvatarController(vrm, () => [0, 1, 0.5][r++ % 3]);
    expect(avatar.nextBlinkIn).toBeCloseTo(BLINK_MIN_S);
    let blinked = false;
    for (let t = 0; t < BLINK_MIN_S + 0.1; t += 1 / 60) {
      avatar.update(1 / 60);
      blinked ||= vrm.expressionManager!.getValue("blink")! > 0.5;
    }
    expect(blinked).toBe(true);
    expect(avatar.nextBlinkIn).toBeGreaterThan(BLINK_MAX_S - 0.2);
    expect(vrm.humanoid.getNormalizedBoneNode("spine")!.rotation.z).not.toBe(0);
  });
});
