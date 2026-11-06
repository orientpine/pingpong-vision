import { describe, expect, test } from "bun:test";
import { combineRefines, refineCorners, refineCornersMulti } from "../public/js/calib-refine.js";

// A 960x540 frame: yellow floor, a blue table top with a 3 px white border on the quad below.
const TRUE = [
  { x: 180, y: 330 },
  { x: 260, y: 260 },
  { x: 700, y: 268 },
  { x: 770, y: 340 },
];

function inside(p, q) {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (c !== 0) {
      if (s && Math.sign(c) !== s) return false;
      s = Math.sign(c);
    }
  }
  return true;
}

function distToQuadEdge(p, q) {
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}

function tableFrame(w = 960, h = 540) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const p = { x: x + 0.5, y: y + 0.5 };
      let c = [150, 120, 40];
      if (inside(p, TRUE)) c = distToQuadEdge(p, TRUE) <= 3 ? [235, 235, 235] : [20, 30, 140];
      rgba[o] = c[0];
      rgba[o + 1] = c[1];
      rgba[o + 2] = c[2];
      rgba[o + 3] = 255;
    }
  }
  return { rgba, w, h };
}

describe("corner snapping", () => {
  test("taps 20 px off land within 3 px of the table's outer border corners", () => {
    const { rgba, w, h } = tableFrame();
    const taps = TRUE.map((p, i) => ({ x: p.x + [18, -15, 12, -20][i], y: p.y + [-12, 16, 15, -10][i] }));
    const res = refineCorners(rgba, w, h, taps);
    expect(res.ok).toBe(true);
    res.corners.forEach((p, i) => expect(Math.hypot(p.x - TRUE[i].x, p.y - TRUE[i].y)).toBeLessThan(3));
  });

  test("no table in view: the taps are kept as they were", () => {
    const w = 960;
    const h = 540;
    const rgba = new Uint8ClampedArray(w * h * 4).fill(128);
    const res = refineCorners(rgba, w, h, TRUE);
    expect(res.ok).toBe(false);
    expect(res.corners).toEqual(TRUE);
  });

  test("several frames: the median holds when one frame has the table hidden", () => {
    const good = tableFrame();
    const blank = { rgba: new Uint8ClampedArray(960 * 540 * 4).fill(128), w: 960, h: 540 };
    const taps = TRUE.map((p) => ({ x: p.x + 10, y: p.y - 8 }));
    const res = refineCornersMulti([good, blank, good], taps);
    expect(res.ok).toBe(true);
    expect(res.snapped).toBe(2);
    res.corners.forEach((p, i) => expect(Math.hypot(p.x - TRUE[i].x, p.y - TRUE[i].y)).toBeLessThan(3));
  });
});

// the same frame moved by (dx, dy) whole px, as a shaking tripod moves the picture
function shifted({ rgba, w, h }, dx, dy) {
  const out = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(h - 1, Math.max(0, y - dy));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - dx));
      out.set(rgba.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * w + x) * 4);
    }
  }
  return { rgba: out, w, h };
}
// a second of frames: the table moved around by up to amp px (fixed offsets so the test repeats)
const OFFSETS = [[0, 0], [1, -1], [-1, 1], [1, 1], [-1, -1], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1]];
const second = (frame, amp) => OFFSETS.map(([x, y]) => shifted(frame, x * amp, y * amp));

