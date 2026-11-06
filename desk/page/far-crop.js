// In a portrait gallery video the far player is small: on the labelled test_5 video the whole-frame pose
// found them in 6% of frames and at none of the 25 far shots, while the same model on a crop of the far end
// found them at 10 of 25. Around each first-pass far shot the desk also reads that crop.
export const CROP_AROUND_S = 0.15;
const SIDE = 0.6;
const ABOVE = 1.4;
const BELOW = 0.35;

// The far end's box in video pixels from the four table corners: the two upper corners are the far edge;
// the box reaches SIDE edge lengths past each far corner, ABOVE above the edge and BELOW below it.
export function farBox(corners, width, height) {
  const [a, b] = [...corners].sort((p, q) => p.y - q.y).slice(0, 2).sort((p, q) => p.x - q.x);
  const edge = Math.hypot(b.x - a.x, b.y - a.y);
  const x0 = Math.max(0, Math.round(a.x - SIDE * edge));
  const x1 = Math.min(width, Math.round(b.x + SIDE * edge));
  const y0 = Math.max(0, Math.round(Math.min(a.y, b.y) - ABOVE * edge));
  const y1 = Math.min(height, Math.round(Math.max(a.y, b.y) + BELOW * edge));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function toFrame(poses, box) {
  return poses.map((pose) => {
    const out = pose.map((p) => ({ x: p.x + box.x, y: p.y + box.y, v: p.v }));
    if (pose.world !== undefined) out.world = pose.world;
    return out;
  });
}

// A phone filming from beside the table sees the far player's legs behind the table edge, and the pipeline
// counts a person only with a leg seen and the feet on the floor plan (players.js plausiblePerson): on a real
// rally original the full model saw the far server with a sure torso (all four points 0.96 or more) at the
// hit and was turned away on the legs. For the desk's joints only, such a person is the far player when the
// torso is surely seen, the hips are inside the far box and nearer the far end than the near one. The
// camera's own players and scoring keep the stricter rule.
const TORSO_VIS = 0.6;
export function hiddenLegsFar(poses, cal, box) {
  if (!cal || !cal.myEnd || !cal.oppEnd) return null;
  let best = null;
  for (const lm of poses) {
    if (!lm || lm.length < 25 || ![11, 12, 23, 24].every((i) => lm[i] && lm[i].v >= TORSO_VIS)) continue;
    const hip = { x: (lm[23].x + lm[24].x) / 2, y: (lm[23].y + lm[24].y) / 2 };
    if (hip.x < box.x || hip.x > box.x + box.w || hip.y < box.y || hip.y > box.y + box.h) continue;
    if (Math.hypot(hip.x - cal.oppEnd.x, hip.y - cal.oppEnd.y) >= Math.hypot(hip.x - cal.myEnd.x, hip.y - cal.myEnd.y)) continue;
    const sh = { x: (lm[11].x + lm[12].x) / 2, y: (lm[11].y + lm[12].y) / 2 };
    const torso = Math.hypot(sh.x - hip.x, sh.y - hip.y);
    if (!best || torso > best.torso) best = { lm, torso };
  }
  return best ? best.lm : null;
}

export function farFrames(given, fps) {
  const frames = new Set();
  for (const g of given) {
    if (g.side !== "far") continue;
    for (let f = Math.max(0, Math.ceil((g.t - CROP_AROUND_S) * fps)); f <= Math.floor((g.t + CROP_AROUND_S) * fps); f++) frames.add(f);
  }
  return frames;
}
