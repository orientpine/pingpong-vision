// Records one rally as a highlight clip on the phone: the camera's own picture, nothing drawn on it,
// encoded with MediaRecorder, plus the overlay as data on the same clock (replay-track.js) so a
// replay draws it with the camera screen's code and can fold or hide it.
// Recording runs only between rallyStart and rallyEnd, so nothing outside a rally is ever encoded
// or uploaded, apart from the pre-roll: while armed (PC save on), the last second of pictures waits in
// a FrameRing and the clip is drawn from it, so a clip starts three seconds before rallyStart (rally.js can call the start a few tenths of a second after the serve) (the
// serve's backswing) and ends at rallyEnd. See frame-ring.js for the memory bound.
import { FrameRing, PREROLL_MS } from "./frame-ring.js";

export const RING_LONG_SIDE = 480;
// camera calls this far apart mean the page was paused (hidden, or the camera stopped)
const PAUSE_MS = 1000;
import { TrackWriter, packTrack, pick } from "./replay-track.js";

const TYPES = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

export function pickMimeType() {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return null;
  return TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || null;
}

export class RallyRecorder {
  // maxSeconds: Safari 26 MediaRecorder writes frozen video after about 15 s in video/mp4
  // (https://bugs.webkit.org/show_bug.cgi?id=315091), so a longer rally keeps its first 14 s.
  // overlay: keep the overlay track (설정 → 다시 보기 오버레이, on by default); off, the clip is the
  // picture alone.
  constructor({ maxWidth = 960, fps = 30, bitsPerSecond = 2_000_000, maxSeconds = 14, overlay = true, preRollMs = PREROLL_MS } = {}) {
    this.overlay = overlay;
    this.preRollMs = preRollMs;
    this.ring = null;
    this.stopping = null;
    // set by the camera each frame: buffer the pre-roll only while a clip may be saved (see armed below)
    this._armed = false;
    this.armedAt = null;
    // why the recorder was last not armed and for how long (arm()), and when the camera calls came back
    // after a pause over PAUSE_MS (a hidden page sends no pictures): both go in a clip's meta.start
    this.offWhy = "start";
    this.offAt = null;
    this.lastOff = null;
    this.lastCallAt = null;
    this.resumedAt = null;
    this.pauseMs = null;
    this.lastCam = null;
    this.minCam = null;
    // when the pre-roll pool was last made (setSize) and how many times: a clip's meta.start says how
    // long the pool had been filling, so a short pre-roll names its cause
    this.ringAt = null;
    this.rings = 0;
    // the camera time of the next picture the pool keeps (thin)
    this.nextKeep = null;
    this.raf = null;
    this.lastTickAt = -Infinity;
    this.maxSeconds = maxSeconds;
    this.maxWidth = maxWidth;
    this.fps = fps;
    this.bitsPerSecond = bitsPerSecond;
    this.mimeType = pickMimeType();
    this.rec = null;
    // each clip has its own id (start's answer); stop(id) answers only for that clip
    this.nextClipId = 1;
    this.recId = null;
    this.chunks = [];
    this.track = null;
  }

  get armed() {
    return this._armed;
  }

  set armed(on) {
    this.arm(on);
  }

  // why: when not armed, the reason (the camera's mode, "no-save", "secondary"), kept for meta.start
  arm(on, why = null) {
    const now = performance.now();
    if (on && !this._armed) {
      this.armedAt = now;
      this.lastOff = { why: this.offWhy, forMs: this.offAt === null ? null : Math.round(now - this.offAt) };
    }
    if (!on && (this._armed || this.offAt === null)) this.offAt = now;
    if (!on) this.offWhy = why ?? this.offWhy;
    this._armed = on;
  }

  // A camera faster than the clip's fps (phones give 34-39 pictures a second) filled the pool, sized for
  // fps, in under three seconds, and the oldest pictures went early: a 2.4 s pre-roll. The pool keeps about
  // fps pictures a second by their camera time (each picture is kept when it is no more than half a clip
  // frame before the next kept time), so the same memory holds the whole pre-roll. A picture without a camera
  // time, or a clock going back, is kept. true: leave this picture out.
  thin(cam, t0) {
    const at = Number.isFinite(cam) ? cam * 1000 : t0;
    const every = 1000 / this.fps;
    if (this.nextKeep !== null && at < this.nextKeep - every / 2 && at >= this.nextKeep - 2 * every) return true;
    this.nextKeep = Math.max((this.nextKeep ?? at) + every, at + every / 2);
    if (this.nextKeep > at + 2 * every) this.nextKeep = at + every;
    return false;
  }

