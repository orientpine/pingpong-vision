// 다시 보기 with the overlay drawn live: the clip is the camera's own picture and
// its overlay track (replay-track.js) holds what the camera screen drew. This page lays out the camera
// screen (ui.js, hud.js: the same code) over the clip and, for every picture the video shows, draws the
// state recorded with that picture. 선수·코트 folds and opens as on the camera; 오버레이 끄기 hides it all.
//
// replay.html?clip=<share path>[&loop=1][&autoplay=0][&embed=1]. A host page (tournament 다시 보기, the share
// page) hears { type: "ppv-replay", event: "ended" | "ready" | "plain" | "close" } and may send
// { type: "ppv-replay", cmd: "again" | "pause" }. embed=1: the host gives this page the whole screen and
// leaves its controls to it: ‹ and ✕ 닫기 in the top row (the camera's status strip, not shown here) send
// "close", and 다시 보기 shows in the bottom row when the clip ends.
//
// Where it starts: the clip holds up to 3 s before its rally (the recorder's pre-roll, for the desk), but a
// replay starts LEAD_MS before the rally, so the serve comes at once; 처음부터 plays the clip from 0.
import { createUI, icon } from "./ui.js";
import { L } from "./i18n.js";
import { Track, replayStartMs } from "./replay-track.js";
import { frameClock } from "./frame-clock.js";

const SHARE = /\/s\/[A-Za-z0-9_-]{43}$/;
const params = new URLSearchParams(location.search);
const clip = new URL(params.get("clip") || "", location.href);
const root = document.getElementById("app");
// 선수·코트 redraws at once, also on a paused or ended clip (no picture comes to draw it)
const ui = createUI(root, { onPanels: () => draw(now()) }, { replay: true });
const app = root.firstElementChild;
const video = ui.video;
video.loop = params.get("loop") === "1";
// playback starts from the rally once the track says where it is (start())
const autoplay = params.get("autoplay") !== "0";
video.autoplay = false;
const embed = params.get("embed") === "1";
video.removeAttribute("aria-label");
video.setAttribute("aria-label", L("랠리 다시 보기 영상", "Rally replay video"));

let track = null;
let shownNotice = null;
let overlayOn = localStorage.getItem("ppv-replay-overlay") !== "off";

const chip = (cls, text, onClick, label) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `chip replay__chip ${cls}`;
  // the panels and notices keep off these (ui.js placePanels, toastBlocks)
  b.setAttribute("data-keepout", "");
  if (typeof text === "string") b.append(Object.assign(document.createElement("span"), { textContent: text }));
  else b.append(text);
  if (label) b.setAttribute("aria-label", label);
  b.addEventListener("click", onClick);
  return b;
};
// bottom row, right end (선수·코트 holds the left end): 처음부터, the overlay switch, and 다시 보기 once it ends
const toggle = chip("replay__overlay", "", () => setOverlay(!overlayOn));
toggle.hidden = true;
const fromStart = chip("replay__start", L("처음부터", "From start"), () => playFrom(0), L("처음부터 보기, 랠리 앞 구간부터", "Play from the start, before the rally"));
const again = chip("replay__again", L("다시 보기", "Replay"), () => playFrom(startMs), L("다시 보기, 서브부터", "Replay from the serve"));
again.hidden = true;
const row = Object.assign(document.createElement("div"), { className: "replay__bar" });
row.append(fromStart, toggle, again);
app.append(row);
if (embed) {
  app.setAttribute("data-embed", "1");
  const close = () => tell("close");
  const back = chip("replay__back", icon("back"), close, L("뒤로, 다시 보기 닫기", "Back, close replay"));
  const shut = chip("replay__close", `✕ ${L("닫기", "Close")}`, close, L("다시 보기 닫기", "Close replay"));
  app.append(back, shut);
  addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
}

function setOverlay(on) {
  overlayOn = on;
  localStorage.setItem("ppv-replay-overlay", on ? "on" : "off");
  app.setAttribute("data-overlay", on ? "on" : "off");
  toggle.setAttribute("aria-pressed", String(!on));
  toggle.firstChild.textContent = on ? L("오버레이 끄기", "Overlay off") : L("오버레이 켜기", "Overlay on");
  draw(now());
}

// where it starts: replay-track.js replayStartMs. No track within START_WAIT_MS: from 0, as before.
const START_WAIT_MS = 1500;
let startMs = 0;
function playFrom(ms, play = true) {
  again.hidden = true;
  const go = () => {
    video.currentTime = ms / 1000;
    if (play) video.play().catch(() => {});
  };
  if (video.readyState >= 1) go();
  else video.addEventListener("loadedmetadata", go, { once: true });
}

const tell = (event, extra = {}) => {
  if (parent !== window) parent.postMessage({ type: "ppv-replay", event, ...extra }, location.origin);
};

// the camera screen picked phone or TV by the same rule (app.js updateLayout)
const layout = () => (innerWidth >= 1024 && innerWidth > innerHeight ? "tv" : "phone");

