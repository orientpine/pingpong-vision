// The overlay of a rally clip, kept as data beside the camera's own picture (the picture is saved
// as filmed and the overlay is drawn again on replay). The recorder adds one frame per
// recorded picture: the time since the clip's first picture and the parts of the camera state the
// screen draws from (ui.js render + hud.js drawHud). A frame keeps only the parts that changed since
// the one before. The replay page (replay.js) rebuilds the full state for any time and draws it with
// the camera screen's own code.
//
// File: gzip of JSON { v: 1, meta, frames: [{ t, cam, ...changed parts }], notices: [{ t, text }] } on the PC,
// served back as plain JSON. cam is the camera clock (seconds) of the state, the clock shot and bounce
// times use, so the analysis desk can find a shot in the clip; files from before it have no cam.

export const TRACK_VERSION = 1;

// what the screen draws from; everything else in the camera state (settings, link, save) stays out
export const TRACK_KEYS = ["rally", "ball", "bounces", "lastShot", "players", "tracking", "calibrationIssue", "calibration", "colorHint"];

// positions to a tenth of a video pixel, everything else to two decimals
function round(v, key) {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    const k = key === "x" || key === "y" ? 10 : 100;
    return Math.round(v * k) / k;
  }
  if (Array.isArray(v)) return v.map((x) => round(x, key));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      // a landmark's depth and the trail's timestamps are never drawn
      if (k === "z" || (key === "trail" && k === "t")) continue;
      if (x !== undefined) out[k] = round(x, k);
    }
    return out;
  }
  return v;
}

// the drawn parts of one state; trail points carry the key so their t is dropped
export function pick(state) {
  const out = {};
  for (const k of TRACK_KEYS) {
    const v = state[k];
    if (v === undefined) continue;
    if (k === "ball") out.ball = v ? { trail: (v.trail || []).map((p) => round(p, "trail")), current: round(v.current ?? null), lock: round(v.lock ?? null) } : null;
    else if (k === "calibration") out.calibration = v && v.corners ? { corners: round(v.corners) } : null;
    else out[k] = round(v ?? null, k);
  }
  return out;
}

export class TrackWriter {
  constructor(meta = {}) {
    this.meta = meta;
    this.frames = [];
    this.notices = [];
    this.last = {};
    this.t0 = null;
  }

  time(now) {
    if (this.t0 == null) this.t0 = now;
    return Math.round(now - this.t0);
  }

  add(now, state, cam) {
    const t = this.time(now);
    const parts = pick(state);
    const frame = { t };
    if (Number.isFinite(cam)) frame.cam = Math.round(cam * 1000) / 1000;
    for (const [k, v] of Object.entries(parts)) {
      const s = JSON.stringify(v);
      if (this.last[k] !== s) {
        this.last[k] = s;
        frame[k] = v;
      }
    }
    this.frames.push(frame);
  }

  notice(now, text) {
    if (this.t0 == null) return;
    this.notices.push({ t: this.time(now), text: String(text) });
  }

  json() {
    return JSON.stringify({ v: TRACK_VERSION, meta: this.meta, frames: this.frames, notices: this.notices });
  }
}

// the upload body: gzip where the browser has CompressionStream, else the JSON itself (the PC gzips it)
export async function packTrack(text) {
  if (typeof CompressionStream !== "function") return new Blob([text], { type: "application/json" });
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Blob([await new Response(stream).arrayBuffer()], { type: "application/gzip" });
}

// Where a replay starts, in clip ms: LEAD_MS before the rally. The engine starts a rally on the first ball
// it sees, at or just after the serve's hit (10 of 13 club clips from 2026-11-04 put the serve shot within
// 5 ms of it), and the toss starts 0.6-0.8 s before that, so 1 s shows the whole serve; 0.5 s started
// mid-toss. A rally less than MIN_FROM_MS past that, or none, plays from 0. The clip keeps its pre-roll.
export const LEAD_MS = 1000;
const MIN_FROM_MS = 300;
export function replayStartMs(rallyMs, lead = LEAD_MS) {
  if (!Number.isFinite(rallyMs)) return 0;
  const from = rallyMs - lead;
  return from < MIN_FROM_MS ? 0 : from;
}

// A read track: state at any time. frames are folded forward once, so a lookup is a binary search.
export class Track {
  constructor(data) {
    if (!data || data.v !== TRACK_VERSION || !Array.isArray(data.frames)) throw new Error("not an overlay track");
    this.meta = data.meta || {};
    this.notices = (data.notices || []).slice().sort((a, b) => a.t - b.t);
    this.times = [];
    this.states = [];
    // camera clock per frame, null for files recorded before it was kept
    this.cams = [];
    let cur = {};
    for (const f of data.frames) {
      const { t, cam, ...parts } = f;
      cur = { ...cur, ...parts };
      this.times.push(t);
      this.states.push(cur);
      this.cams.push(Number.isFinite(cam) ? cam : null);
    }
  }

  static parse(text) {
    return new Track(JSON.parse(text));
  }

  get duration() {
    return this.times.length ? this.times[this.times.length - 1] : 0;
  }

  indexAt(ms) {
    const ts = this.times;
    if (!ts.length) return -1;
    let lo = 0, hi = ts.length - 1;
    if (ms <= ts[0]) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ts[mid] <= ms) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // the frame shown at ms: the nearest recorded frame, so a picture and its overlay pair up even
  // when the decoder reports a time a hair before the frame's own
  nearest(ms) {
    const i = this.indexAt(ms);
    if (i < 0) return -1;
    return i + 1 < this.times.length && this.times[i + 1] - ms < ms - this.times[i] ? i + 1 : i;
  }

  stateAt(ms) {
    const i = this.nearest(ms);
    return i < 0 ? null : { ...this.states[i], frameT: this.times[i] };
  }

  // the frame on screen when the video stands still at ms (paused, seeked, ended): the last one at or
  // before it, with 2 ms for clock jitter
  stateAtOrBefore(ms) {
    const i = this.indexAt(ms + 2);
    return i < 0 ? null : { ...this.states[i], frameT: this.times[i] };
  }

  // where this clip's rally starts, in clip ms: the first frame with the rally on, less the rally time it
  // already shows (the engine starts a rally on the first ball it sees, the serve). The first frames can
  // still carry the rally before (active false), and a clip queued behind another can start inside its
  // rally (0). null: no rally in the track.
  rallyStartMs() {
    const i = this.states.findIndex((s) => s.rally && s.rally.active);
    if (i < 0) return null;
    return Math.max(0, this.times[i] - (Number(this.states[i].rally.timeMs) || 0));
  }

  // the notice showing at ms (a camera notice stays up 3 s, ui.js)
  noticeAt(ms, showMs = 3000) {
    let hit = null;
    for (const n of this.notices) if (n.t <= ms && ms - n.t < showMs) hit = n;
    return hit;
  }
}
