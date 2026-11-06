import { describe, expect, test } from "bun:test";
import { farBox, farFrames, hiddenLegsFar, toFrame } from "../desk/page/far-crop.js";
import { plausiblePerson } from "../public/js/players.js";

const TEST5 = [{ x: 207.563, y: 1072.813 }, { x: 300.938, y: 1007 }, { x: 730.688, y: 1007 }, { x: 822.375, y: 1070 }];
const TEST2 = [{ x: 199.688, y: 1012.625 }, { x: 313.313, y: 947.938 }, { x: 753.188, y: 956.938 }, { x: 835.875, y: 1026.688 }];

describe("far crop", () => {
  test("the box sits on the far edge of the table and above it", () => {
    expect(farBox(TEST5, 1080, 1920)).toEqual({ x: 43, y: 405, w: 946, h: 752 });
    const box = farBox(TEST2, 1080, 1920);
    expect(box.y).toBeLessThan(947 - 400);
    expect(box.y + box.h).toBeGreaterThan(957);
    expect(box.x).toBeLessThan(313);
    expect(box.x + box.w).toBeGreaterThan(753);
  });

  test("corner order does not matter and the box stays inside the frame", () => {
    expect(farBox([...TEST5].reverse(), 1080, 1920)).toEqual(farBox(TEST5, 1080, 1920));
    const box = farBox(TEST5, 900, 1920);
    expect(box.x + box.w).toBe(900);
  });

  test("crop poses come back in video pixels with their world joints", () => {
    const pose = [{ x: 10, y: 20, v: 0.9 }];
    pose.world = [{ x: 0, y: 0, z: 0 }];
    const [out] = toFrame([pose], { x: 43, y: 405, w: 946, h: 752 });
    expect(out[0]).toEqual({ x: 53, y: 425, v: 0.9 });
    expect(out.world).toBe(pose.world);
  });

  // a landscape clip filmed from beside the table (960x540): the far end is on the left
  const SIDE = [{ x: 847.6, y: 285.4 }, { x: 668.7, y: 358.8 }, { x: 198.2, y: 272.5 }, { x: 412.9, y: 245.2 }];
  const cal = { myEnd: { x: 758.1, y: 322.1 }, oppEnd: { x: 305.6, y: 258.9 } };
  const person = (hipX, hipY, torsoV, legV) => {
    const lm = Array.from({ length: 33 }, () => ({ x: hipX, y: hipY, v: 0.9 }));
    for (const i of [11, 12]) lm[i] = { x: hipX, y: hipY - 60, v: torsoV };
    for (const i of [23, 24]) lm[i] = { x: hipX, y: hipY, v: torsoV };
    for (const i of [25, 26, 27, 28]) lm[i] = { x: hipX, y: hipY + 60, v: legV };
    return lm;
  };

  test("a far player whose legs the table hides is taken; the camera's rule turns them away", () => {
    const box = farBox(SIDE, 960, 540);
    const server = person(250, 264, 0.99, 0.1);
    expect(plausiblePerson(server, null)).toBe(false);
    expect(hiddenLegsFar([server], cal, box)).toBe(server);
  });

  test("no one is taken with an unsure torso, outside the far box or nearer the near end", () => {
    const box = farBox(SIDE, 960, 540);
    expect(hiddenLegsFar([person(250, 264, 0.4, 0.1)], cal, box)).toBe(null);
    expect(hiddenLegsFar([person(900, 264, 0.99, 0.1)], cal, box)).toBe(null);
    expect(hiddenLegsFar([person(540, 330, 0.99, 0.1)], cal, box)).toBe(null);
    expect(hiddenLegsFar([person(250, 264, 0.99, 0.1)], null, box)).toBe(null);
  });

  test("only frames near far shots are cropped", () => {
    const frames = farFrames([{ t: 1, side: "far" }, { t: 3, side: "near" }], 60);
    expect([...frames].sort((a, b) => a - b)).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69]);
  });
});
