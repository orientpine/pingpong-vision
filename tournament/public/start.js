// The start screen's scene: a pixel-art arena and four short points played in random order on one
// low-resolution canvas scaled up with crisp pixels. Everything is drawn from code through one camera, so the far end is
// really smaller than the near end and no image is added to the first load. The arena is ray-cast
// once per size into an offscreen canvas; the moving layer is plain rectangles. With reduced motion it
// stays on one still frame, the deciding shot of one point.
const TABLE_Z = 0.76, TABLE_L = 1.37, TABLE_W = 0.7625, NET_H = 0.1525, BOUNCE_Z = TABLE_Z + 0.02, G = 9.8;
export const NET_TOP = TABLE_Z + NET_H;
const ZOOM_MAX = 1.09, FADE = 0.3, ORBIT_DEG_PER_S = 15, FIT_STEP = 10, SLICE_MS = 8;

// '#ffd34d' is the ball's colour alone, so its pixels on the canvas are the ball (QA reads them).
// The ball's path, in table metres (x across, y along: near player at -y, z up from the floor).
// who = a racket hit; bounce = the court it lands in; net = it clips the top of the net and drops over.
// Between two nodes it flies a parabola. stand = how far back that player is for that hit.
const SERVE_AND_SMASH = [
  { t: 0, x: -0.42, y: -1.62, z: 1.0, hand: 'near' },
  { t: 0.8, x: -0.4, y: -1.6, z: 1.04, who: 'near' },
  { t: 0.98, x: -0.3, y: -0.75, z: BOUNCE_Z, bounce: 'near' },
  { t: 1.5, x: 0.3, y: 0.8, z: BOUNCE_Z, bounce: 'far' },
  { t: 1.78, x: 0.42, y: 1.75, z: 1.28, who: 'far' },
  { t: 2.18, x: -0.38, y: -0.8, z: BOUNCE_Z, bounce: 'near' },
  { t: 2.46, x: -0.5, y: -1.75, z: 1.28, who: 'near' },
  { t: 2.86, x: 0.45, y: 0.7, z: BOUNCE_Z, bounce: 'far' },
  { t: 3.12, x: 0.3, y: 1.7, z: 0.95, who: 'far' },
  { t: 4.0, x: -0.2, y: -0.85, z: BOUNCE_Z, bounce: 'near' },
  { t: 4.62, x: -0.1, y: -1.25, z: 1.85, who: 'near', smash: true },
  { t: 4.82, x: 0.42, y: 0.95, z: BOUNCE_Z, bounce: 'far' },
  { t: 5.5, x: 0.78, y: 3.4, z: 1.05 },
  { t: 5.9, x: 0.9, y: 5.0, z: 0.05 },
];
// The far player backs off and lobs two attacks back, then jumps on the first short ball.
const DEFENCE_AND_COUNTER = [
  { t: 0, x: 0.42, y: 1.62, z: 1.0, hand: 'far' },
  { t: 0.8, x: 0.4, y: 1.6, z: 1.04, who: 'far' },
  { t: 0.98, x: 0.3, y: 0.75, z: BOUNCE_Z, bounce: 'far' },
  { t: 1.5, x: -0.25, y: -0.8, z: BOUNCE_Z, bounce: 'near' },
  { t: 1.78, x: -0.4, y: -1.75, z: 1.3, who: 'near' },
  { t: 2.1, x: 0.45, y: 1.0, z: BOUNCE_Z, bounce: 'far' },
  { t: 2.5, x: 0.55, y: 2.75, z: 0.85, who: 'far', stand: 2.6 },
  { t: 3.35, x: -0.1, y: -0.7, z: BOUNCE_Z, bounce: 'near' },
  { t: 3.62, x: -0.2, y: -1.7, z: 1.6, who: 'near' },
  { t: 3.9, x: -0.5, y: 1.05, z: BOUNCE_Z, bounce: 'far' },
  { t: 4.3, x: -0.6, y: 2.8, z: 0.8, who: 'far', stand: 2.65 },
  { t: 5.15, x: 0.2, y: -0.8, z: BOUNCE_Z, bounce: 'near' },
  { t: 5.45, x: 0.3, y: -1.75, z: 1.15, who: 'near' },
  { t: 6.0, x: 0.05, y: 0.55, z: BOUNCE_Z, bounce: 'far' },
  { t: 6.3, x: 0.02, y: 1.2, z: 1.8, who: 'far', smash: true },
  { t: 6.5, x: -0.5, y: -0.9, z: BOUNCE_Z, bounce: 'near' },
  { t: 6.85, x: -0.8, y: -2.6, z: 1.0 },
  { t: 7.15, x: -0.95, y: -3.6, z: 0.05 },
];
// A fast flat rally, then the near player's drive clips the net and dies just over it.
const NET_IN = [
  { t: 0, x: 0.42, y: -1.62, z: 1.0, hand: 'near' },
  { t: 0.8, x: 0.4, y: -1.6, z: 1.04, who: 'near' },
  { t: 0.98, x: 0.3, y: -0.75, z: BOUNCE_Z, bounce: 'near' },
  { t: 1.5, x: -0.3, y: 0.8, z: BOUNCE_Z, bounce: 'far' },
  { t: 1.78, x: -0.42, y: 1.75, z: 1.25, who: 'far' },
  { t: 2.14, x: 0.4, y: -0.75, z: BOUNCE_Z, bounce: 'near' },
  { t: 2.4, x: 0.5, y: -1.75, z: 1.35, who: 'near' },
  { t: 2.76, x: -0.45, y: 0.75, z: BOUNCE_Z, bounce: 'far' },
  { t: 3.02, x: -0.5, y: 1.75, z: 1.2, who: 'far' },
  { t: 3.38, x: 0.1, y: -0.8, z: BOUNCE_Z, bounce: 'near' },
  { t: 3.64, x: 0.15, y: -1.75, z: 1.2, who: 'near' },
  { t: 3.88, x: 0.05, y: 0, z: NET_TOP + 0.015, net: true },
  { t: 4.16, x: -0.1, y: 0.38, z: BOUNCE_Z, bounce: 'far' },
  { t: 4.76, x: -0.3, y: 1.7, z: 0.55 },
  { t: 5.0, x: -0.35, y: 2.2, z: 0.05 },
];
// Both players deep in a slow rally, then the far player stops the ball dead over the net and it
// breaks away from the near player, who lunges the wrong way (seen beside him from the front).
const DROP_SHOT = [
  { t: 0, x: -0.42, y: 1.62, z: 1.0, hand: 'far' },
  { t: 0.8, x: -0.4, y: 1.6, z: 1.04, who: 'far' },
  { t: 0.98, x: -0.3, y: 0.75, z: BOUNCE_Z, bounce: 'far' },
  { t: 1.5, x: 0.35, y: -0.8, z: BOUNCE_Z, bounce: 'near' },
  { t: 1.8, x: 0.45, y: -1.85, z: 1.2, who: 'near', stand: -2.15 },
  { t: 2.25, x: -0.4, y: 0.9, z: BOUNCE_Z, bounce: 'far' },
  { t: 2.55, x: -0.5, y: 1.8, z: 1.15, who: 'far' },
  { t: 3.05, x: 0.4, y: -0.9, z: BOUNCE_Z, bounce: 'near' },
  { t: 3.38, x: 0.5, y: -2.0, z: 1.1, who: 'near', stand: -2.3 },
  { t: 3.88, x: 0.05, y: 1.0, z: BOUNCE_Z, bounce: 'far' },
  { t: 4.12, x: -0.1, y: 1.5, z: 1.22, who: 'far' },
  { t: 4.77, x: -0.15, y: -0.3, z: BOUNCE_Z, bounce: 'near', climax: true },
  { t: 5.12, x: -0.85, y: -0.5, z: 0.9 },
  { t: 5.47, x: -1.0, y: -0.6, z: 0.05 },
];

// One short point. Its deciding moment runs in slow motion, then the last picture holds, all timed
// from that moment. power = how hard the screen reacts to it; loser = where the beaten player lunges.
function point(nodes, loser, opts) {
  const deciding = nodes.find((n) => n.smash || n.climax || n.net), c = deciding.t;
  const warp = [[0, 0], [c - 0.07, c - 0.07], [c + 0.08, c], [c + 1.18, c + 0.24], [c + 1.58, c + 0.88], [c + 1.88, c + 1.28], [c + 3.78, c + 1.68]];
  const at = c + (opts?.still ?? 0.11), i = warp.findIndex((w) => w[1] > at), [r0, s0] = warp[i - 1], [r1, s1] = warp[i];
  return { nodes, climax: c, end: nodes.at(-1).t, loop: c + 3.78, warp, loser: 'far', lunge: loser, lungeAt: c, power: 1, ...opts, still: r0 + ((at - s0) * (r1 - r0)) / (s1 - s0) };
}

export const SCENES = [
  point(SERVE_AND_SMASH, { x: 1.15 }),
  point(DEFENCE_AND_COUNTER, { x: -1.05, y: -1.9 }, { loser: 'near' }),
  point(NET_IN, { x: -0.25, y: 1.6 }, { power: 0.5, still: 0 }),
  point(DROP_SHOT, { x: 0.6, y: -1.6 }, { loser: 'near', lungeAt: 4.17, power: 0, still: -0.05 }),
];
export const NODES = SCENES[0].nodes;
export const LOOP = SCENES[0].loop;
export const STILL_REAL = SCENES[0].still;

