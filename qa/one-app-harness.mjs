import { createServer } from "node:net";
// Both real apps behind one origin, as on the Funnel host (tournament at "/", camera at "/vision/"),
// with isolated data and a seeded tournament: a finished one in the archive, then a live one where
// blue took game 1 and game 2 stands at 7:5, the last point carrying a real clip. reset() puts the
// tournament data back to that seed (restart on a copy), so a test that pressed a writing button
// starts the next press from the same state. Used by qa/every-button.mjs and qa/back-nav.mjs.
import { devices } from "playwright";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCodes } from "./player-names.mjs";
import { assertPortsFree } from "./ports.mjs";
import { tx } from "./qa-lang.mjs";

const up = async (port, path) => {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}${path}`)).status < 500) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`server ${port} did not start`);
};


// ascii: the seeded tournaments and players get Latin names, so an English-mode census can count every
// Hangul character on screen as an untranslated string (qa/i18n-census.mjs).
// files: more test clips served the same way, { "/__qa/shaky.webm": "<path>" }.
export async function startOneApp({ vision, tournament, clip, port = 8960, ascii = false, files = {} }) {
  const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ppv-oneapp-"));
  const ports = { proxy: port, tour: port + 1, vision: port + 2 };
  await assertPortsFree(ports);
  const tourDir = join(tmp, "tour");
  const seedDir = join(tmp, "tour-seed");
  const startTour = () => spawn("bun", [join(tournament, "server.js")], { cwd: tournament, env: { ...process.env, PORT: String(ports.tour), DATA_DIR: tourDir, PPV_SAVE_DIR: join(tmp, "saves") }, stdio: ["ignore", "ignore", "inherit"] });
  let tour = startTour();
  const startVision = () => spawn("bun", [join(vision, "server.js")], { cwd: vision, env: { ...process.env, PORT: String(ports.vision), PPV_SAVE_DIR: join(tmp, "saves"), PPV_TOURNAMENT_URL: `http://127.0.0.1:${ports.tour}`, PPV_TOURNAMENT_DATA: join(tourDir, "tournament.json"), PPV_KEY_FILE: join(tmp, "upload-key"), PPV_SETUP_FILE: join(tmp, "setup.json") }, stdio: ["ignore", "ignore", "inherit"] });
  let vis = startVision();
  await Promise.all([up(ports.tour, "/api/state"), up(ports.vision, "/healthz")]);

  const target = (path) => (path === "/vision" || path.startsWith("/vision/") ? ports.vision : ports.tour);
  const sockets = new Set();
  const proxy = Bun.serve({
    port: ports.proxy,
    hostname: "127.0.0.1",
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/__qa/cam.webm") return new Response(Bun.file(clip), { headers: { "content-type": "video/webm" } });
      if (files[url.pathname]) return new Response(Bun.file(files[url.pathname]), { headers: { "content-type": "video/webm" } });
      if (req.headers.get("upgrade") === "websocket") return server.upgrade(req, { data: { path: url.pathname + url.search } }) ? undefined : new Response("no", { status: 400 });
      const headers = new Headers(req.headers);
      headers.delete("host");
      headers.delete("accept-encoding");
      try {
        const res = await fetch(`http://127.0.0.1:${target(url.pathname)}${url.pathname}${url.search}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(), redirect: "manual" });
        return new Response(res.body, { status: res.status, headers: res.headers });
      } catch {
        return new Response("upstream restarting", { status: 503 });
      }
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        const back = new WebSocket(`ws://127.0.0.1:${ports.tour}${ws.data.path}`);
        ws.data.back = back;
        ws.data.queue = [];
        back.onopen = () => ws.data.queue.splice(0).forEach((m) => back.send(m));
        back.onmessage = (e) => ws.send(e.data);
        back.onclose = () => ws.close();
      },
      message(ws, m) { ws.data.back.readyState === 1 ? ws.data.back.send(m) : ws.data.queue.push(m); },
      close(ws) { sockets.delete(ws); ws.data.back?.close(); },
    },
  });
  const origin = `http://127.0.0.1:${ports.proxy}`;
  const api = async (path, body, headers = {}) => {
    const res = await fetch(origin + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...headers }, body: body && JSON.stringify(body) });
    return res.json();
  };

  const first = await api("/api/tournament", { name: ascii ? "Last Cup" : "지난 대회", players: await withCodes(origin, ascii ? ["Ann", "Ben", "Cal", "Dee"] : ["가", "나", "다", "라"]), format: "double", bestOf: 3 });
  const created = await api("/api/tournament", { name: ascii ? "Club Test" : "탁구장 시험", players: await withCodes(origin, ascii ? ["Kim Blue", "Park Red", "Third", "Fourth"] : ["김블루", "박레드", "셋째", "넷째"]), format: "double", bestOf: 3 }, { "x-pin": first.pin });
  const pin = created.pin;
  const matchId = created.state.derived.matches.find((m) => m.status === "ready").id;
  const seq = [...Array(11).fill(0).flatMap((_, i) => (i < 7 ? [0, 1] : [0])), ...[0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0]];
  let n = 0;
  for (const side of seq) await api("/api/action", { type: "point", matchId, side, seq: n++ }, { "x-pin": pin });
  const key = readFileSync(join(tmp, "upload-key"), "utf8").trim();
  const form = new FormData();
  form.set("record", JSON.stringify({ id: Date.now(), durationMs: 4200, shots: 5, bounces: [] }));
  form.set("video", new Blob([readFileSync(clip)], { type: "video/webm" }), "rally.webm");
  const uploaded = await (await fetch(`${origin}/vision/api/rallies`, { method: "POST", headers: { "x-ppv-key": key }, body: form })).json();
  await api("/api/action", { type: "clip", matchId, index: n - 1, url: `/vision/${uploaded.share}` }, { "x-pin": pin });
  // a second saved clip earlier in the match, so replay can pick an older rally
  await api("/api/action", { type: "clip", matchId, index: n - 3, url: `/vision/${uploaded.share}` }, { "x-pin": pin });
  const seed = await api("/api/state");
  tour.kill();
  await new Promise((r) => tour.once("exit", r));
  cpSync(tourDir, seedDir, { recursive: true });
  tour = startTour();
  await up(ports.tour, "/api/state");

  async function reset() {
    for (const ws of sockets) ws.close();
    tour.kill();
    await new Promise((r) => tour.once("exit", r));
    rmSync(tourDir, { recursive: true, force: true });
    cpSync(seedDir, tourDir, { recursive: true });
    tour = startTour();
    await up(ports.tour, "/api/state");
  }
  // A deploy while pages stay open: both servers restart from other checkouts on the same data.
  async function swap(next) {
    const exited = (p) => new Promise((r) => (p.exitCode !== null ? r() : p.once("exit", r)));
    tour.kill();
    vis.kill();
    await Promise.all([exited(tour), exited(vis)]);
    tournament = next.tournament;
    vision = next.vision;
    tour = startTour();
    vis = startVision();
    await Promise.all([up(ports.tour, "/api/state"), up(ports.vision, "/healthz")]);
  }
  async function stop() {
    proxy.stop(true);
    tour.kill();
    vis.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
  return { origin, api, pin, key, matchId, seedRev: seed.rev, reset, swap, stop, tmp };
}

