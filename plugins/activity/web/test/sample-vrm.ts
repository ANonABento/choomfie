/**
 * Builds a tiny VRM 1.0 model in memory for tests: the required humanoid
 * bones and one mesh with a morph target per expression the avatar drives.
 * Written for this repo and released CC0, so no third-party model is shipped.
 */

const BONES: Array<[name: string, parent: string | null, y: number, x: number]> = [
  ["hips", null, 0.9, 0],
  ["spine", "hips", 0.1, 0],
  ["head", "spine", 0.5, 0],
  ["leftUpperArm", "spine", 0.4, 0.15],
  ["leftLowerArm", "leftUpperArm", 0, 0.25],
  ["leftHand", "leftLowerArm", 0, 0.25],
  ["rightUpperArm", "spine", 0.4, -0.15],
  ["rightLowerArm", "rightUpperArm", 0, -0.25],
  ["rightHand", "rightLowerArm", 0, -0.25],
  ["leftUpperLeg", "hips", -0.05, 0.1],
  ["leftLowerLeg", "leftUpperLeg", -0.4, 0],
  ["leftFoot", "leftLowerLeg", -0.4, 0],
  ["rightUpperLeg", "hips", -0.05, -0.1],
  ["rightLowerLeg", "rightUpperLeg", -0.4, 0],
  ["rightFoot", "rightLowerLeg", -0.4, 0],
];

export const SAMPLE_EXPRESSIONS = ["aa", "blink", "happy", "sad", "angry", "surprised", "relaxed"];

export function sampleVrm(): ArrayBuffer {
  const triangle = [0, 1.4, 0, 0.1, 1.4, 0, 0, 1.5, 0];
  const floats = new Float32Array(triangle.length * (1 + SAMPLE_EXPRESSIONS.length));
  floats.set(triangle);
  SAMPLE_EXPRESSIONS.forEach((_, i) => floats.set([0, 0.01, 0, 0, 0, 0, 0, 0, 0], (i + 1) * 9));
  const bin = new Uint8Array(floats.buffer);

  const accessors = Array.from({ length: SAMPLE_EXPRESSIONS.length + 1 }, (_, i) => ({
    bufferView: i,
    componentType: 5126,
    count: 3,
    type: "VEC3",
    min: i === 0 ? [0, 1.4, 0] : [0, 0, 0],
    max: i === 0 ? [0.1, 1.5, 0] : [0, 0.01, 0],
  }));
  const bufferViews = accessors.map((_, i) => ({ buffer: 0, byteOffset: i * 36, byteLength: 36 }));

  const nodes: Array<Record<string, unknown>> = BONES.map(([name, , y, x]) => ({ name, translation: [x, y, 0] }));
  BONES.forEach(([, parent], i) => {
    if (!parent) return;
    const p = nodes[BONES.findIndex(([n]) => n === parent)];
    p.children = [...((p.children as number[]) ?? []), i];
  });
  const meshNode = nodes.push({ name: "Face", mesh: 0 }) - 1;

  const json = {
    asset: { version: "2.0", generator: "choomfie test" },
    extensionsUsed: ["VRMC_vrm"],
    scene: 0,
    scenes: [{ nodes: [0, meshNode] }],
    nodes,
    meshes: [
      {
        primitives: [{ attributes: { POSITION: 0 }, targets: SAMPLE_EXPRESSIONS.map((_, i) => ({ POSITION: i + 1 })) }],
        weights: SAMPLE_EXPRESSIONS.map(() => 0),
      },
    ],
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.byteLength }],
    extensions: {
      VRMC_vrm: {
        specVersion: "1.0",
        meta: { name: "choomfie test", authors: ["choomfie"], // three-vrm only accepts VRM licence URLs; this generated model itself is CC0
        licenseUrl: "https://vrm.dev/licenses/1.0/" },
        humanoid: { humanBones: Object.fromEntries(BONES.map(([name], i) => [name, { node: i }])) },
        expressions: {
          preset: Object.fromEntries(
            SAMPLE_EXPRESSIONS.map((name, i) => [name, { morphTargetBinds: [{ node: meshNode, index: i, weight: 1 }] }]),
          ),
        },
      },
    },
  };

  const pad = (bytes: Uint8Array, fill: number) => {
    const out = new Uint8Array(Math.ceil(bytes.length / 4) * 4).fill(fill);
    out.set(bytes);
    return out;
  };
  const jsonChunk = pad(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const binChunk = pad(bin, 0);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const out = new DataView(new ArrayBuffer(total));
  out.setUint32(0, 0x46546c67, true);
  out.setUint32(4, 2, true);
  out.setUint32(8, total, true);
  out.setUint32(12, jsonChunk.length, true);
  out.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(out.buffer, 20).set(jsonChunk);
  const binAt = 20 + jsonChunk.length;
  out.setUint32(binAt, binChunk.length, true);
  out.setUint32(binAt + 4, 0x004e4942, true);
  new Uint8Array(out.buffer, binAt + 8).set(binChunk);
  return out.buffer;
}
