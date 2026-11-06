// 카메라 여러 대 (docs/multicam.md). Two phones with the PIN on one match: each judges as before,
// the secondary sends its finished rallies to the primary, and the primary fills the bounces and
// shots it lost (공 찾는 중, a body in the way) with the other camera's, then judges once.
// One camera: nothing here runs and the judging is the one-camera path untouched.
import { judgePoint, suspects } from "./point.js";
import { TABLE_LENGTH, TABLE_WIDTH } from "./geom.js";
import { L } from "./i18n.js";

// Two cameras' segments are one rally when they share at least this much time. One rally seen by
// both shares far more; a rally that starts right after the other camera's previous one ended
// (rally.js cuts no_bounce / no_shot rallies while the ball is still seen) shares none, beyond the
// clock error (<= 50 ms) and a frame.
export const MIN_OVERLAP_MS = 100;
// the primary waits at most this long for a camera that keeps saying it is still in the rally
export const MAX_WAIT_MS = 15000;
export const STALE_MS = 3000; // a camera silent this long is not waited for
export const BOUNCE_DT_MS = 100; // the same bounce seen by two cameras: time apart at most
export const BOUNCE_DM = 0.6; // ... and table distance at most (m), when both have it
export const SHOT_DT_MS = 250; // the same hit seen by two cameras
const CLOCK_KEEP = 8;

// Offset from this phone's performance clock to the tournament server's Date.now(), from pings
// over the WebSocket: offset = s - (c + rtt / 2), kept from the fastest of the last few answers.
// Its error is at most rtt / 2 of that answer (errMs).
export class Clock {
  constructor() {
    this.samples = [];
  }

  sample(c, s, now) {
    const rtt = now - c;
    if (!(rtt >= 0) || !Number.isFinite(s)) return;
    this.samples.push({ rtt, off: s - (c + rtt / 2) });
    if (this.samples.length > CLOCK_KEEP) this.samples.shift();
  }

  best() {
    let b = null;
    for (const x of this.samples) if (!b || x.rtt < b.rtt) b = x;
    return b;
  }

  get ok() {
    return this.samples.length > 0;
  }

  get offset() {
    const b = this.best();
    return b ? b.off : 0;
  }

  get errMs() {
    const b = this.best();
    return b ? Math.round(b.rtt / 2) : null;
  }

  // performance-clock ms -> server ms
  toServer(perfMs) {
    return perfMs + this.offset;
  }
}

const mirrorX = (x, near) => (x == null ? null : near === 1 ? TABLE_LENGTH - x : x);
const mirrorY = (y, near) => (y == null ? null : near === 1 ? TABLE_WIDTH - y : y);

// One camera's rallyEnd (rally.js, times in seconds of the performance clock) as a segment both
// cameras read the same way: server ms, and end colours (0 blue, 1 red) instead of near / far,
// with table x / y measured from the blue end. near: the end colour nearest this camera.
export function shareSegment(e, { near = 0, offset = 0, cam = "self" } = {}) {
  const ms = (t) => Math.round(t * 1000 + offset);
  const end = (side) => (side === "near" ? near : 1 - near);
  return {
    cam,
    near,
    why: e.why,
    startMs: ms(e.t - (e.durationS || 0)),
    endMs: ms(e.t),
    bounces: (e.bounces || []).map((b) => ({ t: ms(b.t), end: end(b.side), x: mirrorX(b.tx, near), y: mirrorY(b.ty, near) })),
    shots: (e.shotList || []).map((s) => ({ t: ms(s.t), end: end(s.side), inferred: !!s.inferred })),
    serveNet: e.serveNet || null,
    serveSeen: e.serveSeen || null,
    maxSpeedKmh: e.maxSpeedKmh ?? null,
  };
}