// The next point to play: any but the one just played (-1 on the first).
export function pickScene(prev, rnd = Math.random) {
  const n = SCENES.length;
  return prev < 0 ? Math.floor(rnd() * n) : (prev + 1 + Math.floor(rnd() * (n - 1))) % n;
}

export function ballAt(t, sc = SCENES[0]) {
  const nodes = sc.nodes;
  if (t >= sc.end) return { x: nodes.at(-1).x, y: nodes.at(-1).y, z: nodes.at(-1).z };
  let i = 0;
  while (t >= nodes[i + 1].t) i++;
  const a = nodes[i], b = nodes[i + 1], d = b.t - a.t, s = t - a.t, k = s / d;
  const v = (b.z - a.z + (G * d * d) / 2) / d;
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + v * s - (G * s * s) / 2 };
}

// Loop time to scene time.
export function sceneTime(r, sc = SCENES[0]) {
  const c = ((r % sc.loop) + sc.loop) % sc.loop, warp = sc.warp;
  let i = 0;
  while (c > warp[i + 1][0]) i++;
  const [r0, s0] = warp[i], [r1, s1] = warp[i + 1];
  return s0 + ((s1 - s0) * (c - r0)) / (r1 - r0);
}

const ease = (k) => k * k * (3 - 2 * k);
const clamp01 = (k) => Math.min(1, Math.max(0, k));
const mix = (a, b, k) => a + (b - a) * k;

// Where a player stands and where the racket is at scene time t. At a hit the racket is on the ball.
export function poseAt(who, t, sc = SCENES[0]) {
  const hits = sc.nodes.filter((n) => n.who === who), side = who === 'near' ? -1 : 1, lefty = who === 'near' ? 1 : -1;
  const next = hits.find((h) => h.t >= t) ?? hits.at(-1);
  const prev = hits.findLast((h) => h.t < t) ?? hits[0];
  const standAt = (h) => h.x - 0.34 * lefty;
  const k = next === prev ? 1 : ease(clamp01((t - prev.t) / Math.max(0.01, next.t - prev.t)));
  let x = mix(standAt(prev), standAt(next), k);
  const standBack = (h) => h.stand ?? side * (TABLE_L + 0.62);
  let y = mix(standBack(prev), standBack(next), k);
  let jump = 0;
  const smash = sc.nodes.find((n) => n.smash);
  if (smash?.who === who) {
    jump = 0.42 * Math.sin(Math.PI * clamp01((t - smash.t + 0.34) / 0.86));
    if (t > smash.t - 0.72) y = mix(y, smash.y + side * 0.62, clamp01((t - smash.t + 0.72) / 0.5));
  } else if (sc.loser === who && t > sc.lungeAt) {
    const k = ease(clamp01((t - sc.lungeAt - 0.08) / 0.7)); // a lunge that does not reach the winner
    x = mix(x, sc.lunge.x, k);
    if (sc.lunge.y !== undefined) y = mix(y, sc.lunge.y, k);
  }
  const near = hits.reduce((b, h) => (Math.abs(h.t - t) < Math.abs(b.t - t) ? h : b), hits[0]);
  const rel = t - near.t;
  const w = 1 - ease(clamp01((Math.abs(rel) - 0.16) / 0.3));
  const reach = near.smash ? 1.5 : 0.75;
  const swing = rel < 0 ? rel * reach : rel * reach * 0.7;
  const onHit = { x: near.x + swing * lefty * 1.2, y: near.y + (rel < 0 ? 1 : -1) * swing * side * 0.9 + (rel > 0 ? 0 : 0), z: near.z + (near.smash ? -rel * 2.4 : Math.abs(rel) * 0.3) };
  const idle = { x: x + 0.3 * lefty, y: y - side * 0.34, z: 1.0 + jump };
  const racket = { x: mix(idle.x, onHit.x, w), y: mix(idle.y, onHit.y, w), z: mix(idle.z, onHit.z, w) };
  // An arm and a racket reach only so far: a big backswing stays within it (every hit is well inside).
  const sh = { x: x + 0.17 * lefty, y: y - side * 0.1, z: 1.28 + jump }, far = Math.hypot(racket.x - sh.x, racket.y - sh.y, racket.z - sh.z);
  if (far > REACH) for (const k of ['x', 'y', 'z']) racket[k] = sh[k] + ((racket[k] - sh[k]) * REACH) / far;
  return { x, y, jump, racket, side, lefty, stride: Math.sin(t * 7) * 0.05 };
}

// One camera on a circle around the table, tilted down as if from the stands. deg 0 is the front.
function aimCamera(W, H, stage, deg) {
  const tall = stage.h > stage.w * 1.05, a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const turn = (x, y) => [x * cos - y * sin, x * sin + y * cos];
  const [cx, cy] = tall ? turn(0.9, -6.8) : turn(2.6, -7.4), [lx, ly] = turn(0, 0.6);
  const c = { x: cx, y: cy, z: tall ? 4.4 : 3.1 };
  let fx = lx - c.x, fy = ly - c.y, fz = (tall ? 1.3 : 1.9) - c.z;
  const fl = Math.hypot(fx, fy, fz);
  fx /= fl; fy /= fl; fz /= fl;
  let rx = fy, ry = -fx;
  const rl = Math.hypot(rx, ry);
  rx /= rl; ry /= rl;
  const ux = ry * fz, uy = -rx * fz, uz = rx * fy - ry * fx;
  return { c, f: [fx, fy, fz], r: [rx, ry], u: [ux, uy, uz], s: 1, ox: 0, oy: 0, W, H, cx: stage.x + stage.w / 2, cy: stage.y + stage.h / 2, zoom: 1, dx: 0, dy: 0, deg, tall };
}

// The ball counts while it is near the table; once it has flown past, it may leave the stage.
export const inPlay = (b) => Math.abs(b.x) < 1.2 && Math.abs(b.y) < 2.0;

// Scale and offset that keep everything moving in this point inside the stage from this angle. Each
// point is fitted on its own, so a deep defender does not shrink the other three.
function fitCamera(cam, stage, sc) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  const add = (x, y, z) => { const p = raw(cam, x, y, z); x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); };
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) add(sx * TABLE_W, sy * TABLE_L, 0);
  for (let t = 0; t < sc.end + 0.4; t += 0.06) {
    const b = ballAt(t, sc);
    if (inPlay(b)) add(b.x, b.y, b.z);
    for (const who of ['near', 'far']) {
      const p = poseAt(who, t, sc);
      add(p.x - 0.35, p.y, 0); add(p.x + 0.35, p.y, 0); add(p.x, p.y, 1.9 + p.jump); add(p.racket.x, p.racket.y, p.racket.z);
    }
  }
  const room = cam.tall ? 0.9 : 0.56, s = Math.min((stage.w * room) / ZOOM_MAX / (x1 - x0), (stage.h * (cam.tall ? 0.94 : 0.8)) / ZOOM_MAX / (y1 - y0));
  return { s, ox: cam.cx - (s * (x0 + x1)) / 2, oy: cam.cy - (s * (y0 + y1)) / 2 };
}

// The camera at any angle, its fit read off a table made once per screen size so it changes smoothly.
function cameraAt(s, deg, sc) {
  const d = ((deg % 360) + 360) % 360, cam = aimCamera(s.W, s.H, s.stage, d), fits = s.fits[sc];
  const i = Math.floor(d / FIT_STEP), k = (d - i * FIT_STEP) / FIT_STEP, a = fits[i], b = fits[(i + 1) % fits.length];
  cam.s = mix(a.s, b.s, k); cam.ox = mix(a.ox, b.ox, k); cam.oy = mix(a.oy, b.oy, k);
  return cam;
}

function raw(cam, x, y, z) {
  const dx = x - cam.c.x, dy = y - cam.c.y, dz = z - cam.c.z;
  const d = dx * cam.f[0] + dy * cam.f[1] + dz * cam.f[2];
  return { x: (dx * cam.r[0] + dy * cam.r[1]) / d, y: -(dx * cam.u[0] + dy * cam.u[1] + dz * cam.u[2]) / d, d };
}

// World to canvas pixels, zoom and shake included. p is pixels per metre at that depth.
export function project(cam, x, y, z) {
  const q = raw(cam, x, y, z);
  const sx = cam.ox + cam.s * q.x, sy = cam.oy + cam.s * q.y;
  return { x: cam.cx + (sx - cam.cx) * cam.zoom + cam.dx, y: cam.cy + (sy - cam.cy) * cam.zoom + cam.dy, p: (cam.s * cam.zoom) / q.d, d: q.d };
}

const behind = (p) => p.d !== undefined && p.d < 0.5;

function poly(g, pts, color) {
  if (pts.some(behind)) return;
  g.fillStyle = color;
  const n = pts.length;
  const top = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y)))), bot = Math.min(4096, Math.ceil(Math.max(...pts.map((p) => p.y))));
  for (let y = top; y <= bot; y++) {
    let a = 1e9, b = -1e9;
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      if (y + 0.5 < Math.min(p.y, q.y) || y + 0.5 > Math.max(p.y, q.y) || p.y === q.y) continue;
      const x = p.x + ((y + 0.5 - p.y) * (q.x - p.x)) / (q.y - p.y);
      a = Math.min(a, x); b = Math.max(b, x);
    }
    if (b >= a) g.fillRect(Math.round(a), y, Math.max(1, Math.round(b) - Math.round(a)), 1);
  }
}

