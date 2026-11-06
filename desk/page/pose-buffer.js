// The analyzer's own record of the players' joints, per shot. Pure, so it runs in the page and in
// tests. The joints of each frame go into a time-based buffer per table end; when a shot is known,
// the frames at the shot's reference times are copied out of it. A time the buffer no longer holds
// gives null. Only the desk uses this; the phone records no pose. See docs/analysis-desk.md.

// nose, then MediaPipe's body points 11..32: no other face point is kept
export const JOINTS = [0, ...Array.from({ length: 22 }, (_, i) => i + 11)];
export const AT = [-0.77, -0.4, 0];
const WINDOW_S = 1.2;
// the nearest frame stands in for a reference time up to this far away (one dropped frame at 30 fps)
const MAX_GAP_S = 0.05;
const SIDES = ["near", "far"];
// the racket wrist is the one that moves fastest in this time before the hit
const SWING_S = 0.3;
const WRISTS = { L: 15, R: 16 };
const MIN_WRIST_V = 0.5;

const round = (v) => Math.round(v * 1000) / 1000;
const centre = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// Image joints: origin the hip centre, unit the torso (shoulder centre to hip centre), so body size
// and the player's place in the picture are gone. null when the torso has no length.
export function joints2d(lm) {
  const hip = centre(lm[23], lm[24]);
  const shoulder = centre(lm[11], lm[12]);
  const torso = Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y);
  if (torso === 0) return null;
  return JOINTS.map((i) => [round((lm[i].x - hip.x) / torso), round((lm[i].y - hip.y) / torso), round(lm[i].v)]);
}

// MediaPipe's world landmarks (lm.world, see createPose): metres, already around the hips.
export function joints3d(lm) {
  if (!lm.world) return null;
  return JOINTS.map((i) => {
    const p = lm.world[i];
    return [round(p.x), round(p.y), round(p.z), round(p.visibility ?? lm[i].v)];
  });
}

export class ShotPoses {
  constructor(model) {
    this.model = model;
    this.hist = { near: [], far: [] };
    this.pending = [];
    this.poses = new Map();
  }

  // shot and shotUpdate events, the same pair RallyShots gathers shots from
  onEvent(e) {
    if ((e.type !== "shot" && e.type !== "shotUpdate") || this.poses.has(e.shot)) return;
    this.poses.set(e.shot, null);
    this.pending.push(e.shot);
  }

  // After each processed frame: rally.js reports a shot from inside that frame, so the shot is read
  // here, once the frame's own joints are in the buffer. players is the Pipeline's Players.
  frame(t, players) {
    for (const side of SIDES) {
      const p = players[side];
      const hist = this.hist[side];
      if (p.landmarks && p.seenT === t) hist.push({ t, lm: p.landmarks });
      while (hist.length && t - hist[0].t > WINDOW_S) hist.shift();
    }
    this.settle();
  }

  settle() {
    for (const shot of this.pending) this.poses.set(shot, this.shotPose(shot));
    this.pending = [];
  }

  landmarksAt(side, t) {
    let best = null;
    for (const h of this.hist[side]) if (!best || Math.abs(h.t - t) < Math.abs(best.t - t)) best = h;
    return best && Math.abs(best.t - t) <= MAX_GAP_S ? best.lm : null;
  }

  // The shot's vote for the racket hand: "L" or "R" for the wrist with the higher peak speed in the
  // SWING_S before the hit, null when neither wrist was seen well in two frames of it (or a tie).
  racketVote(side, t) {
    const seen = this.hist[side].filter((h) => h.t >= t - SWING_S - 1e-9 && h.t <= t + 1e-9);
    const peak = (i) => {
      let best = 0;
      for (let k = 1; k < seen.length; k++) {
        const [a, b] = [seen[k - 1], seen[k]];
        if (a.lm[i].v < MIN_WRIST_V || b.lm[i].v < MIN_WRIST_V) continue;
        best = Math.max(best, Math.hypot(b.lm[i].x - a.lm[i].x, b.lm[i].y - a.lm[i].y) / (b.t - a.t));
      }
      return best;
    };
    const [left, right] = [peak(WRISTS.L), peak(WRISTS.R)];
    return left === right ? null : left > right ? "L" : "R";
  }

  // null when no reference time of the shot had this player in the buffer. pose2d.hand is decided
  // over the whole job from the votes (racketHands in desk/run-state.js), not per shot.
  shotPose({ side, t }) {
    const found = AT.map((dt) => this.landmarksAt(side, t + dt));
    if (found.every((lm) => lm === null)) return null;
    return {
      pose2d: { model: this.model, at: AT, frames: found.map((lm) => lm && joints2d(lm)) },
      pose3d: { frames: found.map((lm) => lm && joints3d(lm)) },
      vote: this.racketVote(side, t),
    };
  }

  // { [shotIndex]: { pose2d, pose3d } } for a rally's shots; indices follow the draft's order by time
  rallyPose(shots) {
    this.settle();
    const sorted = [...shots].sort((a, b) => a.t - b.t);
    const posed = sorted.map((shot, i) => [i, this.poses.get(shot)]).filter(([, pose]) => pose);
    for (const shot of sorted) this.poses.delete(shot);
    return Object.fromEntries(posed);
  }
}