// The same segment as if its camera had the other near end colour: every end swaps and table x / y
// turn 180 degrees about the table centre.
export function turnSegment(seg) {
  const turn = (x) => ({ ...x, end: 1 - x.end, ...("x" in x ? { x: x.x == null ? null : TABLE_LENGTH - x.x, y: x.y == null ? null : TABLE_WIDTH - x.y } : {}) });
  return { ...seg, near: seg.near == null ? null : 1 - seg.near, bounces: seg.bounces.map(turn), shots: seg.shots.map(turn) };
}

// Back to one camera's near / far (what point.js reads) and its table x / y, times in seconds.
function toLocal(list, near) {
  return list.map((x) => ({ ...x, t: x.t / 1000, side: x.end === near ? "near" : "far", ...("x" in x ? { tx: mirrorX(x.x, near), ty: mirrorY(x.y, near) } : {}) }));
}

const sameBounce = (a, b) =>
  a.cam !== b.cam && a.end === b.end && Math.abs(a.t - b.t) <= BOUNCE_DT_MS && (a.x == null || b.x == null || Math.hypot(a.x - b.x, (a.y ?? 0) - (b.y ?? 0)) <= BOUNCE_DM);
const sameShot = (a, b) => a.cam !== b.cam && a.end === b.end && Math.abs(a.t - b.t) <= SHOT_DT_MS;

// All cameras' events of one rally, each real event once. Where two cameras saw the same bounce the
// primary's is kept; for a hit, a measured one over an inferred one (then the primary's).
export function mergeEvents(segs, primary) {
  const bounces = [];
  const shots = [];
  const all = (key) => segs.flatMap((s) => s[key].map((x) => ({ ...x, cam: s.cam }))).sort((a, b) => a.t - b.t);
  for (const b of all("bounces")) {
    const i = bounces.findIndex((k) => sameBounce(k, b));
    if (i < 0) bounces.push(b);
    else if (b.cam === primary && bounces[i].cam !== primary) bounces[i] = b;
  }
  for (const s of all("shots")) {
    const i = shots.findIndex((k) => sameShot(k, s));
    if (i < 0) shots.push(s);
    else {
      const k = shots[i];
      if ((k.inferred && !s.inferred) || (k.inferred === s.inferred && s.cam === primary && k.cam !== primary)) shots[i] = s;
    }
  }
  return { bounces, shots };
}

// Judge one merged rally on the primary. near: the primary's near end colour.
//   judged    point.js's call on the merged events (null: nothing to score)
//   conflict  two cameras that both saw the rally's last bounce call different winners: ask
//             (누가 땄나요) instead of entering. A camera that lost the ball before the last bounce
//             has an unfinished view; the merge fills it, that is not a conflict.
//   filled    bounces the primary did not see that came from the other camera
export function judgeRally(segs, { primary = "self", near = 0 } = {}) {
  const { bounces, shots } = mergeEvents(segs, primary);
  const durationS = (Math.max(...segs.map((s) => s.endMs)) - Math.min(...segs.map((s) => s.startMs))) / 1000;
  const judged = judgePoint({ shots: toLocal(shots, near), bounces: toLocal(bounces, near), durationS });
  const last = bounces.length ? Math.max(...bounces.map((b) => b.t)) : null;
  const cams = [...new Set(segs.map((s) => s.cam))];
  const perCam = {};
  for (const cam of cams) {
    const own = segs.filter((s) => s.cam === cam);
    const ob = own.flatMap((s) => s.bounces);
    const os = own.flatMap((s) => s.shots);
    const j = judgePoint({ shots: toLocal(os, near), bounces: toLocal(ob, near) });
    const lastOwn = ob.length ? Math.max(...ob.map((b) => b.t)) : null;
    perCam[cam] = { judged: j, bounces: ob.length, sawLast: last != null && lastOwn != null && lastOwn >= last - BOUNCE_DT_MS };
  }
  const voters = cams.filter((c) => perCam[c].judged && perCam[c].sawLast);
  const conflict = voters.length >= 2 && new Set(voters.map((c) => perCam[c].judged.winner)).size > 1;
  // two cameras that both saw the last bounce called the same winner: right whatever either camera's pick
  // (a turned pick turns its own call), so it is not a point the end check could put in doubt
  const agreed = voters.length >= 2 && !conflict;
  const filled = bounces.filter((b) => b.cam !== primary).length;
  // fault / let questions read the serve: the segment holding the rally's first hit
  const first = shots[0];
  const serveSeg = (first && segs.find((s) => s.cam === first.cam && s.shots.some((x) => x.t === first.t))) || segs[0];
  const suspect = serveSeg
    ? suspects({ shots: toLocal(shots, near), bounces: toLocal(bounces, near), serveNet: serveSeg.serveNet, serveSeen: serveSeg.serveSeen })
    : null;
  const startMs = Math.min(...segs.map((s) => s.startMs));
  const endMs = Math.max(...segs.map((s) => s.endMs));
  return {
    judged,
    conflict,
    agreed,
    perCam,
    filled,
    suspect,
    bounces: toLocal(bounces, near),
    shots: toLocal(shots, near),
    startMs,
    endMs,
    maxSpeedKmh: segs.reduce((m, s) => (s.maxSpeedKmh != null && (m == null || s.maxSpeedKmh > m) ? s.maxSpeedKmh : m), null),
    stopped: segs.some((s) => s.cam === primary && s.why === "stop"),
  };
}