function line(g, a, b, w, color) {
  if (behind(a) || behind(b)) return;
  g.fillStyle = color;
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, w * 0.6)));
  const s = Math.max(1, Math.round(w));
  for (let i = 0; i <= n; i++) g.fillRect(Math.round(a.x + ((b.x - a.x) * i) / n - s / 2), Math.round(a.y + ((b.y - a.y) * i) / n - s / 2), s, s);
}

// The arena is one convex room: floor, roof, raked stands on four sides, walls above them. A ray ends
// on the nearest plane; the floor is polished, so it also shows what a mirrored ray sees.
const ROOF = 8.4, A = 7.5, K = 1.25, TOP = 3.4, WALL = A + K * TOP, FAR_B = 11, NEAR_B = 12;
const CROWD = [[255, 92, 150], [255, 211, 77], [90, 220, 255], [240, 240, 255], [226, 60, 70], [80, 120, 240], [60, 70, 130]];
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const hash = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
const rgb = [0, 0, 0];
const set = (r, g, b) => { rgb[0] = r; rgb[1] = g; rgb[2] = b; };

function trace(ox, oy, oz, dx, dy, dz, bounce, hits, px) {
  let t = 1e9, id = 0;
  const hit = (u, n) => { if (u > 1e-4 && u < t) { t = u; id = n; } };
  if (dz < 0) hit(-oz / dz, 1);
  if (dz > 0) hit((ROOF - oz) / dz, 2);
  const sx = dx >= 0 ? 1 : -1;
  hit((sx * (A + K * oz) - ox) / (dx - sx * K * dz), 3);
  hit((sx * WALL - ox) / dx, 4);
  hit((FAR_B + K * oz - oy) / (dy - K * dz), 5);
  hit((FAR_B + K * TOP - oy) / dy, 6);
  hit((-NEAR_B - K * oz - oy) / (dy + K * dz), 7);
  hit((-NEAR_B - K * TOP - oy) / dy, 6);
  const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
  if (id === 1) {
    const inCourt = Math.abs(x) < 4 && Math.abs(y) < 6.5;
    const line = inCourt && (Math.abs(Math.abs(x) - 3.9) < 0.07 || Math.abs(Math.abs(y) - 6.4) < 0.07);
    const spot = Math.max(0, 1 - Math.hypot(x / 6.5, y / 8));
    const plank = Math.floor(x * 1.4) % 2 ? 0.92 : 1;
    const l = (0.35 + 1.25 * spot) * plank;
    if (line) set(240, 240, 255);
    else if (inCourt) set(24 * l, 58 * l, 150 * l);
    else set(70 * l, 24 * l, 74 * l);
    if (!bounce) {
      const r = rgb[0], g = rgb[1], b = rgb[2], fres = 0.3 + 0.35 * clamp01(1 + dz * 2);
      trace(x, y, 0.001, dx, dy, -dz, 1, hits, px);
      set(r * (1 - fres) + rgb[0] * fres, g * (1 - fres) + rgb[1] * fres, b * (1 - fres) + rgb[2] * fres);
    }
  } else if (id === 2) {
    const rib = Math.abs((y + 40) % 4 - 2) < 0.22 || Math.abs((x + 40) % 4 - 2) < 0.16;
    const lamp = Math.abs(x) < 6.2 && Math.abs(y) < 8 && ((x + 40) % 2.4) < 0.5 && ((y + 40) % 2.4) < 0.5;
    if (lamp) set(255, 240, 190);
    else if (rib) set(62, 66, 128);
    else set(16, 16, 50);
  } else if (id === 3 || id === 5 || id === 7) {
    const u = id === 3 ? y : x;
    const row = Math.floor(z / 0.5), col = Math.floor(u / 0.34), aisle = ((col % 16) + 16) % 16 < 1;
    const fade = (0.28 + 0.42 * clamp01(1 - z / TOP)) * (0.35 + 0.65 * clamp01((t - 6) / 10));
    if (aisle || ((z / 0.5) % 1) < 0.3 || hash(col, row + 9) < 0.18) set(26 * fade, 24 * fade, 70 * fade);
    else {
      const c = CROWD[Math.floor(hash(row, col + id * 40) * CROWD.length)];
      set(c[0] * fade, c[1] * fade, c[2] * fade);
      if (px && hits && !bounce && hash(col, row) > 0.55) hits.push(px);
    }
  } else {
    const ring = z > TOP && z < TOP + 1.4;
    const u = id === 4 ? y : x;
    if (ring) {
      const b = Math.floor((u + 60) / 1.6);
      const on = ((z - TOP) / 1.4 * 4) % 1 < 0.7;
      const c = b % 3 === 0 ? [255, 70, 150] : b % 3 === 1 ? [70, 210, 255] : [255, 200, 70];
      const k = on ? 0.68 : 0.22;
      set(c[0] * k, c[1] * k, c[2] * k);
    } else {
      const col = Math.abs((u + 60) % 6 - 3) < 0.4;
      set(col ? 44 : 20, col ? 44 : 20, col ? 96 : 60);
    }
  }
}

function paintRow(img, cam, W, y, flashes) {
  const d = img.data, [fx, fy, fz] = cam.f, [rx, ry] = cam.r, [ux, uy, uz] = cam.u, c = cam.c;
  for (let x = 0; x < W; x++) {
    const a = (x + 0.5 - cam.ox) / cam.s, b = -(y + 0.5 - cam.oy) / cam.s;
    trace(c.x, c.y, c.z, fx + rx * a + ux * b, fy + ry * a + uy * b, fz + uz * b, 0, flashes, (y << 16) | x);
    const dith = BAYER[(x & 3) + (y & 3) * 4] - 7.5, i = (y * W + x) * 4;
    for (let k = 0; k < 3; k++) d[i + k] = Math.min(255, Math.max(0, Math.round((rgb[k] + dith * 2.2) / 12) * 12));
    d[i + 3] = 255;
  }
}

function paintDressing(g, cam) {
  const P = (x, y, z) => project(cam, x, y, z);
  // Roof trusses: a bowed lower chord with diagonals, one every 4 m along the hall.
  for (let y = -2; y <= 14; y += 4) {
    const low = (x) => ROOF - 0.7 - 1.1 * (1 - (x / 15) ** 2);
    for (let x = -15; x < 15; x += 2.5) {
      line(g, P(x, y, low(x)), P(x + 2.5, y, low(x + 2.5)), 1, '#7f88d8');
      line(g, P(x, y, ROOF), P(x + 2.5, y, low(x + 2.5)), 1, '#3d4390');
      line(g, P(x + 2.5, y, low(x + 2.5)), P(x + 2.5, y, ROOF), 1, '#3d4390');
    }
  }
  // Light pylons at the four corners of the court, with a lamp bank each.
  for (const [x, y] of [[-6.8, -3], [6.8, -3], [-6.8, 9], [6.8, 9]]) {
    const w = 0.22;
    poly(g, [P(x - w, y, 0), P(x + w, y, 0), P(x + w, y, 5.4), P(x - w, y, 5.4)], '#2c3072');
    poly(g, [P(x + w * 0.2, y, 0), P(x + w, y, 0), P(x + w, y, 5.4), P(x + w * 0.2, y, 5.4)], '#555cc0');
    poly(g, [P(x - 1, y, 5.2), P(x + 1, y, 5.2), P(x + 1, y, 6.6), P(x - 1, y, 6.6)], '#1c1f58');
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
      const lx = x - 0.75 + i * 0.6, lz = 5.4 + j * 0.55;
      poly(g, [P(lx, y, lz), P(lx + 0.4, y, lz), P(lx + 0.4, y, lz + 0.4), P(lx, y, lz + 0.4)], '#fff4c8');
    }
  }
  // Hanging scoreboard: abstract blocks only, no characters.
  // On a tall screen it would sit behind the title, so it hangs only on a wide one.
  if (cam.W > cam.H) {
  const bz = 3.0, bw = 3.2, by = 8, bx = 5, B = (x, z) => P(x + bx, by, z);
  poly(g, [B(-bw, bz), B(bw, bz), B(bw, bz + 2.6), B(-bw, bz + 2.6)], '#0a0c2c');
  poly(g, [B(-bw - 0.12, bz - 0.12), B(bw + 0.12, bz - 0.12), B(bw + 0.12, bz + 0.1), B(-bw - 0.12, bz + 0.1)], '#f5bf3a');
  poly(g, [B(-bw - 0.12, bz + 2.5), B(bw + 0.12, bz + 2.5), B(bw + 0.12, bz + 2.72), B(-bw - 0.12, bz + 2.72)], '#f5bf3a');
  for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) {
    const lx = -2.9 + i * 1.5, lz = bz + 0.4 + j * 1.05, c = i < 2 ? (j ? '#ff4a6a' : '#ff8a4a') : j ? '#4a8cff' : '#4af0ff';
    poly(g, [B(lx, lz), B(lx + 1.2, lz), B(lx + 1.2, lz + 0.8), B(lx, lz + 0.8)], c);
  }
  }
  // Banners and pennants down both sides.
  const cloth = ['#d9363e', '#f5bf3a', '#3f6fe0'];
  for (let i = 0; i < 7; i++) for (const s of [-1, 1]) {
    const y = -2 + i * 2.4, x = s * 8.6, c = cloth[(i + (s > 0 ? 1 : 0)) % 3];
    poly(g, [P(x, y, 7.2), P(x, y + 1.1, 7.2), P(x, y + 1.1, 5.4), P(x, y + 0.55, 4.8), P(x, y, 5.4)], c);
    line(g, P(x, y, 7.2), P(x, y + 1.1, 7.2), 1, '#f2f6ff');
  }
  // The lamp light as hazy shafts onto the court.
  g.globalAlpha = 0.09;
  for (const [x, y] of [[-6.8, -3], [6.8, -3], [-6.8, 9], [6.8, 9]]) poly(g, [P(x - 0.6, y, 5.4), P(x + 0.6, y, 5.4), P(Math.sign(x) * -1.6, y * 0.2 + 2.2, 0), P(Math.sign(x) * 2.4, y * 0.2 - 1, 0)], '#ffe9b0');
  g.globalAlpha = 1;
  // Pale pool under the table, and the table mirrored in the floor.
  const alongY = Math.abs(cam.c.y) >= Math.abs(cam.c.x), ex = Math.sign(cam.c.x) * TABLE_W, ey = Math.sign(cam.c.y) * TABLE_L;
  const a = alongY ? [-TABLE_W, ey] : [ex, -TABLE_L], b = alongY ? [TABLE_W, ey] : [ex, TABLE_L];
  g.globalAlpha = 0.3;
  poly(g, [P(a[0], a[1], 0), P(b[0], b[1], 0), P(b[0], b[1], -TABLE_Z * 0.9), P(a[0], a[1], -TABLE_Z * 0.9)], '#2a5be8');
  g.globalAlpha = 1;
  const k = cam.H;
  g.globalAlpha = 0.34;
  for (let i = 0; i < 8; i++) { g.fillStyle = '#04061c'; g.fillRect(0, k - 1 - i * 3, cam.W, 3); g.globalAlpha *= 0.82; }
  g.globalAlpha = 1;
}

