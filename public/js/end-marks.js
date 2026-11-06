// end-marks.js - where the two end lines are on screen and what to do when something covers one.
// Pure geometry (screen CSS px, no DOM) so it can be tested; hud.js draws, ui.js marks panels.
// Owner, 2026-10-31: the end colours tell which end is blue and which is red, and the ball's path must
// stay clear, so nothing here ever lands on the table quad.
import { insidePolygon } from "./geom.js";

// Each end line sits `offset` px outside the table edge, away from the table's centre.
export function endLines(corners, toScreen, offset) {
  const q = corners.map((c) => toScreen(c));
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const out = (a, b) => {
    let nx = -(b.y - a.y), ny = b.x - a.x;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    if (((a.x + b.x) / 2 - cx) * nx + ((a.y + b.y) / 2 - cy) * ny < 0) { nx = -nx; ny = -ny; }
    return [{ x: a.x + nx * offset, y: a.y + ny * offset }, { x: b.x + nx * offset, y: b.y + ny * offset }];
  };
  return { near: out(q[0], q[1]), far: out(q[2], q[3]), quad: q };
}

// A player's body on screen: the box around its drawn joints (null where a joint is not shown), plus
// `pad` px for the joint squares and line width. End labels keep off it (owner, 2026-11-01: in landscape
// the 레드 끝 label sat over a player's body). `extra` rects (the foot ellipse) widen the box.
export function bodyBox(pts, pad = 3, extra = []) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) if (p) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  for (const r of extra) if (r) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
  if (x0 > x1) return null;
  return { x: Math.floor(x0 - pad), y: Math.floor(y0 - pad), w: Math.ceil(x1 - x0 + pad * 2), h: Math.ceil(y1 - y0 + pad * 2) };
}

const inRect = (p, r) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;

// How much of a line is out of sight: off the canvas or under one of `rects` ({x, y, w, h, id}).
// `by` is the id of the rect over most of it ("off" when the canvas edge hides most of it).
export function coverOf([a, b], rects, w, h, n = 20) {
  let hidden = 0;
  const count = {};
  for (let i = 0; i < n; i++) {
    const p = { x: a.x + ((b.x - a.x) * (i + 0.5)) / n, y: a.y + ((b.y - a.y) * (i + 0.5)) / n };
    let k = null;
    if (p.x < 0 || p.y < 0 || p.x >= w || p.y >= h) k = "off";
    else {
      const r = rects.find((x) => inRect(p, x));
      if (r) k = r.id ?? "box";
    }
    if (k) { hidden++; count[k] = (count[k] || 0) + 1; }
  }
  const by = Object.entries(count).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  return { covered: hidden / n, by };
}

const segSamples = (a, b, n = 12) => Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));
function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Which edge of a covering panel carries the end mark: the one closest to the hidden line whose mark
// (the edge plus whatever reaches `depth` px into the panel: h for top / bottom, v for left / right;
// the border is 2 px, the label sits outside) stays off the table quad (a panel edge facing the net
// would sit on the ball's path).
export function panelEdge(rect, [a, b], quad, depth = { h: 4, v: 4 }) {
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const { x, y, w, h } = rect;
  const edges = {
    left: [{ x, y }, { x, y: y + h }],
    right: [{ x: x + w, y }, { x: x + w, y: y + h }],
    top: [{ x, y }, { x: x + w, y }],
    bottom: [{ x, y: y + h }, { x: x + w, y: y + h }],
  };
  const order = Object.entries(edges).sort((p, q) => distToSeg(m, ...p[1]) - distToSeg(m, ...q[1]));
  const strip = (name, [p, q]) => {
    const d = name === "left" || name === "right" ? depth.v : depth.h;
    const inward = { left: { x: d, y: 0 }, right: { x: -d, y: 0 }, top: { x: 0, y: d }, bottom: { x: 0, y: -d } }[name];
    const pts = [];
    for (let k = 0; k <= 4; k++) for (const e of segSamples(p, q)) pts.push({ x: e.x + (inward.x * k) / 4, y: e.y + (inward.y * k) / 4 });
    return pts;
  };
  const clear = order.find(([name, seg]) => strip(name, seg).every((p) => !insidePolygon(p, quad)));
  return (clear || order[0])[0];
}