// 끝 색 자동 맞춤 (docs/multicam.md). Which end colour is really nearest the other camera is read from
// bounces both cameras saw: a bounce the other camera sent lands where this camera saw it either as
// sent (its near colour is right) or only once turned 180 degrees (its near colour is the other one).
// Each such bounce is one vote for the other camera's true near colour; a bounce that fits both
// (the middle of the table) is no vote. Measured on the public videos:
// 0 wrong decisions in 17,622 trials up to 0.5 m calibration noise, usually within 1-11 s of play.
export const END_VOTES = 3; // a decision: this many votes for one colour among the last END_WINDOW, none for the other
export const END_WINDOW = 6;
const fits = (a, b) => a.end === b.end && (a.x == null || b.x == null || Math.hypot(a.x - b.x, (a.y ?? 0) - (b.y ?? 0)) <= BOUNCE_DM);

// Votes for the true near colour of each other camera in one rally (segments in the shared frame).
export function endVotes(segs, primary = "self") {
  const own = segs.filter((s) => s.cam === primary).flatMap((s) => s.bounces);
  const votes = [];
  for (const s of segs) {
    if (s.cam === primary) continue;
    const near = s.near === 1 ? 1 : 0;
    const turned = turnSegment(s);
    s.bounces.forEach((b, i) => {
      const a = own.find((o) => Math.abs(o.t - b.t) <= BOUNCE_DT_MS);
      if (!a) return;
      const asSent = fits(a, b);
      const asTurned = fits(a, turned.bounces[i]);
      if (asSent !== asTurned) votes.push({ cam: s.cam, near: asSent ? near : 1 - near, t: b.t });
    });
  }
  return votes.sort((x, y) => x.t - y.t);
}

// The primary's check of each other camera's end colour. A person picks every phone's near end colour
// (on the calibration screen after the four corners, and in settings), and merging reads each phone's
// rallies with its own pick from the start. The shared bounces only warn: when END_VOTES of the last
// END_WINDOW votes say the other camera's pick is turned (and more than say it is right), its state is
// "mismatch" and the screen says so; merging goes on with the picks. Measured with the picks right on
// the public videos (8,811 noisy trials up to 0.5 m): 0 warnings; with one pick turned 8,807 warned.
//   ok        no sign the pick is wrong (also before any shared bounce)
//   mismatch  the bounces say that phone's pick is turned; cleared when that phone's pick changes
export class EndSync {
  constructor() {
    this.cams = new Map();
  }

  get(cam) {
    return this.cams.get(cam) || { state: "ok", near: null, votes: [] };
  }

  reset() {
    this.cams.clear();
  }