function paintTable(g, cam) {
  const P = (x, y, z) => project(cam, x, y, z), w = TABLE_W, l = TABLE_L, z = TABLE_Z;
  for (const [x, y] of [[-w + 0.1, -l + 0.2], [w - 0.1, -l + 0.2], [-w + 0.1, l - 0.2], [w - 0.1, l - 0.2]]) line(g, P(x, y, 0), P(x, y, z), Math.max(1, P(x, y, 0).p * 0.05), '#23284e');
  const ex = Math.sign(cam.c.y) * l, sx = Math.sign(cam.c.x) * w;
  poly(g, [P(-w, ex, z - 0.04), P(w, ex, z - 0.04), P(w, ex, z), P(-w, ex, z)], '#0f2470');
  poly(g, [P(sx, -l, z - 0.04), P(sx, l, z - 0.04), P(sx, l, z), P(sx, -l, z)], '#16307f');
  poly(g, [P(-w, -l, z), P(w, -l, z), P(w, l, z), P(-w, l, z)], '#2348c8');
  poly(g, [P(0.03, -l, z), P(0.03, l, z), P(-0.03, l, z), P(-0.03, -l, z)], '#d8e4ff');
  const edge = (a, b) => line(g, a, b, 1, '#f2f6ff');
  edge(P(-w, -l, z), P(w, -l, z)); edge(P(w, -l, z), P(w, l, z)); edge(P(w, l, z), P(-w, l, z)); edge(P(-w, l, z), P(-w, -l, z));
}

// The net at its true height over the table's centre line.
export const netEnds = (cam) => [project(cam, -TABLE_W - 0.08, 0, NET_TOP), project(cam, TABLE_W + 0.08, 0, NET_TOP)];
function paintNet(g, cam) {
  const P = (x, z) => project(cam, x, 0, z);
  const w = TABLE_W + 0.08;
  g.globalAlpha = 0.5;
  poly(g, [P(-w, TABLE_Z), P(w, TABLE_Z), P(w, NET_TOP), P(-w, NET_TOP)], '#c9d4f0');
  g.globalAlpha = 1;
  line(g, P(-w, NET_TOP), P(w, NET_TOP), 1, '#f2f6ff');
  line(g, P(-w, TABLE_Z), P(-w, NET_TOP), 1, '#23284e');
  line(g, P(w, TABLE_Z), P(w, NET_TOP), 1, '#23284e');
}

const KIT = { near: { shirt: '#d9363e', hi: '#ff6a5e', face: '#d9363e' }, far: { shirt: '#3f6fe0', hi: '#7fa6ff', face: '#3f6fe0' } };
const SKIN = '#f0c08f', SHORTS = '#141830', HAIR = '#2a2030', SOCK = '#f2f6ff', INK = '#080a24', WOOD = '#c89a5a';

// Bone lengths in metres. GRIP is hand to the middle of the blade. The blade is drawn about half as big
// again as a real one (like the ball), so it still reads as a racket a few pixels across on a phone.
export const BONES = { upper: 0.29, fore: 0.27, thigh: 0.44, shin: 0.43, grip: 0.2 };
const BLADE_L = 0.12, BLADE_W = 0.11;
const v3 = (x, y, z) => ({ x, y, z });
const add3 = (a, b, k = 1) => v3(a.x + b.x * k, a.y + b.y * k, a.z + b.z * k);
const sub3 = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len3 = (a) => Math.hypot(a.x, a.y, a.z);
const unit3 = (a, f = v3(0, 0, 1)) => { const l = len3(a); return l > 1e-9 ? v3(a.x / l, a.y / l, a.z / l) : f; };
const cross3 = (a, b) => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const mid3 = (a, b, k = 0.5) => v3(mix(a.x, b.x, k), mix(a.y, b.y, k), mix(a.z, b.z, k));
const REACH = BONES.upper + BONES.fore + BONES.grip - 0.03;

// Two bones from a towards b, the middle joint bent towards pole. Out of reach, the chain straightens
// and stops short; too close, it folds as far as it can. The bone lengths never change.
function bend(a, b, l1, l2, pole) {
  const to = sub3(b, a), dir = unit3(to), d = Math.min(Math.max(len3(to), Math.abs(l1 - l2) + 0.02), l1 + l2 - 1e-4);
  const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d), out = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  const side = unit3(add3(pole, dir, -dot3(pole, dir)), unit3(cross3(dir, v3(0, 0, 1)), v3(1, 0, 0)));
  return { joint: add3(add3(a, dir, along), side, out), end: add3(a, dir, d) };
}

// The player's joints in table metres at scene time t: hips, knees, ankles and toes, shoulders,
// elbows and hands, and the racket in the hand (blade centre, handle direction u, face normal n).
// The body stands where poseAt says and the hand carries the racket to poseAt's racket point.
export function skeleton(who, t, sc = SCENES[0]) {
  const b = poseAt(who, t, sc), fw = v3(0, -b.side, 0), out = v3(b.lefty, 0, 0), up = v3(0, 0, 1);
  const was = poseAt(who, t - 0.04, sc), then = poseAt(who, t + 0.04, sc);
  const vel = v3((then.x - was.x) / 0.08, (then.y - was.y) / 0.08, 0), speed = Math.min(3, Math.hypot(vel.x, vel.y));
  // Light bouncing steps on the toes; quicker, longer steps while moving.
  const phase = t * 9, lift = 0.025 + Math.min(0.07, speed * 0.05);
  const pelvis = v3(b.x, b.y, 0.8 + b.jump - 0.02 * Math.abs(Math.sin(phase)));
  const R = b.racket;
  // Shoulders turn with the stroke: back on the backswing, through on the hit.
  let chest = add3(add3(pelvis, fw, 0.1), up, 0.48);
  const turn = Math.max(-0.55, Math.min(0.55, dot3(sub3(R, chest), fw) * 1.4));
  const across = unit3(add3(v3(out.x * Math.cos(turn), 0, 0), fw, Math.sin(turn)));
  const hipAcross = unit3(add3(v3(out.x * Math.cos(turn / 2), 0, 0), fw, Math.sin(turn / 2)));
  // The handle points up and out on a short stroke and lines up with the arm on a long reach.
  const reachOf = (S) => len3(sub3(R, S));
  let S = add3(chest, across, 0.17);
  const k = clamp01((reachOf(S) - 0.32) / 0.3);
  const rest = unit3(add3(add3(out, up, 2.2), fw, 0.55)), u = unit3(add3(rest, sub3(unit3(sub3(R, S)), rest), k));
  const handAt = add3(R, u, -BONES.grip);
  // Lean into a long reach so the hand gets there, and away from a ball right at the body so the arm
  // is not folded flat.
  const gap = len3(sub3(handAt, S)), short = gap - (BONES.upper + BONES.fore) * 0.97, tight = 0.27 - gap;
  if (short > 0 || tight > 0) {
    const lean = unit3(sub3(handAt, S)), by = short > 0 ? Math.min(0.14, short) : -Math.min(0.1, tight);
    chest = add3(chest, v3(lean.x, lean.y, Math.min(0.2, lean.z)), by);
    S = add3(chest, across, 0.17);
  }
  const S2 = add3(chest, across, -0.17);
  const arm = bend(S, handAt, BONES.upper, BONES.fore, add3(add3(out, up, -0.8), fw, -0.2));
  const hand = arm.end, c = add3(hand, u, BONES.grip), n = unit3(add3(fw, u, -dot3(fw, u)), out);
  // The free hand: the ball in it for the serve, then folded up in front of the shoulder, the arm a
  // narrow V (about 42 degrees) set in the turned shoulders' own frame: the upper arm hangs to the
  // floor and a little out, so the elbow shows beside the shirt from the back, and the forearm comes
  // back up and in, so the V shows from the front.
  const front = unit3(add3(fw, across, -dot3(fw, across)));
  const upper = unit3(add3(add3(v3(0, 0, -0.85), across, -0.7), front, 0.35)), fore = unit3(add3(add3(v3(0, 0, 0.8), across, 0.45), front, 0.4));
  let free = add3(add3(S2, upper, BONES.upper), fore, BONES.fore);
  if (who === sc.nodes[0].hand && t < 0.3) { const toss = ballAt(Math.min(t, 0.05), sc), k = clamp01((t - 0.05) / 0.25); free = mid3(v3(toss.x, toss.y, toss.z - 0.03), free, k * k * (3 - 2 * k)); }
  const arm2 = bend(S2, free, BONES.upper, BONES.fore, upper);
  const legs = [-1, 1].map((s) => {
    const hip = add3(pelvis, hipAcross, 0.1 * s), step = Math.sin(phase + (s > 0 ? 0 : Math.PI));
    const ankle = v3(b.x + s * 0.25 * b.lefty + vel.x * 0.05 * step, b.y + fw.y * 0.05 * s * b.lefty + vel.y * 0.05 * step, b.jump * 0.75 + 0.07 + lift * Math.max(0, step));
    const leg = bend(hip, ankle, BONES.thigh, BONES.shin, add3(fw, out, 0.3 * s * b.lefty));
    return { hip, knee: leg.joint, ankle: leg.end, toe: add3(add3(leg.end, fw, 0.13), up, -0.05) };
  });
  const head = add3(add3(chest, fw, 0.04), up, 0.29);
  return { pose: b, pelvis, chest, head, legs, arms: [{ shoulder: S, elbow: arm.joint, hand }, { shoulder: S2, elbow: arm2.joint, hand: arm2.end }], racket: { c, u, n, w: unit3(cross3(u, n), out) } };
}

