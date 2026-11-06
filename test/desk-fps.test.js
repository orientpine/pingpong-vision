import { describe, expect, test } from "bun:test";
import { pickFps } from "../desk/fps.js";

describe("desk fps", () => {
  test("a constant frame rate is used as is", () => {
    expect(pickFps("60/1", "60/1")).toBe(60);
    expect(pickFps("30000/1001", "30000/1001")).toBeCloseTo(29.97, 2);
  });
  test("a recorder clip that reports the container tick falls back to its average rate", () => {
    expect(pickFps("30000/1", "500000/47561")).toBeCloseTo(10.51, 2);
  });
  test("no usable rate gives 0", () => {
    expect(pickFps("0/0", "0/0")).toBe(0);
    expect(pickFps("90000/1", "")).toBe(0);
  });
});