  forget(cam) {
    this.cams.delete(cam);
  }

  // That phone's pick as its status says it; a new pick starts its check again. Returns what changed.
  pick(cam, near) {
    const c = this.get(cam);
    if (near !== 0 && near !== 1) return [];
    if (c.near === near) return [];
    const was = c.state;
    this.cams.set(cam, { state: "ok", near, votes: [] });
    return was === "ok" ? [] : [{ cam, state: "ok", near }];
  }

  // Count one rally's votes against each camera's pick (the near colour its segment was sent with);
  // returns what changed: [{ cam, state, near }].
  observe(segs, primary = "self") {
    const changed = [];
    const sent = new Map(segs.filter((s) => s.cam !== primary).map((s) => [s.cam, s.near === 1 ? 1 : 0]));
    for (const v of endVotes(segs, primary)) {
      const c = this.get(v.cam);
      const near = sent.get(v.cam);
      if (c.near !== near) { c.near = near; c.state = "ok"; c.votes = []; }
      c.votes = [...c.votes, v.near === near ? 0 : 1].slice(-END_WINDOW);
      const against = c.votes.filter(Boolean).length;
      if (c.state === "ok" && against >= END_VOTES && against > c.votes.length - against) {
        c.state = "mismatch";
        changed.push({ cam: v.cam, state: "mismatch", near });
      }
      this.cams.set(v.cam, c);
    }
    return changed;
  }
}

// 점수 보류 (docs/multicam.md "Score hold"). Once the end check warns, nobody knows which phone's pick is
// turned, so no judged point of that match is entered by itself: each one asks (누가 땄나요), and the tap names
// an end colour, which the match's ends turn into a player whatever either camera picked. A person changing a
// pick on either phone ends the hold; if the picks still disagree the next shared bounces warn again.
export const HOLD_REASON = L("점수 보류 · 끝 색 확인", "Scoring paused · check end colours");

// What the primary does with one judged rally (judgeRally's result): ask, and why, or enter.
export function scoreAction(r, { hold = false } = {}) {
  if (hold) return { ask: true, reason: HOLD_REASON, hold: true };
  if (r.conflict) return { ask: true, reason: L("카메라 2대 판정이 달라요", "The 2 cameras disagree"), hold: false };
  return { ask: false, reason: null, hold: false };
}

// The hold of one match, kept by the primary (and stored, so a reload keeps it). auto: the points entered
// by themselves since the picks last changed, with the side each went to; when the check warns they are
// the ones that may have gone to the wrong player, handed back once to be marked for the referee (never
// changed by themselves). A point two cameras agreed on is not listed (see judgeRally's agreed).
export const HOLD_KEEP = 60;
export class EndHold {
  constructor(saved = null) {
    this.matchId = saved && saved.matchId != null ? saved.matchId : null;
    this.on = !!(saved && saved.on);
    this.auto = saved && Array.isArray(saved.auto) ? saved.auto.slice(-HOLD_KEEP) : [];
  }

  // the match this phone scores now; another match starts with no hold and nothing listed
  for(matchId) {
    if (matchId === this.matchId) return false;
    this.matchId = matchId;
    this.on = false;
    this.auto = [];
    return true;
  }

  // a point entered by itself: { index, side } (side: the tournament slot it went to)
  entered(point) {
    if (this.on) return;
    this.auto = [...this.auto, point].slice(-HOLD_KEEP);
  }

  // the end check warned: hold, and the listed points to mark (once)
  warn() {
    if (this.on) return [];
    const marks = this.auto;
    this.on = true;
    this.auto = [];
    return marks;
  }

  // a person changed a pick: the points from here on are judged with the new picks
  picked() {
    const was = this.on;
    this.on = false;
    this.auto = [];
    return was;
  }

  toJSON() {
    return { matchId: this.matchId, on: this.on, auto: this.auto };
  }
}

