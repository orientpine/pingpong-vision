// The start screen's scene, checked in table metres (the ball's flight, bounces, rackets) and in what
// playRally actually draws on a recording canvas (perspective, the net line, the stage, reduced
// motion, a hidden tab).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as start from '../public/start.js';
import { NET_TOP, SCENES, TITLE_LINES, ballAt, drawStartWord, inPlay, netEnds, pickScene, playRally, poseAt, project, sceneTime, titleLine } from '../public/start.js';

const BALL = '#ffd34d', TW = 0.7625, TL = 1.37;
const hexAt = (px, i) => '#' + [px[i], px[i + 1], px[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
const saved = {};
let reduced = false, queue = [], listeners = {}, visibility = 'visible';

beforeAll(() => {
  for (const k of ['document', 'matchMedia', 'requestAnimationFrame', 'addEventListener', 'removeEventListener']) saved[k] = globalThis[k];
  globalThis.document = {
    get visibilityState() { return visibility; },
    createElement: () => fakeCanvas(),
    addEventListener: (k, f) => { listeners[k] = f; },
    removeEventListener: (k) => { delete listeners[k]; },
  };
  globalThis.matchMedia = () => ({ matches: reduced });
  globalThis.requestAnimationFrame = (f) => queue.push(f);
});
afterAll(() => Object.assign(globalThis, saved));

function fakeCanvas(view, stage, drawn) {
  const g = {
    fillStyle: '', globalAlpha: 1, imageSmoothingEnabled: true,
    fillRect(x, y, w, h) { drawn?.push({ c: this.fillStyle, a: this.globalAlpha, x, y, w, h }); },
    drawImage() {},
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {},
  };
  const box = { left: 0, top: 0, width: view?.[0] ?? 10, height: view?.[1] ?? 10 };
  return {
    isConnected: true, width: 0, height: 0, getContext: () => g,
    getBoundingClientRect: () => box,
    parentElement: stage && { querySelector: () => ({ getBoundingClientRect: () => stage }) },
  };
}

// Plays on a recording canvas; one entry per drawn frame with the scene time and the camera.
function play(view, stage, frames, reduce = false, opts = {}) {
  reduced = reduce; queue = []; listeners = {}; visibility = 'visible';
  const drawn = [];
  const canvas = fakeCanvas(view, stage, drawn);
  playRally(canvas, opts.rnd, opts.orbit);
  const out = [];
  // Each drawn frame's rectangles are the ones recorded since the previous frame.
  const snap = () => { const sc = canvas.rally.scene; out.push({ t: sc.t, rects: drawn.splice(0), cam: { ...sc.cam }, scene: sc, sc: sc.sc }); };
  snap();
  for (let now = 16; out.length < frames && queue.length; now += 16) { queue.shift()(now); snap(); }
  return { out, canvas };
}

const PHONE = [[393, 852], { left: 0, top: 130, width: 393, height: 520 }];
const TV = [[1920, 1080], { left: 0, top: 240, width: 1920, height: 640 }];
const ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];
const first = (i) => () => (i + 0.5) / SCENES.length;
const netOf = (sc) => sc.nodes.find((n) => n.net);

test('all four points are different: who wins the point and how it is decided', () => {
  expect(SCENES.length).toBe(4);
  expect(SCENES.map((sc) => (sc.nodes.some((n) => n.smash) ? 'smash' : netOf(sc) ? 'net' : 'drop'))).toEqual(['smash', 'smash', 'net', 'drop']);
  expect(SCENES.map((sc) => sc.loser)).toEqual(['far', 'near', 'far', 'near']);
  expect(new Set(SCENES.map((sc) => sc.nodes.filter((n) => n.who).length)).size).toBeGreaterThan(1);
});

test('the ball clears the net on every crossing and never sinks into the table; a net-in touches the tape', () => {
  for (const sc of SCENES) {
    const bad = [];
    let crossings = 0;
    for (let t = 0; t < sc.end; t += 1 / 1000) {
      const a = ballAt(t, sc), b = ballAt(t + 1 / 1000, sc);
      if (a.y * b.y <= 0 && a.y !== b.y) {
        crossings++;
        const z = a.z + ((b.z - a.z) * -a.y) / (b.y - a.y), clipped = netOf(sc) && Math.abs(t - netOf(sc).t) < 0.01;
        if (clipped ? z < NET_TOP || z > NET_TOP + 0.03 : z < NET_TOP + 0.02) bad.push({ t, z });
      }
      if (Math.abs(a.x) <= TW && Math.abs(a.y) <= TL && a.z < 0.78 - 1e-9) bad.push({ t, sank: a.z });
    }
    expect(bad).toEqual([]);
    expect(crossings).toBe(sc.nodes.filter((n) => n.who).length);
  }
});

test('each stroke: the serve bounces once on each side, every return once in the receiver court, the racket is on the ball', () => {
  for (const sc of SCENES) {
    const hits = sc.nodes.filter((n) => n.who);
    const bounces = [];
    for (let t = 0.002; t < sc.end; t += 0.002) {
      const p = ballAt(t - 0.002, sc), c = ballAt(t, sc), n = ballAt(t + 0.002, sc);
      if (c.z < p.z && c.z <= n.z && Math.abs(c.x) <= TW && Math.abs(c.y) <= TL && Math.abs(c.y) > 0.02) bounces.push({ t, side: c.y < 0 ? 'near' : 'far' });
    }
    for (let i = 0; i < hits.length; i++) {
      const from = hits[i].t, to = hits[i + 1]?.t ?? sc.end, other = hits[i].who === 'near' ? 'far' : 'near';
      const sides = bounces.filter((b) => b.t > from && b.t < to).map((b) => b.side);
      expect({ stroke: i, sides }).toEqual({ stroke: i, sides: i === 0 ? [hits[i].who, other] : [other] });
      const r = poseAt(hits[i].who, hits[i].t, sc).racket;
      expect(Math.hypot(r.x - hits[i].x, r.y - hits[i].y, r.z - hits[i].z)).toBeLessThan(1e-9);
      if (i) expect(hits[i].who).not.toBe(hits[i - 1].who);
    }
  }
});

test('drawn frames from every side: near things bigger, ball over the net line where it crosses, scene inside the stage', () => {
  for (const [view, stage] of [PHONE, TV]) for (let i = 0; i < SCENES.length; i++) for (const deg of ANGLES) {
    const sc = SCENES[i];
    const { out } = play(view, stage, Math.ceil((sc.loop * 1000) / 16) - 2, false, { rnd: first(i), orbit: { deg, spin: 0 } });
    expect(out[0].sc).toBe(sc);
    const px = out[0].scene.W / view[0];
    const st = { x0: stage.left * px, y0: stage.top * px, x1: (stage.left + stage.width) * px, y1: (stage.top + stage.height) * px };
    const bad = [];
    for (const f of out) {
      if (f.t >= sc.end) continue;
      const w = ballAt(f.t, sc);
      // The ball is the one opaque ball-yellow square; the smash spark in the same colour is 1 px lines.
      const balls = f.rects.filter((r) => r.c === BALL && r.a === 1 && r.w === r.h && r.w >= 2);
      if (inPlay(w)) expect(balls.length).toBe(1);
      const b = balls[0], [l, r] = netEnds(f.cam), cx = b && b.x + b.w / 2, clipped = netOf(sc) && Math.abs(f.t - netOf(sc).t) < 0.09;
      if (b && deg % 180 === 0 && netOf(sc) && Math.abs(f.t - netOf(sc).t) < 0.004) {
        const netY = l.y + ((cx - l.x) * (r.y - l.y)) / (r.x - l.x);
        if (b.y + b.h < netY - 1) bad.push({ notTouching: f.t, bottom: b.y + b.h, netY }); // the net-in really touches the tape
      }
      if (b && deg % 180 === 0 && !clipped && Math.abs(w.y) < 0.08 && cx > Math.min(l.x, r.x) && cx < Math.max(l.x, r.x)) {
        const netY = l.y + ((cx - l.x) * (r.y - l.y)) / (r.x - l.x);
        if (b.y + b.h + 1 > netY) bad.push({ t: f.t, bottom: b.y + b.h, netY }); // at least 1 px of air over the tape
      }
      for (const who of ['near', 'far']) {
        const p = poseAt(who, f.t, sc), points = [project(f.cam, p.x, p.y, 0), project(f.cam, p.x, p.y, 1.9 + p.jump)];
        if (inPlay(w)) points.push(project(f.cam, w.x, w.y, w.z));
        for (const q of points) if (q.x < st.x0 || q.x > st.x1 || q.y < st.y0 - 1 || q.y > st.y1 + 1) bad.push({ view, i, deg, t: f.t, who, q });
      }
    }
    expect(bad).toEqual([]);
    const cam = out[0].cam, toward = project(cam, -cam.f[0] * 2, -cam.f[1] * 2, 1).p, off = project(cam, cam.f[0] * 2, cam.f[1] * 2, 1).p;
    expect(toward).toBeGreaterThan(off * 1.3);
  }
}, 30000);

// The colour a drawn frame ends up with at canvas pixel (x, y): the last opaque rectangle over it.
const pixelAt = (rects, x, y) => { for (let k = rects.length - 1; k >= 0; k--) { const r = rects[k]; if (r.a === 1 && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r.c; } return null; };
const depthOf = (cam, q) => (q.x - cam.c.x) * cam.f[0] + (q.y - cam.c.y) * cam.f[1] + (q.z - cam.c.z) * cam.f[2];
const WOOD = '#c89a5a', INK = '#080a24';

test('a racket behind the body is hidden by it and one in front of it shows, from every side', () => {
  let hidden = 0, shown = 0;
  const bad = [];
  for (const [view, stage] of [PHONE, TV]) for (let i = 0; i < SCENES.length; i++) for (const deg of ANGLES) {
    const sc = SCENES[i];
    const { out } = play(view, stage, Math.ceil((sc.loop * 1000) / 16) - 2, false, { rnd: first(i), orbit: { deg, spin: 0 } });
    for (const f of out) {
      if (f.t >= sc.end) continue;
      const ball = f.rects.filter((r) => r.c === BALL && r.a === 1 && r.w === r.h && r.w >= 2);
      for (const who of ['near', 'far']) {
        const p = poseAt(who, f.t, sc), o = poseAt(who === 'near' ? 'far' : 'near', f.t, sc);
        // The body's core: a thin column through the middle of the chest, under the head.
        const lo = { x: p.x, y: p.y, z: 1.0 + p.jump }, hi = { x: p.x, y: p.y - p.side * 0.08, z: 1.28 + p.jump };
        const a = project(f.cam, lo.x, lo.y, lo.z), b = project(f.cam, hi.x, hi.y, hi.z), core = Math.max(1, 0.05 * a.p);
        const inCore = (x, y) => { const vx = b.x - a.x, vy = b.y - a.y, k = ((x - a.x) * vx + (y - a.y) * vy) / (vx * vx + vy * vy || 1); return k > 0 && k < 1 && Math.hypot(a.x + vx * k - x, a.y + vy * k - y) <= core; };
        const R = p.racket, rp = project(f.cam, R.x, R.y, R.z), gap = depthOf(f.cam, R) - (depthOf(f.cam, lo) + depthOf(f.cam, hi)) / 2;
        if (Math.abs(gap) < 0.22) continue;
        // Leave out pixels the other player, standing nearer, or the ball (drawn last, outlined) may own.
        const op = project(f.cam, o.x, o.y, 1.1 + o.jump), oNear = depthOf(f.cam, { x: o.x, y: o.y, z: 1.1 }) < depthOf(f.cam, lo);
        // Out to the blade's rim: the face is the shirt's colour, so the racket shows by its outline and handle.
        // Behind: only the core counts. In front: anywhere on the blade, so a racket that is not drawn fails.
        const rr = Math.max(2, 0.16 * rp.p), pix = [];
        // At the hit the ball sits on the blade and is drawn over it, so a racket in front is judged without it.
        if (gap < 0 && ball.some((q) => Math.hypot(q.x + q.w / 2 - rp.x, q.y + q.h / 2 - rp.y) < rr + q.w)) continue;
        for (let y = Math.floor(rp.y - rr); y <= Math.ceil(rp.y + rr); y++) for (let x = Math.floor(rp.x - rr); x <= Math.ceil(rp.x + rr); x++) {
          if (Math.hypot(x + 0.5 - rp.x, y + 0.5 - rp.y) > rr || (gap > 0 && !inCore(x + 0.5, y + 0.5)) || (gap < 0 && !inCore(rp.x, rp.y))) continue;
          if (oNear && Math.abs(x - op.x) < 0.5 * op.p && Math.abs(y - op.y) < 1.1 * op.p) continue;
          if (ball.some((q) => x >= q.x - 2 && x < q.x + q.w + 2 && y >= q.y - 2 && y < q.y + q.h + 2)) continue;
          pix.push(pixelAt(f.rects, x, y));
        }
        if (pix.length < 2) continue;
        const racketInk = pix.filter((c) => c === WOOD || c === INK).length;
        if (gap > 0) { hidden++; if (racketInk) bad.push({ behind: true, view: view[0], i, deg, t: +f.t.toFixed(3), who, racketInk, of: pix.length }); }
        else { shown++; if (!racketInk) bad.push({ inFront: true, view: view[0], i, deg, t: +f.t.toFixed(3), who }); }
      }
    }
  }
  expect(hidden).toBeGreaterThan(50);
  expect(shown).toBeGreaterThan(50);
  const seen = { hidden, shown, behindButDrawn: bad.filter((x) => x.behind).length, inFrontButGone: bad.filter((x) => x.inFront).length };
  expect({ ...seen, first: bad.slice(0, 4) }).toEqual({ hidden, shown, behindButDrawn: 0, inFrontButGone: 0, first: [] });
}, 60000);

test('arms and legs are two bones each that keep their length, bend at elbow and knee, move smoothly, and the racket stays in the hand', () => {
  expect(typeof start.skeleton).toBe('function');
  const { upper, fore, thigh, shin, grip } = start.BONES;
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const angle = (a, j, b) => { const u = [a.x - j.x, a.y - j.y, a.z - j.z], v = [b.x - j.x, b.y - j.y, b.z - j.z]; return (Math.acos((u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v))) * 180) / Math.PI; };
  const bad = [];
  for (const sc of SCENES) for (const who of ['near', 'far']) {
    let prev = null;
    const step = 1 / 120;
    for (let t = 0; t < sc.end; t += step) {
      const k = start.skeleton(who, t, sc), at = { who, t: +t.toFixed(3) };
      for (const A of k.arms) {
        if (Math.abs(d(A.shoulder, A.elbow) - upper) > 1e-6 || Math.abs(d(A.elbow, A.hand) - fore) > 1e-6) bad.push({ ...at, armLength: true });
        const e = angle(A.shoulder, A.elbow, A.hand);
        if (e < 25 || e > 179) bad.push({ ...at, elbow: e });
      }
      for (const L of k.legs) {
        if (Math.abs(d(L.hip, L.knee) - thigh) > 1e-6 || Math.abs(d(L.knee, L.ankle) - shin) > 1e-6) bad.push({ ...at, legLength: true });
        const n = angle(L.hip, L.knee, L.ankle);
        if (n < 70 || n > 179) bad.push({ ...at, knee: n });
        if (L.ankle.z < 0.05) bad.push({ ...at, footInFloor: L.ankle.z });
      }
      // Shoulders and hips sit level across the body, shoulders wider, both above the knees.
      const sw = d(k.arms[0].shoulder, k.arms[1].shoulder), hw = d(k.legs[0].hip, k.legs[1].hip);
      if (!(sw > hw && Math.abs(k.arms[0].shoulder.z - k.arms[1].shoulder.z) < 0.05 && k.legs.every((L) => L.hip.z > L.knee.z))) bad.push({ ...at, frame: { sw, hw } });
      // The racket is in the hand: grip length from the hand, and on the ball at every hit.
      if (Math.abs(d(k.arms[0].hand, k.racket.c) - grip) > 1e-6) bad.push({ ...at, gripOff: d(k.arms[0].hand, k.racket.c) });
      const hit = sc.nodes.find((n) => n.who === who && Math.abs(n.t - t) < step / 2);
      if (hit && d(k.racket.c, hit) > 0.03) bad.push({ ...at, racketOffBall: d(k.racket.c, hit) });
      // No joint jumps between two frames 1/120 s apart (a smash moves the hand fastest, about 12 m/s).
      if (prev) {
        const pairs = [[prev.arms[0].hand, k.arms[0].hand], [prev.arms[0].elbow, k.arms[0].elbow], [prev.arms[1].hand, k.arms[1].hand], [prev.arms[1].elbow, k.arms[1].elbow], [prev.racket.c, k.racket.c], ...k.legs.flatMap((L, i) => [[prev.legs[i].knee, L.knee], [prev.legs[i].ankle, L.ankle]])];
        const jump = Math.max(...pairs.map(([a, b]) => d(a, b)));
        if (jump > 0.12) bad.push({ ...at, jump });
      }
      prev = k;
    }
  }
  expect({ bad: bad.length, first: bad.slice(0, 6) }).toEqual({ bad: 0, first: [] });
});

test('elbows and knees bend the way a person bends, on every scene, through the whole swing and from every side', () => {
  const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // The part of v square to a.
  const off = (v, a) => { const k = dot(v, a) / dot(a, a); return v.map((x, i) => x - k * a[i]); };
  const bad = {}, note = (kind, at) => { (bad[kind] ??= []).push(at); };
  let bentFree = 0;
  for (const [i, sc] of SCENES.entries()) {
    const cams = [PHONE, TV].flatMap(([view, stage]) => ANGLES.map((deg) => ({ view: view[0], deg, cam: play(view, stage, 1, false, { rnd: first(i), orbit: { deg, spin: 0 } }).out[0].cam })));
    for (const who of ['near', 'far']) for (let t = 0; t < sc.end; t += 1 / 120) {
      const k = start.skeleton(who, t, sc), fw = -k.pose.side, at = { i, who, t: +t.toFixed(3) };
      k.arms.forEach((A, arm) => {
        const upper = sub(A.elbow, A.shoulder), reach = sub(A.hand, A.shoulder), point = off(upper, reach), fold = off(sub(A.hand, A.elbow), upper);
        // Hand in front of the shoulder: the forearm folds forward, never back towards the body.
        if (reach[1] * fw > 0.02 && fold[1] * fw < -0.03) note('reversed', { ...at, arm });
        // A really bent free arm hangs its elbow down; the same from every camera, on the drawn screen.
        if (arm === 1 && Math.hypot(...point) > 0.1) {
          bentFree++;
          if (point[2] > -0.08) note('notDown', { ...at, drop: point[2] });
          const mid = { x: (A.shoulder.x + A.hand.x) / 2, y: (A.shoulder.y + A.hand.y) / 2, z: (A.shoulder.z + A.hand.z) / 2 };
          for (const c of cams) if (project(c.cam, A.elbow.x, A.elbow.y, A.elbow.z).y <= project(c.cam, mid.x, mid.y, mid.z).y) note('screenUp', { ...at, view: c.view, deg: c.deg });
        }
      });
      for (const L of k.legs) if (off(sub(L.knee, L.hip), sub(L.ankle, L.hip))[1] * fw < 0.05) note('kneeBack', at);
    }
  }
  expect(bentFree).toBeGreaterThan(1000);
  expect(Object.entries(bad).map(([kind, l]) => ({ kind, n: l.length, first: l[0] }))).toEqual([]);
}, 30000);

test('the free arm folds in a narrow V, elbow to the floor and hand up in front, on every scene, all through, from every side', () => {
  const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const off = (v, a) => { const k = dot(v, a) / dot(a, a); return v.map((x, i) => x - k * a[i]); };
  const deg = (u, v) => Math.acos(dot(u, v) / Math.hypot(...u) / Math.hypot(...v)) * 180 / Math.PI;
  const turns = Array.from({ length: 24 }, (_, j) => j * 15);
  const bad = {}, note = (kind, at) => { (bad[kind] ??= []).push(at); };
  let checked = 0;
  for (const [i, sc] of SCENES.entries()) {
    const cams = [PHONE, TV].flatMap(([view, stage]) => turns.map((d) => ({ view: view[0], d, cam: play(view, stage, 1, false, { rnd: first(i), orbit: { deg: d, spin: 0 } }).out[0].cam })));
    for (const who of ['near', 'far']) for (let t = 0; t < sc.end; t += 1 / 120) {
      // The server's free hand holds the ball out over the table until the toss, then folds in.
      if (who === sc.nodes[0].hand && t < 0.3) continue;
      const k = start.skeleton(who, t, sc), A = k.arms[1], at = { i, who, t: +t.toFixed(3) };
      checked++;
      const e = deg(sub(A.shoulder, A.elbow), sub(A.hand, A.elbow));
      if (e < 25 || e > 60) note('angle', { ...at, e });
      if (!(A.elbow.z < A.shoulder.z)) note('elbowAboveShoulder', at);
      if (!(A.elbow.z < A.hand.z)) note('elbowAboveHand', at);
      // The elbow points at the floor: the way it sticks out of the shoulder-hand line is mostly down.
      const point = off(sub(A.elbow, A.shoulder), sub(A.hand, A.shoulder));
      if (!(point[2] < 0 && -point[2] > Math.abs(point[0]) && -point[2] > Math.abs(point[1]))) note('notFloor', { ...at, point });
      for (const c of cams) {
        const P = (q) => project(c.cam, q.x, q.y, q.z).y, y = P(A.elbow);
        if (!(y > P(A.shoulder) && y > P(A.hand))) note('screenNotV', { ...at, view: c.view, deg: c.d });
        // With the shoulders square to the camera (their line within 20 degrees of the screen's), the elbow
        // sits beside the shirt, not hidden behind it: at least three quarters of the 0.09 m upper arm
        // clear of the 0.3 m shirt. Shoulders turned further away hide the far arm, as on a real body.
        const sx = k.arms[0].shoulder.x - k.arms[1].shoulder.x, sy = k.arms[0].shoulder.y - k.arms[1].shoulder.y;
        if (Math.abs(sx * c.cam.r[0] + sy * c.cam.r[1]) >= Math.cos(Math.PI / 9) * Math.hypot(sx, sy) * Math.hypot(c.cam.r[0], c.cam.r[1])) {
          const scale = project(c.cam, k.pose.x, k.pose.y, 1).p;
          const beside = Math.abs(project(c.cam, A.elbow.x, A.elbow.y, A.elbow.z).x - project(c.cam, k.chest.x, k.chest.y, k.chest.z).x) / scale;
          if (beside < 0.15 + 0.09 / 4) note('hiddenByShirt', { ...at, view: c.view, deg: c.d, beside });
        }
      }
    }
  }
  expect(checked).toBeGreaterThan(4000);
  expect(Object.entries(bad).map(([kind, l]) => ({ kind, n: l.length, first: l[0] }))).toEqual([]);
}, 30000);

test('reduced motion: one still frame of the deciding moment from the front, no animation loop', () => {
  for (let i = 0; i < SCENES.length; i++) {
    const { out } = play(...PHONE, 5, true, { rnd: first(i) });
    expect(out.length).toBe(1);
    expect(queue.length).toBe(0);
    const sc = SCENES[i], b = ballAt(out[0].t, sc);
    expect(out[0].cam.deg).toBe(0);
    expect(Math.abs(b.y)).toBeLessThan(0.2);
    expect(b.z).toBeGreaterThan(NET_TOP);
  }
});

test('the next point is picked at random and is never the one just played', () => {
  const seen = new Set();
  let prev = pickScene(-1);
  for (let i = 0; i < 2000; i++) {
    const next = pickScene(prev);
    expect(next).not.toBe(prev);
    seen.add(next);
    prev = next;
  }
  expect(seen.size).toBe(SCENES.length);
  let n = 0;
  const { canvas } = play(...PHONE, Math.ceil(30000 / 16), false, { rnd: () => (n++ * 0.37) % 1 });
  const { played } = canvas.rally;
  expect(played.length).toBeGreaterThan(2);
  expect(played.every((p, i) => !i || p !== played[i - 1])).toBe(true);
}, 30000);

test('the camera keeps turning round the table, one turn in 24 s, and a new view swaps in whole', () => {
  const { out } = play(...PHONE, 800);
  const degs = out.map((f) => f.cam.deg);
  expect(degs.at(-1)).toBeGreaterThan(90);
  expect(degs.every((d, i) => !i || d >= degs[i - 1])).toBe(true);
  expect(new Set(degs).size).toBeGreaterThan(20);
  expect(project(out[0].cam, 0, -2, 1).p).toBeGreaterThan(project(out[0].cam, 0, 2, 1).p);
  const after = out.at(-1).cam;
  expect(Math.atan2(after.c.y, after.c.x)).not.toBeCloseTo(Math.atan2(out[0].cam.c.y, out[0].cam.c.x), 1);
  // Each camera stays on its circle: same height, same distance from the table's centre.
  for (const f of out) { expect(f.cam.c.z).toBe(out[0].cam.c.z); expect(Math.hypot(f.cam.c.x, f.cam.c.y)).toBeCloseTo(Math.hypot(out[0].cam.c.x, out[0].cam.c.y), 6); }
}, 30000);

test('a hidden tab stops drawing and a visible one resumes', () => {
  const { canvas } = play(...PHONE, 3);
  visibility = 'hidden';
  listeners.visibilitychange();
  const before = canvas.rally.scene.frames;
  for (let now = 2000; queue.length; now += 16) queue.shift()(now);
  expect(canvas.rally.scene.frames).toBe(before);
  visibility = 'visible';
  listeners.visibilitychange();
  expect(queue.length).toBe(1);
  queue.shift()(3000);
  expect(canvas.rally.scene.frames).toBe(before + 1);
});

test('the loop clock maps onto the whole scene and holds the last picture', () => {
  for (const sc of SCENES) {
    expect(sceneTime(0, sc)).toBe(0);
    expect(sceneTime(sc.loop - 1e-6, sc)).toBeGreaterThan(sc.end);
    for (let r = 0; r < sc.loop - 0.02; r += 0.01) expect(sceneTime(r + 0.01, sc)).toBeGreaterThanOrEqual(sceneTime(r, sc));
  }
});

test('START is drawn with its whole outline inside the canvas', () => {
  const dots = [];
  const c = { width: 0, height: 0, getContext: () => ({ fillStyle: '', fillRect: (x, y, w, h) => dots.push([x, y, w, h]) }) };
  drawStartWord(c);
  expect(dots.length).toBeGreaterThan(100);
  expect(dots.every(([x, y, w, h]) => x >= 0 && y >= 0 && x + w <= c.width && y + h <= c.height)).toBe(true);
});

// The red ribbon behind VISION, measured on its drawn pixels in the logo's grid: it shows past
// VISION's letters on both sides, its two ends mirror each other in the band's own 13-degree lean (a
// pixel's mirror is found within one pixel for 97% of them), and it stays inside its picture. The
// lines are drawn over it (the start screen's DOM order), so it cannot cover a letter.
test('the title ribbon sits behind VISION, its ends mirrored in its lean, inside its picture', () => {
  const drawn = start.titleRibbon?.();
  expect(drawn).toBeDefined();
  const { px, W, H } = drawn, lines = TITLE_LINES.map((l) => titleLine(...l)), top = Math.round(lines[0].H - 0.05 * W);
  const lit = (x, y) => x >= 0 && x < W && y >= 0 && y < H && px[(y * W + x) * 4 + 3] > 0;
  const lean = Math.tan((13 * Math.PI) / 180), dots = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (lit(x, y)) dots.push([x, y]);
  let mirrored = 0;
  for (const [x, y] of dots) {
    const slide = (78 - (y + 0.5)) * lean, mx = Math.round(W - (x + 0.5 - slide) + slide - 0.5);
    if (lit(mx - 1, y) || lit(mx, y) || lit(mx + 1, y)) mirrored++;
  }
  // VISION's letters row by row (outline included); ribbon pixels outside them on each side.
  let left = 0, right = 0;
  for (const [x, y] of dots) {
    const r = y - top;
    if (r < 0 || r >= lines[1].H) continue;
    const xs = [];
    for (let i = 0; i < W; i++) { const k = (r * W + i) * 4; if (lines[1].px[k + 3] && hexAt(lines[1].px, k) === '#090a24') xs.push(i); }
    if (!xs.length) continue;
    if (x < xs[0]) left++; else if (x > xs.at(-1)) right++;
  }
  const xs = dots.map(([x]) => x), ys = dots.map(([, y]) => y);
  expect({
    besideVision: left > 0 && right > 0,
    mirrored: mirrored / dots.length >= 0.97,
    inside: Math.min(...xs) > 0 && Math.max(...xs) < W - 1 && Math.min(...ys) > 0 && Math.max(...ys) < H - 1,
  }).toEqual({ besideVision: true, mirrored: true, inside: true });
});

// Fire streaks on both sides, matching: each line's streaks, counted by their own colours (VISION's
// white is left out, the letters use it too), show on the left and the right half alike, within a
// tenth of each other. PINGPONG's show on both sides; VISION's all sit at the ribbon's height, where
// the ribbon stands in front, so none of them show.
test('the title fire streaks out on both sides of PINGPONG, matching left and right; the ribbon hides VISION\'s', () => {
  const counts = TITLE_LINES.map((line) => {
    const { px, H, W } = titleLine(...line), fire = new Set(line[2].fire.filter((c) => c !== '#ffffff'));
    let left = 0, right = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px[(y * W + x) * 4 + 3] && fire.has(hexAt(px, (y * W + x) * 4))) x < W / 2 ? left++ : right++;
    return { left, right };
  });
  const [pp, vi] = counts;
  expect({ pingpongBoth: pp.left > 0 && pp.right > 0, pingpongEven: Math.abs(pp.left - pp.right) <= 0.1 * Math.max(pp.left, pp.right), visionHidden: vi.left === 0 && vi.right === 0 })
    .toEqual({ pingpongBoth: true, pingpongEven: true, visionHidden: true });
});

test('the drawn title: both lines keep their whole outline inside the canvas, no letter is cut', () => {
  for (const line of TITLE_LINES) {
    const { px, H, W } = titleLine(...line);
    let x0 = W, x1 = -1, y0 = H, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (px[i] === 0x09 && px[i + 1] === 0x0a && px[i + 2] === 0x24 && px[i + 3] === 255) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    expect(x1).toBeGreaterThan(x0);
    expect([x0 > 0, x1 < W - 1, y0 > 0, y1 < H - 1]).toEqual([true, true, true, true]);
  }
});
