// How far a fitted table quad is from the read one, three ways (qa/corner-refine.mjs, qa/calib-snap-ui.mjs):
//   cornerPx: per corner, px. Where two sides meet at a sharp angle (a table seen from its side) a 1 px
//             offset of one side slides the corner 3 px along the other, so a corner can read 5 px off
//             while both sides lie on the border.
//   lineMaxPx: the largest distance from points along each read side to the fitted side line, px.
//   tableMaxCm: a 9 x 5 grid on the real table top, put into the picture with the read quad and taken back
//             with the fitted one: the largest miss on the table, cm (what a bounce in/out call sees).
import { TABLE_LENGTH, TABLE_WIDTH, apply, homography } from "../public/js/geom.js";

const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function invert(H) {
  const [a, b, c, e, f, g, h, i, j] = H;
  const A = f * j - g * i, B = -(e * j - g * h), C = e * i - f * h;
  const det = a * A + b * B + c * C;
  return [A, -(b * j - c * i), b * g - c * f, B, a * j - c * h, -(a * g - c * e), C, -(a * i - b * h), a * f - b * e].map((v) => v / det);
}
// table metres -> picture for a quad in walk order; the shorter pair of opposite sides is the width
function tableToPicture(q) {
  const s01 = d(q[0], q[1]) + d(q[2], q[3]);
  const s12 = d(q[1], q[2]) + d(q[3], q[0]);
  const [a, b] = s01 < s12 ? [TABLE_WIDTH, TABLE_LENGTH] : [TABLE_LENGTH, TABLE_WIDTH];
  return homography([{ x: 0, y: 0 }, { x: a, y: 0 }, { x: a, y: b }, { x: 0, y: b }], q);
}
export function quadError(fit, truth) {
  const cornerPx = fit.map((p, i) => d(p, truth[i]));
  let lineMaxPx = 0;
  for (let e = 0; e < 4; e++) {
    const a = fit[e], b = fit[(e + 1) % 4];
    const len = d(a, b) || 1;
    for (let k = 0; k <= 8; k++) {
      const t = 0.1 + (0.8 * k) / 8;
      const p = { x: truth[e].x + (truth[(e + 1) % 4].x - truth[e].x) * t, y: truth[e].y + (truth[(e + 1) % 4].y - truth[e].y) * t };
      lineMaxPx = Math.max(lineMaxPx, Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / len);
    }
  }
  const Ht = tableToPicture(truth);
  const Hf = tableToPicture(fit);
  let tableMaxCm = Infinity;
  if (Ht && Hf) {
    const back = invert(Hf);
    const s01 = d(truth[0], truth[1]) + d(truth[2], truth[3]) < d(truth[1], truth[2]) + d(truth[3], truth[0]);
    const [A, B] = s01 ? [TABLE_WIDTH, TABLE_LENGTH] : [TABLE_LENGTH, TABLE_WIDTH];
    tableMaxCm = 0;
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 4; j++) {
      const m = { x: (A * i) / 8, y: (B * j) / 4 };
      const r = apply(back, apply(Ht, m));
      tableMaxCm = Math.max(tableMaxCm, d(r, m) * 100);
    }
  }
  return { cornerPx, cornerMaxPx: Math.max(...cornerPx), lineMaxPx, tableMaxCm };
}
