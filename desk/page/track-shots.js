// A 다시 보기 original's shots and bounces in clip time, read from its overlay track
// (public/js/replay-track.js) instead of following the ball again: the desk only takes pose around
// them. Pure, so it runs in the page and in tests.
//   timing "track"      frames carry cam (the camera clock): a camera time c is at clip time
//                       t + (c - cam) of the frame whose cam is nearest. Exact to the millisecond.
//   timing "estimated"  an original from before cam: a shot is put at the frame, in the 1.5 s up to
//                       the frame that first shows it, whose ball is nearest the shot's place. Off by
//                       up to a frame; the desk marks such a result as estimated. Bounces move by the
//                       shots' median offset.
const LOOKBACK_MS = 1500;

function fold(frames) {
  const out = [];
  let cur = {};
  for (const f of frames) {
    const { t, cam, ...parts } = f;
    cur = { ...cur, ...parts };
    out.push({ t, cam: Number.isFinite(cam) ? cam : null, state: cur });
  }
  return out;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

const round = (v) => Math.round(v * 1000) / 1000;

// { timing, shots: [{ t, side, stroke, kind, speedKmh, arc, inferred }], bounces: [{ tx, ty, side, t }] },
// times in clip seconds; timing is null when the track has no shot.
export function trackShots(doc) {
  const frames = fold(Array.isArray(doc?.frames) ? doc.frames : []);
  const byIndex = new Map();
  frames.forEach((f, k) => {
    const s = f.state.lastShot;
    if (!s || !Number.isFinite(s.index) || !Number.isFinite(s.t)) return;
    const seen = byIndex.get(s.index);
    byIndex.set(s.index, { shot: s, first: seen ? seen.first : k });
  });
  if (!byIndex.size) return { timing: null, shots: [], bounces: [] };
  const withCam = frames.filter((f) => f.cam !== null);
  const timing = withCam.length ? "track" : "estimated";
  const atCam = (c) => {
    let best = withCam[0];
    for (const f of withCam) if (Math.abs(f.cam - c) < Math.abs(best.cam - c)) best = f;
    return best.t / 1000 + (c - best.cam);
  };
  const byPlace = ({ shot, first }) => {
    const end = frames[first].t;
    let best = null;
    for (let k = first; k >= 0 && end - frames[k].t <= LOOKBACK_MS; k--) {
      const b = frames[k].state.ball?.current;
      if (!b || !shot.at) continue;
      const d = Math.hypot(b.x - shot.at.x, b.y - shot.at.y);
      if (!best || d < best.d) best = { d, t: frames[k].t / 1000 };
    }
    return best ? best.t : null;
  };
  const shots = [];
  const offsets = [];
  for (const entry of [...byIndex.values()].sort((a, b) => a.shot.index - b.shot.index)) {
    const t = timing === "track" ? atCam(entry.shot.t) : byPlace(entry);
    if (t === null) continue;
    offsets.push(t - entry.shot.t);
    const s = entry.shot;
    shots.push({ t: round(t), side: s.side, stroke: s.stroke ?? null, kind: s.kind ?? null, speedKmh: s.speedKmh ?? null, arc: s.arc ?? null, inferred: false });
  }
  const shift = median(offsets);
  const last = frames.length ? frames[frames.length - 1].state.bounces : null;
  const bounces = (Array.isArray(last) ? last : [])
    .filter((b) => Number.isFinite(b?.t))
    .map((b) => ({ tx: b.tx ?? null, ty: b.ty ?? null, side: b.side, t: round(timing === "track" ? atCam(b.t) : b.t + shift) }));
  return { timing, shots, bounces };
}
