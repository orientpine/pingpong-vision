// The overlay on a small clip box in the tournament app (TV 방금 포인트, the phone's clip card): a
// canvas laid over the <video> in the same page, drawn from the clip's overlay track with the camera
// screen's own drawHud (name tags, joints, trail, LOCK, bounces) plus the record strip (RALLY TIME,
// SHOT COUNT, SPEED) across the top of the picture. The player panels and court map are left to the
// full-screen 다시 보기 (replay.html): a small box has no room for them (lead, 2026-10-31).
// A clip with no track (recorded before tracks, overlay already in the picture) draws nothing.
import { drawHud } from "./hud.js";
import { Track } from "./replay-track.js";
import { frameClock } from "./frame-clock.js";

const tracks = new Map();

// one fetch per clip; null when the clip has no track
export function loadTrack(clip) {
  if (!tracks.has(clip)) {
    tracks.set(clip, fetch(`${clip}/overlay`, { cache: "no-store" })
      .then(async (res) => (res.ok ? new Track(await res.json()) : null))
      .catch((err) => { console.warn("ppv: clip overlay track", err); return null; }));
  }
  return tracks.get(clip);
}

function fmtClock(ms) {
  const s = Math.max(0, ms || 0) / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(2).padStart(5, "0")}`;
}

const STRIP_H = 20;

function drawStrip(ctx, rally, x, y, w) {
  const font = (getComputedStyle(ctx.canvas).getPropertyValue("--font-11") || "").trim() || "Galmuri11, monospace";
  ctx.fillStyle = "rgba(10,22,52,0.86)";
  ctx.fillRect(x, y, w, STRIP_H);
  ctx.fillStyle = "#f2f6ff";
  ctx.font = `700 12px ${font}`;
  ctx.textBaseline = "middle";
  const r = rally || {};
  const speed = r.speedKmh == null ? "--" : `~${r.speedKmh} km/h`;
  ctx.fillText(`RALLY ${fmtClock(r.timeMs)}  ${r.shots || 0} SHOT  ${speed}`, x + 6, y + STRIP_H / 2 + 1);
}

export class ClipOverlay {
  constructor(video, canvas, clip) {
    this.video = video;
    this.canvas = canvas;
    this.clip = clip;
    this.track = null;
    this.stopped = false;
    this.lastKey = "";
    loadTrack(clip).then((track) => {
      if (this.stopped) return;
      this.track = track;
      canvas.hidden = !track;
      if (track) this.loop();
    });
  }

  stop() {
    this.stopped = true;
  }

  loop() {
    let seeking = false, seekShown = null;
    const alive = () => {
      if (this.stopped || !this.video.isConnected) this.stopped = true;
      return !this.stopped;
    };
    if (this.video.requestVideoFrameCallback) {
      this.draw(this.video.currentTime);
      frameClock(this.video, {
        alive,
        onFrame: (meta) => { if (seeking) seekShown = meta.mediaTime; this.draw(meta.mediaTime); },
        onTime: (sec) => this.draw(sec),
        setMode: (m) => { this.canvas.dataset.clock = m; },
      });
    } else {
      const tick = () => { if (alive()) { this.draw(this.video.currentTime); requestAnimationFrame(tick); } };
      tick();
    }
    // a video standing still shows the last picture at or before currentTime (frame callbacks can lag)
    // (a picture presented during the seek is the seek's own and is kept)
    this.video.addEventListener("seeking", () => { seeking = true; seekShown = null; });
    this.video.addEventListener("seeked", () => {
      seeking = false;
      if (this.stopped) return;
      if (seekShown !== null) this.draw(seekShown);
      else this.draw(this.video.currentTime, true);
    });
    for (const ev of ["pause", "loadeddata"]) this.video.addEventListener(ev, () => !this.stopped && this.draw(this.video.currentTime, true));
  }

  // the canvas sits exactly on the video element; the picture inside it is object-fit: contain
  place() {
    const v = this.video, c = this.canvas;
    const w = v.clientWidth, h = v.clientHeight;
    c.style.left = `${v.offsetLeft}px`;
    c.style.top = `${v.offsetTop}px`;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; }
    return { w, h };
  }

  draw(sec, still = false) {
    const track = this.track;
    if (!track) return;
    const { w, h } = this.place();
    if (!w || !h) return;
    const src = track.meta.source || { width: this.video.videoWidth, height: this.video.videoHeight };
    const k = Math.min(w / src.width, h / src.height);
    const ox = (w - src.width * k) / 2, oy = (h - src.height * k) / 2;
    const state = still ? track.stateAtOrBefore(Math.max(0, sec) * 1000) : track.stateAt(Math.max(0, sec) * 1000);
    if (!state) return;
    const ctx = this.canvas.getContext("2d");
    drawHud(ctx, state, (p) => ({ x: ox + p.x * k, y: oy + p.y * k }), { top: oy + STRIP_H + 4, trailWidth: 2 });
    drawStrip(ctx, state.rally, Math.round(ox), Math.round(oy), Math.round(src.width * k));
    this.canvas.dataset.frameT = String(state.frameT);
  }
}
