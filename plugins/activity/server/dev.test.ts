import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAvatarBus, type AvatarBus } from "./bus.ts";
import { parseTunnelUrl, startActivityDev, type Tunnel } from "./dev.ts";

const env = {
  DISCORD_CLIENT_ID: "app",
  DISCORD_CLIENT_SECRET: "shh",
  ACTIVITY_ALLOWLIST: "111, 222",
  ACTIVITY_BUS_PORT: "0",
};

let running: AvatarBus | null = null;
afterEach(async () => {
  await running?.stop();
  running = null;
});

describe("activity:dev", () => {
  test("starts the server and a tunnel to its port", async () => {
    let tunneledPort = -1;
    let stopped = false;
    const lines: string[] = [];
    const { bus, url } = await startActivityDev(env, {
      startBus: startAvatarBus,
      startTunnel: (port): Tunnel => {
        tunneledPort = port;
        return { url: Promise.resolve("https://a-b-c.trycloudflare.com"), stop: () => (stopped = true) };
      },
      log: (l) => lines.push(l),
    });
    running = bus;
    expect(tunneledPort).toBe(bus.port);
    expect(url).toBe("https://a-b-c.trycloudflare.com");
    expect(lines.join("\n")).toContain('target "a-b-c.trycloudflare.com"');
    expect(stopped).toBe(false);
    const res = await fetch(`http://localhost:${bus.port}/api/token`, { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
  });

  test("missing env fails loudly", async () => {
    const deps = { startBus: startAvatarBus, startTunnel: (): Tunnel => ({ url: new Promise(() => {}), stop: () => {} }), log: () => {} };
    await expect(startActivityDev({ ...env, DISCORD_CLIENT_SECRET: "" }, deps)).rejects.toThrow("DISCORD_CLIENT_SECRET");
  });

  test("tunnel failure stops the server", async () => {
    let bus: AvatarBus | null = null;
    const deps = {
      startBus: (o: Parameters<typeof startAvatarBus>[0]) => (bus = startAvatarBus(o)),
      startTunnel: (): Tunnel => ({ url: Promise.reject(new Error("no cloudflared")), stop: () => {} }),
      log: () => {},
    };
    await expect(startActivityDev(env, deps)).rejects.toThrow("no cloudflared");
    await expect(fetch(`http://localhost:${bus!.port}/api/token`)).rejects.toThrow();
  });

  test("tunnel URL is read from cloudflared output", () => {
    expect(parseTunnelUrl("INF |  https://quiet-fox-12.trycloudflare.com  |")).toBe("https://quiet-fox-12.trycloudflare.com");
    expect(parseTunnelUrl("INF starting")).toBeNull();
  });
});

describe("static serving", () => {
  test("serves the web client and avatar without a token, not outside the dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "activity-web-"));
    writeFileSync(join(dir, "index.html"), "<html>hi</html>");
    const vrm = join(dir, "me.vrm");
    writeFileSync(vrm, "VRM");
    running = startAvatarBus({
      pipeline: { kind: "cascaded", on: () => () => {}, sendUtterance: async () => {}, close: async () => {} },
      allowlist: [],
      verifyToken: async () => null,
      toBrain: () => {},
      staticDir: dir,
      vrmPath: vrm,
    });
    const base = `http://localhost:${running.port}`;
    expect(await (await fetch(`${base}/`)).text()).toBe("<html>hi</html>");
    expect(await (await fetch(`${base}/avatar.vrm`)).text()).toBe("VRM");
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/bus`)).status).toBe(401);
  });
});
