import { DiscordSDK } from "@discord/embedded-app-sdk";
import { WebGLRenderer } from "three";
import { startActivity } from "./app.ts";
import { connectBus } from "./bus-client.ts";

const WEBGL_HINT =
  "Choomfie needs WebGL. Turn on hardware acceleration in Discord (Settings → Advanced) and relaunch the Activity.";

function notice(text: string): void {
  const el = document.createElement("div");
  el.className = "notice";
  el.textContent = text;
  document.body.append(el);
}

async function main(): Promise<void> {
  const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID as string | undefined;
  if (!clientId) throw new Error("VITE_DISCORD_CLIENT_ID is not set");
  const root = document.getElementById("app")!;
  const canvas = document.getElementById("stage") as HTMLCanvasElement;

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (err: unknown) {
    console.error(err);
    notice(WEBGL_HINT);
    return;
  }
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

  const activity = await startActivity({
    sdk: new DiscordSDK(clientId),
    clientId,
    fetch: window.fetch.bind(window),
    root,
    canvas,
    renderer,
    loadModel: async () => {
      const res = await fetch("/avatar.vrm");
      if (!res.ok) throw new Error(`avatar.vrm: ${res.status}`);
      return res.arrayBuffer();
    },
    connectBus,
    aspect: canvas.clientWidth / canvas.clientHeight,
  });

  let last = performance.now();
  const frame = (now: number) => {
    activity.tick((now - last) / 1000);
    last = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((err: unknown) => {
  console.error(err);
  notice(err instanceof Error ? err.message : String(err));
});