function drawPlayer(g, cam, who, t, sc) {
  const k = skeleton(who, t, sc), b = k.pose, kit = KIT[who];
  const P = (q) => project(cam, q.x, q.y, q.z), D = (q) => raw(cam, q.x, q.y, q.z).d;
  const p = project(cam, b.x, b.y, 1).p, W = (m) => Math.max(1, m * p);
  const groundShadow = project(cam, b.x, b.y, 0);
  g.globalAlpha = 0.45;
  poly(g, [{ x: groundShadow.x - W(0.42), y: groundShadow.y }, { x: groundShadow.x, y: groundShadow.y - W(0.12) }, { x: groundShadow.x + W(0.42), y: groundShadow.y }, { x: groundShadow.x, y: groundShadow.y + W(0.12) }], '#03041a');
  g.globalAlpha = 1;
  const limb = (a, c, w, color) => { line(g, P(a), P(c), W(w), color); };
  // Which way the player faces on screen: towards the other end of the table, seen from the camera.
  const away = -b.side * cam.f[1], acrossView = -b.side * cam.r[1];
  const view = Math.abs(away) >= Math.abs(acrossView) ? (away > 0 ? 'back' : 'front') : acrossView > 0 ? 'right' : 'left';
  // Every body part is drawn far to near from this camera, so whatever is behind the body (the far arm,
  // the racket on a backswing) is covered by it. bones: [from, to, width, colour].
  const parts = [];
  const torsoAt = mid3(k.pelvis, k.chest), dTorso = D(torsoAt);
  for (const L of k.legs) {
    parts.push({ d: D(mid3(L.hip, L.knee)), bones: [[L.hip, L.knee, 0.13, SKIN], [L.hip, mid3(L.hip, L.knee, 0.5), 0.18, SHORTS]] });
    parts.push({ d: D(mid3(L.knee, L.ankle)), bones: [[L.knee, L.ankle, 0.11, SKIN], [mid3(L.knee, L.ankle, 0.7), L.ankle, 0.12, SOCK], [L.ankle, L.toe, 0.1, SOCK]] });
  }
  const [sa, sb] = [k.arms[0].shoulder, k.arms[1].shoulder];
  parts.push({ d: dTorso + 1e-3, bones: [[add3(k.pelvis, v3(0, 0, -0.04)), add3(k.pelvis, v3(0, 0, 0.12)), 0.3, SHORTS], [k.legs[0].hip, k.legs[1].hip, 0.2, SHORTS]] });
  const stripe = view !== 'back' && [mid3(k.pelvis, k.chest, 0.45), add3(k.chest, v3(0, 0, 0.04)), 0.1, kit.hi];
  parts.push({ d: dTorso, bones: [[add3(k.pelvis, v3(0, 0, 0.1)), k.chest, 0.3, kit.shirt], [sa, sb, 0.13, kit.shirt], ...(stripe ? [stripe] : [])] });
  for (const A of k.arms) {
    parts.push({ d: D(mid3(A.shoulder, A.elbow)), bones: [[A.shoulder, A.elbow, 0.09, SKIN], [A.shoulder, mid3(A.shoulder, A.elbow, 0.5), 0.12, kit.shirt]] });
    parts.push({ d: D(mid3(A.elbow, A.hand)), bones: [[A.elbow, A.hand, 0.08, SKIN], [A.hand, A.hand, 0.1, SKIN]] });
  }
  const { c, u, w } = k.racket, neck = add3(c, u, -BLADE_L);
  parts.push({ d: D(mid3(k.arms[0].hand, neck)), bones: [], draw: () => line(g, P(k.arms[0].hand), P(neck), Math.max(1, W(0.03)), WOOD) });
  // The blade is a flat oval in 3D: seen face on it is round, seen edge on it is a thin line.
  const rim = (grow) => Array.from({ length: 12 }, (_, i) => { const a = (i / 12) * Math.PI * 2; return P(add3(add3(c, u, Math.cos(a) * (BLADE_L + grow)), w, Math.sin(a) * (BLADE_W + grow))); });
  parts.push({ d: D(c), bones: [], draw: () => { poly(g, rim(1.5 / p), INK); poly(g, rim(0), kit.face); } });
  const hp = P(k.head), r = W(0.15);
  parts.push({ d: Math.min(D(k.head), dTorso - 1e-3), bones: [], draw: () => drawHead(g, hp, r, view) });
  // A dark outline pass under the whole body first, so the sprite stands off the busy crowd.
  for (const part of parts) for (const [a, c2, wd] of part.bones) limb(a, c2, wd + 3 / p, INK);
  parts.sort((x, y) => y.d - x.d);
  for (const part of parts) { for (const [a, c2, wd, color] of part.bones) limb(a, c2, wd, color); part.draw?.(); }
  return P(c);
}

function drawHead(g, hp, r, view) {
  const hx = Math.round(hp.x - r), hy = Math.round(hp.y - r), hw = Math.round(r * 2);
  line(g, hp, hp, r * 2 + 2, INK);
  line(g, hp, hp, r * 2, SKIN);
  g.fillStyle = HAIR;
  if (view === 'back') g.fillRect(hx, hy, hw, Math.round(r * 1.5));
  else {
    g.fillRect(hx, hy, hw, Math.round(r * 0.8));
    if (view !== 'front') g.fillRect(view === 'right' ? hx : hx + hw - Math.round(r), hy, Math.round(r), Math.round(r * 1.5));
    if (hw >= 4) {
      const ey = hy + Math.round(r * 1.05);
      g.fillStyle = '#080a24';
      if (view === 'front') { g.fillRect(hx + 1, ey, 1, 1); g.fillRect(hx + hw - 2, ey, 1, 1); }
      else g.fillRect(view === 'right' ? hx + hw - 2 : hx + 1, ey, 1, 1);
    }
  }
}

function drawBall(g, cam, t, big, sc) {
  const b = ballAt(t, sc), c = project(cam, b.x, b.y, b.z);
  const size = Math.max(2, Math.round(c.p * 0.1 * (big ? 1.3 : 1)));
  for (let i = 5; i > 0; i--) {
    const q = ballAt(Math.max(0, t - i * (big ? 0.03 : 0.018)), sc), s = project(cam, q.x, q.y, q.z);
    g.fillStyle = ['#fff2b0', '#ffe07a', '#d8b84a', '#a08a3e', '#6e6238'][i - 1];
    const w = Math.max(1, size - i + 1);
    g.fillRect(Math.round(s.x - w / 2), Math.round(s.y - w / 2), w, w);
  }
  g.fillStyle = '#080a24';
  g.fillRect(Math.round(c.x - size / 2) - 1, Math.round(c.y - size / 2) - 1, size + 2, size + 2);
  g.fillStyle = '#ffd34d';
  g.fillRect(Math.round(c.x - size / 2), Math.round(c.y - size / 2), size, size);
  return { c, size };
}

function ballShadow(g, cam, t, sc) {
  const b = ballAt(t, sc), over = Math.abs(b.x) <= TABLE_W && Math.abs(b.y) <= TABLE_L;
  const s = project(cam, b.x, b.y, over ? TABLE_Z + 0.002 : 0);
  const h = b.z - (over ? TABLE_Z : 0), w = Math.max(1, Math.round(s.p * (0.14 - Math.min(0.08, h * 0.05))));
  g.globalAlpha = 0.5;
  g.fillStyle = '#03041a';
  g.fillRect(Math.round(s.x - w), Math.round(s.y), w * 2, Math.max(1, Math.round(w * 0.6)));
  g.globalAlpha = 1;
}

