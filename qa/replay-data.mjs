// 다시 보기 with the overlay as data, measured end to end on the real apps:
//   1. record  the real camera screen (fake camera playing a test clip, calibrated, PC save on) films
//              until a rally clip reaches the PC. Every recorded picture is logged on the camera: its
//              track time, where the name tags were drawn on the camera screen, and a 24x24 luma
//              fingerprint of the picture handed to the encoder.
//   2. saved   (a) the save folder holds the video and overlay.json.gz; the decoded video carries no
//              HUD ink (theme gold / end colours), the overlay track's size and frame count.
//   3. replay  the replay page at the camera's own viewport: (b) for sampled pictures the name tags
//              land within 4 px of where the camera drew them; (d) after a seek, while playing, after
//              pause and on the frozen last frame, the drawn overlay frame is the picture on screen
//              (fingerprint match, within one frame); (c) 선수·코트 starts open and folds / opens;
//              오버레이 끄기 hides it.
//   4. player  the spectator's full-screen 다시 보기 (phone and TV): the new clip opens in the replay
//              page (captures open and folded), (e) an old clip without a track plays as a plain video.
//   bun qa/replay-data.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> --out=<dir>
//     [--shape=portrait|landscape] [--play=chromium|webkit] [--port=9990]
import { chromium, webkit } from "playwright";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DEVICES, fakeCamera, playClip, startCamera, startOneApp } from "./one-app-harness.mjs";
import { withLang } from "./qa-lang.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out;
const shape = args.shape || "portrait";
const playEngine = args.play === "webkit" ? webkit : chromium;
mkdirSync(out, { recursive: true });
const report = { shape, play: args.play || "chromium", checks: {} };
const check = (name, pass, detail) => {
  report.checks[name] = { pass: !!pass, detail };
  console.log(`CHECK ${name} ${pass ? "PASS" : "FAIL"} ${JSON.stringify(detail)}`);
};
const camDev = shape === "portrait" ? DEVICES.phone : DEVICES.land;
// --stamp=0: no frame index in the recorded picture (captures for people); the stamp-read sync checks are skipped
const stampOn = args.stamp !== "0";
report.stamp = stampOn;

const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9990) });
const rec = withLang(await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] }));
const play = playEngine === chromium ? rec : withLang(await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {}));
const tagsOf = (s) => Object.fromEntries((s || "").split("|").filter(Boolean).map((x) => { const [side, v] = x.split(":"); const [px, py, w, h] = v.split(",").map(Number); return [side, { x: px, y: py, w, h }]; }));
const dist = (a, b) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0) / a.length;

