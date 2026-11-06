import { describe, expect, test } from "bun:test";
import { trackShots } from "../desk/page/track-shots.js";

// A clip recorded from camera time 20.0: frames every 100 ms, a serve at 20.35 shown from 20.6 and a
// drive at 21.2 shown from 21.4, a bounce at 20.7. The ball sits on the shot's place at the hit.
function clip({ cam = true } = {}) {
  const frames = [];
  for (let k = 0; k <= 15; k++) {
    const c = 20 + k / 10;
    const f = { t: k * 100 };
    if (cam) f.cam = Math.round(c * 1000) / 1000;
    f.ball = { trail: [], current: k === 3 ? { x: 100, y: 50 } : k === 12 ? { x: 400, y: 80 } : { x: 250, y: 300 }, lock: null };
    if (k === 6) f.lastShot = { index: 1, side: "far", t: 20.35, at: { x: 100, y: 50 }, stroke: "포핸드", kind: "서브", speedKmh: null };
    if (k === 8) f.lastShot = { index: 1, side: "far", t: 20.35, at: { x: 100, y: 50 }, stroke: "포핸드", kind: "서브", speedKmh: 30 };
    if (k === 14) f.lastShot = { index: 2, side: "near", t: 21.2, at: { x: 400, y: 80 }, stroke: "백핸드", kind: "드라이브", speedKmh: 40 };
    if (k === 8) f.bounces = [{ tx: 1, ty: 0.5, side: "near", t: 20.7 }];
    frames.push(f);
  }
  return { v: 1, meta: {}, frames, notices: [] };
}

describe("track shots", () => {
  test("with cam each shot and bounce lands at its exact clip time, with its last known values", () => {
    const r = trackShots(clip());
    expect(r.timing).toBe("track");
    expect(r.shots.map((s) => [s.t, s.side, s.kind, s.speedKmh])).toEqual([[0.35, "far", "서브", 30], [1.2, "near", "드라이브", 40]]);
    expect(r.bounces).toEqual([{ tx: 1, ty: 0.5, side: "near", t: 0.7 }]);
  });
  test("without cam a shot goes to the frame whose ball is nearest its place, marked estimated", () => {
    const r = trackShots(clip({ cam: false }));
    expect(r.timing).toBe("estimated");
    expect(r.shots.map((s) => s.t)).toEqual([0.3, 1.2]);
    expect(r.bounces[0].t).toBeCloseTo(0.675, 3);
  });
  test("a track with no shot gives none, and a malformed document does not throw", () => {
    expect(trackShots({ v: 1, frames: [{ t: 0 }] })).toEqual({ timing: null, shots: [], bounces: [] });
    expect(trackShots(null).shots).toEqual([]);
  });
});