function drawHitSpark(g, cam, t, sc) {
  for (const n of sc.nodes) {
    const age = t - n.t;
    if (!(n.who || n.bounce || n.net) || age < 0 || age > (n.smash || n.net ? 0.26 : 0.09)) continue;
    const c = project(cam, n.x, n.y, n.z), r = Math.round(c.p * (n.smash ? 0.75 : n.net ? 0.4 : 0.16) * (1 - age / (n.smash || n.net ? 0.4 : 0.14)));
    g.fillStyle = n.smash ? '#fff7d0' : '#f2f6ff';
    g.fillRect(Math.round(c.x) - r, Math.round(c.y), r * 2, 1);
    g.fillRect(Math.round(c.x), Math.round(c.y) - r, 1, r * 2);
    if (n.smash) { const k = Math.round(r * 0.55); line(g, { x: c.x - k, y: c.y - k }, { x: c.x + k, y: c.y + k }, 1, '#ffe27a'); line(g, { x: c.x + k, y: c.y - k }, { x: c.x - k, y: c.y + k }, 1, '#ffe27a'); }
  }
}

// Speed lines thrown out from the deciding hit, broken up by a fixed pattern.
function speedLines(g, cam, power, sc) {
  const n = sc.nodes.find((m) => m.t === sc.climax), c = project(cam, n.x, n.y, n.z), reach = Math.hypot(cam.W, cam.H);
  g.globalAlpha = Math.min(0.75, power);
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + hash(i, 3), r0 = reach * (0.16 + 0.1 * hash(i, 7)), r1 = r0 + reach * (0.12 + 0.2 * hash(i, 9));
    line(g, { x: c.x + Math.cos(a) * r0, y: c.y + Math.sin(a) * r0 }, { x: c.x + Math.cos(a) * r1, y: c.y + Math.sin(a) * r1 }, 1, i % 3 ? '#f2f6ff' : '#ffe27a');
  }
  g.globalAlpha = 1;
}

function frame(g, s, r, reduced, sc = SCENES[0]) {
  const { cam, W, H, room, table, flashes } = s, c = sc.climax;
  const t = sceneTime(r, sc), since = t - c;
  s.t = t;
  s.sc = sc;
  s.frames = (s.frames || 0) + 1;
  const hit = since >= 0 && since < 0.45 ? (1 - since / 0.45) * sc.power : 0;
  // A slow push in on the rally, a jolt forward on the deciding shot, then a drift back.
  const push = ease(clamp01(r / (c - 0.12))) * 0.05 + (r > c - 0.07 ? 0.03 * (1 - ease(clamp01((r - c - 1.38) / 2))) : 0);
  cam.zoom = 1 + push + hit * 0.01;
  cam.dx = hit > 0.5 ? (Math.floor(r * 40) % 2 ? 1 : -1) * Math.round(hit * 2) : 0;
  cam.dy = hit > 0.5 ? (Math.floor(r * 53) % 2 ? 1 : -1) * Math.round(hit * 2) : 0;
  g.imageSmoothingEnabled = false;
  const zw = W * cam.zoom, zh = H * cam.zoom;
  g.drawImage(room, cam.cx - cam.cx * cam.zoom + cam.dx, cam.cy - cam.cy * cam.zoom + cam.dy, zw, zh);
  // Two sweeping stage lights, and the crowd's camera flashes, thick on the smash.
  const sweep = Math.sin(r * 1.3);
  g.globalAlpha = 0.1;
  for (const k of [-1, 1]) {
    const a = project(cam, k * 6.8, 9, 5.6), m = project(cam, k * (1.5 + sweep * k * 2), 1.5, 0);
    poly(g, [{ x: a.x - 2, y: a.y }, { x: a.x + 2, y: a.y }, { x: m.x + 26, y: m.y }, { x: m.x - 26, y: m.y }], k < 0 ? '#ffe9a0' : '#8fe6ff');
  }
  g.globalAlpha = 1;
  const pops = reduced ? 16 : hit ? 40 : 6;
  g.fillStyle = '#ffffff';
  for (let i = 0; i < pops && flashes.length; i++) {
    const q = flashes[Math.floor(hash(i, Math.floor(r * 14)) * flashes.length)];
    g.fillRect(Math.round(cam.cx + ((q & 0xffff) - cam.cx) * cam.zoom), Math.round(cam.cy + ((q >> 16) - cam.cy) * cam.zoom), 1, 1);
  }
  // Back to front from this camera: the further player, the table, the net, the nearer player, the ball.
  const depth = (p) => (p.x - cam.c.x) * cam.f[0] + (p.y - cam.c.y) * cam.f[1];
  const ball = depth(ballAt(t, sc)), [first, last] = ['far', 'near'].map((who) => ({ who, d: depth(poseAt(who, t, sc)) })).sort((x, y) => y.d - x.d);
  if (ball > first.d) ballShadow(g, cam, t, sc);
  drawPlayer(g, cam, first.who, t, sc);
  g.drawImage(table, cam.cx - cam.cx * cam.zoom + cam.dx, cam.cy - cam.cy * cam.zoom + cam.dy, zw, zh);
  if (ball <= first.d) ballShadow(g, cam, t, sc);
  paintNet(g, cam);
  const near = drawPlayer(g, cam, last.who, t, sc);
  drawHitSpark(g, cam, t, sc);
  if (hit) speedLines(g, cam, hit * 1.2, sc);
  // The ball goes on top of everything, outlined: a player or the net tape never hides it.
  drawBall(g, cam, t, hit > 0, sc);
  if (!reduced && sc.power === 1 && since >= 0 && since < 0.03) { g.globalAlpha = 0.4 * (1 - since / 0.03); g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
  const fade = reduced ? 0 : Math.max(1 - r / FADE, (r - (sc.loop - FADE)) / FADE);
  if (fade > 0) { g.globalAlpha = Math.min(1, fade); g.fillStyle = '#04061c'; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
  return near;
}

function build(canvas, deg0 = 0, sc0 = 0) {
  const box = canvas.getBoundingClientRect?.() ?? { width: 393, height: 852, left: 0, top: 0 };
  const px = Math.max(3, Math.min(6, Math.round(Math.min(box.width, box.height) / 130)));
  const W = Math.max(1, Math.round(box.width / px)), H = Math.max(1, Math.round(box.height / px));
  canvas.width = W;
  canvas.height = H;
  const r = canvas.parentElement?.querySelector?.('.start-stage')?.getBoundingClientRect?.();
  const stage = r ? { x: (r.left - box.left) / px, y: (r.top - box.top) / px, w: r.width / px, h: r.height / px } : { x: 0, y: 0, w: W, h: H };
  const s = { W, H, px, stage, fits: [], flashes: [] };
  for (const sc of SCENES) { const f = []; for (let deg = 0; deg < 360; deg += FIT_STEP) f.push(fitCamera(aimCamera(W, H, stage, deg), stage, sc)); s.fits.push(f); }
  const layer = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  s.room = layer(); s.table = layer(); s.nextRoom = layer(); s.nextTable = layer();
  s.img = s.room.getContext('2d').createImageData(W, H);
  paintView(s, deg0, sc0);
  return s;
}

// The arena from a new angle is too slow to draw in one frame on a phone, so it is ray-cast a few rows
// a frame into a spare layer and swapped in whole. Camera, table and players then step together
// and the room never slips against the table, while the players keep the full frame rate.
function beginView(s, deg, sc) {
  s.job = { cam: cameraAt(s, deg, sc), y: 0, flashes: [] };
}

function finishView(s) {
  const { cam, flashes } = s.job, room = s.nextRoom, table = s.nextTable;
  const rg = room.getContext('2d'), tg = table.getContext('2d');
  rg.putImageData(s.img, 0, 0);
  paintDressing(rg, cam);
  tg.clearRect?.(0, 0, s.W, s.H);
  paintTable(tg, cam);
  s.nextRoom = s.room; s.nextTable = s.table;
  s.room = room; s.table = table; s.cam = cam; s.flashes = flashes;
  s.job = null;
}

function stepView(s, ms) {
  const j = s.job, stop = performance.now() + ms;
  while (j.y < s.H) {
    paintRow(s.img, j.cam, s.W, j.y++, j.flashes);
    if (!(j.y & 3) && performance.now() > stop) return;
  }
  finishView(s);
}

function paintView(s, deg, sc) {
  beginView(s, deg, sc);
  stepView(s, Infinity);
}

export function playRally(canvas, rnd = Math.random, { deg: start = 0, spin = ORBIT_DEG_PER_S } = {}) {
  const g = canvas.getContext('2d');
  let at0 = pickScene(-1, rnd);
  let s = build(canvas, start, at0);
  let at = at0, deg = start;
  canvas.rally = {
    scene: s, played: [at],
    draw: (r, i = at, angle = deg) => { paintView(canvas.rally.scene, angle, i); return frame(g, canvas.rally.scene, r, false, SCENES[i]); },
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    frame(g, s, SCENES[at].still, true, SCENES[at]);
    return;
  }
  let clock = 0, last = 0, queued = false, running = true;
  const tick = (now) => {
    queued = false;
    if (!canvas.isConnected) { stop(); return; }
    if (!running) return;
    const dt = Math.min(100, last ? now - last : 0) / 1000;
    clock += dt;
    deg += dt * spin;
    last = now;
    if (clock >= SCENES[at].loop) {
      clock = 0;
      at = pickScene(at, rnd);
      canvas.rally.played.push(at);
      paintView(s, deg, at); // under the fade to black, so the new point's framing never slides in
    }
    if (spin) {
      if (!s.job) beginView(s, deg, at);
      stepView(s, SLICE_MS);
    }
    frame(g, s, clock, false, SCENES[at]);
    queue();
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(tick); } };
  const onVisible = () => { running = document.visibilityState !== 'hidden'; if (running) { last = 0; queue(); } };
  const onResize = () => { s = build(canvas, deg, at); canvas.rally.scene = s; };
  const stop = () => { document.removeEventListener?.('visibilitychange', onVisible); globalThis.removeEventListener?.('resize', onResize); };
  document.addEventListener?.('visibilitychange', onVisible);
  globalThis.addEventListener?.('resize', onResize);
  frame(g, s, 0, false, SCENES[at]);
  queue();
}

// The title, drawn pixel by pixel like a fighting-game logo instead of set in a font: bold cut-corner
// block letters on a 9-row grid, sheared right, the first letter larger, letters overlapping, a pixel
// side, two outlines, a metal face and streaks behind. '#' is a full cell; / \ b d are the cells cut
// on a diagonal (the corner that stays is bottom-right, bottom-left, top-right, top-left).
const GLYPH = {
  P: ['/######\\', '###..###', '###..###', '###..###', '#######d', '######d.', '###.....', '###.....', '##d.....'],
  I: ['/##', '###', '###', '###', '###', '###', '###', '###', '##d'],
  N: ['###\\.###', '####.###', '#####\\##', '###b####', '###.####', '###.b###', '###..###', '###..###', '##d..##d'],
  G: ['/######\\', '###..###', '###.....', '###.....', '###.####', '###.####', '###..###', '###..###', 'b######d'],
  O: ['/######\\', '###..###', '###..###', '###..###', '###..###', '###..###', '###..###', '###..###', 'b######d'],
  V: ['###..###', '###..###', '###..###', '###..###', 'b##..##d', '.###.##.', '.##\\/##.', '..####..', '..b##d..'],
  S: ['/######\\', '###..###', '###.....', 'b#####\\.', '.b#####\\', '.....###', '###..###', '###..###', 'b######d'],
};
// Eight-wide letters get a ninth column in the middle, so their counters stay open once sheared.
for (const k of Object.keys(GLYPH)) if (GLYPH[k][0].length === 8) GLYPH[k] = GLYPH[k].map((r) => r.slice(0, 5) + r.slice(4));
const GOLD = ['#fff8d0', '#ffe878', '#ffc830', '#ffa018', '#7a2c10', '#ffb838', '#ffd668', '#e87a18'];
const CHROME = ['#ffffff', '#dfeaff', '#a9c4ff', '#6f97ff', '#1f3a96', '#7fa4ff', '#c6d8ff', '#eef4ff'];
const SHEAR = Math.tan((13 * Math.PI) / 180);
const LINE_W = 272, DEPTH = 3, GAP = 3;
// The red ribbon behind VISION, like a fighting-game logo's banner: a band leaning like the letters
// with a folded, notched tail at each end (the tails mirror each other in the band's own lean, and the
// leaning right tail still ends inside the screen). Drawn
// in the logo's grid and finished like the letters: a red face shaded by height like their metal, a
// light rim, a red side and the dark outline. The lines are drawn over it, so it never covers a
// letter; the fire streaks stop where it is, so it stands in front of them, which leaves VISION's
// streaks (all at the ribbon's height) out and PINGPONG's on both sides.
export const TITLE_RIBBON = ['#ff8a6a', '#ff5a4a', '#e83a2a', '#d92a1e', '#b01e18', '#8a1420'];
const RIBBON_TAIL = ['#b01e18', '#8a1420', '#6a0e18'], RIBBON_RIM = '#ffd0b8', RIBBON_H = 86, RIBBON_BASE = 78, RIBBON_DEPTH = 2;
const lean = ([x, y]) => [x + (RIBBON_BASE - y) * SHEAR, y];
const RIBBON_PARTS = [
  [TITLE_RIBBON, 50, 74, [[30, 50], [242, 50], [242, 74], [30, 74]]],
  [RIBBON_TAIL, 56, 80, [[10, 56], [34, 56], [34, 80], [10, 80], [20, 68]]],
  [RIBBON_TAIL, 56, 80, [[238, 56], [262, 56], [252, 68], [262, 80], [238, 80]]],
].map(([colours, top, bottom, shape]) => [colours, top, bottom, shape.map(lean)]);
const inShape = (P, x, y) => P.reduce((inside, [ax, ay], k) => {
  const [bx, by] = P[(k + 1) % P.length], px = x + 0.5, py = y + 0.5;
  return (ay > py) !== (by > py) && px < ax + ((py - ay) * (bx - ax)) / (by - ay) ? !inside : inside;
}, false);
const RIBBON_PX = new Uint8ClampedArray(LINE_W * RIBBON_H * 4);
{
  const W = LINE_W, H = RIBBON_H, face = new Array(W * H).fill(null);
  for (const [colours, top, bottom, P] of RIBBON_PARTS) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (inShape(P, x, y)) face[y * W + x] = colours[Math.min(colours.length - 1, Math.max(0, Math.floor(((y - top) / (bottom - top + 1)) * colours.length)))];
  }
  const has = (x, y) => x >= 0 && y >= 0 && x < W && y < H && face[y * W + x] !== null;
  const side = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (has(x, y)) {
    for (let d = 1; d <= RIBBON_DEPTH; d++) if (x + d < W && y + d < H) side[(y + d) * W + x + d] = Math.max(side[(y + d) * W + x + d], d);
  }
  const solid = (x, y) => has(x, y) || (x >= 0 && x < W && y >= 0 && y < H && side[y * W + x] > 0);
  const near = (x, y, r, f) => { for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (Math.abs(i) + Math.abs(j) <= r + 1 && f(x + i, y + j)) return true; return false; };
  const dot = (x, y, hex) => { const i = (y * W + x) * 4, n = parseInt(hex.slice(1), 16); RIBBON_PX[i] = n >> 16; RIBBON_PX[i + 1] = (n >> 8) & 255; RIBBON_PX[i + 2] = n & 255; RIBBON_PX[i + 3] = 255; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (has(x, y)) dot(x, y, face[y * W + x]);
    else if (side[y * W + x]) dot(x, y, side[y * W + x] > 1 ? '#5e0e1c' : '#c22a2a');
    else if (near(x, y, 1, has)) dot(x, y, RIBBON_RIM);
    else if (near(x, y, 2, solid)) dot(x, y, '#090a24');
  }
}
// A line's top sits between two logo rows (VISION's at 34.4), so both are checked.
const underRibbon = (x, y) => [Math.floor(y), Math.ceil(y)].some((r) => r >= 0 && r < RIBBON_H && RIBBON_PX[(r * LINE_W + x) * 4 + 3]);
const inCell = (c, u, v) => (c === '#' ? true : c === '/' ? u + v >= 1 : c === '\\' ? v >= u : c === 'b' ? u >= v : c === 'd' ? u + v <= 1 : false);