try {
  // ---------- 1. record ----------
  const { defaultBrowserType: _d, ...camDesc } = camDev;
  const camCtx = await rec.newContext(camDesc);
  await camCtx.addInitScript(() => { sessionStorage.setItem("pp-started", "1"); });
  // --cam=WxH: the fake camera picture size (default 960x540); smaller means less to analyse per frame
  if (args.cam) await camCtx.addInitScript((s) => { window.__qaCamSize = s; }, args.cam);
  await camCtx.addInitScript(fakeCamera, `${app.origin}/__qa/cam.webm`);
  // --mime=webm: a WebKit (WPE) build without H.264 has no decoder for it, so a clip meant for it is recorded as WebM
  // (an iPhone records and plays its own mp4); QA only, the app picks the format itself
  if (args.mime === "webm") await camCtx.addInitScript(() => { const orig = MediaRecorder.isTypeSupported.bind(MediaRecorder); MediaRecorder.isTypeSupported = (t) => !/mp4/.test(t) && orig(t); });
  // this PC's WPE WebKit has no H.264 decoder (canPlayType avc1 is ""), and Chromium now records MP4:
  // a WebKit play run keeps the Chromium recorder on webm so the player under test gets a picture it can decode
  if (playEngine !== chromium) await camCtx.addInitScript(() => { const o = MediaRecorder.isTypeSupported.bind(MediaRecorder); MediaRecorder.isTypeSupported = (t) => !/mp4/.test(t) && o(t); });
  await camCtx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, { "pp-pin": app.pin, "pp-role": "camera", "ppv.uploadKey": JSON.stringify(app.key), "ppv.tourMode": JSON.stringify("all"), "ppv.stableMode": JSON.stringify(args.stable || "off") });
  // recorder timeline (QA only): MediaRecorder start/stop, every chunk with its bytes, onstop
  await camCtx.addInitScript(() => {
    const L = (window.__qaRecLog = []);
    const now = () => Math.round(performance.now());
    const MR = window.MediaRecorder;
    if (!MR) return;
    window.MediaRecorder = class extends MR {
      constructor(...a) {
        super(...a);
        this.addEventListener("dataavailable", (e) => L.push({ ev: "data", t: now(), bytes: e.data ? e.data.size : 0 }));
        this.addEventListener("stop", () => L.push({ ev: "onstop", t: now() }));
      }
      start(...a) { L.push({ ev: "mr.start", t: now() }); return super.start(...a); }
      stop(...a) { L.push({ ev: "mr.stop", t: now() }); return super.stop(...a); }
    };
  });
  const cam = await camCtx.newPage();
  await cam.goto(app.origin + "/vision/", { waitUntil: "load" });
  await cam.evaluate(() => document.fonts.ready);
  // --serve=now: the rally may start right after the corners are set (the old way). Default: the clip waits
  // until the camera has sent pictures without a pause for 3.5 s, then plays from its start, so the pre-roll
  // check sees a rally served at least the pre-roll after the corner screen.
  const serveNow = args.serve === "now";
  report.serve = serveNow ? "now" : "after-3.5s";
  await startCamera(cam, { holdClip: !serveNow });
  if (!serveNow) {
    // 3.5 s after the corner screen closed, and (a recorder that keeps these) 3.5 s of pictures without a pause
    const runningAt = await cam.evaluate(() => performance.now());
    await cam.waitForFunction((since) => {
      const r = window.__ppv.recorder, t = performance.now();
      if (!r || t - since < 3500) return false;
      if (typeof r.lastCallAt !== "number") return true;
      return t - r.lastCallAt < 200 && (r.resumedAt === null || t - r.resumedAt > 3500);
    }, runningAt, { timeout: 60000, polling: 100 });
    await playClip(cam);
  }
  // the app's own recorder calls: start (rallyStart), stop (rallyEnd), the last picture drawn, the clip size
  await cam.evaluate(() => {
    const L = window.__qaRecLog, now = () => Math.round(performance.now());
    const P = window.__ppv.recorder && Object.getPrototypeOf(window.__ppv.recorder);
    if (!P) return;
    const { start, stop, frame } = P;
    P.start = function (...a) { L.push({ ev: "rallyStart", t: now() }); return start.apply(this, a); };
    P.frame = function (...a) { if (this.rec) { this.__qaLast = now(); (this.__qaTimes ||= []).push(this.__qaLast); } return frame.apply(this, a); };
    P.stop = function (...a) {
      const ts = this.__qaTimes || []; this.__qaTimes = [];
      const d = ts.slice(1).map((x, k) => x - ts[k]);
      L.push({ ev: "rallyEnd.stop", t: now(), lastFrame: this.__qaLast ?? null, drawn: ts.length, drawGapMax: d.length ? Math.max(...d) : null, drawGapsOver200: d.filter((g) => g >= 200).length });
      const p = stop.apply(this, a);
      p.then((r) => L.push({ ev: "clip", t: now(), bytes: r && r.video ? r.video.size : r && r.size ? r.size : 0 }));
      return p;
    };
  });
  await cam.evaluate((stamp) => {
    const r = window.__ppv.recorder;
    const orig = r.frame.bind(r);
    const fc = document.createElement("canvas");
    fc.width = 24; fc.height = 24;
    const fx = fc.getContext("2d", { willReadFrequently: true });
    const overlay = document.querySelector(".stage__overlay");
    window.__qaClips = [];
    let last = null;
    // the screen as the camera showed it, each camera frame, so a drawn picture can be paired with the screen
    // at its own shown time (with a pre-roll it is drawn about a second later)
    r.frame = (v, s, ...rest) => {
      window.__qaPic = window.__qaPic || ((v) => { if (!v || !v.videoWidth) return null; const b = v.getBoundingClientRect(); const fit = getComputedStyle(v).objectFit; const k = (fit === "cover" ? Math.max : Math.min)(b.width / v.videoWidth, b.height / v.videoHeight); return { left: b.left + (b.width - v.videoWidth * k) / 2, top: b.top + (b.height - v.videoHeight * k) / 2, k, vw: v.videoWidth }; });
      const live = (window.__qaLive ||= []);
      live.push({ now: performance.now(), tags: overlay.dataset.tags || "", pic: window.__qaPic(document.querySelector(".stage__video")), compact: document.querySelector(".app")?.dataset.stable === "1" });
      if (live.length > 240) live.shift();
      return orig(v, s, ...rest);
    };
    // every clip picture, whoever draws it (the camera frame or the recorder's own loop): stamp its index and
    // keep the screen at the time the picture was shown (draw's t0)
    const origDraw = r.draw.bind(r);
    r.draw = (picture, t0, ...rest) => {
      const track = r.track;
      const n = track ? track.frames.length : 0;
      const ret = origDraw(picture, t0, ...rest);
      if (!track || track.frames.length === n) return ret;
      if (track !== last) { last = track; window.__qaClips.push([]); }
      // QA only: the picture's index as 12 black/white 16 px blocks in the top-left corner, so the
      // replay can read which recorded picture it shows
      const idx = track.frames.length - 1;
      if (stamp) for (let b = 0; b < 12; b++) { r.ctx.fillStyle = (idx >> b) & 1 ? "#fff" : "#000"; r.ctx.fillRect(b * 16, 0, 16, 16); }
      fx.drawImage(r.canvas, 0, 0, 24, 24);
      const d = fx.getImageData(0, 0, 24, 24).data;
      const fp = [];
      for (let i = 0; i < d.length; i += 4) fp.push(Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]));
      const live = window.__qaLive || [];
      const seen = live.reduce((best, x) => (!best || Math.abs(x.now - t0) < Math.abs(best.now - t0) ? x : best), null) || { tags: "", pic: null, compact: false };
      window.__qaClips.at(-1).push({ t: track.frames.at(-1).t, cam: track.frames.at(-1).cam, tags: seen.tags, fp, pic: seen.pic, compact: seen.compact });
      return ret;
    };
  }, stampOn);
  // a camera screen capture mid-rally (rally clips here are 15-50 track frames), with the track time it shows
  let camShot = null;
  const camShotTimer = (async () => {
    await cam.waitForFunction(() => window.__ppv.recorder.track && window.__ppv.recorder.track.frames.length > 10 && document.querySelector(".stage__overlay").dataset.tags.includes(":"), null, { timeout: 180000, polling: 100 });
    const t0 = await cam.evaluate(() => window.__ppv.recorder.track.frames.at(-1).t);
    await cam.screenshot({ path: join(out, `${shape}-camera.png`) });
    const t1 = await cam.evaluate(() => window.__ppv.recorder.track?.frames.at(-1).t ?? null);
    camShot = { t0, t1 };
  })().catch((e) => { camShot = { error: String(e.message || e) }; });
  const camLog = [];
  cam.on("console", (m) => { if (/ppv:|upload|error/i.test(m.text())) camLog.push(m.type() + " " + m.text().slice(0, 200)); });
  cam.on("pageerror", (e) => camLog.push("pageerror " + e.message));
  await cam.waitForFunction(() => (window.__ppv.state.history || []).some((h) => h.upload && h.upload.status === "done"), null, { timeout: 240000, polling: 500 }).catch(async (err) => {
    const st = await cam.evaluate(() => { const s = window.__ppv.state; return { mode: s.mode, tracking: s.tracking, rally: s.rally, history: (s.history || []).slice(0, 5).map((h) => ({ shots: h.shots, bounces: (h.bounces || []).length, upload: h.upload })), rec: s.perf && s.perf.rec, save: s.save, tour: s.tour && { ws: s.tour.ws, connected: s.tour.connected, needPick: s.tour.needPick, matchId: s.tour.matchId, error: s.tour.error, match: s.tour.match && { no: s.tour.match.no, status: s.tour.match.status } }, fps: s.perf && s.perf.fps, stable: s.stable && s.stable.compact }; }).catch((e) => String(e));
    throw new Error(`no saved rally: ${JSON.stringify(st)} log=${JSON.stringify(camLog.slice(-8))}`);
  });
  await camShotTimer;
  const done = await cam.evaluate(() => window.__ppv.state.history.find((h) => h.upload && h.upload.status === "done").upload);
  const recStats = await cam.evaluate(() => window.__ppv.state.perf.rec);
  const clips = await cam.evaluate(() => window.__qaClips);
  console.log(`RALLIES ${JSON.stringify(await cam.evaluate(() => ({ fps: window.__ppv.state.perf && window.__ppv.state.perf.fps, history: (window.__ppv.state.history || []).map((h) => ({ shots: h.shots, bounces: (h.bounces || []).length, ms: h.durationMs, up: h.upload && h.upload.status })) })).catch(() => null))}`);
  console.log(`RECLOG ${JSON.stringify(await cam.evaluate(() => window.__qaRecLog || []).catch(() => []))}`);
  await camCtx.close();
  const id = new URL(done.url).pathname.split("/").at(-1);
  const sharePath = `/vision/s/${id}`;

  // ---------- 2. saved ----------
  const dir = join(app.tmp, "saves", id);
  const files = existsSync(dir) ? readdirSync(dir).sort().map((f) => ({ f, bytes: statSync(join(dir, f)).size })) : [];
  // the saved video's frame spacing (QA only): median and largest gap between picture times, and gaps of 200 ms or more
  {
    const vf = files.find((x) => x.f.startsWith("video."));
    if (vf) {
      const pts = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", join(dir, vf.f)]).toString().replace(/,/g, " ").split(/\s+/).map(Number).filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
      const gaps = pts.slice(1).map((x, k) => Math.round((x - pts[k]) * 1000)).sort((a, b) => a - b);
      console.log(`CLIPGAPS ${JSON.stringify({ frames: pts.length, median: gaps.length ? gaps[gaps.length >> 1] : null, max: gaps.length ? gaps.at(-1) : null, over200: gaps.filter((g) => g >= 200).length, lastPtsMs: pts.length ? Math.round(pts.at(-1) * 1000) : null })}`);
    }
  }
  const videoFile = files.find((x) => x.f.startsWith("video."));
  // --remux=1: the saved webm's container is written again with its length (ffmpeg -c copy, same frames);
  // MediaRecorder webm has no duration and a WPE build can end such a file early
  if (args.remux && videoFile && videoFile.f.endsWith(".webm")) {
    const src = join(dir, videoFile.f), tmp = join(dir, "remux.webm");
    const dur = (f) => Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).stdout.toString().trim();
    const before = dur(src);
    const r = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-i", src, "-c", "copy", tmp]);
    if (r.exitCode !== 0) throw new Error(`remux failed: ${r.stderr.toString()}`);
    Bun.spawnSync(["mv", tmp, src]);
    report.remux = { before, after: dur(src), bytes: statSync(src).size };
    console.log(`REMUX ${JSON.stringify(report.remux)}`);
  }
  const gz = existsSync(join(dir, "overlay.json.gz")) ? readFileSync(join(dir, "overlay.json.gz")) : new Uint8Array();
  const track = await (await fetch(`${app.origin}${sharePath}/overlay`)).json();
  // the camera's own log of the clip it drew, paired with the saved track: by track time, or, when the PC moved the
  // pictures onto the camera's times at save (track meta.retimed = "cam", times rewritten), by the unchanged camera
  // clock; the paired frames then take the saved times, which are the ones the replay plays
  const sameLen = (c) => c.length === track.frames.length;
  const byT = clips.find((c) => sameLen(c) && c.every((f, i) => f.t === track.frames[i].t));
  const byCam = byT ? null : clips.find((c) => sameLen(c) && c.every((f, i) => Number.isFinite(f.cam) && f.cam === track.frames[i].cam));
  const camFrames = byT || (byCam ? byCam.map((f, i) => ({ ...f, t: track.frames[i].t })) : []);
  report.paired = byT ? "t" : byCam ? "cam" : "none";
  const clipOut = join(out, `${shape}-clip.${videoFile ? videoFile.f.split(".")[1] : "bin"}`);
  // the save's record (retime result and all) beside the clip, for a look after the run
  if (existsSync(join(dir, "record.json"))) writeFileSync(join(out, `${shape}-record.json`), readFileSync(join(dir, "record.json")));
  writeFileSync(clipOut, Buffer.from(await (await fetch(`${app.origin}${sharePath}/video`)).arrayBuffer()));
  const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=codec_name,width,height,pix_fmt,nb_read_frames:format=duration", "-of", "json", clipOut]).stdout.toString();
  // HUD ink: pixels on the theme gold (LOCK, speed, trail) or the end colours (tags, joints) in every decoded frame
  const W = 240;
  const fr = JSON.parse(probe).streams[0];
  const H = Math.round((fr.height / fr.width) * W / 2) * 2;
  const raw = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", clipOut, "-vf", `scale=${W}:${H}:flags=neighbor`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout;
  const ink = (buf, w, h) => {
    const pal = [[0xff, 0xd3, 0x4d], [0x4f, 0x8d, 0xff], [0xff, 0x6b, 0x6b]];
    let n = 0;
    for (let i = 0; i < w * h * 3; i += 3) if (pal.some((c) => Math.abs(buf[i] - c[0]) < 18 && Math.abs(buf[i + 1] - c[1]) < 18 && Math.abs(buf[i + 2] - c[2]) < 18)) n++;
    return n;
  };
  const frames = Math.floor(raw.length / (W * H * 3));
  let maxInk = 0;
  for (let k = 0; k < frames; k++) maxInk = Math.max(maxInk, ink(raw.subarray(k * W * H * 3), W, H));
  report.saved = { id: id.slice(0, 6) + "…", files, overlayBytes: gz.length, overlayJsonBytes: gunzipSync(gz).length, trackFrames: track.frames.length, notices: track.notices.length, meta: track.meta, probe: JSON.parse(probe), recStats, camFramesLogged: camFrames.length, inkPerFrameMax: maxInk, inkFramePixels: W * H, camShot };
  check("a-two-files", files.some((x) => x.f === "overlay.json.gz") && !!videoFile && camFrames.length > 10, { files, camFrames: camFrames.length });
  // every track frame keeps the camera clock the desk finds shots by (replay-track.js cam)
  const clock = track.frames.filter((f) => Number.isFinite(f.cam)).length;
  check("a-track-cam", clock === track.frames.length, { frames: track.frames.length, withCam: clock });
  // the clip opens with the pre-roll: the rally that started this clip begins about a second in. Its start is
  // where the track's rally turns active, or where rally.timeMs starts again (a clip that follows another
  // within a second opens with the last rally's tail).
  let prev = null, ownStart = null, cur = null;
  for (const x of track.frames) {
    if ("rally" in x) cur = x.rally;
    const active = !!(cur && cur.active);
    // a start is a change from the frame before: a first frame already active is the last rally's tail
    if (active && prev && (!prev.active || (cur.timeMs ?? 0) < (prev.timeMs ?? 0))) { ownStart = x.t; break; }
    prev = active ? { active, timeMs: cur.timeMs } : { active };
  }
  const start = (track.meta && track.meta.start) || null;
  if (serveNow) {
    // served right after the corner screen: a short pre-roll is allowed, but the clip must say why in numbers
    const short = ownStart === null || ownStart < 700;
    check("a-preroll-visible", !short || (start !== null && Number.isFinite(start.preRollMs) && (Number.isFinite(start.pauseMs) || Number.isFinite(start.armedMs))), { ownRallyStartMs: ownStart, short, start });
  } else if (start && start.queued) {
    // the rally began while the last clip was still being drawn: this clip starts where that one ended, so its
    // pre-roll is the gap between the two rallies (by design); the check is that the clip says so
    check("a-preroll-queued", Number.isFinite(start.preRollMs), { ownRallyStartMs: ownStart, start });
  } else check("a-preroll", ownStart !== null && ownStart >= 2500, { ownRallyStartMs: ownStart, preRollMs: track.meta && track.meta.preRollMs, frames: track.frames.length, start });

  // ---------- 2b. the picture never waits for the track (lead, 2026-10-31) ----------
  // slow: the track comes 3 s late; the clip already plays with nothing of the overlay on it, then the
  // overlay joins. fail: the track request fails; the clip plays alone, no switch, no page error.
  for (const mode of ["slow", "fail"]) {
    const { defaultBrowserType: _s, ...sDesc } = camDev;
    const sCtx = await play.newContext(sDesc);
    const sp = await sCtx.newPage();
    const sErr = [];
    sp.on("pageerror", (e) => sErr.push(String(e.message)));
    await sp.route("**/overlay", async (r) => {
      if (mode === "fail") return r.abort();
      await new Promise((res) => setTimeout(res, 3000));
      return r.continue();
    });
    const t0 = Date.now();
    await sp.goto(`${app.origin}/vision/replay.html?clip=${encodeURIComponent(sharePath)}`, { waitUntil: "load" });
    const playedEarly = await sp.waitForFunction(() => window.__ppvReplay && window.__ppvReplay.video.currentTime > 0.2, null, { timeout: 2500 }).then(() => true, () => false);
    const early = await sp.evaluate(() => {
      const app = document.querySelector(".app");
      const v = window.__ppvReplay.video;
      const r = v.getBoundingClientRect();
      return { overlay: app.dataset.overlay, t: v.currentTime, err: v.error && v.error.code, picture: Math.round(r.width) + "x" + Math.round(r.height), screens: [...document.querySelectorAll(".screen")].filter((e) => !e.hidden && getComputedStyle(e).display !== "none").length, canvas: getComputedStyle(document.querySelector(".stage__overlay")).visibility, glance: getComputedStyle(document.querySelector(".glance")).visibility };
    });
    const earlyMs = Date.now() - t0;
    await sp.waitForFunction((want) => document.querySelector(".app").dataset.overlay === want, mode === "slow" ? "on" : "none", { timeout: 15000 }).catch(() => {});
    const late = await sp.evaluate(() => ({ overlay: document.querySelector(".app").dataset.overlay, toggleHidden: document.querySelector(".replay__overlay").hidden, playing: !window.__ppvReplay.video.paused, canvas: getComputedStyle(document.querySelector(".stage__overlay")).visibility }));
    await sp.screenshot({ path: join(out, `${shape}-track-${mode}.png`) });
    const pass = playedEarly && (early.overlay === "pending" || (mode === "fail" && early.overlay === "none")) && early.screens === 0 && early.canvas === "hidden" && early.glance === "hidden" && !early.err && sErr.length === 0
      && (mode === "slow" ? late.overlay === "on" && !late.toggleHidden && late.canvas === "visible" : late.overlay === "none" && late.toggleHidden && late.playing);
    check(`track-${mode}`, pass, { playedEarly, earlyMs, early, late, errors: sErr });
    await sCtx.close();
  }

  // ---------- 3. replay page at the camera's viewport ----------
  const { defaultBrowserType: _p, ...playDesc } = camDev;
  const rpCtx = await play.newContext(playDesc);
  const rp = await rpCtx.newPage();
  const errors = [];
  rp.on("pageerror", (e) => errors.push(String(e.message)));
  await rp.goto(`${app.origin}/vision/replay.html?clip=${encodeURIComponent(sharePath)}&autoplay=0`, { waitUntil: "load" });
  await rp.evaluate(() => document.fonts.ready);
  await rp.waitForFunction(() => window.__ppvReplay && window.__ppvReplay.track && window.__ppvReplay.video.readyState >= 2, null, { timeout: 20000 });
  // the picture on screen, its fingerprint, and the overlay frame drawn with it
  await rp.evaluate(() => {
    const fc = document.createElement("canvas");
    fc.width = 24; fc.height = 24;
    const fx = fc.getContext("2d", { willReadFrequently: true });
    window.__qaRead = () => {
      fx.drawImage(window.__ppvReplay.video, 0, 0, 24, 24);
      const d = fx.getImageData(0, 0, 24, 24).data;
      const fp = [];
      for (let i = 0; i < d.length; i += 4) fp.push(Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]));
      const v = window.__ppvReplay.video;
      const bc = window.__qaBar || (window.__qaBar = Object.assign(document.createElement("canvas"), { width: 192, height: 16 }));
      const bx = bc.getContext("2d", { willReadFrequently: true });
      const sx = v.videoWidth / 960;
      bx.drawImage(v, 0, 0, 192 * sx, 16 * sx, 0, 0, 192, 16);
      const bd = bx.getImageData(0, 0, 192, 16).data;
      let shown = 0;
      for (let b = 0; b < 12; b++) { const i = (8 * 192 + b * 16 + 8) * 4; if (bd[i] + bd[i + 1] + bd[i + 2] > 384) shown |= 1 << b; }
      const app = document.querySelector(".app");
      const rv = window.__ppvReplay.video, rr = rv.getBoundingClientRect(), fit = getComputedStyle(rv).objectFit, kk = (fit === "cover" ? Math.max : Math.min)(rr.width / rv.videoWidth, rr.height / rv.videoHeight);
      const pic = { left: rr.left + (rr.width - rv.videoWidth * kk) / 2, top: rr.top + (rr.height - rv.videoHeight * kk) / 2, k: kk, vw: rv.videoWidth };
      return { shown, frameT: Number(app.dataset.frameT), mediaT: Number(app.dataset.mediaT), tags: document.querySelector(".stage__overlay").dataset.tags || "", fp, panels: app.dataset.panels, overlay: app.dataset.overlay, pic };
    };
    window.__qaSeek = async (sec) => {
      const v = window.__ppvReplay.video;
      v.pause();
      await new Promise((res) => { v.addEventListener("seeked", res, { once: true }); v.currentTime = sec; });
      await new Promise((res) => { const to = setTimeout(res, 400); v.requestVideoFrameCallback?.(() => { clearTimeout(to); res(); }); });
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      return window.__qaRead();
    };
  });
  const idxOfT = (t) => camFrames.findIndex((f) => f.t === t);
  // which recorded picture is on screen: the camera fingerprint nearest the shown one; pictures that
  // repeat (the camera handed the same picture twice) all count as that picture
  // the picture on screen is read from its stamp; in sync = the drawn overlay frame is that picture
  // (exact) or its neighbour (within one frame)
  const judge = (r) => {
    const i = idxOfT(r.frameT);
    return { frameIdx: i, shownIdx: r.shown, off: i - r.shown, exact: i === r.shown, ok: i >= 0 && Math.abs(i - r.shown) <= 1 };
  };
  const seekRows = [];
  const tagRows = [];
  const tagVideo = [];
  const step = Math.max(1, Math.floor(camFrames.length / 12));
  for (let k = 2; k < camFrames.length - 1; k += step) {
    for (const off of [0, 12]) {
      const r = await rp.evaluate((s) => window.__qaSeek(s), (camFrames[k].t + off) / 1000);
      const j = judge(r);
      seekRows.push({ k, off, ...j, frameT: r.frameT, mediaT: r.mediaT });
      if (off === 0 && camFrames[k].tags.includes(":")) {
        const a = tagsOf(camFrames[j.frameIdx >= 0 ? j.frameIdx : k].tags), b = tagsOf(r.tags);
        for (const side of Object.keys(a)) {
          if (!b[side]) { tagRows.push({ k, side, missing: true }); continue; }
          const cf = camFrames[j.frameIdx >= 0 ? j.frameIdx : k], cp = cf.pic, rp2 = r.pic;
          // same: both screens show the picture in the same box, so the tag can be compared in screen px
          const same = !!(cp && rp2 && Math.abs(cp.k - rp2.k) < 0.002 && Math.abs(cp.left - rp2.left) < 1 && Math.abs(cp.top - rp2.top) < 1);
          tagRows.push({ k, side, dx: b[side].x - a[side].x, dy: b[side].y - a[side].y, same });
          // the tag's anchor in the recorded video's own pixels, from each screen's picture box
          if (cp && rp2) { const vx = (p, q) => ({ x: (q.x - p.left) / p.k, y: (q.y - p.top) / p.k }); const ca0 = vx(cp, a[side]), ra = vx(rp2, b[side]), sc = rp2.vw / cp.vw, ca = { x: ca0.x * sc, y: ca0.y * sc }; tagVideo.push({ k, side, compact: !!cf.compact, dx: ra.x - ca.x, dy: ra.y - ca.y, scale: Math.min(cp.k, rp2.k) }); }
        }
      }
    }
  }
  // in-replay only: for each seek row, the name tag drawn by the replay against the head of the same track
  // frame, both in video px (tag centre x - head x, tag bottom - head top); a clip recorded while stable
  // mode shrank the camera picture must give the same numbers as one recorded at full size
  const tagHead = [];
  for (const row of seekRows.filter((x) => x.off === 0 && x.exact)) {
    const r = await rp.evaluate(async (sec) => {
      const o = await window.__qaSeek(sec);
      const rp = window.__ppvReplay, v = rp.video, b = v.getBoundingClientRect(), kk = (getComputedStyle(v).objectFit === "cover" ? Math.max : Math.min)(b.width / v.videoWidth, b.height / v.videoHeight), pic = v.videoWidth ? { left: b.left + (b.width - v.videoWidth * kk) / 2, top: b.top + (b.height - v.videoHeight * kk) / 2, k: kk } : null, st = rp.track.stateAt(o.frameT);
      if (!pic || !st || !st.players) return null;
      const vw = rp.track.meta.source.width, vh = rp.track.meta.source.height, out = {};
      for (const side of ["near", "far"]) {
        const lm = st.players[side] && st.players[side].landmarks;
        const m = (o.tags || "").split("|").find((x) => x.startsWith(side + ":"));
        if (!lm || !m) continue;
        const face = lm.slice(0, 11).filter((p) => p && (p.visibility == null || p.visibility > 0.5));
        if (!face.length) continue;
        const px = (p) => (p.x <= 1.5 ? p.x * vw : p.x), py = (p) => (p.y <= 1.5 ? p.y * vh : p.y);
        const hx = face.reduce((a, p) => a + px(p), 0) / face.length, hy = Math.min(...face.map(py));
        const [x, y, w, h] = m.split(":")[1].split(",").map(Number);
        out[side] = { dx: (x + w / 2 - pic.left) / pic.k - hx, dy: (y + h - pic.top) / pic.k - hy };
      }
      return out;
    }, row.mediaT ?? row.frameT / 1000).catch(() => null);
    if (r) for (const [side, v] of Object.entries(r)) tagHead.push({ side, ...v });
  }
  const med = (a) => (a.length ? a.slice().sort((p, q) => p - q)[a.length >> 1] : null);
  console.log(`TAGHEAD ${JSON.stringify({ stable: args.stable || "off", rows: tagHead.length, dxMedian: med(tagHead.map((t) => Math.round(t.dx))), dxMaxAbs: tagHead.length ? Math.round(Math.max(...tagHead.map((t) => Math.abs(t.dx)))) : null, dyMedian: med(tagHead.map((t) => Math.round(t.dy))), dySpread: tagHead.length ? Math.round(Math.max(...tagHead.map((t) => t.dy)) - Math.min(...tagHead.map((t) => t.dy))) : null })}`);
  if (stampOn) check("d-seek-sync", seekRows.length && seekRows.every((r) => r.ok), { rows: seekRows.length, exact: seekRows.filter((r) => r.exact).length, bad: seekRows.filter((r) => !r.ok) });
  // screen px only where both screens put the picture in the same box: a phone replay has no control-bar
  // column, so its picture is bigger than the camera's and only b-tag-video (video px) can compare
  const sameRows = tagRows.filter((r) => !r.missing && r.same);
  const worst = Math.max(...sameRows.map((r) => Math.max(Math.abs(r.dx), Math.abs(r.dy))));
  const vWorst = Math.max(0, ...tagVideo.map((r) => Math.max(Math.abs(r.dx), Math.abs(r.dy))));
  // on the video's own pixels the allowance is 4 screen px of the smaller of the two pictures
  const vLimit = tagVideo.length ? 4 / Math.min(...tagVideo.map((r) => r.scale)) : 0;
  check("b-tag-video", tagVideo.length > 0 && vWorst <= vLimit, { compared: tagVideo.length, compactRows: tagVideo.filter((r) => r.compact).length, worstVideoPx: Math.round(vWorst * 10) / 10, limitVideoPx: Math.round(vLimit * 10) / 10 });
  if (args.stable !== "auto") {
    if (sameRows.length) check("b-tag-position", !tagRows.some((r) => r.missing) && worst <= 4, { compared: sameRows.length, worstPx: worst, missing: tagRows.filter((r) => r.missing).length });
    else console.log(`SKIP b-tag-position ${JSON.stringify({ why: "the replay picture box differs from the camera's; b-tag-video compares in video px", rows: tagRows.length })}`);
  }

  // playing: every picture presented, the overlay drawn with it; one pass from the start to the end
  // every wait is bounded and named, so a stuck engine fails the run with the step instead of hanging it
  const playPass = (pass) => rp.evaluate(async (pass) => {
    const v = window.__ppvReplay.video;
    // a step gets 8 s; playing to the end gets the clip's own length plus 3 s (a clip with the whole pre-roll runs past 8 s)
    const within = (name, p, ms = 8000) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`stuck: play pass ${pass} ${name} (t=${v.currentTime.toFixed(2)} ended=${v.ended} paused=${v.paused} dur=${(v.duration || 0).toFixed(2)})`)), ms))]);
    const rows = [];
    const sought = new Promise((r) => v.addEventListener("seeked", r, { once: true }));
    v.currentTime = 0;
    await within("seeked to 0", sought);
    await within("ended", new Promise((res) => {
      // with each sample: the element's currentTime and the presented picture's mediaTime (rVFC metadata)
      const each = (now, md) => { const row = window.__qaRead(); rows.push({ ...row, ct: Math.round(v.currentTime * 1000), mt: md ? Math.round(md.mediaTime * 1000) : null }); if (!v.paused && !v.ended) v.requestVideoFrameCallback(each); else res(); };
      v.requestVideoFrameCallback(each);
      v.addEventListener("ended", () => setTimeout(res, 200), { once: true });
      v.play();
    }), Math.max(8000, (Number.isFinite(v.duration) ? v.duration : 0) * 1000 + 3000));
    return rows;
  }, pass);
  // a rally clip can be about a second long: its first pass alone must stay in sync to the end
  const withTimes = (rows) => rows.map((r) => ({ ...judge(r), ct: r.ct, mt: r.mt }));
  const firstPass = withTimes(await playPass(1));
  const firstBad = firstPass.filter((j) => !j.ok);
  const lastIdx = camFrames.length - 1;
  if (stampOn) check("d-short-clip-to-end", firstPass.length > 0 && firstBad.length === 0 && Math.max(...firstPass.map((j) => j.frameIdx)) >= lastIdx - 1, { clipMs: camFrames.at(-1)?.t, frames: firstPass.length, bad: firstBad.length, reachedIdx: Math.max(...firstPass.map((j) => j.frameIdx)), lastIdx, sample: firstBad.slice(0, 5) });
  // the play-sync judgement needs more than 10 drawn frames: the same clip is played again until it has them
  const playJudged = [...firstPass];
  let passes = 1;
  while (playJudged.length <= 10 && passes < 6) { passes++; playJudged.push(...withTimes(await playPass(passes))); }
  const playBad = playJudged.filter((j) => !j.ok);
  if (stampOn) check("d-play-sync", playJudged.length > 10 && playBad.length === 0, { frames: playJudged.length, passes, exact: playJudged.filter((j) => j.exact).length, bad: playBad.length, sample: playBad.slice(0, 5) });
  const endRow = await rp.evaluate(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return { ...window.__qaRead(), ended: window.__ppvReplay.video.ended }; });
  const endJ = judge(endRow);
  if (stampOn) check("d-end-freeze", endRow.ended && endJ.ok, { ...endJ, frameT: endRow.frameT, lastT: camFrames.at(-1)?.t });
  // pause mid-clip after playing
  const pauseRow = await rp.evaluate(async () => {
    const v = window.__ppvReplay.video;
    v.currentTime = 0;
    await new Promise((r) => v.addEventListener("seeked", r, { once: true }));
    await v.play();
    await new Promise((r) => setTimeout(r, 700));
    // what the viewer sees in the first 500 ms after the pause: the picture's number on every animation
    // frame (a jump is a picture other than the one paused on) and whether the picture went blank
    const before = window.__qaRead();
    const settled = new Promise((r) => v.addEventListener("seeked", r, { once: true }));
    v.pause();
    const t0 = performance.now(), samples = [];
    while (performance.now() - t0 < 500) {
      const s = window.__qaRead();
      samples.push({ ms: Math.round(performance.now() - t0), shown: s.shown, lum: Math.round(s.fp.reduce((a, b) => a + b, 0) / s.fp.length), ready: v.readyState });
      await new Promise((r) => requestAnimationFrame(r));
    }
    // the player may seek to currentTime on pause; read once that seek has settled (bounded)
    await Promise.race([settled, new Promise((r) => setTimeout(r, 3000))]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { ...window.__qaRead(), before: before.shown, samples };
  });
  const pauseJ = judge(pauseRow);
  if (stampOn) check("d-pause-sync", pauseJ.ok, { ...pauseJ, frameT: pauseRow.frameT });
  const jumps = pauseRow.samples.map((s) => Math.abs(s.shown - pauseRow.before));
  console.log(`PAUSEVIEW ${JSON.stringify({ before: pauseRow.before, final: pauseRow.shown, jumpMax: Math.max(0, ...jumps, Math.abs(pauseRow.shown - pauseRow.before)), blanks: pauseRow.samples.filter((s) => s.lum < 8 || s.ready < 2).length, samples: pauseRow.samples.length, shownSeq: pauseRow.samples.map((s) => s.shown).join(",") })}`);

  // the same moment as the camera capture, side by side
  if (camShot && camShot.t0 != null) {
    await rp.evaluate((s) => window.__qaSeek(s), camShot.t0 / 1000);
    await rp.screenshot({ path: join(out, `${shape}-replay-same-moment.png`) });
  }
  // fold, open, overlay off / on
  const tapIt = async (loc) => (playDesc.hasTouch ? loc.tap() : loc.click());
  const st0 = await rp.evaluate(() => window.__qaRead());
  await rp.screenshot({ path: join(out, `${shape}-replay-open.png`) });
  await tapIt(rp.locator(".dock"));
  const st1 = await rp.evaluate(() => ({ ...window.__qaRead(), bottomHidden: document.querySelector(".bottom").hidden }));
  await rp.screenshot({ path: join(out, `${shape}-replay-folded.png`) });
  await tapIt(rp.locator(".dock"));
  const st2 = await rp.evaluate(() => ({ ...window.__qaRead(), bottomHidden: document.querySelector(".bottom").hidden }));
  check("c-fold", st0.panels === "open" && st1.panels === "closed" && st1.bottomHidden && st2.panels === "open" && !st2.bottomHidden, { start: st0.panels, folded: st1.panels, again: st2.panels });
  await tapIt(rp.locator(".replay__overlay"));
  const off = await rp.evaluate(() => ({ ...window.__qaRead(), canvas: getComputedStyle(document.querySelector(".stage__overlay")).visibility, glance: getComputedStyle(document.querySelector(".glance")).visibility }));
  await rp.screenshot({ path: join(out, `${shape}-replay-overlay-off.png`) });
  // the ink counter's own control: the same count on the replay screen with the overlay drawn
  for (const name of ["replay-open", "replay-overlay-off"]) {
    const png = join(out, `${shape}-${name}.png`);
    const vw = playDesc.viewport.width, vh = playDesc.viewport.height;
    const buf = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", png, "-vf", `scale=${vw}:${vh}:flags=neighbor`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout;
    report.saved[`ink-${name}`] = ink(buf, vw, vh);
  }
  await tapIt(rp.locator(".replay__overlay"));
  const on = await rp.evaluate(() => getComputedStyle(document.querySelector(".stage__overlay")).visibility);
  check("overlay-switch", off.overlay === "off" && off.canvas === "hidden" && off.glance === "hidden" && on === "visible", { off: [off.overlay, off.canvas, off.glance], on });
  // buttons, chips and bars of the camera never show in the replay
  const shown = await rp.evaluate(() => [...document.querySelectorAll(".app button, .app .chip")].filter((b) => { const r = b.getBoundingClientRect(); return r.width && getComputedStyle(b).visibility === "visible" && !b.closest("[hidden]"); }).map((b) => b.className));
  check("replay-only-own-buttons", shown.every((c) => /dock|replay__chip/.test(c)), shown);
  check("replay-no-page-errors", errors.length === 0, errors);
  await rpCtx.close();

  // ---------- 4. the spectator's full-screen player ----------
  const state = await app.api("/api/state");
  const m = state.derived.matches.find((x) => x.id === app.matchId);
  // the camera was linked, so its scored point may already carry the new clip; the seeded clips have no track
  // the old clip: one with no overlay track on the PC (the seeded clips); the camera's own points carry tracks
  const noTrack = [];
  for (const [k, u] of Object.entries(m.clips)) if ((await fetch(`${app.origin}${u}/overlay`, { method: "HEAD" })).status === 404) noTrack.push(Number(k));
  const oldIndex = Math.max(...noTrack);
  let newIndex = Number(Object.entries(m.clips).find(([, u]) => u === sharePath)?.[0] ?? NaN);
  if (!Number.isInteger(newIndex)) {
    newIndex = [...m.points.keys()].reverse().find((i) => !m.clips[i]);
    await app.api("/api/action", { type: "clip", matchId: app.matchId, index: newIndex, url: sharePath }, { "x-pin": app.pin });
  }
  report.clipIndex = { oldIndex, newIndex };
  report.player = {};

  // frame callbacks blocked on purpose while the picture plays (half speed, so the clip lasts): the
  // overlay must keep following from currentTime, then go back to callbacks once they are let through
  const STALL_PROBE = async ({ videoSel, markSel }) => {
    const v = document.querySelector(videoSel), mark = document.querySelector(markSel);
    const proto = HTMLVideoElement.prototype, real = proto.requestVideoFrameCallback;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // a rally clip can be about a second long: loop it so the picture is still playing when callbacks come back
  const loop0 = v.loop; v.loop = true; v.playbackRate = 0.5; v.currentTime = 0;
    await Promise.race([v.play().catch(() => {}), wait(2000)]);
    proto.requestVideoFrameCallback = function () { return 0; };
    await wait(900);
    const seen = new Set(); let clock = null;
    for (let i = 0; i < 12; i++) { seen.add(mark.dataset.frameT ?? mark.getAttribute("data-frame-t")); clock = mark.dataset.clock ?? mark.getAttribute("data-clock"); await wait(100); }
    const advanced = v.currentTime;
    proto.requestVideoFrameCallback = real;
    // wait for the switch back to frame callbacks itself (not a fixed time), up to 5 s, and keep how long it took
    const t0 = performance.now();
    let back = mark.dataset.clock ?? mark.getAttribute("data-clock");
    while (back !== "frames" && performance.now() - t0 < 5000) { await wait(50); back = mark.dataset.clock ?? mark.getAttribute("data-clock"); }
    const backMs = back === "frames" ? Math.round(performance.now() - t0) : null;
    v.playbackRate = 1; v.loop = loop0;
    return { framesWhileBlocked: seen.size, clockWhileBlocked: clock, clockAfter: back, backMs, videoAt: +advanced.toFixed(2), playing: !v.paused };
  };
  
  for (const dev of (args.devices || "phone,tv").split(",")) {
    const { defaultBrowserType: _t, ...desc } = DEVICES[dev];
    const ctx = await play.newContext(desc);
    await ctx.addInitScript(() => { sessionStorage.setItem("pp-started", "1"); localStorage.setItem("pp-role", "viewer"); localStorage.setItem("pp-sound", "0"); });
    const page = await ctx.newPage();
    const perr = [];
    page.on("pageerror", (e) => perr.push(String(e.message)));
    await page.goto(app.origin + "/");
    await page.waitForSelector(".pscore, .tv-score");
    await page.evaluate(() => document.fonts.ready);
    // a list re-render (a new clip action) can detach the row under a scroll; take the fresh one
    const scrollTo = async (loc) => {
      for (let i = 0; ; i++) {
        try { return await loc.scrollIntoViewIfNeeded({ timeout: 3000 }); }
        catch (err) { if (i >= 3 || !/not attached/.test(err.message)) throw err; }
      }
    };
    const press = async (sel) => { const b = page.locator(sel).first(); await scrollTo(b); await (desc.hasTouch ? b.tap() : b.click()); };
    await press(`[data-act="clip-play"][data-index="${newIndex}"]`);
    await page.waitForSelector(".replay-full__frame", { timeout: 10000 });
    const frame = await (await page.$(".replay-full__frame")).contentFrame();
    await frame.waitForFunction(() => window.__ppvReplay && window.__ppvReplay.track && window.__ppvReplay.video.readyState >= 2, null, { timeout: 20000 });
    await frame.evaluate(() => document.fonts.ready);
    const playing = await frame.evaluate(async () => { const v = window.__ppvReplay.video; const t = v.currentTime; await new Promise((r) => setTimeout(r, 600)); return v.currentTime > t; });
    const stallFull = await frame.evaluate(`(${STALL_PROBE})({ videoSel: "video", markSel: ".app" })`);
    report.player[`${dev}-stall`] = stallFull;
    check(`callback-stall-full-${dev}`, stallFull.framesWhileBlocked >= 4 && stallFull.clockWhileBlocked === "time" && stallFull.clockAfter === "frames", stallFull);
    // every wait inside the player is bounded and named, so a stuck engine fails the run instead of hanging it
    const within = (name) => `(p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("stuck: ${name}")), 8000))])`;
    await frame.evaluate(async (w) => { const within = eval(w); const v = window.__ppvReplay.video; v.pause(); await within(new Promise((r) => { v.addEventListener("seeked", r, { once: true }); v.currentTime = Math.min(v.duration - 0.05, 1.0); })); await new Promise((r) => setTimeout(r, 200)); }, within(`${dev} seek to 1 s`));
    await page.screenshot({ path: join(out, `${shape}-player-${dev}-open.png`) });
    await (desc.hasTouch ? frame.locator(".dock").tap() : frame.locator(".dock").click());
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(out, `${shape}-player-${dev}-folded.png`) });
    const folded = await frame.evaluate(() => document.querySelector(".app").dataset.panels);
    await (desc.hasTouch ? frame.locator(".dock").tap() : frame.locator(".dock").click());
    // ends: 다시 보기 shows (the replay page's own, embedded), and plays it again from a second before the serve
    await frame.evaluate(async (w) => { const within = eval(w); const v = window.__ppvReplay.video; v.currentTime = Math.max(0, v.duration - 0.3); await within(v.play()); await within(new Promise((r) => v.addEventListener("ended", r, { once: true }))); }, within(`${dev} play to the end`));
    await frame.waitForSelector(".replay__again:not([hidden])", { timeout: 5000 });
    await (desc.hasTouch ? frame.locator(".replay__again").tap() : frame.locator(".replay__again").click());
    const replayed = await frame.evaluate(async () => { await new Promise((r) => setTimeout(r, 400)); const rp = window.__ppvReplay, v = rp.video; return !v.paused && v.currentTime >= rp.startMs / 1000 && v.currentTime < rp.startMs / 1000 + 1; });
    await (desc.hasTouch ? frame.locator(".replay__close").tap() : frame.locator(".replay__close").click());
    await page.waitForFunction(() => !document.querySelector(".replay-full"), null, { timeout: 5000 }).catch(() => {});
    const closed = await page.evaluate(() => !document.querySelector(".replay-full"));
    // the small clip box (the picked rally stays in it): overlay canvas on the video, drawn from the track
    const readSlot = () => page.evaluate(async () => {
      const v = document.querySelector("video[data-clip-video]");
      const c = document.querySelector("[data-clip-hud]");
      if (!v || !c) return { missing: true };
      // WebKit can leave a play() promise pending for good; do not wait on it past 2 s
      if (v.paused) await Promise.race([v.play().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
      // moving = the overlay followed while the picture itself advanced; a software-rendered WebKit can
      // take over a second to show the first frames after play(), so wait (up to 4 s) for the picture
      const t0 = c.dataset.frameT, v0 = v.currentTime;
      for (let i = 0; i < 20 && !(v.currentTime > v0 + 0.3 && c.dataset.frameT !== t0); i++) await new Promise((r) => setTimeout(r, 200));
      const vr = v.getBoundingClientRect(), cr = c.getBoundingClientRect();
      let ink = 0;
      if (c.width && !c.hidden) { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) ink++; }
      return { src: v.getAttribute("src").split("/").slice(-2, -1)[0].slice(0, 6), hidden: c.hidden, ink, moving: c.dataset.frameT !== t0, videoAdvanced: +(v.currentTime - v0).toFixed(2), off: [cr.x - vr.x, cr.y - vr.y, cr.width - vr.width, cr.height - vr.height].map((n) => Math.round(n)), same: !!(v.__qa && c.__qa) };
    });
    await page.evaluate(() => document.querySelector("video[data-clip-video]")?.scrollIntoView({ block: "center" }));
    const slot = await readSlot();
    await page.screenshot({ path: join(out, `${shape}-slot-${dev}.png`) });
    await page.evaluate(() => { const v = document.querySelector("video[data-clip-video]"); const c = document.querySelector("[data-clip-hud]"); if (v) v.__qa = 1; if (c) c.__qa = 1; });
    // a state push re-renders the screen (the same clip attached again bumps the revision)
    const rev0 = (await app.api("/api/state")).rev;
    await app.api("/api/action", { type: "clip", matchId: app.matchId, index: newIndex, url: sharePath }, { "x-pin": app.pin });
    await page.waitForFunction((r) => window.__ppRev === undefined || window.__ppRev > r, rev0, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(600);
    const after = await readSlot();
    const rev1 = (await app.api("/api/state")).rev;
    report.player[`${dev}-slot`] = { slot, after, rev: [rev0, rev1] };
    const stallSlot = await page.evaluate(`(${STALL_PROBE})({ videoSel: "video[data-clip-video]", markSel: "[data-clip-hud]" })`);
    report.player[`${dev}-slot-stall`] = stallSlot;
    check(`callback-stall-slot-${dev}`, stallSlot.framesWhileBlocked >= 4 && stallSlot.clockWhileBlocked === "time" && stallSlot.clockAfter === "frames", stallSlot);
    check(`slot-${dev}`, !slot.missing && !slot.hidden && slot.ink > 50 && slot.moving && slot.off.every((n) => Math.abs(n) <= 1) && after.same && after.moving && !after.hidden && rev1 > rev0, report.player[`${dev}-slot`]);
    // the rally list folds (tournament #17): closed, the small box keeps drawing; 전체 n개 보기, an older
    // rally's clip opens the overlay player too
    const foldBtn = page.locator('[data-act="fold"][data-key="rallies"]').first();
    let fold = { skipped: true };
    if (await foldBtn.count()) {
      await scrollTo(foldBtn); await (desc.hasTouch ? foldBtn.tap() : foldBtn.click());
      const closedList = await page.evaluate(() => document.querySelectorAll('[data-act="clip-play"]').length);
      const slotClosed = await readSlot();
      await page.screenshot({ path: join(out, `${shape}-slot-${dev}-list-closed.png`) });
      await (desc.hasTouch ? page.locator('[data-act="fold"][data-key="rallies"]').first().tap() : page.locator('[data-act="fold"][data-key="rallies"]').first().click());
      await app.api("/api/action", { type: "clip", matchId: app.matchId, index: 10, url: sharePath }, { "x-pin": app.pin });
      await page.waitForTimeout(800);
      const before = await page.evaluate(() => !!document.querySelector('[data-act="clip-play"][data-index="10"]'));
      const all = page.locator('[data-act="fold-all"][data-key="rallies"]').first();
      if (await all.count()) { await scrollTo(all); await (desc.hasTouch ? all.tap() : all.click()); }
      await press('[data-act="clip-play"][data-index="10"]');
      const opened = await page.waitForSelector(".replay-full__frame", { timeout: 10000 }).then(() => true, () => false);
      await page.screenshot({ path: join(out, `${shape}-player-${dev}-from-all-list.png`) });
      // embedded, the close button is the replay page's own (✕ 닫기 in its top row)
      if (opened) {
        const fr2 = await (await page.$(".replay-full__frame")).contentFrame();
        const shut = fr2.locator(".replay__close");
        await shut.waitFor({ timeout: 10000 });
        await (desc.hasTouch ? shut.tap() : shut.click());
        await page.waitForFunction(() => !document.querySelector(".replay-full"), null, { timeout: 5000 });
      }
      fold = { closedListButtons: closedList, slotClosed, hiddenBeforeAll: !before, opened };
      check(`fold-list-${dev}`, closedList === 0 && !slotClosed.hidden && slotClosed.ink > 50 && slotClosed.moving && !before && opened, fold);
    }
    report.player[`${dev}-fold`] = fold;
    // (e) the old clip: a plain video, no replay page (fresh page, so the rows do not move under the tap)
    await page.reload();
    await page.waitForSelector(".pscore, .tv-score");
    await press(`[data-act="clip-play"][data-index="${oldIndex}"]`);
    const picked = await page.evaluate(() => document.querySelector('[data-act="clip-play"][aria-pressed="true"]')?.dataset.index);
    await page.waitForSelector(".replay-full video", { timeout: 10000 }).catch(async (err) => {
      const dom = await page.evaluate(() => ({ full: document.querySelector(".replay-full")?.outerHTML.slice(0, 600) || null, hist: history.state, btn: document.querySelectorAll('[data-act="clip-play"]').length }));
      throw new Error(`${err.message.split("\n")[0]} ${JSON.stringify(dom)}`);
    });
    const old = await page.evaluate(async () => {
      const v = document.querySelector(".replay-full video");
      if (v.readyState < 2) await new Promise((r) => { v.addEventListener("loadeddata", r, { once: true }); setTimeout(r, 5000); });
      const t = v.currentTime;
      await new Promise((r) => setTimeout(r, 600));
      return { frame: !!document.querySelector(".replay-full__frame"), err: v.error && v.error.code, advanced: v.currentTime > t, w: v.videoWidth };
    });
    old.picked = picked;
    await page.screenshot({ path: join(out, `${shape}-player-${dev}-old-clip.png`) });
    await page.goBack();
    const closedByBack = await page.evaluate(() => !document.querySelector(".replay-full"));
    const oldSlot = await readSlot();
    check(`e-old-clip-slot-${dev}`, !oldSlot.missing && oldSlot.hidden && oldSlot.ink === 0, oldSlot);
    report.player[dev] = { playing, folded, replayed, closed, old, closedByBack, errors: perr };
    check(`player-${dev}`, playing && folded === "closed" && replayed && closed && closedByBack && perr.length === 0, report.player[dev]);
    check(`e-old-clip-${dev}`, !old.frame && !old.err && old.advanced && old.w > 0, old);
    await ctx.close();
  }
} catch (err) {
  report.error = String(err.stack || err);
  console.log(`ERROR ${report.error}`);
} finally {
  await rec.close();
  if (play !== rec) await play.close();
  await app.stop();
}
writeFileSync(join(out, `${shape}-report.json`), JSON.stringify(report, null, 2));
const fails = Object.entries(report.checks).filter(([, c]) => !c.pass).map(([k]) => k);
console.log(`REPLAY_DATA_DONE ${shape} fails=${report.error ? "error" : fails.join(",") || "none"}`);
