import { L, both, errorText, setLang } from "./i18n.js";
import { RallyShots, rallyRecord } from "./analysis-record.js";
import { combineRefines, refineCorners } from "./calib-refine.js";
import { createPose } from "./pose.js";
import { DownloadError } from "./download.js";
import { Pipeline } from "./pipeline.js";
import { RallyRecorder } from "./recorder.js";
import { createUI } from "./ui.js";
import { LOW_LIGHT, StarveWatch, frameLuma, frameSig } from "./guards.js";
import { judgePoint, suspects } from "./point.js";
import { Clock, EndHold, EndSync, Merger, STALE_MS, judgeRally, scoreAction, shareSegment } from "./multicam.js";
import { MANUAL, REFEREE, SIDE_NAMES, TournamentLink, sideLabel } from "./tournament.js";
import { unlock } from "./voice.js";
import { Venue } from "./venue.js";

// Back from the mode choice lands here on the old camera entry; the camera stays closed and it goes
// straight on to the choice (and out of the app on the next back). Choosing camera clears the mark.
if (sessionStorage.getItem("pp-left-camera")) location.replace("/?role");
function leaveToPicker() {
  sessionStorage.setItem("pp-left-camera", "1");
  location.replace("/?role");
}

// The app's own folder (/vision/). The address bar shows only the one tournament address, so
// every request of this app is made against this folder, never against the page address.
const BASE = new URL("../", import.meta.url);

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`ppv.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`ppv.${key}`, JSON.stringify(value));
    } catch (err) {
      console.warn("ppv: could not save", key, err);
    }
  },
};

const state = {
  mode: "intro",
  layout: "phone",
  layoutPref: store.get("layout", "auto"),
  endOnCubic: store.get("endOnCubic", false),
  // 판정 안정 모드: "auto" may make the picture small when the analysis starves, "off" never does (owner, 2026-10-31)
  stableMode: store.get("stableMode", "auto") === "off" ? "off" : "auto",
  analysisFrom: ["screen", "probe", "probe-big"].includes(store.get("analysisFrom", "screen")) ? store.get("analysisFrom", "screen") : "screen",
  replayOverlay: store.get("replayOverlay", true) !== false,
  cameraGuide: store.get("cameraGuide", false) === true,
  ballColor: store.get("ballColor", "white") === "orange" ? "orange" : "white",
  source: null,
  loadingText: null,
  loading: null,
  error: null,
  perf: { fps: 0, ms: 0, poseMs: 0, ballMs: 0 },
  video: { width: 0, height: 0 },
  calibration: null,
  rally: { active: false, timeMs: 0, shots: 0, speedKmh: null, maxSpeedKmh: null },
  ball: { trail: [], current: null },
  bounces: [],
  lastShot: null,
  players: {
    near: { label: L("블루 사이드", "Blue side"), end: 0, hand: "R", landmarks: null, moveM: null, wristDeg: null, wristKmh: null, shotKmh: null },
    far: { label: L("레드 사이드", "Red side"), end: 1, hand: "R", landmarks: null, moveM: null, wristDeg: null, wristKmh: null, shotKmh: null },
  },
  tracking: "no-calibration",
  calibrationIssue: null,
  // check: what the server said about the stored key: null (not asked yet), "ok", "rejected", "unknown" (no answer)
  save: { keySet: !!store.get("uploadKey", null), check: null, supported: null, keyError: null },
  history: store.get("history", []),
  // 판정 안정 모드: compact = the portrait picture is the production-size middle row instead of full screen;
  // locked = it came back to full screen once and got bad again, so it stays compact for this camera run
  stable: { compact: false, locked: false, log: store.get("stableLog", []) },
  showHistory: false,
  estimateNote: L("속도·거리는 화면 기반 추정치", "Speed and distance are screen-based estimates"),
};

let pose = null;
let pipeline = null;
let stream = null;
let fileUrl = null;
let running = false;
let frameHandle = null;
let wakeLock = null;
let lastShotAt = -Infinity;
let fpsCount = 0;
let fpsT0 = performance.now();
let lastRallyTimeMs = 0;
let recorder = null;
let lastRallyShots = 0;
let lastAsk = "null";
const tour = new TournamentLink(store, () => {
  state.tour = tour.view();
  // the referee screen hears an opened or answered 누가 땄나요 at once (확인 후 입력)
  const ask = JSON.stringify(askNow());
  if (ask !== lastAsk) {
    lastAsk = ask;
    if (venue.attached) sendMultiStatus(true);
  }
  render();
}, {
  say: (text) => venue.say(text),
  onPin: () => saveByPin(),
  // the players changed ends (the rules, or a fix on any screen): their settings go with them
  onEnds: (m) => {
    swapPlayerSettings();
    ui.notice(L(`엔드 교체 · ${SIDE_NAMES[0]} ${m.names[m.ends[0]]} · ${SIDE_NAMES[1]} ${m.names[m.ends[1]]}`, `Change ends · ${SIDE_NAMES[0]} ${m.names[m.ends[0]]} · ${SIDE_NAMES[1]} ${m.names[m.ends[1]]}`));
  },
});
const venue = new Venue(store, tour, () => state.mode);
state.tour = tour.view();

// ---------- 카메라 여러 대 (docs/multicam.md) ----------
// Roles from the match's camera list: "single" (one camera, or not attached: the one-camera path
// untouched), "primary" (judges the merged rally, records and scores) or "secondary" (judges on
// its own screen, sends each finished rally to the primary, never scores, speaks or records).
// endSync: on the primary, whether the shared bounces say another camera's picked end colour is turned
// (multicam.js EndSync, a warning only: every phone's colour is a person's pick)
// hold: 점수 보류 of the match this phone scores (multicam.js EndHold), stored so a reload keeps it; a
// secondary keeps the primary's, so it holds too if it is left as the one camera
const multi = { clock: new Clock(), merger: null, endSync: null, hold: new EndHold(store.get("endHold", null)), role: "single", count: 0, cams: [], clips: new Map(), peers: {}, counted: new Set(), lastActive: null, lastBall: null, statusAt: 0, log: [] };

// 확인 후 입력: the open 누가 땄나요 as the referee screen shows it (the point number it is for, the camera's
// call as an end colour or none, held or not)
function askNow() {
  const c = tour.pending && tour.pending.choice ? tour.pending : null;
  return c && c.seq != null ? { seq: c.seq, pre: c.pre ?? null, hold: !!c.hold } : null;
}

function holdNow() {
  if (multi.hold.for(tour.matchId)) saveHold();
  return multi.hold;
}
function saveHold() {
  store.set("endHold", multi.hold.toJSON());
}
// a person changed a pick on either phone: no hold, and the points from here on are judged with the new picks
function holdPicked() {
  const was = holdNow().picked();
  saveHold();
  if (was) {
    multi.log.push({ at: Date.now(), hold: false });
    if (venue.attached) sendMultiStatus(true);
  }
}
venue.clock = multi.clock;
venue.onCameras = (cams) => setMultiRole(cams);
venue.onMc = (msg) => onMultiMessage(msg);

// Cameras that count: the ones that are judging. This phone counts once its camera runs (calibrated,
// analysing); another phone counts once it has said it runs, and while this phone heard it in the last
// STALE_MS, or DROP_MS once counted (the same 15 s after which the server drops a silent row). A phone
// still loading its model or being calibrated is on the list but not counted, so the count does not
// go 2-1-2 while it gets ready (its main thread can be busy for many seconds then), and a row for a
// phone that went quiet or a stale row of a reload never makes this phone a secondary.
const DROP_MS = 15000;
function liveCount(cams, me) {
  if (!me) return 0;
  const now = Date.now();
  const live = cams.filter((c) => {
    if (c.id === me.id) return state.mode === "running";
    const p = multi.peers[c.id];
    return !!p && p.running && now - p.at <= (multi.counted.has(c.id) ? DROP_MS : STALE_MS);
  });
  multi.counted = new Set(live.map((c) => c.id));
  return live.length;
}

function setMultiRole(cams) {
  const me = venue.me();
  const n = liveCount(cams, me);
  if (me && !tour.cameraId) tour.cameraId = venue.id;
  const role = n >= 2 && multi.clock.ok ? (me.primary ? "primary" : "secondary") : "single";
  const before = multi.count;
  multi.cams = cams;
  multi.count = n;
  for (const id of Object.keys(multi.peers)) if (!cams.some((c) => c.id === id)) delete multi.peers[id];
  if (role !== multi.role) {
    const was = multi.role;
    multi.role = role;
    // what the primary collected is judged now, alone; a new primary starts an empty collector
    if (was === "primary") pollMerged(true);
    multi.merger = role === "primary" ? new Merger() : null;
    multi.endSync = role === "primary" ? new EndSync() : null;
    if (role === "primary" && recorder && !recorder.recording && pipeline && pipeline.rally && pipeline.rally.rally && store.get("uploadKey", null)) clipStart();
  }
  // a camera that left the list is not waited for; one that is only quiet is handled by the collector's own clock
  if (multi.merger) for (const id of multi.merger.cams.keys()) if (id !== "self" && !cams.some((c) => c.id === id)) multi.merger.forget(id);
  if (multi.endSync) for (const id of multi.endSync.cams.keys()) if (!cams.some((c) => c.id === id)) multi.endSync.forget(id);
  if (before >= 1 && n >= 1 && before >= 2 !== n >= 2) ui.notice(n >= 2 ? L("카메라 2대로 전환", "Switched to 2 cameras") : L("카메라 1대로 전환", "Switched to 1 camera"), { record: false });
  state.multi = multiView();
  render();
}

function multiView() {
  const me = venue.me();
  // the primary warns when the shared bounces say the other camera's picked colour is turned
  const other = multi.cams.find((c) => !me || c.id !== me.id);
  const warn = multi.role === "primary" && other && multi.endSync && multi.endSync.get(other.id).state === "mismatch";
  // 점수 보류: the primary's own, or on a secondary the primary's as its status says
  const hold = holdNow().on;
  return {
    count: multi.count,
    role: multi.role,
    ends: warn || hold ? { state: "mismatch" } : null,
    hold,
    errMs: multi.clock.errMs,
    // the other phone's state as this phone last heard it: "연결 중" until its first status, "느림" when silent for 3 s
    cams: multi.cams.map((c) => {
      if (me && c.id === me.id) return { ...c, me: true, ball: state.mode === "running" && state.tracking === "locked" ? "seen" : "lost" };
      const p = multi.peers[c.id];
      return { ...c, ball: p ? p.ball : null, fresh: p ? Date.now() - p.at <= STALE_MS : null };
    }),
  };
}

function serverMs(t) {
  return Math.round(t * 1000 + multi.clock.offset);
}

function onMultiMessage(msg) {
  if (msg.kind === "status" && msg.from) {
    const before = multi.peers[msg.from];
    // the other phone's person changed its pick: that ends a hold (on the primary, which judges)
    if (multi.role === "primary" && before && before.near != null && msg.near != null && before.near !== msg.near) holdPicked();
    // a secondary keeps the primary's hold (it holds too if it is left as the one camera)
    if (multi.role === "secondary" && msg.primary && typeof msg.hold === "boolean" && msg.hold !== holdNow().on) {
      if (msg.hold) multi.hold.warn();
      else multi.hold.picked();
      saveHold();
      state.multi = multiView();
      render();
    }
    multi.peers[msg.from] = { ball: msg.ball, active: !!msg.active, running: msg.running !== false, near: msg.near ?? null, at: Date.now() };
    if (multi.merger) multi.merger.status(msg.from, { active: msg.active, startMs: msg.startMs });
    // that phone's picked colour: a new pick clears a warning about the old one
    if (multi.endSync) for (const c of multi.endSync.pick(msg.from, msg.near)) onEndSync(c);
  }
  if (msg.kind === "rally" && msg.seg && msg.from && multi.merger) {
    multi.merger.add({ ...msg.seg, cam: msg.from });
    pollMerged();
  }
}

function onEndSync(c) {
  multi.log.push({ at: Date.now(), end: c });
  // merging goes on with the colours people picked, but no point is entered by itself until a pick changes
  // (점수 보류): each asks 누가 땄나요, and the points entered by themselves before it are marked for the referee
  if (c.state === "mismatch") {
    ui.notice(L("두 폰 끝 색이 반대로 보여요 · 설정에서 확인", "The two phones see the ends the other way round · check Settings"), { record: false });
    const matchId = tour.matchId;
    const marks = holdNow().warn();
    saveHold();
    multi.log.push({ at: Date.now(), hold: true, marks: marks.length });
    if (marks.length) track(tour.mark(matchId, marks).then((n) => multi.log.push({ at: Date.now(), marked: n, of: marks.length })));
    if (venue.attached) sendMultiStatus(true);
  } else if (c.state === "ok") holdPicked();
  state.multi = multiView();
}

// This camera's ball and rally state to the other camera: at once when a rally starts or ends,
// a ball change at most every 0.3 s, otherwise once a second.
function sendMultiStatus(force = false) {
  if (!venue.attached) return;
  const r = pipeline && pipeline.rally && pipeline.rally.rally;
  const active = !!r;
  const ball = state.mode === "running" && state.tracking === "locked" ? "seen" : "lost";
  const running = state.mode === "running";
  const now = performance.now();
  const due = active !== multi.lastActive || running !== multi.lastRunning || (ball !== multi.lastBall && now - multi.statusAt >= 300) || now - multi.statusAt >= 1000;
  if (!due && !force) return;
  multi.lastRunning = running;
  multi.lastActive = active;
  multi.lastBall = ball;
  multi.statusAt = now;
  const best = multi.clock.best();
  venue.send({ type: "mc", matchId: venue.attached.matchId, kind: "status", ball, active, running, startMs: r ? serverMs(r.startT) : null, rttMs: best ? Math.round(best.rtt) : null, clockMs: multi.clock.errMs, near: tour.near, hold: holdNow().on, ask: askNow() });
}

function multiRallyEnd(e) {
  const seg = shareSegment(e, { near: tour.near, offset: multi.clock.offset, cam: "self" });
  if (multi.role === "secondary") {
    // a recording this phone started while it was still the one camera is not uploaded by a secondary
    if (recorder && recorder.recording) clipStop();
    venue.send({ type: "mc", matchId: venue.attached && venue.attached.matchId, kind: "rally", seg });
    sendMultiStatus();
    return;
  }
  const clip = clipStop();
  if (multi.merger.add(seg)) multi.clips.set(seg.startMs, clip);
  pollMerged();
}

function pollMerged(all = false) {
  const m = multi.merger;
  if (!m) return;
  const r = pipeline && pipeline.rally && pipeline.rally.rally;
  m.status("self", { active: !!r && !all, startMs: r ? serverMs(r.startT) : null });
  for (const segs of m.poll(all ? Infinity : Date.now())) finishMerged(segs);
}
setInterval(() => multi.role === "primary" && pollMerged(), 250);
// also while the camera loads or is being calibrated (no frames yet), so the other phone does not read it as slow
setInterval(() => venue.attached && sendMultiStatus(), 1000);
// a phone that stops reporting drops out of the count within STALE_MS even if no list arrives
setInterval(() => venue.attached && setMultiRole(multi.cams), 1000);

// One collected rally on the primary, merged with each phone's picked end colour; its shared bounces
// also check those picks (a warning only).
function finishMerged(segs) {
  if (multi.endSync) for (const c of multi.endSync.observe(segs)) onEndSync(c);
  finishRally(segs);
}

// One rally on the primary: judged once, scored once, the primary's clip of it attached.
function finishRally(segs) {
  const r = judgeRally(segs, { primary: "self", near: tour.near });
  const judged = r.stopped ? null : r.judged;
  const linked = !!(state.tour.connected && state.tour.matchId && judged);
  const act = scoreAction(r, { hold: holdNow().on });
  const last = [...segs].sort((a, b) => a.endMs - b.endMs).at(-1);
  const rally = { why: last ? last.why : null, startMs: Date.now() - Math.max(0, r.endMs - r.startMs), endMs: Date.now() };
  const scored = linked ? tour.score(judged, r.suspect, act.ask ? { ask: true, reason: act.reason, hold: act.hold, rally } : { rally }) : Promise.resolve(null);
  // entered by itself and not agreed by two cameras: listed, to be marked if the end check warns later
  // (확인 후 입력: the camera's call confirmed counts as the camera's; a hand pick or a referee entry does not)
  if (linked && !act.ask && !r.agreed) track(scored.then((p) => {
    if (p && !p.cancelled && p.reason !== MANUAL && p.reason !== REFEREE && p.matchId === multi.hold.matchId) {
      multi.hold.entered({ index: p.index, side: p.side });
      saveHold();
    }
  }));
  if (!linked && judged && judged.sure) tour.say(both(`${SIDE_NAMES[tour.colourOf(judged.winner)]} 득점`, `Point ${SIDE_NAMES[tour.colourOf(judged.winner)]}`));
  const own = segs.filter((s) => s.cam === "self").sort((a, b) => a.endMs - b.endMs);
  const clips = own.map((s) => multi.clips.get(s.startMs));
  for (const s of own) multi.clips.delete(s.startMs);
  const clip = clips[clips.length - 1] || Promise.resolve(null);
  multi.log.push({ at: Date.now(), cams: [...new Set(segs.map((s) => s.cam))], segs: segs.length, bounces: r.bounces.length, filled: r.filled, conflict: r.conflict, winner: judged ? judged.winner : null, sure: judged ? judged.sure : null, ask: judged ? !!judged.ask : null, dropped: multi.merger ? multi.merger.dropped : 0 });
  track(scored);
  const keep = (r.shots.length >= 2 && r.bounces.length >= 1) || linked;
  if (!keep) return;
  const players = Object.fromEntries(["near", "far"].map((s) => [s, { label: state.players[s].label, moveM: state.players[s].moveM, wristDeg: state.players[s].wristDeg }]));
  const durationMs = Math.max(0, r.endMs - r.startMs);
  const entry = { id: Date.now(), startedAt: Date.now() - durationMs, durationMs, shots: r.shots.length, maxSpeedKmh: r.maxSpeedKmh, bounces: r.bounces.map((b) => ({ tx: b.tx, ty: b.ty, side: b.side, t: b.t })), players, cameras: 2, analysisFps: rallyFps(r.startMs - multi.clock.offset, r.endMs - multi.clock.offset), screen: screenSize() };
  state.history = [entry, ...state.history].slice(0, 100);
  store.set("history", state.history);
  if (judged) entry.point = { winner: judged.winner, reason: judged.label };
  track(clip.then((blob) => blob && uploadRally(entry, blob, scored)));
}

const ui = createUI(document.getElementById("app"), {
  onStartCamera: () => {
    unlock();
    startCamera();
  },
  onOpenFile: (file) => startFile(file),
  onStop: () => stop(),
  onLeave: () => leave(),
  onBeginCalibration: () => {
    if (!state.video.width) return;
    state.prevMode = state.mode;
    state.mode = "calibrating";
    holdFileForCalibration(true);
    render();
  },
  onCalibrationDone: (corners) => {
    applyCalibration(corners, true);
    state.mode = state.prevMode || "running";
    holdFileForCalibration(false);
    render();
  },
  onSnapCorners: (corners, done) => {
    snapCorners(corners).then(done, (err) => {
      console.warn("ppv: corner snap failed", err);
      done(null);
    });
    return true;
  },
  onCalibrationCancel: () => {
    state.mode = state.prevMode || "running";
    holdFileForCalibration(false);
    render();
  },
  // 자리 교체: the two players trade ends; the red / blue ends stay where they are. Linked, the
  // tournament keeps it for every screen (onEnds above follows); alone, only this camera.
  onSwapPlayers: () => {
    tour.swapEnds().then((written) => {
      if (written) return;
      swapPlayerSettings();
      ui.notice(L("자리 교체: 레드·블루 사이드는 그대로, 선수만 바꿨어요", "Players swapped: Red/Blue sides unchanged, only the players moved"));
      render();
    });
  },
  onSetHand: (side, hand) => {
    const hands = store.get("hands", {});
    hands[side] = hand;
    store.set("hands", hands);
    if (pipeline) pipeline.players[side].hand = hand;
    state.players[side].hand = hand;
    render();
  },
  onOpenHistory: () => {
    state.showHistory = true;
    render();
  },
  onCloseHistory: () => {
    state.showHistory = false;
    render();
  },
  onClearHistory: () => {
    state.history = [];
    store.set("history", []);
    render();
  },
  onSetUploadKey: (key) => setUploadKey(key),
  onRetrySave: () => saveByPin(),
  onTourConnect: (pin) => {
    unlock();
    tour.connect(pin).then(() => venue.start());
  },
  onTourVoice: (on) => {
    unlock();
    tour.setVoice(on);
  },
  onTourLet: () => tour.confirmLet(),
  onTourFault: () => tour.confirmFault(),
  onTourDisconnect: () => tour.disconnect(),
  onTourRefresh: () => tour.refresh(),
  onTourMatch: (id) => tour.setMatch(id),
  // a person picked this phone's near colour (calibration or settings): the other phone's check starts
  // again against it, and the other phone hears it at once
  onTourNear: (side) => {
    tour.setNear(side);
    if (multi.endSync) multi.endSync.reset();
    holdPicked();
    if (venue.attached) sendMultiStatus(true);
    state.multi = multiView();
    render();
  },
  onTourMode: (mode) => tour.setMode(mode),
  onTourCancel: () => tour.cancel(),
  onTourPick: (side) => tour.pick(side),
  onTourFix: (kind, arg, seen) => tour.fix(kind, arg, seen),
  onDeleteRally: (id) => deleteRally(id),
  onSetEndOnCubic: (on) => {
    state.endOnCubic = on;
    store.set("endOnCubic", on);
    if (pipeline) pipeline.setEndOnCubic(on);
    render();
  },
  onSetAnalysisFrom: (from) => {
    state.analysisFrom = ANALYSIS_FROM.includes(from) ? from : "screen";
    store.set("analysisFrom", state.analysisFrom);
    analysisPref = state.analysisFrom;
    probe.style.cssText = PROBE_CSS[analysisPref] || PROBE_CSS.probe;
    // the hidden copy is attached only at camera start, so a running camera restarts to apply it
    if (state.source === "camera" && running) startCamera();
    render();
  },
  onSetStableMode: (mode) => {
    state.stableMode = mode === "off" ? "off" : "auto";
    store.set("stableMode", state.stableMode);
    if (state.stableMode === "off" && state.stable.compact) backToFull("dismiss");
    render();
  },
  // the "판정 안정 모드 · 영상 작게" chip: full screen now, and not again for this camera run
  onDismissStable: () => {
    if (state.stable.compact) backToFull("dismiss");
    render();
  },
  onSetReplayOverlay: (on) => {
    state.replayOverlay = !!on;
    store.set("replayOverlay", state.replayOverlay);
    if (recorder) recorder.overlay = state.replayOverlay;
    render();
  },
  onSetCameraGuide: (on) => {
    state.cameraGuide = !!on;
    store.set("cameraGuide", state.cameraGuide);
    render();
  },
  // The language reloads the page, so it waits while recording (the clip and the points would stop).
  onSetLang: (lang) => {
    if (state.mode === "running") { ui.notice(L("기록을 멈춘 뒤 언어를 바꿀 수 있어요", "Stop recording to change the language")); return; }
    setLang(lang);
  },
  onSetBallColor: (color) => {
    state.ballColor = color === "orange" ? "orange" : "white";
    store.set("ballColor", state.ballColor);
    if (pipeline) pipeline.setBallColor(state.ballColor);
    render();
  },
  onSetLayout: (layout) => {
    state.layoutPref = layout;
    store.set("layout", layout);
    updateLayout();
    render();
  },
});
const video = ui.video;
// The analysis reads the camera from its own tiny video of the same stream, not from the full-screen
// stage video: on a software-composited WebKit the large stage video presented a new camera frame for
// only about one analysis read in four (72-91% repeats vs main's 0), and ball locks collapsed.
const probe = document.createElement("video");
probe.muted = true; probe.playsInline = true; probe.autoplay = true;
probe.setAttribute("aria-hidden", "true");
const PROBE_CSS = {
  probe: "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none",
  "probe-big": "position:fixed;left:0;bottom:0;width:320px;height:180px;opacity:0.01;pointer-events:none;z-index:2147483647",
};
probe.style.cssText = PROBE_CSS.probe;
document.body.append(probe);
// which video the analysis reads (preview setting for the phone check): "screen" (default, the stage
// video as before), "probe" (a hidden 2x2 copy of the stream) or "probe-big" (a hidden 320x180 copy)
const ANALYSIS_FROM = ["screen", "probe", "probe-big"];
let analysisPref = "screen";  // read from the store when the camera starts, not every frame
const analysisFrom = () => analysisPref;
let probeFresh = false;   // a new frame was presented since the last analysis read
let probeMeta = null;     // that frame's requestVideoFrameCallback metadata
let probeSeenAt = 0;      // when the analysis video last showed a new frame (performance.now)
let probeLastT = -1;
let probeGen = 0;
let probeStream = null;   // the hidden video's own clone of the camera stream ("따로" settings only)
function watchProbe() {
  probeSeenAt = performance.now();
  if (!probe.requestVideoFrameCallback) return;
  const gen = ++probeGen;
  const tick = (_now, meta) => {
    if (gen !== probeGen || !probe.srcObject) return;
    probeFresh = true;
    probeMeta = meta || null;
    probeSeenAt = performance.now();
    probe.requestVideoFrameCallback(tick);
  };
  probe.requestVideoFrameCallback(tick);
}
// An almost invisible video may be paused or slowed by the browser (iOS power saving). If it shows no
// new frame for over a second, read the stage video instead until it moves again.
function analysisSource() {
  if (state.source !== "camera" || analysisFrom() === "screen" || !probe.srcObject || probe.readyState < 2) return video;
  const now = performance.now();
  if (!probe.requestVideoFrameCallback && probe.currentTime !== probeLastT) { probeLastT = probe.currentTime; probeSeenAt = now; }
  return now - probeSeenAt > 1000 ? video : probe;
}
function attachProbe() {
  if (!stream || probeStream) return;
  probe.style.cssText = PROBE_CSS[analysisFrom()] || PROBE_CSS.probe;
  probeStream = stream.clone();
  probe.srcObject = probeStream;
  probe.play().catch((err) => console.warn("ppv: analysis video", err));
  watchProbe();
}
function detachProbe() {
  probe.srcObject = null;
  if (probeStream) {
    for (const track of probeStream.getTracks()) track.stop();
    probeStream = null;
  }
}

// ---------- guards that keep automatic scoring from failing quietly (guards.js) ----------
const starve = new StarveWatch();
let guardFrames = 0;
let darkSince = null;
let darkShown = false;
function resetGuards() {
  starve.reset();
  guardFrames = 0;
  darkSince = null;
  darkShown = false;
  state.stable = { ...state.stable, compact: false, locked: false };
}
// processed: an analysis read happened on this frame tick
function guardTick(processed) {
  if (state.source !== "camera" || state.mode !== "running") return;
  const rgba = processed ? pipeline.lastRgba : null;
  const now = performance.now();
  const change = state.stableMode === "off" ? null : starve.tick(now, !!rgba, rgba ? frameSig(rgba) : 0);
  if (change) applyStable(change);
  if (!rgba || darkShown || ++guardFrames % 10) return;
  if (frameLuma(rgba) < LOW_LIGHT.luma) {
    darkSince = darkSince ?? now;
    if (now - darkSince >= LOW_LIGHT.holdMs) {
      darkShown = true;
      ui.notice(L("조명이 어두워요, 공이 잘 안 보일 수 있어요", "Lighting is dim; the ball may be hard to see"));
    }
  } else darkSince = null;
}
// a camera that stops presenting frames also stops the frame callback, so the window has to close on
// a clock too: no frame at all in 5 s is the worst starvation, not a pause in the count
setInterval(() => guardTick(false), 1000);
// 판정 안정 모드 (lead, 2026-10-31): when the analysis starves, the portrait picture leaves the full-screen
// overlay for the production-size middle row; after 30 s of good windows it goes back, and if it gets
// bad again it stays small for the rest of this camera run. The 판정용 영상 setting is never touched.
const STABLE_WHAT = { compact: L("영상 작게", "Small video"), full: L("전체 화면으로 돌아감", "Back to full screen"), stay: L("영상 작게(이번 촬영 동안 유지)", "Small video (kept for this session)"), dismiss: L("직접 전체 화면(이번 촬영 동안 안 켬)", "Full screen by hand (not re-enabled this session)") };
function backToFull(action) {
  starve.dismiss();
  const last = starve.last || { fps: 0, repeat: 0 };
  applyStable({ action, fps: last.fps, repeat: last.repeat, base: starve.base });
}
function applyStable({ action, fps, repeat, base, badWindows = null }) {
  const entry = { at: Date.now(), action, fps: Math.round(fps), basePct: base ? Math.round((fps / base) * 100) : null, repeatPct: Math.round(repeat * 100), what: STABLE_WHAT[action] };
  const log = [...(state.stable.log || []), entry].slice(-20);
  state.stable = { compact: action === "compact" || action === "stay", locked: action === "stay", log };
  store.set("stableLog", log);
  console.warn("ppv: steady-call mode", entry);
  // one numbers-only line in the vision server's journal, so we can see why a real phone switched
  fetch(new URL("api/stable-log", BASE), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, fps: entry.fps, repeatPct: entry.repeatPct, basePct: entry.basePct, badWindows, at: entry.at }), keepalive: true }).catch(() => {});
  // a frozen camera runs no frame loop, so redraw here or the chip and the smaller picture never show
  render();
}

function updateLayout() {
  const auto = innerWidth >= 1024 && innerWidth > innerHeight ? "tv" : "phone";
  state.layout = state.layoutPref === "auto" ? auto : state.layoutPref;
}
addEventListener("resize", () => {
  updateLayout();
  render();
});
updateLayout();

function render() {
  labelPlayers();
  ui.render(state);
}

// Each end by its colour and, linked to a match, the player standing there ("레드 · 김블루").
function labelPlayers() {
  const v = tour.view();
  for (const side of ["near", "far"]) {
    const p = state.players[side];
    const label = sideLabel(v, side);
    const end = tour.colourOf(side);
    if (p.label !== label || p.end !== end) state.players[side] = { ...p, label, end };
  }
}

function swapPlayerSettings() {
  if (pipeline) pipeline.players.swap();
  const hands = store.get("hands", {});
  store.set("hands", { near: hands.far, far: hands.near });
  const { near, far } = state.players;
  state.players = { near: { ...near, hand: far.hand, moveM: far.moveM }, far: { ...far, hand: near.hand, moveM: near.moveM } };
  syncPlayers();
}

function fail(title, detail, steps = [], retry = null) {
  running = false;
  state.mode = "error";
  state.loading = null;
  state.error = { title, detail, steps, retry };
  render();
}

async function ensurePipeline() {
  if (!pose) {
    state.mode = "loading";
    state.loadingText = L("자세 인식 모델을 받는 중 (처음 한 번)", "Downloading the pose model (first time only)");
    state.loading = { phase: "download", received: 0, total: 0 };
    render();
    pose = await createPose({
      model: "lite",
      numPoses: 2,
      onProgress: (p) => {
        state.loading = p;
        if (p.phase === "init") state.loadingText = L("자세 인식 모델 준비 중", "Preparing the pose model");
        render();
      },
    });
    state.loading = null;
  }
  if (!pipeline) {
    pipeline = new Pipeline({ pose, onEvent, endOnCubic: state.endOnCubic, ballColor: state.ballColor });
    const hands = store.get("hands", {});
    for (const side of ["near", "far"]) if (hands[side]) pipeline.players[side].hand = hands[side];
  }
}

// The 정밀하게 button: about a second of full-size frames, at least 90 ms apart (10 frames), each
// refined as it arrives so the frames are not kept. The tripod shakes and players lean over the
// table: combineRefines takes per-corner medians and measures how far the table moved between frames.
// A paused file gives one frame (the shake cannot be measured then).
const SNAP_FRAMES = { count: 10, gapMs: 90, maxMs: 1500 };
async function snapCorners(corners) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const runs = [];
  const grab = () => {
    ctx.drawImage(video, 0, 0, w, h);
    runs.push(refineCorners(ctx.getImageData(0, 0, w, h).data, w, h, corners));
  };
  const still = video.paused || video.ended;
  const t0 = performance.now();
  grab();
  let last = performance.now();
  // a new camera frame (requestVideoFrameCallback where the engine has it, else a timer)
  const next = () => new Promise((res) => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(() => res()) : setTimeout(res, SNAP_FRAMES.gapMs)));
  while (!still && runs.length < SNAP_FRAMES.count && performance.now() - t0 < SNAP_FRAMES.maxMs) {
    await Promise.race([next(), new Promise((res) => setTimeout(res, SNAP_FRAMES.gapMs * 2))]);
    if (performance.now() - last < SNAP_FRAMES.gapMs) continue;
    grab();
    last = performance.now();
  }
  return { ...combineRefines(runs, corners), ms: Math.round(performance.now() - t0) };
}

function applyCalibration(corners, save) {
  const cal = pipeline.setCalibration(corners);
  state.calibration = cal ? { corners } : null;
  if (save && cal) store.set("calibration", { corners, width: state.video.width, height: state.video.height });
}

function restoreCalibration() {
  const saved = store.get("calibration", null);
  if (saved && saved.width === state.video.width && saved.height === state.video.height) applyCalibration(saved.corners, false);
  else if (saved && Math.abs(saved.width / saved.height - state.video.width / state.video.height) < 0.01) {
    const k = state.video.width / saved.width;
    applyCalibration(saved.corners.map((c) => ({ x: c.x * k, y: c.y * k })), true);
  }
}

function cameraError(err) {
  if (err instanceof DownloadError) {
    stopSources();
    return fail(L("자세 인식 모델을 받지 못했어요", "Could not download the pose model"), err.kind === "stalled" ? L(`받는 중에 멈췄어요. ${err.message}.`, `The download stalled. ${err.message}.`) : `${err.message}.`, [
      L("와이파이나 데이터가 켜져 있는지 확인하세요.", "Check that Wi-Fi or mobile data is on."),
      L("다시 받기를 누르면 처음부터 다시 받아요.", "Tap Retry download to start over."),
    ], L("다시 받기", "Retry download"));
  }
  const name = err && err.name;
  if (!window.isSecureContext) {
    return fail(L("보안 주소(https)가 아니에요", "Not a secure (https) address"), L("카메라는 https 주소에서만 켜져요.", "The camera only works on https addresses."), [L("안내받은 https:// 주소로 다시 열어 주세요.", "Reopen the https:// address you were given.")]);
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return fail(L("카메라 권한이 꺼져 있어요", "Camera permission is off"), L("브라우저가 이 사이트의 카메라 사용을 막았어요.", "The browser has blocked camera access for this site."), [
      L("브라우저의 사이트 설정에서 카메라 권한을 허용하세요.", "Allow camera access in the browser's site settings."),
      L("권한을 바꾼 뒤 다시 시도 버튼을 누르세요.", "After changing the permission, tap Try again."),
    ]);
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return fail(L("카메라를 찾지 못했어요", "No camera found"), L("이 기기에서 쓸 수 있는 카메라가 없어요.", "This device has no usable camera."), [L("다른 앱이 카메라를 쓰고 있으면 닫고 다시 시도하세요.", "If another app is using the camera, close it and try again.")]);
  }
  if (name === "NotSupportedError" && state.source === "file") {
    return fail(L("이 영상을 재생하지 못했어요", "Could not play this video"), L("이 브라우저가 이 영상 파일을 열지 못했어요.", "This browser could not open the video file."), [L("아이폰 카메라로 찍은 영상(MOV/MP4)을 고르세요.", "Pick a video shot with an iPhone camera (MOV/MP4)."), L("같은 영상으로 한 번 더 시도해 보세요.", "Try the same video once more.")]);
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return fail(L("카메라를 열 수 없어요", "Cannot open the camera"), L("다른 앱이나 탭이 카메라를 쓰고 있을 수 있어요.", "Another app or tab may be using the camera."), [L("카메라 앱이나 영상 통화를 닫고 다시 시도하세요.", "Close camera apps or video calls and try again.")]);
  }
  return fail(L("시작하지 못했어요", "Could not start"), String((err && err.message) || err), [L("페이지를 새로고침한 뒤 다시 시도하세요.", "Reload the page and try again.")]);
}

async function startCamera() {
  stopSources();
  state.error = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
    });
  } catch (err) {
    return cameraError(err);
  }
  state.source = "camera";
  video.srcObject = stream;
  analysisPref = state.analysisFrom;
  probe.style.cssText = PROBE_CSS[analysisPref] || PROBE_CSS.probe;
  // "화면" (default): one video only, exactly as production. iPhone Safari showed a black stage when
  // the same camera stream also played in the hidden video (owner, 2026-10-31 05:56 KST), so a "따로"
  // setting gives the hidden video its own clone of the stream instead of sharing the track.
  resetGuards();
  if (analysisPref !== "screen") attachProbe();
  watchTrack(stream);
  await begin();
}

// The camera can drop out at a venue (iOS pauses it when another app takes over, a call comes
// in, the phone overheats). While the session runs, start it again by itself; begin() keeps
// the saved calibration, so play resumes without new taps.
function watchTrack(s) {
  for (const track of s.getVideoTracks()) {
    track.addEventListener("ended", () => {
      if (stream === s && running && state.source === "camera") setTimeout(() => startCamera(), 500);
    });
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !running || state.source !== "camera") return;
  const live = stream && stream.getVideoTracks().some((tr) => tr.readyState === "live");
  if (!live) startCamera();
});

// The tournament app can change the match list or drop the connection; refresh it every 30 s
// while linked so the next point goes to the right place.
setInterval(() => {
  if (state.tour.connected && !state.tour.pending && document.visibilityState === "visible") tour.refresh();
}, 30000);

// iPhone Safari tells a web page neither battery level nor temperature, so a phone that is
// heating up shows only as falling frame rate: warn when fps stays under half of what this
// session ran at in its first 20 s, for 30 s.
const slow = { base: [], since: null };
function watchSlow(fps, now) {
  if (!running || !fps) return;
  if (slow.base.length < 20) {
    slow.base.push(fps);
    return;
  }
  const base = [...slow.base].sort((x, y) => x - y)[10];
  if (fps < base / 2) slow.since = slow.since ?? now;
  else slow.since = null;
  state.slowPhone = slow.since != null && now - slow.since > 30000;
}

async function startFile(file) {
  stopSources();
  state.error = null;
  fileUrl = URL.createObjectURL(file);
  state.source = "file";
  video.srcObject = null;
  video.autoplay = false;
  video.src = fileUrl;
  video.loop = false;
  // Reopening a file that already played to its end: WebKit can keep the old end position on
  // the element until the new source has loaded, so the new file played from 12 s, ended at once
  // and the app stopped (ui-r2 end-of-file-stop, about one run in three). Load the new source,
  // then start it from 0 and wait for that seek before playing.
  await new Promise((res) => {
    if (video.readyState >= 1) return res();
    const done = () => { video.removeEventListener("loadedmetadata", done); video.removeEventListener("error", done); res(); };
    video.addEventListener("loadedmetadata", done);
    video.addEventListener("error", done);
    setTimeout(done, 10000);
  });
  if (video.currentTime !== 0 && !video.error) {
    await new Promise((res) => {
      const done = () => { video.removeEventListener("seeked", done); res(); };
      video.addEventListener("seeked", done);
      setTimeout(done, 3000);
      video.currentTime = 0;
    });
  }
  await begin();
}

async function begin() {
  try {
    await ensurePipeline();
    // A seek on a freshly set file can finish after the calibration pause and make WebKit resume
    // on its own, so only seek when not already at the start.
    if (state.source === "file" && video.currentTime !== 0) video.currentTime = 0;
    try {
      await video.play();
    } catch (err) {
      if (state.source !== "file" || !video.error || video.error.code !== 4) throw err;
      console.warn("ppv: file source failed to load, reloading once", video.error.message);
      video.load();
      await video.play();
    }
    if (!video.videoWidth) await new Promise((res) => video.addEventListener("loadedmetadata", res, { once: true }));
  } catch (err) {
    console.warn("ppv: start failed", err && err.name, err && err.message, "media error", video.error && video.error.code, video.error && video.error.message, "readyState", video.readyState, "networkState", video.networkState);
    return cameraError(err);
  }
  state.video = { width: video.videoWidth, height: video.videoHeight };
  pipeline.setVideoSize(video.videoWidth, video.videoHeight);
  recorder = recorder || new RallyRecorder({ overlay: state.replayOverlay });
  recorder.setSize(video.videoWidth, video.videoHeight);
  state.save.supported = recorder.supported;
  restoreCalibration();
  pipeline.reset();
  state.bounces = [];
  state.lastShot = null;
  running = true;
  state.mode = state.calibration ? "running" : "calibrating";
  state.prevMode = "running";
  if (state.mode === "calibrating") holdFileForCalibration(true);
  requestWakeLock();
  render();
  schedule();
}

function holdFileForCalibration(on) {
  if (state.source !== "file" || !running) return;
  if (on) video.pause();
  else if (state.mode === "running") video.play().catch((err) => console.warn("ppv: resume after calibration", err));
}

video.addEventListener("playing", () => {
  if (state.source === "file" && state.mode === "calibrating") video.pause();
});
// requestVideoFrameCallback stops firing once a file ends, so onFrame never sees video.ended.
video.addEventListener("ended", () => {
  if (running && state.source === "file" && state.mode === "running") stop();
});
// The camera can change its frame size after it starts: an iPhone held upright reports the sensor's
// landscape 1280x720 first and turns it to 720x1280 a moment later (owner's iPhone, 2026-10-31 06:10 KST). The
// size taken at start fed the tap mapping (taps squeezed into a landscape band), the analysis canvas
// and the clip recorder, so all of them follow the new size here.
video.addEventListener("resize", () => {
  if (!running || !video.videoWidth || !video.videoHeight) return;
  const w = video.videoWidth, h = video.videoHeight;
  const old = state.video;
  if (w === old.width && h === old.height) return;
  const turned = !old.width || Math.abs(w / h - old.width / old.height) > 0.01;
  const corners = state.calibration && state.calibration.corners;
  state.video = { width: w, height: h };
  pipeline.setVideoSize(w, h);
  if (recorder) recorder.setSize(w, h);
  if (corners && !turned) {
    const k = w / old.width;
    applyCalibration(corners.map((c) => ({ x: c.x * k, y: c.y * k })), true);
  } else if (corners) {
    // corners taken on the other shape point at the wrong place: use a calibration saved for this
    // shape, else calibrate again
    applyCalibration(null, false);
    restoreCalibration();
    if (!state.calibration && state.mode === "running") {
      state.prevMode = "running";
      state.mode = "calibrating";
      ui.notice(L("화면 방향이 바뀌었어요. 다시 보정해 주세요", "Screen orientation changed. Please calibrate again"));
    }
  }
  render();
});

function schedule() {
  if (!running) return;
  // camera read through the analysis video: tick with the display, not with the stage video's frames,
  // so a stage video that presents rarely cannot hold the analysis back (onFrame waits for probeFresh)
  const throughProbe = state.source === "camera" && analysisFrom() !== "screen";
  if (!throughProbe && video.requestVideoFrameCallback) frameHandle = video.requestVideoFrameCallback(onFrame);
  else frameHandle = requestAnimationFrame(() => onFrame(performance.now(), null));
}

// The analysis clock of a camera frame: when it was captured (captureTime), else when the browser got
// it (presentationTime), both on the performance clock - not when this callback ran, which is the next
// display tick, 0-17 ms after the frame came. At 20-30 fps that jitter alone broke the ball tracker's
// parabola test (clip12 at a phone's frame spacing: ball on 54% of frames with true times, 11% with
// tick times). Which field a camera gives is fixed by its first frame, so the clock never mixes.
let camClock = null;
let lastFrameT = -Infinity;
// the analysis time of the frame state shows, handed to the recorder so its overlay track and the
// state's bounce and shot times are on one clock
let recT = null;
// when recT was last set (frame callback time): a camera call long after it (the page was paused) must not hand
// the recorder a picture stamped with that old time
let recTAt = null;
function frameTime(meta, now) {
  if (camClock == null) camClock = meta && meta.captureTime > 0 ? "captureTime" : meta && meta.presentationTime > 0 ? "presentationTime" : "tick";
  state.perf.clock = camClock;
  const ms = camClock !== "tick" && meta && meta[camClock] > 0 ? meta[camClock] : now;
  lastFrameT = Math.max(ms / 1000, lastFrameT + 1e-4);
  return lastFrameT;
}

function onFrame(now, meta) {
  if (!running) return;
  if (video.ended) {
    stop();
    return;
  }
  const t = state.source === "file" ? (meta ? meta.mediaTime : video.currentTime) : now / 1000;
  if (state.mode === "running" && video.readyState >= 2) {
    const src = analysisSource();
    // with frame callbacks, read the analysis video only when it presented a new frame
    if (src !== probe || !probe.requestVideoFrameCallback || probeFresh) {
      probeFresh = false;
      const ft = state.source === "camera" ? frameTime(src === probe ? probeMeta : meta, now) : t;
      recT = ft;
      recTAt = now;
      pipeline.process(src, ft);
      pipeline.poseEvery = Math.min(8, Math.max(1, Math.round(pipeline.perf.poseMs / 15)));
      snapshot(ft);
      if (venue.attached) sendMultiStatus();
      if (multi.role === "primary") pollMerged();
      fpsCount++;
      guardTick(true);
    } else guardTick(false);
    state.save.recording = !!(recorder && recorder.recording);
  }
  const wall = performance.now();
  if (wall - fpsT0 >= 1000) {
    state.perf.fps = Math.round((fpsCount * 1000) / (wall - fpsT0));
    fpsLog.push({ at: wall, fps: state.perf.fps });
    if (fpsLog.length > 600) fpsLog.shift();
    watchSlow(state.perf.fps, wall);
    fpsCount = 0;
    fpsT0 = wall;
  }
  render();
  // one clip picture per screen frame, with the state just drawn as its overlay track entry
  // with PC save on (and not the second camera) the recorder keeps the last three seconds as its pre-roll.
  // It keeps filling on the corner screen too (the camera still films there): a rally served right after
  // the corners are set still gets its whole pre-roll. Off, the reason goes to the next clip's meta.start.
  const filming = state.mode === "running" || state.mode === "calibrating";
  if (recorder) {
    const why = !filming ? `mode:${state.mode}` : !store.get("uploadKey", null) ? "no-save" : multi.role === "secondary" ? "secondary" : null;
    recorder.arm(why === null, why);
  }
  // the analysis clock is fresh, or not used for this picture (corner screen, a file)
  const recFresh = state.source !== "camera" || state.mode !== "running" || (recT != null && recTAt != null && now - recTAt <= 250);
  if (filming && recorder && recorder.wantsFrames && recFresh) {
    // on the corner screen the analysis is paused, so its clock (recT) is not moving: the camera's own
    // frame time is used, on the same clock
    const cam = state.source !== "camera" ? t : state.mode === "running" && recT != null ? recT : frameTime(meta, now);
    recSafe(() => recorder.frame(video, state, cam));
    state.perf.rec = recorder.stats;
  }
  schedule();
}

function syncPlayers() {
  if (!pipeline) return;
  state.players = pipeline.players.state();
  labelPlayers();
}

// The analysis rate during a rally, kept with the saved rally (the rate a phone really reaches decides
// whether bounces are found at all: rally.js needs five points in 0.25 s). Median of the once-a-second
// readings between the rally's start and end (performance-clock ms), else the latest one.
const fpsLog = [];
function rallyFps(fromMs, toMs) {
  const xs = fpsLog.filter((s) => s.at >= fromMs && s.at <= toMs + 1000).map((s) => s.fps).sort((a, b) => a - b);
  if (!xs.length) return fpsLog.length ? fpsLog[fpsLog.length - 1].fps : null;
  return xs[Math.floor(xs.length / 2)];
}
// the screen the rally was filmed on: viewport size only, nothing that names the device
const screenSize = () => ({ width: Math.round(window.innerWidth), height: Math.round(window.innerHeight) });

function snapshot(t) {
  const snap = pipeline.snapshot(t);
  state.ball = snap.ball;
  state.tracking = snap.tracking;
  state.calibrationIssue = snap.calibrationIssue;
  state.colorHint = snap.colorHint || null;
  syncPlayers();
  state.perf = { ...state.perf, ms: snap.perf.ms, poseMs: snap.perf.poseMs, ballMs: snap.perf.ballMs };
  if (snap.rally) {
    state.rally = { active: true, timeMs: snap.rally.timeMs, shots: snap.rally.shots, speedKmh: snap.rally.speedKmh, maxSpeedKmh: snap.rally.maxSpeedKmh };
    state.bounces = snap.rally.bounces.map((b) => ({ tx: b.tx, ty: b.ty, side: b.side, t: b.t }));
    lastRallyTimeMs = snap.rally.timeMs;
    lastRallyShots = snap.rally.shots;
  } else {
    state.rally = { ...state.rally, active: false, timeMs: lastRallyTimeMs, shots: lastRallyShots };
  }
  const shot = snap.rally && snap.rally.lastShot;
  if (shot) lastShotAt = shot.t;
  state.lastShot = shot && t - lastShotAt < 1.5 ? { ...shot } : t - lastShotAt < 1.5 ? state.lastShot : null;
}

// How the camera screen looked when the clip started, kept with its overlay track: the replay lays
// out the same screen code for its own size, and QA compares the two.
function clipMeta() {
  const stage = document.querySelector(".stage");
  const s = stage ? stage.getBoundingClientRect() : { left: 0, top: 0 };
  const a = ui.videoToScreen({ x: 0, y: 0 });
  const b = ui.videoToScreen({ x: state.video.width, y: state.video.height });
  return {
    layout: state.layout,
    portrait: innerHeight > innerWidth,
    view: { width: innerWidth, height: innerHeight },
    fit: stage ? stage.getAttribute("data-video-fit") || "contain" : "contain",
    picture: { x: Math.round(s.left + a.x), y: Math.round(s.top + a.y), width: Math.round(b.x - a.x), height: Math.round(b.y - a.y) },
  };
}

const uiNotice = ui.notice;
ui.notice = (text, opts = {}) => {
  uiNotice(text, opts);
  if (recorder && opts.record !== false) recorder.notice(text);
};

const rallyShots = new RallyShots();
function onEvent(e) {
  rallyShots.onEvent(e);
  // 확인 후 입력 keeps its question through the next serve (answered here or on the referee screen)
  if (e.type === "rallyStart" && !(tour.pending && tour.pending.keep)) tour.dropChoice();
  if (e.type === "rallyStart" && store.get("uploadKey", null) && recorder && multi.role !== "secondary") clipStart();
  if (e.type !== "rallyEnd") return;
  if (multi.role !== "single" && state.source === "camera") return multiRallyEnd(e);
  // A rally cut short by 정지 is not a finished point; everything else is judged (point.js).
  const judged = e.why !== "stop" ? judgePoint({ shots: e.shotList, bounces: e.bounces, durationS: e.durationS }) : null;
  const linked = !!(state.tour.connected && state.tour.matchId && judged);
  const draft = linked ? rallyShots.draft(e, tour.slotOf("near")) : null;
  // one camera left while a hold stands (the other phone went off after the warning): it may be the one
  // whose pick is turned, so it asks too until a person changes a pick
  const held = holdNow().on;
  const rally = { why: e.why, startMs: Date.now() - e.durationS * 1000, endMs: Date.now() };
  const scored = linked ? tour.score(judged, suspects({ shots: e.shotList, bounces: e.bounces, serveNet: e.serveNet, serveSeen: e.serveSeen }), { ...(held ? scoreAction(null, { hold: true }) : {}), rally }) : Promise.resolve(null);
  if (draft) track(scored.then((point) => point && tour.postAnalysis(point, rallyRecord(draft, point))));
  if (!linked && judged && judged.sure) tour.say(both(`${SIDE_NAMES[tour.colourOf(judged.winner)]} 득점`, `Point ${SIDE_NAMES[tour.colourOf(judged.winner)]}`));
  const keep = (e.shots >= 2 && e.bounces.length >= 1) || linked;
  const clip = clipStop();
  if (stopRefused) track(scored.then((point) => point && (state.clipRefused = [...(state.clipRefused || []), { matchId: point.matchId, index: point.index }].slice(-50))));
  track(scored);
  if (!keep) return;
  const players = Object.fromEntries(["near", "far"].map((s) => [s, { label: state.players[s].label, moveM: state.players[s].moveM, wristDeg: state.players[s].wristDeg }]));
  // camera frames carry performance-clock seconds; a file's media time does not, so its rate is the latest reading
  const fromMs = state.source === "camera" ? (e.t - e.durationS) * 1000 : Infinity;
  const entry = { id: Date.now(), startedAt: Date.now() - e.durationS * 1000, durationMs: Math.round(e.durationS * 1000), shots: e.shots, maxSpeedKmh: e.maxSpeedKmh, bounces: e.bounces, players, analysisFps: rallyFps(fromMs, state.source === "camera" ? e.t * 1000 : Infinity), screen: screenSize() };
  state.history = [entry, ...state.history].slice(0, 100);
  store.set("history", state.history);
  if (judged) entry.point = { winner: judged.winner, reason: judged.label };
  track(clip.then((rec) => rec && uploadRally(entry, rec, scored)));
}

// Recording is extra; scoring is the job. An exception in a recorder hook turns recording off for this
// page (that clip is dropped), says so once on the console and the PC chip, and the camera goes on.
// The clip id of the rally being played (the recorder's answer to start). A rally's stop asks for that
// clip only: a rally the recorder could not take (one still finishing and one already waiting) gets no
// clip, never the clip of the rally before it.
let rallyClip = null;
// the recorder turned this rally down (it is saved with no clip); kept per point in state.clipRefused
let rallyRefused = false;
let stopRefused = false;
function clipStart() {
  const id = recSafe(() => recorder.start(clipMeta()));
  if (id) rallyClip = id;
  else if (!recorder.recording) rallyClip = null;
  rallyRefused = !id && !rallyClip;
}
function clipStop() {
  const id = rallyClip;
  rallyClip = null;
  stopRefused = rallyRefused;
  rallyRefused = false;
  return (id && recorder && recSafe(() => recorder.stop(id))) || Promise.resolve(null);
}

function recSafe(fn) {
  try {
    return fn();
  } catch (err) {
    if (recorder && !recorder.broken) {
      console.warn("ppv: replay recording off", err);
      recorder.fail();
      state.save = { ...state.save, recordOff: true };
      ui.notice(L("다시 보기 녹화를 껐어요. 점수와 분석은 그대로예요", "Replay recording is off. Scores and analysis carry on"));
    }
    return null;
  }
}

// ---------- leaving the camera: the top-left back, or the browser's back ----------
// Work that must finish before the page goes: rally uploads and score writes.
const pending = new Set();
function track(p) {
  pending.add(p);
  p.catch(() => {}).finally(() => pending.delete(p));
  return p;
}

// One extra history entry, added on the first tap (browsers skip entries added without one), so
// the browser's back lands here first and leaves the same way as the button.
function guard() {
  if (!(history.state && history.state.ppvGuard)) history.pushState({ ppvGuard: 1 }, "");
}
window.addEventListener("pointerdown", guard, true);
window.addEventListener("popstate", (e) => {
  if (e.state && e.state.ppvGuard) return;
  ui.back();
  if (!leaving) guard();
});

let leaving = false;
async function leave() {
  if (leaving) return;
  if (state.mode === "running" && !(await ui.confirmLeave())) return;
  leaving = true;
  state.leaving = true;
  stop();
  if (pending.size) {
    state.mode = "loading";
    state.loadingText = L("나가는 중… 랠리 영상과 점수를 마저 보내요", "Leaving… sending the last rally clips and scores");
    render();
  }
  await Promise.race([Promise.allSettled([...pending, tour.queue]), new Promise((r) => setTimeout(r, 8000))]);
  leaveToPicker();
}

// ---------- rally saves on the owner's PC (docs/save-to-pc.md) ----------
function setUpload(entry, upload) {
  const h = state.history.find((r) => r.id === entry.id);
  if (!h) return;
  h.upload = upload;
  store.set("history", state.history);
  render();
}

async function uploadRally(entry, { video: blob, overlay }, scored = Promise.resolve(null)) {
  const key = store.get("uploadKey", null);
  if (!key) return;
  setUpload(entry, { status: "uploading" });
  const { upload, ...record } = entry;
  const form = new FormData();
  form.set("record", JSON.stringify(record));
  form.set("video", blob, blob.type.includes("mp4") ? "rally.mp4" : "rally.webm");
  if (overlay) form.set("overlay", overlay, "overlay.json.gz");
  try {
    const res = await fetch(new URL("api/rallies", BASE), { method: "POST", headers: { "x-ppv-key": key }, body: form });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) {
      state.save = { ...state.save, check: "rejected" };
    }
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    const share = new URL(body.share, BASE);
    setUpload(entry, { status: "done", id: body.id, url: share.href, bytes: blob.size, overlayBytes: overlay ? overlay.size : 0 });
    scored.then((point) => {
      if (!point) return;
      tour.attachClip(point, share.pathname);
      // the desk reads corners in the clip's own pixels: the clip is the camera picture scaled to the recorder
      const k = (recorder && recorder.scale) || 1;
      const corners = state.calibration && state.calibration.corners.map((c) => ({ x: c.x * k, y: c.y * k }));
      tour.deskFromSave(point, body.id, corners);
    });
  } catch (err) {
    console.warn("ppv: upload failed", err);
    setUpload(entry, { status: "failed", error: String(err.message || err) });
  }
}

// A key on the phone is not enough: the on-screen PC save state says on only when the server
// takes this key. The key itself stays out of the state and off the screen.
async function checkSaveKey() {
  const key = store.get("uploadKey", null);
  if (!key) return null;
  let check = "unknown";
  try {
    const res = await fetch(new URL("api/key-check", BASE), { headers: { "x-ppv-key": key } });
    if (res.status === 204) check = "ok";
    else if (res.status === 401) check = "rejected";
  } catch (err) {
    console.warn("ppv: key check", err);
  }
  if (store.get("uploadKey", null) !== key) return null;
  state.save = { ...state.save, check };
  render();
  return check;
}

async function setUploadKey(key) {
  const k = String(key || "").trim();
  if (!k) {
    store.set("uploadKey", null);
    state.save = { ...state.save, keySet: false, check: null, keyError: null };
    return render();
  }
  try {
    const res = await fetch(new URL("api/key-check", BASE), { headers: { "x-ppv-key": k } });
    if (res.status !== 204) throw new Error(L("열쇠가 맞지 않아요", "The key does not match"));
    store.set("uploadKey", k);
    state.save = { ...state.save, keySet: true, check: "ok", keyError: null };
    if (recorder && pipeline && pipeline.rally && pipeline.rally.rally && !recorder.recording) clipStart();
  } catch (err) {
    state.save = { ...state.save, keyError: String(err.message || err) };
  }
  render();
}

// A tournament PIN that passed on this device also turns PC save on: the server checks it the same
// way and gives this browser its own token, kept where a key would be. A key that still works stays.
let pinSaving = null;
const saveByPin = () => (pinSaving ||= saveByPinOnce().finally(() => (pinSaving = null)));
async function saveByPinOnce() {
  if (!tour.pin) return;
  if (store.get("uploadKey", null) && (await checkSaveKey()) !== "rejected") return;
  try {
    const res = await fetch(new URL("api/pin-save", BASE), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: tour.pin }) });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      store.set("uploadKey", body.token);
      state.save = { ...state.save, keySet: true, check: "ok", keyError: null, notice: L("점수 기록과 PC 저장이 켜졌어요.", "Score recording and PC save are on.") };
      if (recorder && pipeline && pipeline.rally && pipeline.rally.rally && !recorder.recording) clipStart();
    } else if (body.code === "pin") {
      // A stale copy is tried once, not on every open, so it cannot lock the venue out.
      tour.dropPin();
      state.tour = tour.view();
      state.save = { ...state.save, notice: L("대회 PIN이 바뀌었어요. 새 PIN을 넣으면 다시 켜져요.", "The tournament PIN changed. Enter the new PIN to turn it back on.") };
    } else {
      state.save = { ...state.save, keyError: errorText(body, L("PC 저장을 켜지 못했어요", "Could not turn on PC save")) };
    }
  } catch (err) {
    console.warn("ppv: pin save", err);
    state.save = { ...state.save, keyError: L("PC 저장 권한을 받지 못했어요. 연결을 확인하고 다시 시도해 주세요.", "Could not get PC save permission. Check the connection and try again.") };
  }
  render();
}

async function deleteRally(id) {
  const entry = state.history.find((r) => r.id === id);
  if (!entry) return;
  if (entry.upload && entry.upload.id) {
    const res = await fetch(`./api/rallies/${entry.upload.id}`, { method: "DELETE", headers: { "x-ppv-key": store.get("uploadKey", "") } }).catch(() => null);
    if (!res || (res.status !== 204 && res.status !== 404)) {
      setUpload(entry, { ...entry.upload, error: L("PC에서 지우지 못했어요", "Could not delete from the PC") });
      return;
    }
  }
  state.history = state.history.filter((r) => r.id !== id);
  store.set("history", state.history);
  render();
}

function stopSources() {
  running = false;
  if (frameHandle != null) {
    if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameHandle);
    cancelAnimationFrame(frameHandle);
    frameHandle = null;
  }
  detachProbe();
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  if (fileUrl) {
    URL.revokeObjectURL(fileUrl);
    fileUrl = null;
  }
}

function stop() {
  if (pipeline) pipeline.reset();
  stopSources();
  video.pause();
  if (wakeLock) wakeLock.release().catch((err) => console.warn("ppv: wake lock release", err));
  wakeLock = null;
  state.mode = "stopped";
  render();
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch (err) {
    console.warn("ppv: wake lock unavailable", err);
    wakeLock = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && running) requestWakeLock();
});

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register(new URL("sw.js", BASE), { scope: BASE.pathname, updateViaCache: "none" }).catch((err) => console.warn("ppv: service worker", err));
}

// One-time setup link (#setup=<token>): drop it from the address bar first, then trade it once
// for the upload key. The fragment is never sent to the server with the page request.
// A link opened in a tab that already shows the app only changes the fragment (no reload), so
// this also runs on hashchange and on a page restored from the back-forward cache.
async function redeemSetupLink() {
  if (!location.hash.startsWith("#setup")) return;
  const m = /^#setup=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  history.replaceState(null, "", "/" + location.search);
  if (!m) {
    const msg = L("설정 링크 모양이 달라요. 받은 링크를 통째로 다시 열어 주세요", "The setup link looks wrong. Reopen the whole link you received");
    state.save = { ...state.save, keyError: msg, notice: msg };
    render();
    return;
  }
  try {
    const res = await fetch(new URL("api/setup", BASE), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: m[1] }) });
    if (!res.ok) throw new Error(L("설정 링크가 이미 쓰였거나 시간이 지났어요", "The setup link was already used or has expired"));
    const { key } = await res.json();
    store.set("uploadKey", key);
    state.save = { ...state.save, keySet: true, check: "ok", keyError: null, notice: L("PC 저장이 켜졌어요. 랠리가 끝나면 그 구간 영상이 PC로 올라가요.", "PC save is on. When a rally ends, its clip is uploaded to the PC.") };
  } catch (err) {
    // The DM link tapped a second time on a phone that is already on is not a failure.
    if ((await checkSaveKey()) === "ok") state.save = { ...state.save, keyError: null, notice: L("PC 저장은 이미 켜져 있어요. 링크를 또 열지 않아도 돼요.", "PC save is already on. You do not need to open the link again.") };
    else state.save = { ...state.save, keyError: String(err.message || err), notice: String(err.message || err) };
  }
  render();
}
redeemSetupLink().then(checkSaveKey).then(saveByPin);
window.addEventListener("online", () => checkSaveKey().then(saveByPin));
// One app, one address: this screen is the camera role of the tournament app at "/". An old
// camera link lands here too; it keeps the role, and the address bar shows only the one address.
try {
  localStorage.setItem("pp-role", "camera");
} catch {}
if (location.pathname !== "/") history.replaceState(history.state, "", "/" + location.search + location.hash);
if (state.tour.connected) tour.refresh();
venue.start().catch((err) => console.warn("ppv: venue link", err));
window.addEventListener("hashchange", redeemSetupLink);
window.addEventListener("pageshow", (e) => e.persisted && redeemSetupLink());

window.__ppv = { state, venue, multi, get pipeline() { return pipeline; }, get recorder() { return recorder; } };
render();