export const DEVICES = {
  phone: { ...devices["iPhone 15"], viewport: { width: 393, height: 852 } },
  land: { ...devices["iPhone 15"], viewport: { width: 852, height: 393 } },
  pad: { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tv: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
};

// Test-only: WPE WebKit does not play a MediaStream in a visibility:hidden video (iPhone Safari does),
// so the camera is a canvas stream of the test clip; every stopped track is counted in
// sessionStorage so a test can see the camera was released after the page navigated away.
export function fakeCamera(src) {
  document.addEventListener("DOMContentLoaded", () => {
    const st = document.createElement("style");
    st.textContent = ".stage__video { visibility: visible !important; }";
    document.head.append(st);
  });
  if (typeof MediaStreamTrack === "undefined") return;
  const stopTrack = MediaStreamTrack.prototype.stop;
  MediaStreamTrack.prototype.stop = function () {
    sessionStorage.setItem("__tracksStopped", String(Number(sessionStorage.getItem("__tracksStopped") || 0) + 1));
    return stopTrack.call(this);
  };
  const t = window.MediaDevices ? window.MediaDevices.prototype : navigator.mediaDevices;
  if (!t) return;
  t.getUserMedia = async () => {
    const v = document.createElement("video");
    v.src = src; v.muted = true; v.loop = true; v.playsInline = true;
    v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none";
    document.documentElement.append(v);
    await v.play();
    // the harness can hold the clip (paused, the canvas keeps sending its picture) and start it over later
    window.__qaCamVideo = v;
    // WPE can leave a looped clip stuck at its end (currentTime = duration, not paused, not ended), which
    // freezes the fake camera: rewind 0.2 s before the end, and resume, from where it stopped, a clip whose time stood still
    // over 1 s while playing. The harness's own pauses (people fixing the score) are left alone.
    window.__qaClip = { rewinds: 0, stalls: 0, maxT: 0, newFrames: 0, dur: 0 };
    let lastT = -1, sameSince = performance.now(), stallWait = 1000; // doubles after a restart: a seek slower than the wait must not restart forever
    setInterval(() => {
      const now = performance.now();
      if (v.paused && !v.ended) { sameSince = now; return; }
      if (v.currentTime !== lastT) { lastT = v.currentTime; sameSince = now; if (lastT > 1) stallWait = 1000; }
      const d = v.duration || 0;
      if (d && v.currentTime >= d - 0.2) { window.__qaClip.rewinds++; v.currentTime = 0; }
      else if (v.ended || now - sameSince > stallWait) { stallWait = Math.min(stallWait * 2, 16000); window.__qaClip.stalls++; v.currentTime = v.ended ? 0 : v.currentTime; v.play().catch(() => {}); sameSince = now; }
    }, 100);
    const c = document.createElement("canvas");
    const tall = v.videoHeight > v.videoWidth;
    const [cw, ch] = (window.__qaCamSize || (tall ? "540x960" : "960x540")).split("x").map(Number);
    c.width = cw; c.height = ch;
    const g = c.getContext("2d");
    let drawnT = -1;
    const draw = () => {
      // how far the clip really got, and how many different pictures reached the camera
      if (v.currentTime !== drawnT) {
        drawnT = v.currentTime;
        window.__qaClip.newFrames++;
        window.__qaClip.maxT = Math.max(window.__qaClip.maxT, Math.round(drawnT * 10) / 10);
        window.__qaClip.dur = Math.round((v.duration || 0) * 10) / 10;
      }
      g.drawImage(v, 0, 0, c.width, c.height);
    };
    draw();
    setInterval(draw, 1000 / 30);
    const stream = c.captureStream(30);
    window.__camTracks = stream.getTracks();
    sessionStorage.setItem("__tracksOpened", String(Number(sessionStorage.getItem("__tracksOpened") || 0) + stream.getTracks().length));
    return stream;
  };
}

export const CORNERS = [{ x: 355, y: 634 }, { x: 557, y: 519 }, { x: 1339, y: 535 }, { x: 1486, y: 659 }];

// Camera on, four corner taps, running. holdClip: the fake camera's clip is paused while the corners are set
// (the camera keeps sending that picture), so no rally can start until the caller plays it (playClip).
export async function startCamera(page, { holdClip = false } = {}) {
  await page.getByRole("button", { name: tx(/카메라 시작/, /Start camera/) }).click();
  await page.waitForFunction(() => ["calibrating", "running", "error"].includes(window.__ppv?.state.mode), null, { timeout: 180000 });
  const s = await page.evaluate(() => ({ mode: window.__ppv.state.mode, w: window.__ppv.state.video?.width, h: window.__ppv.state.video?.height }));
  if (s.mode === "error") throw new Error("camera error");
  if (holdClip) await page.evaluate(() => window.__qaCamVideo && window.__qaCamVideo.pause());
  if (s.mode === "calibrating") {
    for (const c of CORNERS) {
      const pt = await page.evaluate(([x, y]) => {
        const v = document.querySelector("video");
        const r = v.getBoundingClientRect();
        const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
        return { x: r.left + (r.width - v.videoWidth * k) / 2 + x * k, y: r.top + (r.height - v.videoHeight * k) / 2 + y * k };
      }, [c.x * (s.w / 1920), c.y * (s.h / 1080)]);
      await page.mouse.click(pt.x, pt.y);
      await page.waitForTimeout(250);
    }
    await page.getByRole("button", { name: tx(/^확인/, /^OK/) }).click();
    await page.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 20000 });
  }
}

// Plays a clip held by startCamera({ holdClip: true }) from its start.
export async function playClip(page) {
  await page.evaluate(() => { const v = window.__qaCamVideo; if (!v) return; v.currentTime = 0; return v.play(); });
}
