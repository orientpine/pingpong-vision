import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real pose.js, copied beside a stand-in MediaPipe bundle: public/vendor exists only on a served
// path, so there is no file to import. worldLandmarks counts its reads, so the default path is
// shown not to touch it.
const landmarks = [[{ x: 0.5, y: 0.25, visibility: 0.75 }, { x: 0.1, y: 0.2 }]];
const worldLandmarks = [[{ x: 0.01, y: -0.5, z: 0.2, visibility: 0.75 }, { x: 0.02, y: 0.1, z: 0, visibility: 0.5 }]];
let worldReads = 0;
globalThis.__poseResult = {
  landmarks,
  get worldLandmarks() {
    worldReads += 1;
    return worldLandmarks;
  },
};
const FAKE_BUNDLE = `
export const FilesetResolver = { forVisionTasks: async () => ({ wasmLoaderPath: "http://x/l.js", wasmBinaryPath: "http://x/b.wasm" }) };
export const PoseLandmarker = { createFromOptions: async () => ({ detectForVideo: () => globalThis.__poseResult, close() {} }) };
`;
const root = mkdtempSync(join(tmpdir(), "pp-pose-option-"));
mkdirSync(join(root, "js"));
mkdirSync(join(root, "vendor/mediapipe"), { recursive: true });
for (const file of ["pose.js", "download.js", "i18n.js"]) cpSync(join(import.meta.dir, "../public/js", file), join(root, "js", file));
writeFileSync(join(root, "vendor/mediapipe/vision_bundle.mjs"), FAKE_BUNDLE);
const { createPose } = await import(join(root, "js/pose.js"));

let fetchSpy;
beforeAll(() => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array(4)));
});
afterAll(() => {
  fetchSpy.mockRestore();
  rmSync(root, { recursive: true });
});

test("without the world option detect() gives the same plain poses and never reads world landmarks", async () => {
  const pose = await createPose({ delegate: "CPU" });
  worldReads = 0;
  const poses = pose.detect(null, 0, 1000, 800);
  expect(poses).toEqual([[{ x: 500, y: 200, v: 0.75 }, { x: 100, y: 160, v: 1 }]]);
  expect(Object.keys(poses[0])).toEqual(["0", "1"]);
  expect(worldReads).toBe(0);
});

test("with the world option each pose keeps its image joints and carries its world landmarks", async () => {
  const pose = await createPose({ delegate: "CPU", world: true });
  const [first] = pose.detect(null, 0, 1000, 800);
  expect([...first]).toEqual([{ x: 500, y: 200, v: 0.75 }, { x: 100, y: 160, v: 1 }]);
  expect(first.world).toEqual(worldLandmarks[0]);
});