describe("정밀하게 over a second of frames", () => {
  const frame = tableFrame();
  const taps = TRUE.map((p, i) => ({ x: p.x + [25, -30, 20, -35][i], y: p.y + [-20, 25, 30, -15][i] }));

  test("a still tripod: snapped within 3 px, shake read as ok (under 1 px)", () => {
    const res = refineCornersMulti(second(frame, 0), taps);
    expect(res.ok).toBe(true);
    expect(res.frames).toBe(10);
    expect(res.shake).toBe("ok");
    expect(res.shakePx).toBeLessThan(1);
    res.corners.forEach((p, i) => expect(Math.hypot(p.x - TRUE[i].x, p.y - TRUE[i].y)).toBeLessThan(3));
  });

  // the answer is where the table was in the median frame, so it can be off by the shake itself
  test("a tripod shaking by 5 px: snapped within the shake of the table, and the shake is reported (warn)", () => {
    const res = refineCornersMulti(second(frame, 5), taps);
    expect(res.ok).toBe(true);
    expect(res.shake).toBe("warn");
    expect(res.shakePx).toBeGreaterThan(3);
    res.corners.forEach((p, i) => expect(Math.hypot(p.x - TRUE[i].x, p.y - TRUE[i].y)).toBeLessThan(3 + 5 * Math.SQRT2));
  });

  test("a tripod shaking by 14 px: the taps stay and the reason is the shake", () => {
    const res = refineCornersMulti(second(frame, 14), taps);
    expect(res.ok).toBe(false);
    expect(res.code).toBe("shake");
    expect(res.corners).toEqual(taps);
  });

  test("taps 30-40 px off (a finger on a phone): the wider second search still lands within 3 px", () => {
    const res = refineCorners(frame.rgba, frame.w, frame.h, taps);
    expect(res.ok).toBe(true);
    res.corners.forEach((p, i) => expect(Math.hypot(p.x - TRUE[i].x, p.y - TRUE[i].y)).toBeLessThan(3));
  });

  test("one frame at a time (combineRefines) gives the same answer as all frames at once", () => {
    const frames = second(frame, 2);
    const runs = frames.map(({ rgba, w, h }) => refineCorners(rgba, w, h, taps));
    expect(combineRefines(runs, taps)).toEqual(refineCornersMulti(frames, taps));
  });
});

describe("ceiling light on the table top", () => {
  // A light patch over a third of the top (the club's ceiling lights on 11-04 club clips): the whole top
  // is less uniform than a rough quad that sits inside its dark part, which must not refuse the fit.
  test("a lit band over part of the top: the fit is taken (not refused as 'not the table')", () => {
    const f = tableFrame();
    for (let y = 0; y < f.h; y++) for (let x = 0; x < 380; x++) {
      const o = (y * f.w + x) * 4;
      if (f.rgba[o + 2] === 140 && f.rgba[o] === 20) { f.rgba[o] = 90; f.rgba[o + 1] = 110; f.rgba[o + 2] = 205; }
    }
    const taps = TRUE.map((p, i) => ({ x: p.x + [30, 25, -12, -15][i], y: p.y + [-12, 14, 14, -10][i] }));
    const res = refineCorners(f.rgba, f.w, f.h, taps);
    expect(res.ok).toBe(true);
    expect(res.uniform[0]).toBeGreaterThan(res.uniform[1]);
    res.corners.forEach((p, i) => expect(Math.hypot(p.x - TRUE[i].x, p.y - TRUE[i].y)).toBeLessThan(3));
  });
});

describe("a fit that cannot be trusted keeps the taps and says why", () => {
  test("no table in view: no-line, naming the two tapped corners of the side", () => {
    const w = 960;
    const h = 540;
    const res = refineCorners(new Uint8ClampedArray(w * h * 4).fill(128), w, h, TRUE);
    expect(res.code).toBe("no-line");
    expect(res.side.length).toBe(2);
    expect(res.side[1]).toBeGreaterThan(res.side[0]);
  });

  test("most frames without the table: the commonest reason is reported and the taps stay", () => {
    const blank = { rgba: new Uint8ClampedArray(960 * 540 * 4).fill(128), w: 960, h: 540 };
    const res = refineCornersMulti([tableFrame(), blank, blank], TRUE);
    expect(res.ok).toBe(false);
    expect(res.code).toBe("no-line");
    expect(res.corners).toEqual(TRUE);
  });
});
