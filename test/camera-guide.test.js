import { describe, expect, test } from "bun:test";
import { judgePosition, judgeFraming, judgeAngle, judgeLevel, judgeShake, estimateShift } from "../public/js/camera-guide.js";

// Quad order: near end, then far end; same semantic order as makeCalibration.
const good = [{ x: 200, y: 280 }, { x: 200, y: 220 }, { x: 800, y: 220 }, { x: 800, y: 280 }];

describe("camera guide framing", () => {
  test("warns when the table covers less than five percent", () => {
    // Given
    const small = good.map((p) => ({ x: p.x / 2, y: p.y / 2 }));
    // When
    const result = judgeFraming(small, 960, 540);
    // Then
    expect(result.ok).toBe(false);
  });
  test("fails when a corner is clipped even with a large table", () => {
    // Given
    const clipped = good.map((p, i) => i === 0 ? { ...p, x: 10 } : p);
    // When
    const result = judgeFraming(clipped, 960, 540);
    // Then
    expect(result.ok).toBe(false);
  });
  test("passes when the whole table is visible and large enough", () => {
    // Given / When
    const result = judgeFraming(good, 960, 540);
    // Then
    expect(result.ok).toBe(true);
    expect(result.value).toBeCloseTo(36000 / (960 * 540));
  });
  test("cannot measure before the four rough taps", () => {
    // Given / When
    const result = judgeFraming(null, 960, 540);
    // Then
    expect(result.ok).toBeNull();
  });
});

describe("camera guide position", () => {
  test("warns when the camera is behind an end", () => {
    // Given
    const end = good.map((p) => ({ x: p.y, y: p.x }));
    // When: swap the semantic ends, not just the phone orientation
    const result = judgePosition([end[1], end[2], end[3], end[0]], 960, 540);
    // Then
    expect(result.ok).toBe(false);
    expect(result.value).toBeLessThan(2);
  });
  test("passes when the camera is beside the long side", () => {
    // Given / When
    const result = judgePosition(good, 960, 540);
    // Then
    expect(result.ok).toBe(true);
    expect(result.value).toBeGreaterThan(3);
  });
});

describe("camera guide sensors", () => {
  test("warns when roll is six degrees", () => {
    // Given / When
    const result = judgeLevel({ roll: 6, pitch: 15 });
    // Then
    expect(result.ok).toBe(false);
  });
  test("passes when roll is one degree", () => {
    // Given / When
    const result = judgeLevel({ roll: 1, pitch: 15 });
    // Then
    expect(result.ok).toBe(true);
  });
  test("cannot measure when the sensor is absent", () => {
    // Given / When
    const result = judgeLevel(null);
    // Then
    expect(result.ok).toBeNull();
  });
  test("passes a provisional look-down angle in range", () => {
    // Given / When
    const result = judgeAngle({ pitch: 15, roll: 0 });
    // Then
    expect(result.ok).toBe(true);
  });
  test("warns when the camera looks straight ahead", () => {
    // Given / When
    const result = judgeAngle({ pitch: 0, roll: 0 });
    // Then
    expect(result.ok).toBe(false);
  });
});

const w = 160, h = 90;
const grey = (shift) => Uint8Array.from({ length: w * h }, (_, i) => {
  const x = i % w - shift, y = Math.floor(i / w);
  return x < 0 ? 0 : (x * 37 + y * 53 + x * y * 7) % 251;
});
describe("camera guide shake", () => {
  test("estimates no motion when consecutive grey frames match", () => {
    // Given
    const frame = grey(0);
    // When
    const value = estimateShift(frame, frame, w, h);
    // Then
    expect(value).toBeCloseTo(0, 1);
  });
  test("estimates three pixels when the frame moves three pixels", () => {
    // Given
    const before = grey(0), after = grey(3);
    // When
    const value = estimateShift(before, after, w, h);
    // Then
    expect(value).toBeCloseTo(3, 0);
  });
  test("passes when the one-second p90 is below one pixel at 960px", () => {
    // Given
    const samples = [0, 0.1, 0.2, 0.1, 0, 0.2, 0.1, 0, 0, 8];
    // When
    const result = judgeShake(samples);
    // Then
    expect(result.ok).toBe(true);
  });
  test("warns when the one-second p90 exceeds two pixels at 960px", () => {
    // Given
    const samples = Array(30).fill(3);
    // When
    const result = judgeShake(samples);
    // Then
    expect(result.ok).toBe(false);
  });
  test("cannot measure a textureless frame", () => {
    // Given
    const flat = new Uint8Array(w * h);
    // When
    const result = estimateShift(flat, flat, w, h);
    // Then
    expect(result).toBeNull();
  });
});