  get supported() {
    return !this.broken && !!this.mimeType && typeof HTMLCanvasElement !== "undefined" && !!HTMLCanvasElement.prototype.captureStream;
  }

  // Recording failed (an exception in a recorder hook): the clip being taken is dropped, the pre-roll
  // is let go and no clip is taken again until the page reloads. The camera's analysis goes on.
  fail() {
    if (this.broken) return;
    this.broken = true;
    this.armed = false;
    const rec = this.rec;
    const stopping = this.stopping;
    this.rec = null;
    this.recId = null;
    this.track = null;
    this.capped = null;
    this.stopping = null;
    this.ring = null;
    if (stopping) {
      clearTimeout(stopping.timer);
      stopping.resolve(null);
    }
    if (this.queued) {
      if (this.queued.stop) this.queued.stop.resolve(null);
      this.queued = null;
    }
    if (this.holdRec) {
      const held = this.holdRec;
      this.holdRec = null;
      clearTimeout(this.holdTimer);
      try { held.stop(); } catch { /* already stopped */ }
    }
    if (rec) {
      rec.ondataavailable = null;
      rec.onstop = () => { for (const t of rec.stream.getTracks()) t.stop(); };
      try { rec.stop(); } catch { /* already stopped: nothing to save either way */ }
    }
  }

  // a clip is being taken and not yet asked to stop (a stopping clip still draws its last second)
  get recording() {
    return (!!this.rec && !this.stopping) || (!!this.queued && !this.queued.stop);
  }

  // the camera hands pictures over while armed or while a clip is still being drawn
  get wantsFrames() {
    return !this.broken && (this.armed || !!this.rec);
  }

  setSize(vw, vh) {
    const w = Math.min(this.maxWidth, vw);
    const h = Math.round((vh / vw) * w) & ~1;
    if (this.canvas && this.canvas.width === w && this.canvas.height === h) return;
    this.scale = w / vw;
    this.source = { width: vw, height: vh };
    this.canvas = document.createElement("canvas");
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext("2d");
    // the pre-roll pictures are kept smaller than the clip (long side RING_LONG_SIDE): a portrait phone
    // clip is 720x1280, 3.7 MB a picture, and three seconds of it would not fit the 60 MB pool; at
    // 270x480 three seconds at 30 fps (94 pictures with slack) is about 49 MB. The pre-roll plays a
    // little softer; the analysis desk reads at 640 anyway.
    const k = Math.min(1, RING_LONG_SIDE / Math.max(w, h));
    const [rw, rh] = [Math.round(w * k) & ~1, Math.round(h * k) & ~1];
    this.ring = this.preRollMs > 0 ? new FrameRing({ width: rw, height: rh, fps: this.fps, delayMs: this.preRollMs, makeCanvas: (cw, ch) => Object.assign(document.createElement("canvas"), { width: cw, height: ch }) }) : null;
    this.ringAt = performance.now();
    this.rings++;
    this.nextKeep = null;
  }

  // meta: how the camera screen looked (layout, picture box), stored with the track. Answers the new clip's
  // id, or false when no clip is taken for this rally (its stop then gets null, never another rally's clip)
  start(meta = {}) {
    // a new rally inside the last clip's final second: the last clip still draws up to its own rally's
    // end, and this clip begins right after it, so its pre-roll is the gap between the two rallies.
    // Nothing is lost, nothing is taken twice, and a point's ending stays in its own clip.
    if (this.rec && this.stopping) {
      if (this.queued || !this.supported) return false;
      this.queued = { id: this.nextClipId++, meta, stop: null };
      return this.queued.id;
    }
    // the last clip is still holding its stream open for its final pictures: this clip begins after it
    if (this.holdRec) {
      if (this.queued || !this.supported) return false;
      this.queued = { id: this.nextClipId++, meta, stop: null };
      return this.queued.id;
    }
    if (!this.supported || this.rec || !this.canvas) return false;
    const id = this.nextClipId++;
    this.begin(meta, id);
    return id;
  }

