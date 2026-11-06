// The analyzer's side of one run: turns the page's messages into desk Rally records, prints the
// JSON lines the worker reads ({progress} while running, {rallies, pose} at the end) and keeps the
// checkpoint. The page sends, in order: { rally: { startT, draft, pose } } at each rallyEnd (draft
// from RallyShots.draft in public/js/analysis-record.js, pose from ShotPoses.rallyPose in
// desk/page/pose-buffer.js), then { progress: { done, total }, t, resumeFrame, resumeT } every few
// frames.
import { judgePoint } from "../public/js/point.js";

// a racket hand needs this many shot votes at one end of the table; fewer gives null, never a guess
export const MIN_HAND_SHOTS = 5;

// The racket hand of each end over the whole job: the majority of the shots' votes (ShotPoses), or
// null under MIN_HAND_SHOTS votes or on a tie. rallies are this run's Rally records by index.
export function racketHands(rallies, pose) {
  const votes = { near: { L: 0, R: 0 }, far: { L: 0, R: 0 } };
  for (const [rallyIndex, shots] of Object.entries(pose)) {
    for (const [shotIndex, p] of Object.entries(shots)) {
      const side = rallies[rallyIndex]?.shots[shotIndex]?.side;
      if (side && p.vote) votes[side][p.vote] += 1;
    }
  }
  const pick = ({ L, R }) => (L + R < MIN_HAND_SHOTS || L === R ? null : L > R ? "L" : "R");
  return { near: pick(votes.near), far: pick(votes.far) };
}

// the pose the server gets: each shot's pose2d.hand is its end's racketHands, and its own vote goes along
// as pose2d.vote, so the server can decide a player's hand over all their shots (a point clip's job has
// one or two shots, too few for racketHands)
function withHands(rallies, pose) {
  const hands = racketHands(rallies, pose);
  const shotsOf = (rallyIndex, shots) =>
    Object.fromEntries(Object.entries(shots).map(([shotIndex, { vote, ...p }]) => {
      const side = rallies[rallyIndex]?.shots[shotIndex]?.side;
      return [shotIndex, { ...p, pose2d: { ...p.pose2d, hand: side ? hands[side] : null, ...(vote === undefined ? {} : { vote }) } }];
    }));
  return Object.fromEntries(Object.entries(pose).map(([rallyIndex, shots]) => [rallyIndex, shotsOf(rallyIndex, shots)]));
}

// The tournament's Rally record (docs/tournament-link.md, 분석 기록) for one rally the analyzer saw.
// index is the rally's order in the video; startedAt is the match's start plus the rally's video time.
export function deskRally({ startT, draft }, index, playedAt) {
  const judged = judgePoint(draft);
  return {
    v: 1,
    index,
    source: "desk",
    startedAt: playedAt + Math.round(startT * 1000),
    durationMs: draft.durationMs,
    winner: judged ? judged.winner : null,
    nearSlot: 0,
    why: draft.why,
    shots: draft.shots,
    bounces: draft.bounces,
  };
}

export class AnalysisRun {
  // checkpoint: a Checkpoint; out: one JSON-able line per call; given: a gallery job's first-pass Rally
  // records (desk/pass1.js) whose shots this run fills with forehand/backhand and joints, or null
  constructor({ checkpoint, playedAt, out, given = null }) {
    this.checkpoint = checkpoint;
    this.playedAt = playedAt;
    this.out = out;
    this.given = given;
    this.state = { pose: {}, fills: {}, ...checkpoint.load() };
  }

  get startFrame() {
    return this.state.resumeFrame;
  }

  onMessage(m) {
    // { fill: { rally, shot, stroke, pose } }: one first-pass shot read from this run's players
    if (m.fill) {
      this.state.fills[`${m.fill.rally}:${m.fill.shot}`] = { stroke: m.fill.stroke ?? null, pose: m.fill.pose ?? null };
      return;
    }
    if (m.rally) {
      const index = this.state.rallies.length;
      this.state.rallies.push(deskRally(m.rally, index, this.playedAt));
      if (Object.keys(m.rally.pose ?? {}).length > 0) this.state.pose[index] = m.rally.pose;
      return;
    }
    this.state = { ...this.state, lastFrame: m.progress.done, lastT: m.t, resumeFrame: m.resumeFrame, resumeT: m.resumeT };
    this.checkpoint.update(this.state);
    this.out({ progress: m.progress });
  }

  // a rally still open at the last frame was ended by the page after the last progress, so the
  // finished checkpoint begins after the last frame: a rerun adds nothing twice
  // timing: "track" or "estimated" when shot times came from a 다시 보기 track, else null
  finish(timing = null) {
    this.state = { ...this.state, resumeFrame: this.state.lastFrame, resumeT: this.state.lastT };
    this.checkpoint.save(this.state);
    if (this.given) return this.out(filledRallies(this.given, this.state.fills));
    this.out({ rallies: this.state.rallies, pose: withHands(this.state.rallies, this.state.pose), ...(timing ? { timing } : {}) });
  }
}

// The first-pass rallies with each shot's forehand/backhand from its fill (null when the run could not
// read it) and the joints of the shots that have them, keyed like the rallies.
export function filledRallies(given, fills) {
  const pose = {};
  const rallies = given.map((r, ri) => ({
    ...r,
    shots: r.shots.map((s, si) => {
      const fill = fills[`${ri}:${si}`];
      if (fill?.pose) (pose[ri] ??= {})[si] = fill.pose;
      return { ...s, stroke: fill?.stroke ?? null };
    }),
  }));
  return { rallies, pose: withHands(rallies, pose) };
}