function draw(sec, still = false) {
  if (!track) return;
  const ms = Math.max(0, sec) * 1000;
  const s = still ? track.stateAtOrBefore(ms) : track.stateAt(ms);
  if (!s) return;
  ui.render({ ...s, mode: "running", layout: layout(), video: track.meta.source, save: {}, tour: { matches: [] } });
  // what QA reads: the time of the drawn overlay frame next to the picture's own time
  app.setAttribute("data-frame-t", String(s.frameT));
  app.setAttribute("data-media-t", String(Math.round(ms)));
  const n = track.noticeAt(ms);
  if (n && n !== shownNotice) ui.notice(n.text);
  shownNotice = n;
}

// one draw per picture the video presents, at that picture's own media time; a pause, the end or a
// resize keeps that time (currentTime runs a little past the picture on screen and would pick the next
// overlay frame)
let shownAt = null;
// a picture presented between seeking and seeked is the seek's own picture (WebKit can show one a frame
// or two before the target); without one, the still picture is the last at or before currentTime
let seeking = false, seekShown = false;
const now = () => (shownAt ?? video.currentTime);
function onFrame(meta) {
  shownAt = meta.mediaTime;
  if (seeking) seekShown = true;
  draw(shownAt);
}
function onAnimation() {
  draw(video.currentTime);
  requestAnimationFrame(onAnimation);
}

// the server sends the track as plain JSON; a track that does not come within TRACK_WAIT_MS or does not
// parse leaves the replay as the picture alone, as for a clip without one
const TRACK_WAIT_MS = 8000;
async function loadTrack() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRACK_WAIT_MS);
  try {
    const res = await fetch(new URL(`${clip.pathname}/overlay`, location.origin), { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) return null;
    return new Track(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

function start() {
  if (clip.origin !== location.origin || !SHARE.test(clip.pathname)) {
    app.setAttribute("data-replay-error", "clip");
    return;
  }
  // the picture plays at once; the overlay joins when its track arrives (nothing of it shows before)
  app.setAttribute("data-overlay", "pending");
  ui.render({ mode: "running", layout: layout(), save: {}, tour: { matches: [] } });
  video.addEventListener("ended", () => tell("ended"));
  // a video standing still shows the last picture at or before currentTime; frame callbacks can lag a
  // few frames behind under load, so a pause or seek draws from currentTime that way
  video.addEventListener("seeking", () => { seeking = true; seekShown = false; });
  video.addEventListener("seeked", () => {
    seeking = false;
    if (seekShown && shownAt !== null) draw(shownAt);
    else { shownAt = null; draw(video.currentTime, true); }
  });
  video.addEventListener("loadeddata", () => { shownAt = null; draw(video.currentTime, true); });
  // a pause keeps the picture last presented on screen and draws the overlay for that picture's own time
  // (its frame callback); without one (no requestVideoFrameCallback, the end, a seek) it uses currentTime
  video.addEventListener("pause", () => {
    if (video.ended || seeking || shownAt === null) { shownAt = null; draw(video.currentTime, true); return; }
    draw(shownAt);
  });
  // 다시 보기 joins the row, which moves 처음부터 over: draw the last picture's plates again around them
  video.addEventListener("ended", () => { if (embed) { again.hidden = false; draw(now()); } });
  addEventListener("resize", () => draw(now()));
  video.src = new URL(`${clip.pathname}/video`, location.origin).href;
  if (video.requestVideoFrameCallback) {
    frameClock(video, { onFrame, onTime: (sec) => { shownAt = null; draw(sec); }, setMode: (m) => app.setAttribute("data-clock", m) });
  } else requestAnimationFrame(onAnimation);
  const loaded = loadTrack().then((t) => t, (err) => {
    console.warn("ppv: overlay track not loaded, playing the picture alone", err && err.name);
    return null;
  }).then((t) => {
    track = t;
    if (track) {
      toggle.hidden = false;
      setOverlay(overlayOn);
    } else app.setAttribute("data-overlay", "none");
    tell(track ? "ready" : "plain");
    return t;
  });
  // the picture waits for the track (it is small) so it starts at the rally, not 3 s before it and then jumps
  let started = false;
  const begin = (t) => {
    if (started) return;
    started = true;
    startMs = t ? replayStartMs(t.rallyStartMs()) : 0;
    app.setAttribute("data-start-ms", String(Math.round(startMs)));
    if (autoplay || startMs) playFrom(startMs, autoplay);
  };
  loaded.then(begin);
  setTimeout(() => begin(null), START_WAIT_MS);
}

addEventListener("message", (e) => {
  if (e.origin !== location.origin || !e.data || e.data.type !== "ppv-replay") return;
  if (e.data.cmd === "again") playFrom(startMs);
  if (e.data.cmd === "pause") video.pause();
});

window.__ppvReplay = { video, get track() { return track; }, get startMs() { return startMs; }, setOverlay, draw, playFrom };
start();