  // queued: the clip waited for the last one to finish, so its pre-roll is the gap between the two rallies
  begin(meta, id, queued = false) {
    this.recId = id;
    const c = this.canvas;
    this.stats = { frames: 0, frameMs: 0, maxFrameMs: 0, width: c.width, height: c.height, mode: this.overlay ? "data" : "video", trackBytes: 0, preRollMs: this.ring ? this.preRollMs : 0, ring: this.ring ? this.ring.stats : null };
    // each recording keeps its own chunks: the last rally's recorder can still deliver its final chunk
    // and onstop after the next rally has started recording
    const chunks = [];
    this.chunks = chunks;
    // overlay positions are in source video px; the clip is the same picture scaled to clip.width
    this.track = this.overlay ? new TrackWriter({ ...meta, source: this.source, clip: { width: c.width, height: c.height }, fps: this.fps, preRollMs: this.ring ? this.preRollMs : 0 }) : null;
    // with a pre-roll the backlog after a stall is drawn one picture per screen refresh (up to 60 a second); a
    // stream capped at fps would merge some of them and the track would hold pictures the video lacks, so the
    // stream takes a frame each time a picture is drawn
    const stream = this.ring ? c.captureStream() : c.captureStream(this.fps);
    this.rec = new MediaRecorder(stream, { mimeType: this.mimeType, videoBitsPerSecond: this.bitsPerSecond });
    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    this.rec.start(500);
    this.startedAt = performance.now();
    // what the pre-roll had when this clip began: pictures held and the oldest one's age, how long the
    // recorder had been armed and the pool filling (ms; null when never), and pools made since the page opened
    const held = this.ring ? this.ring.entries : [];
    const since = (at) => (at === null ? null : Math.round(this.startedAt - at));
    this.startInfo = { held: held.length, preRollMs: held.length ? Math.round(this.startedAt - held[0].t0) : 0, armedMs: this._armed ? since(this.armedAt) : null, ringMs: since(this.ringAt), rings: this.rings, off: this.lastOff, resumedMs: since(this.resumedAt), pauseMs: this.resumedAt === null ? null : this.pauseMs, queued };
    this.capped = null;
    // per clip, saved in the track's meta: pictures drawn, due pictures skipped (a newer one was due in
    // the same camera frame), pictures handed over early (full pool), and the camera's stalls (gaps
    // between frames over 100 ms; pictures never shown during a stall are not skipped ones)
    this.counts = { drawn: 0, skipped: 0, early: 0, thinned: 0, maxGapMs: 0, stallMs: 0, calls: 0, duePerCall: [0, 0, 0] };
    this.callGaps = [];
    this.lastFrameAt = null;
  }

  // cam: the camera clock of state (seconds), kept with the track frame
  frame(video, state, cam) {
    if (!this.canvas) return;
    const t0 = performance.now();
    if (this.lastCallAt !== null && t0 - this.lastCallAt > PAUSE_MS) {
      this.resumedAt = t0;
      this.pauseMs = Math.round(t0 - this.lastCallAt);
      // the camera clock moved on by about the pause: a picture stamped before that is stale (its time was taken
      // before the pause) and would put a gap of the whole pause inside the clip
      if (this.lastCam !== null) this.minCam = this.lastCam + this.pauseMs - 500;
      // after a pause longer than the pre-roll (a hidden page) every picture held is from before it and would
      // start the next clip with a jump in time: let them go (a clip being taken keeps its own). A shorter
      // stall (the main thread busy, the corner screen working) keeps them: they are still the pre-roll.
      if (this.ring && !this.rec && t0 - this.lastCallAt > this.preRollMs) for (const e of this.ring.drain()) this.ring.release(e);
    }
    this.lastCallAt = t0;
    const camMs = Number.isFinite(cam) ? cam * 1000 : null;
    if (camMs !== null && this.minCam !== null) {
      if (camMs < this.minCam) {
        if (this.rec && this.counts) this.counts.stale = (this.counts.stale || 0) + 1;
        return;
      }
      this.minCam = null;
    }
    if (camMs !== null) this.lastCam = camMs;
    if (!this.ring) {
      if (this.rec && !this.capped) this.draw(video, t0, state, cam);
      return;
    }
    this.releaseHold(t0);
    // Each picture becomes due when it is the pre-roll old. A canvas stream keeps only the last picture drawn
    // in a screen frame, so at most one is drawn per refresh (oldest first): after a stall the backlog is drawn
    // over the next refreshes instead of being dropped. A full pool hands its oldest over early (a shorter
    // pre-roll, no more memory).
    if (this.rec && this.counts) {
      if (this.lastFrameAt != null) {
        const gap = t0 - this.lastFrameAt;
        this.counts.maxGapMs = Math.max(this.counts.maxGapMs, Math.round(gap));
        if (gap > 100) this.counts.stallMs += Math.round(gap - 1000 / this.fps);
        if (this.callGaps.length < 4000) this.callGaps.push(gap);
      }
      this.counts.calls++;
      this.lastFrameAt = t0;
    }
    // Drawing runs on the recorder's own animation-frame loop: each screen refresh draws the oldest due
    // picture, so a stall of the analysis loop delays pictures instead of dropping them; the camera only hands
    // pictures over. While the loop is paused (hidden tab) for over 250 ms, the camera call draws the oldest
    // due picture itself.
    this.ensureLoop();
    if (performance.now() - this.lastTickAt > 250) this.drawOldestDue(t0);
    if (this.thin(cam, t0)) {
      if (this.rec && this.counts) this.counts.thinned++;
      return;
    }
    if (this.ring.full) {
      if (this.rec && this.counts) this.counts.early++;
      this.show(this.ring.takeEarly());
    }
    this.ring.push(video, t0, pick(state), cam);
    if (this.stats) this.stats.ring = this.ring.stats;
  }