export function titleLine(word, ramp, tail, alone = false) {
  const big = 4, small = 3, rows = 9, H = rows * big + 12;
  const mask = new Float32Array(LINE_W * H).fill(-1);
  const put = (x, y, f) => { if (x >= 0 && x < LINE_W && y >= 0 && y < H) mask[y * LINE_W + x] = f; };
  const base = H - 5 - DEPTH;
  const ink = [...word].reduce((a, ch, i) => a + GLYPH[ch][0].length * (i ? small : big) + GAP, 0);
  let pen = Math.round((LINE_W - ink - base * SHEAR) / 2);
  [...word].forEach((ch, i) => {
    const g = GLYPH[ch], u = i ? small : big, hh = rows * u, ww = g[0].length * u;
    for (let y = 0; y < hh; y++) for (let x = 0; x < ww; x++) {
      const cx = Math.floor(x / u), cy = Math.floor(y / u);
      if (inCell(g[cy][cx], (x % u + 0.5) / u, (y % u + 0.5) / u)) {
        const row = base - hh + y;
        put(pen + x + Math.round((base - row) * SHEAR), row, y / hh);
      }
    }
    pen += ww + GAP;
  });
  const has = (x, y) => x >= 0 && x < LINE_W && y >= 0 && y < H && mask[y * LINE_W + x] >= 0;
  const px = new Uint8ClampedArray(LINE_W * H * 4);
  const dot = (x, y, hex, a = 255) => {
    if (x < 0 || x >= LINE_W || y < 0 || y >= H) return;
    const i = (y * LINE_W + x) * 4, n = parseInt(hex.slice(1), 16);
    px[i] = n >> 16; px[i + 1] = (n >> 8) & 255; px[i + 2] = n & 255; px[i + 3] = a;
  };
  const side = new Uint8Array(LINE_W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < LINE_W; x++) {
    if (!has(x, y)) continue;
    for (let d = 1; d <= DEPTH; d++) if (x + d < LINE_W && y + d < H) side[(y + d) * LINE_W + x + d] = Math.max(side[(y + d) * LINE_W + x + d], d);
  }
  const solid = (x, y) => has(x, y) || (x >= 0 && x < LINE_W && y >= 0 && y < H && side[y * LINE_W + x] > 0);
  const near = (x, y, r, f) => { for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (Math.abs(i) + Math.abs(j) <= r + 1 && f(x + i, y + j)) return true; return false; };
  // Streaks and a fire tail behind the letters, pulled out on the side the line flies in from, and the
  // same streak mirrored across the middle of the logo. A pair shows only where both of its dots are
  // clear of the letters, their outline and the ribbon, so the two sides always match.
  // The other line's letters count too, where the two lines overlap.
  const others = alone ? [] : TITLE_LINES.filter((l) => l[0] !== word).map(([w, r, t]) => ({ ...titleLine(w, r, t, true), top: t.top }));
  const onOther = (x, y) => others.some((o) => [Math.floor(y + tail.top - o.top), Math.ceil(y + tail.top - o.top)].some((r) => r >= 0 && r < o.H && o.letters[r * LINE_W + x]));
  const clear = (x, y) => x >= 0 && x < LINE_W && !near(x, y, 2, solid) && !underRibbon(x, y + tail.top) && !onOther(x, y);
  for (let y = 2; y < H - 2; y++) {
    const r = hash(y, tail.seed);
    if (r < 0.42) continue;
    const xs = [];
    for (let x = 0; x < LINE_W; x++) if (has(x, y)) xs.push(x);
    if (!xs.length) continue;
    const from = tail.dir < 0 ? xs[0] : xs.at(-1), len = 8 + Math.floor(r * r * 34);
    for (let k = 0; k < len; k++) {
      const q = k / len, x = from + tail.dir * k;
      if (hash(k, y + tail.seed) < q * 0.75 || !clear(x, y) || !clear(LINE_W - 1 - x, y)) continue;
      for (const at of [x, LINE_W - 1 - x]) dot(at, y, tail.fire[Math.min(tail.fire.length - 1, Math.floor(q * tail.fire.length))]);
    }
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < LINE_W; x++) {
    const i = y * LINE_W + x;
    if (has(x, y)) dot(x, y, ramp[Math.min(ramp.length - 1, Math.floor(mask[i] * ramp.length))]);
    else if (side[i]) dot(x, y, side[i] > 1 ? '#5e0e1c' : '#c22a2a');
    else if (near(x, y, 1, has)) dot(x, y, tail.rim);
    else if (near(x, y, 2, solid)) dot(x, y, '#090a24');
  }
  const letters = new Uint8Array(LINE_W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < LINE_W; x++) letters[y * LINE_W + x] = near(x, y, 2, solid) ? 1 : 0;
  return { px, H, W: LINE_W, letters };
}