// A w x h box at (bx, by) inside [0, cw] x [top, ch], off the table quad and off every rect in `avoid`.
export function fitsOff(bx, by, w, h, quad, avoid, { cw, ch, top = 0 }) {
  if (bx < 0 || by < top || bx + w > cw || by + h > ch) return false;
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 2; j++) if (insidePolygon({ x: bx + (w * i) / 4, y: by + (h * j) / 2 }, quad)) return false;
  if (quad.some((p) => p.x >= bx && p.x <= bx + w && p.y >= by && p.y <= by + h)) return false;
  return !avoid.some((r) => bx < r.x + r.w && r.x < bx + w && by < r.y + r.h && r.y < by + h);
}

// The "블루 끝" / "레드 끝" label of a panel that covers an end: just outside the marked edge (inside the
// panel it covered the panel's own text), sliding along the edge from its middle to the first spot that
// fits (fitsOff). `dir` points from the label into the panel.
export function panelLabelSpot(rect, edge, quad, avoid, { w, h, cw, ch, top = 0, gap = 3 }) {
  const horiz = edge === "top" || edge === "bottom";
  const fixed = { top: rect.y - h - gap, bottom: rect.y + rect.h + gap, left: rect.x - w - gap, right: rect.x + rect.w + gap }[edge];
  const lo = horiz ? rect.x : rect.y, hi = horiz ? rect.x + rect.w - w : rect.y + rect.h - h;
  const mid = (lo + hi) / 2;
  const dir = { top: { x: 0, y: 1 }, bottom: { x: 0, y: -1 }, left: { x: 1, y: 0 }, right: { x: -1, y: 0 } }[edge];
  for (let k = 0; k <= Math.max(0, hi - lo) / 2 + 8; k += 8) for (const along of k ? [mid - k, mid + k] : [mid]) {
    const a = Math.round(Math.max(lo, Math.min(hi, along)));
    const bx = horiz ? a : Math.round(fixed), by = horiz ? Math.round(fixed) : a;
    if (fitsOff(bx, by, w, h, quad, avoid, { cw, ch, top })) return { x: bx, y: by, w, h, dir };
  }
  return null;
}

// A spot for a small arrow tag (w x h) pointing at a hidden line, when no panel covers it: off the table
// quad, off every rect in `avoid`, inside [0, cw] x [top, ch]. Searched outward from the line (away from
// the table), then along it. `dir` is the unit vector from the tag's centre to the line's middle.
export function arrowSpot([a, b], quad, avoid, { w, h, cw, ch, top = 0 }) {
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const cx = quad.reduce((s, p) => s + p.x, 0) / quad.length, cy = quad.reduce((s, p) => s + p.y, 0) / quad.length;
  let ox = m.x - cx, oy = m.y - cy;
  const len = Math.hypot(ox, oy) || 1;
  ox /= len; oy /= len;
  const starts = [m, a, b];
  const fits = (bx, by) => fitsOff(bx, by, w, h, quad, avoid, { cw, ch, top });
  for (let d = 12; d <= 200; d += 6) {
    for (const s of starts) {
      const bx = Math.round(s.x + ox * d - w / 2), by = Math.round(s.y + oy * d - h / 2);
      if (!fits(bx, by)) continue;
      let dx = m.x - (bx + w / 2), dy = m.y - (by + h / 2);
      const dl = Math.hypot(dx, dy) || 1;
      return { x: bx, y: by, w, h, dir: { x: dx / dl, y: dy / dl } };
    }
  }
  return null;
}