// The primary's rally collector. Two segments of different cameras that overlap in time (within
// MIN_OVERLAP_MS) are one rally, and so is everything they chain to: when a body hides the ball from one
// camera, its rally ends (ball_lost) and a new one starts after; the other camera's segment spans
// both and joins them. One camera's own segments are never joined to each other, so with one
// camera every rally is judged on its own, as rally.js cut it. A rally is closed once no camera
// still heard from is in a rally that could join it, or MAX_WAIT_MS after its latest segment came
// in. A segment that overlaps another camera's segment in a closed rally is dropped, so a rally is
// never scored twice.
const overlaps = (a, b, min = MIN_OVERLAP_MS) => Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs) >= min;

export class Merger {
  constructor({ minOverlapMs = MIN_OVERLAP_MS, maxWaitMs = MAX_WAIT_MS, staleMs = STALE_MS } = {}) {
    this.minOverlapMs = minOverlapMs;
    this.maxWaitMs = maxWaitMs;
    this.staleMs = staleMs;
    this.segs = [];
    this.closed = []; // segments of judged rallies, kept a little to refuse late pieces of them
    this.cams = new Map(); // cam -> { active, startMs, at }
    this.dropped = 0;
  }

  // a camera's rally state (startMs in server ms); at = local receive time
  status(cam, { active = false, startMs = null } = {}, at = Date.now()) {
    this.cams.set(cam, { active: !!active, startMs, at });
  }

  forget(cam) {
    this.cams.delete(cam);
  }

  add(seg, at = Date.now()) {
    const into = this.closed.find((c) => c.cam !== seg.cam && overlaps(c, seg, this.minOverlapMs));
    if (into) {
      this.dropped++;
      // kept for QA: which piece came late and into which judged rally (bounded)
      this.droppedSegs = [...(this.droppedSegs || []).slice(-19), { cam: seg.cam, startMs: seg.startMs, endMs: seg.endMs, bounces: seg.bounces.length, into: { cam: into.cam, startMs: into.startMs, endMs: into.endMs }, lateMs: at - into.closedAt }];
      return false;
    }
    this.segs.push({ ...seg, at });
    return true;
  }

  // connected groups: an edge between two segments of different cameras that overlap
  groups() {
    const segs = [...this.segs].sort((a, b) => a.startMs - b.startMs);
    const group = segs.map((_, i) => i);
    const root = (i) => (group[i] === i ? i : (group[i] = root(group[i])));
    for (let i = 0; i < segs.length; i++)
      for (let j = i + 1; j < segs.length; j++)
        if (segs[i].cam !== segs[j].cam && overlaps(segs[i], segs[j], this.minOverlapMs)) group[root(j)] = root(i);
    const byRoot = new Map();
    segs.forEach((s, i) => {
      const r = root(i);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(s);
    });
    return [...byRoot.values()].map((g) => ({ segs: g, startMs: Math.min(...g.map((s) => s.startMs)), endMs: Math.max(...g.map((s) => s.endMs)), at: Math.max(...g.map((s) => s.at)) })).sort((a, b) => a.startMs - b.startMs);
  }

  // A camera in a rally right now could still join group g: g has another camera's segment that
  // runs past that rally's start by the overlap a join needs.
  couldJoin(cam, c, g, now) {
    if (!c.active || now - c.at > this.staleMs) return false;
    const start = c.startMs ?? -Infinity;
    return g.segs.some((s) => s.cam !== cam && s.endMs - start >= this.minOverlapMs);
  }

  // Rallies ready to judge now, oldest first.
  poll(now = Date.now()) {
    const ready = [];
    for (const g of this.groups()) {
      const waiting = [...this.cams].some(([cam, c]) => this.couldJoin(cam, c, g, now));
      if (waiting && now - g.at < this.maxWaitMs) break;
      ready.push(g.segs);
      this.closed.push(...g.segs.map((s) => ({ ...s, closedAt: now })));
      this.segs = this.segs.filter((s) => !g.segs.includes(s));
    }
    while (this.closed.length > 50) this.closed.shift();
    return ready;
  }
}