  ensureLoop() {
    if (this.raf != null || typeof requestAnimationFrame !== "function") return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.lastTickAt = performance.now();
      if (!this.ring) return;
      this.drawOldestDue(this.lastTickAt);
      if (this.ring.entries.length || this.wantsFrames) this.ensureLoop();
    });
  }

  drawOldestDue(now) {
    this.releaseHold(now);
    if (this.holdRec) return;
    // a backlog drains at most one picture per two screen refreshes (about the clip's frame rate): pictures
    // drawn on back-to-back refreshes can land in one video frame, leaving the track a picture the video lacks
    if (this.lastDrawAt != null && now - this.lastDrawAt < 1000 / this.fps - 9) return;
    const due = this.ring.due(now);
    if (this.rec && this.counts) this.counts.duePerCall[Math.min(2, due.length)]++;
    const e = due.shift();
    if (due.length) this.ring.entries.unshift(...due);
    if (e) this.show(e);
  }

  show(e) {
    this.lastDrawAt = performance.now();
    if (this.rec && !this.capped) this.draw(e.slot.canvas, e.t0, e.state, e.cam);
    this.ring.release(e);
    if (this.stopping && e.t0 >= this.stopping.at) this.endStop();
  }

  // one clip picture and its track entry; t0 is when the picture was shown on the camera
  draw(picture, t0, state, cam) {
    const s = performance.now();
    // the whole clip, pre-roll included, stays within maxSeconds
    if (t0 - this.startedAt > this.maxSeconds * 1000 - (this.ring ? this.preRollMs : 0)) {
      this.capped = this.finish(this.rec);
      return;
    }
    this.ctx.drawImage(picture, 0, 0, this.canvas.width, this.canvas.height);
    // the picture just drawn and the state that goes with it share one time stamp
    // a backlog after a stall is drawn one per refresh, later than its show time (the clip briefly runs fast);
    // the track keeps the draw time so the overlay stays on its picture in the clip
    if (this.track) this.track.add(this.ring ? s : t0, state, cam);
    if (this.counts) this.counts.drawn++;
    const ms = performance.now() - s;
    this.stats.frames++;
    this.stats.frameMs += ms;
    this.stats.maxFrameMs = Math.max(this.stats.maxFrameMs, ms);
  }

  // a camera notice (엔드 교체, 자리 교체, ...) shows in the replay at the same moment
  notice(text) {
    if (this.rec && !this.capped && this.track) this.track.notice(performance.now(), text);
  }

  // Resolves to { video, overlay } (overlay is the packed track, or null when the overlay is off), or null.
  // With a pre-roll the clip goes on until the pictures up to now have been drawn (about three seconds);
  // if the camera stops sending pictures, what is held is drawn at once. id is start's answer for that
  // rally (default: the clip still being taken): an id that is not the queued clip or the clip being
  // drawn (refused at start, or already ended) gets null, so a point never gets another rally's clip.
  stop(id = this.queued && !this.queued.stop ? this.queued.id : this.recId) {
    if (!id) return Promise.resolve(null);
    if (this.queued && this.queued.id === id) {
      // the queued clip has not begun yet: it ends at this time once it has
      if (!this.queued.stop) {
        let resolve;
        const promise = new Promise((r) => (resolve = r));
        this.queued.stop = { at: performance.now(), promise, resolve };
      }
      return this.queued.stop.promise;
    }
    if (!this.rec || this.recId !== id) return Promise.resolve(null);
    if (!this.ring) return this.endNow();
    if (this.stopping) return this.stopping.promise;
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    this.stopping = { at: performance.now(), promise, resolve, timer: this.stopTimer(promise) };
    return promise;
  }

  // if the camera stops sending pictures, what is held is drawn at once
  stopTimer(promise) {
    return setTimeout(() => {
      if (this.stopping?.promise !== promise) return;
      for (const e of this.ring.drain()) {
        if (this.rec && !this.capped) this.draw(e.slot.canvas, e.t0, e.state, e.cam);
        this.ring.release(e);
      }
      this.endStop();
    }, this.preRollMs + 1000);
  }

  endStop() {
    const s = this.stopping;
    this.stopping = null;
    clearTimeout(s.timer);
    s.resolve(this.endNow());
    if (!this.holdRec) this.beginQueued();
  }

  beginQueued() {
    const q = this.queued;
    if (!q) return;
    this.queued = null;
    if (!this.supported || !this.canvas) {
      if (q.stop) q.stop.resolve(null);
      return;
    }
    this.begin(q.meta, q.id, true);
    if (q.stop) this.stopping = { ...q.stop, timer: this.stopTimer(q.stop.promise) };
  }

  // the last pictures drawn need a moment to reach the stream before it stops; nothing is drawn meanwhile
  releaseHold(now) {
    if (!this.holdRec || now < this.holdUntil) return;
    const rec = this.holdRec;
    this.holdRec = null;
    clearTimeout(this.holdTimer);
    rec.stop();
    this.beginQueued();
  }

  endNow() {
    const rec = this.rec;
    const capped = this.capped;
    const track = this.track;
    this.rec = null;
    this.recId = null;
    this.capped = null;
    this.track = null;
    if (track && this.counts) {
      // how evenly the camera loop called frame(): bunched calls make several pictures due at once
      const g = (this.callGaps || []).slice().sort((a, b) => a - b);
      const q = (f) => (g.length ? Math.round(g[Math.min(g.length - 1, Math.floor(f * g.length))]) : null);
      track.meta.counts = { ...this.counts, shown: this.counts.drawn + this.counts.skipped + this.counts.early, callGapMs: { p10: q(0.1), p50: q(0.5), p90: q(0.9) } };
      if (this.startInfo) track.meta.start = this.startInfo;
    }
    if (!rec) return Promise.resolve(null);
    let done;
    if (capped) done = capped;
    else if (this.ring) {
      // with a pre-roll the stream stops two clip frames after the last picture, so that picture is in the video
      done = this.finish(rec, true);
      const hold = Math.round(2000 / this.fps);
      this.holdRec = rec;
      this.holdUntil = performance.now() + hold;
      clearTimeout(this.holdTimer);
      this.holdTimer = setTimeout(() => this.releaseHold(Infinity), hold + 500);
    } else done = this.finish(rec);
    return done.then(async (video) => {
      if (!video) return null;
      let overlay = null;
      if (track && track.frames.length) {
        try {
          overlay = await packTrack(track.json());
          if (this.stats) this.stats.trackBytes = overlay.size;
        } catch (err) {
          console.warn("ppv: overlay track not saved", err);
        }
      }
      return { video, overlay };
    });
  }

  finish(rec, later = false) {
    const chunks = this.chunks;
    return new Promise((resolve) => {
      rec.onstop = () => {
        for (const t of rec.stream.getTracks()) t.stop();
        const blob = chunks.length ? new Blob(chunks, { type: this.mimeType.split(";")[0] }) : null;
        if (this.chunks === chunks) this.chunks = [];
        resolve(blob);
      };
      if (!later) rec.stop();
    });
  }
}
