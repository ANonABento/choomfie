/**
 * Activity boot: sign in, load the avatar, connect the bus, wire the room.
 * Every outside dependency is injected so tests run it headless.
 */

import type * as THREE from "three";
import { signIn, type ActivitySDK } from "./auth.ts";
import { AvatarController, createStage, loadVrm } from "./avatar.ts";
import { mountRoom } from "./room.ts";
import type { BusMessage, ClientEvent } from "./protocol.ts";

export interface BusConnection {
  send(event: ClientEvent): void;
}

export interface ActivityDeps {
  sdk: ActivitySDK;
  clientId: string;
  fetch: typeof fetch;
  root: HTMLElement;
  canvas: HTMLElement;
  renderer: { render(scene: THREE.Scene, camera: THREE.Camera): void };
  loadModel: () => Promise<ArrayBuffer>;
  connectBus: (token: string, onMessage: (msg: BusMessage) => void) => BusConnection;
  aspect: number;
}

export interface Activity {
  avatar: AvatarController;
  tick(dt: number): void;
}

export async function startActivity(deps: ActivityDeps): Promise<Activity> {
  const session = await signIn(deps.sdk, deps.clientId, deps.fetch);
  const vrm = await loadVrm(await deps.loadModel());
  const avatar = new AvatarController(vrm);
  const stage = createStage(vrm, deps.aspect);
  const openLink = (url: string) => void deps.sdk.commands.openExternalLink({ url });
  let room: ReturnType<typeof mountRoom> | null = null;
  const bus = deps.connectBus(session.accessToken, (msg) => {
    avatar.apply(msg);
    room?.show(msg);
  });
  room = mountRoom(deps.root, deps.canvas, (event) => bus.send(event), openLink);
  return {
    avatar,
    tick(dt) {
      avatar.update(dt);
      deps.renderer.render(stage.scene, stage.camera);
    },
  };
}
