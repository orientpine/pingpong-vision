import { describe, expect, test } from "bun:test";
import { MAX_JOINT_AGE_S, jointAge } from "../desk/page/fresh-joints.js";

describe("fresh joints", () => {
  test("age is the distance to the nearest seen joints, before or after the shot", () => {
    const hist = [{ t: 1.0 }, { t: 2.5 }, { t: 2.9 }];
    expect(jointAge(hist, 2.8)).toBeCloseTo(0.1);
    expect(jointAge(hist, 1.1)).toBeCloseTo(0.1);
  });

  test("joints from seconds ago are too old for a call; never seen is too old", () => {
    expect(jointAge([{ t: 1.0 }], 14) > MAX_JOINT_AGE_S).toBe(true);
    expect(jointAge([{ t: 13.9 }], 14) > MAX_JOINT_AGE_S).toBe(false);
    expect(jointAge([], 14)).toBe(Infinity);
  });
});
