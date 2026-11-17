/**
 * VRM avatar driven by the bus: mouth, emotion expressions, random blink
 * (every 2–6 s) and a gentle idle sway.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import type { Emotion } from "@choomfie/voice/pipeline/emotion.ts";
import type { BusMessage } from "./protocol.ts";

export const BLINK_MIN_S = 2;
export const BLINK_MAX_S = 6;
const BLINK_S = 0.15;
const MOUTH_SMOOTHING = 20;
const SWAY_HZ = 0.25;
const SWAY_RAD = 0.03;

/** VRM preset expressions per emotion; models without a preset just skip it */
const EMOTION_EXPRESSIONS: Record<Emotion, Array<[string, number]>> = {
  neutral: [],
  happy: [["happy", 1]],
  sad: [["sad", 1]],
  angry: [["angry", 1]],
  surprised: [["surprised", 1]],
  embarrassed: [["happy", 0.4], ["relaxed", 0.6]],
  thinking: [["relaxed", 0.3]],
};
const EMOTION_NAMES = new Set(Object.values(EMOTION_EXPRESSIONS).flat().map(([name]) => name));

export async function loadVrm(data: ArrayBuffer): Promise<VRM> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.parseAsync(data, "");
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error("avatar: file is not a VRM model");
  VRMUtils.rotateVRM0(vrm);
  return vrm;
}

export class AvatarController {
  private mouthTarget = 0;
  private mouth = 0;
  private emotion: Emotion = "neutral";
  private intensity = 0;
  private time = 0;
  private blinkAt: number;
  private blinkEnd = -1;

  constructor(
    readonly vrm: VRM,
    private readonly random: () => number = Math.random,
  ) {
    this.blinkAt = this.nextBlinkDelay();
  }

  /** Seconds until the next blink starts */
  get nextBlinkIn(): number {
    return this.blinkAt - this.time;
  }

  apply(msg: BusMessage): void {
    switch (msg.type) {
      case "mouth":
        this.mouthTarget = msg.value;
        break;
      case "speaking":
        if (!msg.value) this.mouthTarget = 0;
        break;
      case "emotion":
        if (!(msg.name in EMOTION_EXPRESSIONS)) throw new Error(`avatar: unknown emotion "${msg.name}"`);
        this.emotion = msg.name as Emotion;
        this.intensity = msg.intensity;
        break;
      case "look_at":
      case "room":
        break;
    }
  }

  update(dt: number): void {
    this.time += dt;
    const expressions = this.vrm.expressionManager;
    if (expressions) {
      this.mouth += (this.mouthTarget - this.mouth) * Math.min(1, dt * MOUTH_SMOOTHING);
      expressions.setValue("aa", this.mouth);
      for (const name of EMOTION_NAMES) expressions.setValue(name, 0);
      for (const [name, weight] of EMOTION_EXPRESSIONS[this.emotion]) {
        expressions.setValue(name, weight * this.intensity);
      }
      expressions.setValue("blink", this.blinkValue());
    }
    const spine = this.vrm.humanoid?.getNormalizedBoneNode("spine");
    if (spine) spine.rotation.z = Math.sin(this.time * Math.PI * 2 * SWAY_HZ) * SWAY_RAD;
    this.vrm.update(dt);
  }

  private blinkValue(): number {
    if (this.time >= this.blinkAt) {
      this.blinkEnd = this.time + BLINK_S;
      this.blinkAt = this.time + this.nextBlinkDelay();
    }
    if (this.time >= this.blinkEnd) return 0;
    // Close then open over BLINK_S
    return Math.sin(((this.blinkEnd - this.time) / BLINK_S) * Math.PI);
  }

  private nextBlinkDelay(): number {
    return BLINK_MIN_S + this.random() * (BLINK_MAX_S - BLINK_MIN_S);
  }
}

export interface Stage {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

export function createStage(vrm: VRM, aspect: number): Stage {
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const light = new THREE.DirectionalLight(0xffffff, 1.2);
  light.position.set(1, 1, 1);
  scene.add(light);
  scene.add(vrm.scene);
  const camera = new THREE.PerspectiveCamera(30, aspect, 0.1, 20);
  camera.position.set(0, 1.35, 1.6);
  camera.lookAt(0, 1.3, 0);
  return { scene, camera };
}