function paintLine(canvas, shine, spec) {
  const { px, H } = titleLine(...spec);
  canvas.width = LINE_W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  const img = g.createImageData(LINE_W, H);
  img.data.set(px);
  g.putImageData(img, 0, 0);
  const url = canvas.toDataURL();
  shine.style.webkitMaskImage = shine.style.maskImage = 'url(' + url + ')';
}

// The ribbon in one picture over the whole logo, in the logo's grid.
export function titleRibbon() {
  return { px: RIBBON_PX, H: RIBBON_H, W: LINE_W };
}

function paintRibbon(canvas, { px, H, W }) {
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d'), img = g.createImageData(W, H);
  img.data.set(px);
  g.putImageData(img, 0, 0);
}

export const TITLE_LINES = [
  // top: where the line starts in the logo's grid (the second is pulled up by 5% of the width).
  ['PINGPONG', GOLD, { dir: -1, seed: 3, top: 0, rim: '#fff2b8', fire: ['#fff0a0', '#ffc030', '#ff7a18', '#d92a1e', '#7a1020'] }],
  ['VISION', CHROME, { dir: 1, seed: 8, top: 48 - 0.05 * LINE_W, rim: '#e6f2ff', fire: ['#ffffff', '#9fe0ff', '#4a9cff', '#2a4fd8', '#1a2480'] }],
];

// The dark glow that lifts the letters off the crowd: both lines' shapes, blurred once at half
// resolution and scaled up smoothly. A CSS filter here cut a TV's frame rate to a third.
const HALO_PAD = 26, HALO_STEP = 2, LINE_OVERLAP = 0.05;

function paintHalo(canvas, lines, ribbon) {
  const logoH = lines[0].H + lines[1].H - LINE_OVERLAP * LINE_W;
  const W = Math.ceil((LINE_W + HALO_PAD * 2) / HALO_STEP), H = Math.ceil((logoH + HALO_PAD * 2) / HALO_STEP);
  let a = new Float32Array(W * H);
  [...lines, ribbon].forEach((l, n) => {
    const top = n === 1 ? lines[0].H - LINE_OVERLAP * LINE_W : 0;
    for (let y = 0; y < l.H; y++) for (let x = 0; x < LINE_W; x++) {
      if (l.px[(y * LINE_W + x) * 4 + 3]) a[Math.floor((y + top + HALO_PAD) / HALO_STEP) * W + Math.floor((x + HALO_PAD) / HALO_STEP)] = 1;
    }
  });
  for (let pass = 0; pass < 3; pass++) {
    const b = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let sum = 0, n = 0;
      for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) if (x + i >= 0 && x + i < W && y + j >= 0 && y + j < H) { sum += a[(y + j) * W + x + i]; n++; }
      b[y * W + x] = sum / n;
    }
    a = b;
  }
  canvas.width = W;
  canvas.height = H;
  canvas.style.setProperty('--pad-x', (HALO_PAD / LINE_W) * 100 + '%');
  canvas.style.setProperty('--pad-y', (HALO_PAD / logoH) * 100 + '%');
  const g = canvas.getContext('2d'), img = g.createImageData(W, H);
  for (let i = 0; i < W * H; i++) { img.data[i * 4] = 4; img.data[i * 4 + 1] = 6; img.data[i * 4 + 2] = 28; img.data[i * 4 + 3] = Math.min(238, a[i] * 640); }
  g.putImageData(img, 0, 0);
}

export function drawTitle(logo) {
  logo.querySelectorAll('.ln').forEach((ln, i) => paintLine(ln.querySelector('canvas'), ln.querySelector('i'), TITLE_LINES[i]));
  const ribbon = titleRibbon();
  paintRibbon(logo.querySelector('.start-ribbon'), ribbon);
  paintHalo(logo.querySelector('.start-halo'), TITLE_LINES.map((l) => titleLine(...l)), ribbon);
}

// The START button's word, drawn like the title rather than set in a font: bold 7x9 block letters
// with a dark outline and a one-pixel side.
const START_GLYPH = {
  S: ['.#####.', '#######', '###..##', '###....', '.#####.', '....###', '##..###', '#######', '.#####.'],
  T: ['#######', '#######', '..###..', '..###..', '..###..', '..###..', '..###..', '..###..', '..###..'],
  A: ['..###..', '.#####.', '###.###', '###.###', '###.###', '#######', '#######', '###.###', '###.###'],
  R: ['######.', '#######', '###.###', '###.###', '######.', '#####..', '###.###', '###.###', '###.###'],
};

// The app version under START ("V 1.0.2"), drawn in 5-row dots shown two CSS pixels each (V five wide, so it does not read as U), so its
// steps stay visible instead of a font's smoothing. Unknown characters leave a gap.
export const VER_GLYPH = {
  0: ['###', '#.#', '#.#', '#.#', '###'], 1: ['.#.', '##.', '.#.', '.#.', '###'], 2: ['###', '..#', '###', '#..', '###'],
  3: ['###', '..#', '.##', '..#', '###'], 4: ['#.#', '#.#', '###', '..#', '..#'], 5: ['###', '#..', '###', '..#', '###'],
  6: ['###', '#..', '###', '#.#', '###'], 7: ['###', '..#', '.#.', '.#.', '.#.'], 8: ['###', '#.#', '###', '#.#', '###'],
  9: ['###', '#.#', '###', '..#', '###'], V: ['#...#', '#...#', '.#.#.', '.#.#.', '..#..'], '.': ['.', '.', '.', '.', '#'], ' ': ['..', '..', '..', '..', '..'],
};
export const VER_DOT = 2;

export function drawVersion(canvas, text, colour) {
  const glyphs = [...text].map((ch) => VER_GLYPH[ch] ?? VER_GLYPH[' ']);
  const w = Math.max(0, glyphs.reduce((a, g) => a + g[0].length + 1, 0) - 1);
  canvas.width = w;
  canvas.height = 5;
  canvas.style.width = w * VER_DOT + 'px';
  canvas.style.height = 5 * VER_DOT + 'px';
  const g = canvas.getContext('2d');
  g.fillStyle = colour;
  let pen = 0;
  for (const glyph of glyphs) {
    glyph.forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') g.fillRect(pen + x, y, 1, 1); }));
    pen += glyph[0].length + 1;
  }
}

export function drawStartWord(canvas) {
  const cells = [];
  [...'START'].forEach((ch, i) => START_GLYPH[ch].forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') cells.push([2 + i * 8 + x, 2 + y]); })));
  canvas.width = 44;
  canvas.height = 14;
  const g = canvas.getContext('2d');
  g.fillStyle = '#2a0e00';
  for (const [x, y] of cells) g.fillRect(x - 1, y - 1, 4, 4);
  g.fillStyle = '#7a2200';
  for (const [x, y] of cells) g.fillRect(x + 1, y + 1, 1, 1);
  for (const [x, y] of cells) { g.fillStyle = y < 6 ? '#ffffff' : '#ffe9a8'; g.fillRect(x, y, 1, 1); }
}
