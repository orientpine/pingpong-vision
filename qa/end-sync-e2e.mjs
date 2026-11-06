// 끝 색은 사람이 고른다 (docs/multicam.md "End colours: picked by a person on each phone"), on the real apps:
// two Chromium phones (393x852) film the same table from the same place, so phone B's near end is blue like
// phone A's. Phone A calibrates in landscape, phone B in portrait; B starts set to red and the person picks
// blue on its calibration screen with ⇄. Only the rally engine's output is fed (--inject=1, below); the
// relay, collector, end check and scoring are the app's. Steps, each with captures:
//   one-camera            A alone: its chip names where blue and red are; landscape calibration captured
//   pick-at-calibration   B's calibration after the four corners: step "끝 색", ⇄ turns red into blue, 확인
//   merged-at-once        the first two rallies after B joins are merged (no "확인 중", nothing waits);
//                         only A writes points
//   wrong-pick-warns      a person sets B to red in settings by mistake: the shared bounces warn on A (chip
//                         and notice), merging goes on with the picks, B's colour is not changed for it
//   settings-fix          B set back to blue in settings: the warning clears, the next rallies merge
//   swap                  자리 교체 on A: the names trade ends, the end colours and chip stay
//   one-off               B's page closes: A goes back to one camera and still scores alone
// Portrait and landscape captures of the calibration step and the settings sheet, referee 393 and TV.
//   bun qa/end-sync-e2e.mjs --inject=1 --vision=<checkout> --tournament=<checkout> --clip=<webm> [--port=9560] [--out=<dir>]
import { chromium } from "playwright";
import { withCodes } from "./player-names.mjs";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out || "evidence/end-sync";
mkdirSync(out, { recursive: true });
const corners = JSON.parse(args.corners || '[{"x":355,"y":634},{"x":557,"y":519},{"x":1339,"y":535},{"x":1486,"y":659}]');
const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ppv-multicam-"));
const P = Number(args.port || 8960);
const ports = { proxy: P, tour: P + 1, vision: P + 2 };
const delay = { up: Number(args.upMs || 0), down: Number(args.downMs || 0) };
const playS = Number(args.playS || 90);

const procs = [
  spawn("bun", [join(args.tournament, "server.js")], { cwd: args.tournament, env: { ...process.env, PORT: String(ports.tour), DATA_DIR: join(tmp, "tour") }, stdio: ["ignore", "ignore", "inherit"] }),
  spawn("bun", [join(args.vision, "server.js")], {
    cwd: args.vision,
    env: { ...process.env, PORT: String(ports.vision), PPV_SAVE_DIR: join(tmp, "saves"), PPV_TOURNAMENT_URL: `http://127.0.0.1:${ports.tour}`, PPV_TOURNAMENT_DATA: join(tmp, "tour", "tournament.json"), PPV_KEY_FILE: join(tmp, "upload-key"), PPV_SETUP_FILE: join(tmp, "setup.json") },
    stdio: ["ignore", "ignore", "inherit"],
  }),
];
const up = async (port, path) => {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}${path}`)).status < 500) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`server ${port} did not start`);
};
try {
  await Promise.all([up(ports.tour, "/api/state"), up(ports.vision, "/healthz")]);
} catch (err) {
  for (const p of procs) p.kill();
  throw err;
}

// The app opens /ws itself, so the proxy tags a socket by the page's user agent (each phone context
// gets its own suffix) to cut or delay one phone.
const sockets = new Set();
const blocked = {};
const who = (ua) => (/ppv-phone-([AB])/.exec(ua || "") || [])[1] || "screen";
const target = (path) => (path === "/vision" || path.startsWith("/vision/") ? ports.vision : ports.tour);
const clipFor = (name) => (name === "A" && args.clipA ? args.clipA : args.clip);
const proxy = Bun.serve({
  port: ports.proxy,
  hostname: "127.0.0.1",
  async fetch(req, server) {
    const url = new URL(req.url);
    const m = /^\/__qa\/cam-([AB])\.webm$/.exec(url.pathname);
    if (m) return new Response(Bun.file(clipFor(m[1])), { headers: { "content-type": "video/webm" } });
    if (url.pathname === "/__qa/cut") {
      const name = url.searchParams.get("who");
      blocked[name] = Date.now() + Number(url.searchParams.get("ms") || 5000);
      for (const ws of sockets) if (ws.data.who === name) ws.close();
      return new Response("cut");
    }
    if (req.headers.get("upgrade") === "websocket") {
      const tag = who(req.headers.get("user-agent"));
      if (Date.now() < (blocked[tag] || 0)) return new Response("cut", { status: 503 });
      return server.upgrade(req, { data: { path: url.pathname + url.search, who: tag } }) ? undefined : new Response("no", { status: 400 });
    }
    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.delete("accept-encoding");
    const res = await fetch(`http://127.0.0.1:${target(url.pathname)}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      redirect: "manual",
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  },
  websocket: {
    open(ws) {
      sockets.add(ws);
      const back = new WebSocket(`ws://127.0.0.1:${ports.tour}${ws.data.path}`);
      ws.data.back = back;
      ws.data.queue = [];
      back.onopen = () => ws.data.queue.splice(0).forEach((m) => back.send(m));
      back.onmessage = (e) => (delay.down ? setTimeout(() => ws.readyState === 1 && ws.send(e.data), delay.down) : ws.send(e.data));
      back.onclose = () => ws.close();
    },
    message(ws, m) {
      const send = () => (ws.data.back.readyState === 1 ? ws.data.back.send(m) : ws.data.queue.push(m));
      if (delay.up) setTimeout(send, delay.up);
      else send();
    },
    close(ws) {
      sockets.delete(ws);
      ws.data.back?.close();
    },
  },
});
const origin = `http://127.0.0.1:${ports.proxy}`;
const api = async (path, body, headers = {}) => {
  const res = await fetch(origin + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const steps = [];
const report = { args: { ...args, upMs: delay.up, downMs: delay.down }, steps, errors: [] };
const step = async (name, fn, pages = []) => {
  const t0 = Date.now();
  let rec;
  try {
    rec = { name, pass: true, detail: await fn() };
  } catch (err) {
    rec = { name, pass: false, detail: String(err.message || err).split("\n")[0] };
  }
  rec.seconds = Math.round((Date.now() - t0) / 100) / 10;
  steps.push(rec);
  for (const [label, p] of pages) await p.screenshot({ path: `${out}/${String(steps.length).padStart(2, "0")}-${name}-${label}.png` }).catch(() => {});
  console.log(`STEP ${name} ${rec.pass ? "PASS" : "FAIL"} ${rec.seconds}s ${JSON.stringify(rec.detail).slice(0, 600)}`);
  return rec;
};
const waitFor = async (what, fn, ms) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
};

// a canvas stream of the phone's clip, as in qa/one-phone-e2e.mjs
const fakeCamera = ([src, syncClips]) => {
  const target = window.MediaDevices ? window.MediaDevices.prototype : navigator.mediaDevices;
  target.getUserMedia = async () => {
    const v = document.createElement("video");
    window.__qaVideo = v;
    v.src = src;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none";
    document.documentElement.append(v);
    await v.play();
    // WPE can leave a looped clip stuck at its end (currentTime = duration, not paused, not ended), which
    // freezes the fake camera: rewind 0.2 s before the end, and restart a clip whose time stood still
    // over 1 s while playing. The harness's own pauses (people fixing the score) are left alone.
    // a stalled clip resumes from where it stopped (only an ended clip starts again at 0), and the wait
    // doubles after each restart, as in one-phone-e2e (491af44)
    window.__qaClip = { rewinds: 0, stalls: 0 };
    let lastT = -1, sameSince = performance.now(), stallWait = 1000;
    setInterval(() => {
      const now = performance.now();
      if (v.paused && !v.ended) { sameSince = now; return; }
      if (v.currentTime !== lastT) { lastT = v.currentTime; sameSince = now; if (lastT > 1) stallWait = 1000; }
      const d = v.duration || 0;
      if (d && v.currentTime >= d - 0.2) { window.__qaClip.rewinds++; v.currentTime = 0; }
      else if (v.ended || now - sameSince > stallWait) { stallWait = Math.min(stallWait * 2, 16000); window.__qaClip.stalls++; v.currentTime = v.ended ? 0 : v.currentTime; v.play().catch(() => {}); sameSince = now; }
    }, 100);
    // two phones on one live table see each moment at the same time: with --syncClips=1 both fake cameras
    // hold their clip at (wall clock mod clip length), so the same bounce reaches both at the same moment
    if (syncClips) setInterval(() => {
      const d = v.duration || 0;
      if (!d || v.paused) return;
      const want = (Date.now() / 1000) % d;
      let off = v.currentTime - want;
      if (off > d / 2) off -= d;
      if (off < -d / 2) off += d;
      if (Math.abs(off) > 0.04) v.currentTime = want;
    }, 250);
    const c = document.createElement("canvas");
    c.width = 960;
    c.height = 540;
    const g = c.getContext("2d");
    const draw = () => g.drawImage(v, 0, 0, c.width, c.height);
    draw();
    setInterval(draw, 1000 / 30);
    return c.captureStream(30);
  };
};
// every text the page shows that names the camera count, with when it appeared (toasts last 3 s)
// every rally upload: the video part's declared type, size and first 16 bytes, and the server's answer
// (the server reads the container signature, save-server.js sniffVideo, not the declared type)
const watchUploads = () => {
  window.__uploads = [];
  const orig = window.fetch;
  window.fetch = async (input, init) => {
    const url = String(input && input.url ? input.url : input);
    if (!url.includes("/api/rallies") || !init || !(init.body instanceof FormData)) return orig(input, init);
    const v = init.body.get("video");
    let record = null;
    try { const r = JSON.parse(init.body.get("record")); record = { analysisFps: r.analysisFps, screen: r.screen, cameras: r.cameras ?? 1 }; } catch {}
    const rec = { at: Date.now(), kind: v == null ? "missing" : typeof v === "string" ? "string" : "blob", type: v && v.type, size: v && v.size, head: null, status: null, error: null, record };
    if (v && typeof v !== "string") rec.head = [...new Uint8Array(await v.slice(0, 16).arrayBuffer())].map((x) => x.toString(16).padStart(2, "0")).join(" ");
    window.__uploads.push(rec);
    const res = await orig(input, init);
    rec.status = res.status;
    if (!res.ok) rec.error = await res.clone().text().catch(() => null);
    return res;
  };
};
const watchTexts = () => {
  window.__seen = [];
  const words = ["카메라 2대로 전환", "카메라 1대로 전환", "두 폰 끝 색이 반대로 보여요 · 설정에서 확인"];
  setInterval(() => {
    const text = document.body ? document.body.innerText : "";
    for (const w of words) {
      const last = window.__seen.filter((s) => s.text === w).pop();
      const on = text.includes(w);
      if (on && (!last || last.off)) window.__seen.push({ text: w, at: Date.now() });
      if (!on && last && !last.off) last.off = Date.now();
    }
  }, 150);
};

const browser = await chromium.launch();
const pagesOf = {};
const phone = async (name, preset) => {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: `Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36 ppv-phone-${name}` });
  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  await ctx.addInitScript(fakeCamera, [`${origin}/__qa/cam-${name}.webm`, args.syncClips === "1"]);
  await ctx.addInitScript(watchTexts);
  await ctx.addInitScript(watchUploads);
  await ctx.addInitScript((kv) => {
    if (sessionStorage.getItem("__preset")) return;
    sessionStorage.setItem("__preset", "1");
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
  }, preset);
  const p = await ctx.newPage();
  p.on("console", (m) => m.type() === "error" && report.errors.push(`${new Date().toISOString()} ${name} [${steps.length + 1}]: ${m.text()}`));
  p.on("response", async (r) => {
    if (r.url().includes("/api/rallies") && r.status() >= 400) report.errors.push(`${new Date().toISOString()} ${name} upload ${r.status()} ${await r.text().catch(() => "")} size=${(r.request().postDataBuffer() || []).length}`);
  });
  p.__writes = [];
  p.on("request", (r) => {
    if (r.url().endsWith("/api/action") && r.method() === "POST") p.__writes.push({ at: Date.now(), body: r.postData(), camera: r.headers()["x-ppv-camera"] || null });
  });
  pagesOf[name] = p;
  return p;
};
const screen = async (name, role, viewport, preset = {}) => {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  await ctx.addInitScript(watchTexts);
  await ctx.addInitScript((kv) => {
    if (sessionStorage.getItem("__preset")) return;
    sessionStorage.setItem("__preset", "1");
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
  }, { "pp-role": role, ...preset });
  const p = await ctx.newPage();
  p.on("console", (m) => m.type() === "error" && report.errors.push(`${name}: ${m.text()}`));
  await p.goto(origin + "/", { waitUntil: "load" });
  pagesOf[name] = p;
  return p;
};
const startCamera = async (p, afterCorners = null) => {
  await p.goto(origin + "/", { waitUntil: "load" });
  await p.waitForFunction(() => !!window.__ppv, null, { timeout: 30000 });
  await p.getByRole("button", { name: /카메라 시작/ }).click();
  await p.waitForFunction(() => ["calibrating", "running", "error"].includes(window.__ppv?.state.mode), null, { timeout: 180000 });
  const s = await p.evaluate(() => window.__ppv.state);
  if (s.mode === "error") throw new Error(JSON.stringify(s.error));
  if (s.mode === "calibrating") {
    for (const c of corners) {
      const pt = await p.evaluate(([x, y]) => {
        const v = document.querySelector("video.stage__video") || document.querySelector("video");
        const r = v.getBoundingClientRect();
        const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
        return { x: r.left + (r.width - v.videoWidth * k) / 2 + x * k, y: r.top + (r.height - v.videoHeight * k) / 2 + y * k };
      }, [c.x * (s.video.width / 1920), c.y * (s.video.height / 1080)]);
      await p.mouse.click(pt.x, pt.y);
      await p.waitForTimeout(300);
    }
    if (afterCorners) await afterCorners();
    await p.getByRole("button", { name: /확인/ }).click();
    await p.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 20000 });
  }
};
const camView = (p) => p.evaluate(() => ({ count: window.__ppv.multi.count, role: window.__ppv.multi.role, chip: document.querySelector(".strip .chip--role")?.innerText || null, cams: document.querySelector(".chip--cams:not([hidden])")?.innerText || null, offset: window.__ppv.multi.clock.offset, errMs: window.__ppv.multi.clock.errMs, timeOrigin: performance.timeOrigin, log: window.__ppv.multi.log.slice(), attached: !!window.__ppv.venue.attached }));
const bodyHas = (p, text) => p.evaluate((t) => document.body.innerText.includes(t), text);
const seen = (p, text, since) => p.evaluate(([t, s]) => window.__seen.filter((x) => x.text === t && x.at >= s), [text, since]);
const clipPlay = (p, on) => p.evaluate((on) => { const v = [...document.querySelectorAll("video")].find((x) => x.src.includes("/__qa/cam-")); if (v) on ? v.play() : v.pause(); return !!v; }, on).catch(() => false);

let pin = null;
let matchId = null;
const match = async () => (await api("/api/state")).body.derived.matches.find((m) => m.id === matchId);
// the camera left alone keeps judging: a point entered, or its own 누가 땄나요 for an unsure call
const judgesAlone = async (p, n0) => (await match()).points.length > n0 || !!(await p.evaluate(() => window.__ppv.state.tour.pending?.choice).catch(() => false));


const endsView = (p) => p.evaluate(() => {
  // one camera: the end chip; two cameras: the end state rides on the other camera's chip
  const vis = [".chip--ends", ".chip--cams"].map((q) => document.querySelector(q)).filter((e) => e && !e.hidden);
  const m = window.__ppv.multi;
  const chip = vis.map((e) => e.innerText).join(" | ") || null;
  return {
    chip,
    ends: chip ? ((chip.match(/(왼쪽|아래) \S+ · (오른쪽|위) \S+|끝 색 [^·|]+/) || [])[0] || "").trim() : null,
    warn: vis.some((e) => e.classList.contains("chip--warn")),
    near: window.__ppv.state.tour.near,
    role: m.role,
    sync: m.endSync ? [...m.endSync.cams].map(([cam, c]) => ({ cam, state: c.state, near: c.near, votes: c.votes.slice() })) : null,
    plates: [...document.querySelectorAll(".players .plate")].map((e) => e.textContent.trim()),
  };
});
// what decides the vote: A's per-camera votes and state, the rallies A collected (both cameras or one), and
// each fake camera's clip phase against the wall clock (two phones on one table see a bounce at the same time)
const phase = (p) => p.evaluate(() => { const v = window.__qaVideo; const d = v && v.duration; return d ? Math.round((((v.currentTime - (Date.now() / 1000) % d) % d + d) % d) * 1000) : null; }).catch(() => null);
const syncDiag = async () => {
  const a = await pagesOf.A.evaluate(() => {
    const m = window.__ppv.multi;
    const groups = m.log.filter((e) => e.cams);
    return { sync: m.endSync ? [...m.endSync.cams].map(([cam, c]) => ({ cam, state: c.state, near: c.near, votes: c.votes.slice() })) : null, judged: groups.length, judgedBoth: groups.filter((e) => e.cams.length > 1).length, merger: m.merger ? { pending: m.merger.segs.length, dropped: m.merger.dropped, droppedSegs: (m.merger.droppedSegs || []).slice(-5), closed: m.merger.closed.length, closedByCam: m.merger.closed.reduce((o, s) => ((o[s.cam] = (o[s.cam] || 0) + 1), o), {}) } : null };
  });
  const [pa, pb] = [await phase(pagesOf.A), await phase(pagesOf.B)];
  a.clips = { A: await pagesOf.A.evaluate(() => window.__qaClip).catch(() => null), B: await pagesOf.B.evaluate(() => window.__qaClip).catch(() => null) };
  // analysis rate on each phone (the app's own frames-analysed-per-second counter)
  a.fps = { A: await pagesOf.A.evaluate(() => window.__ppv.state.perf.fps).catch(() => null), B: await pagesOf.B.evaluate(() => window.__ppv.state.perf.fps).catch(() => null) };
  return { at: new Date().toISOString(), ...a, clipPhaseMs: { A: pa, B: pb, BminusA: pa != null && pb != null ? pb - pa : null } };
};
const logOf = (p) => p.evaluate(() => window.__ppv.multi.log.slice());
const shot = async (p, name) => {
  await p.evaluate(() => document.fonts.ready).catch(() => {});
  await p.screenshot({ path: `${out}/${name}.png` });
  if (name.endsWith("-393")) (report.layout ??= {})[name] = await chipsOverButtons(p);
};
// visible strip / stage chips over any button outside them (the landscape strip overflowed under 정지 once)
const chipsOverButtons = (p) => p.evaluate(() => {
  const chips = [...document.querySelectorAll(".chip")].filter((e) => !e.hidden && e.offsetParent !== null && !e.matches("button"));
  const buttons = [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null && !b.closest(".strip, .stage__chips"));
  const hits = [];
  for (const c of chips) {
    const q = c.getBoundingClientRect();
    for (const b of buttons) {
      const r = b.getBoundingClientRect();
      if (r.width && q.left < r.right && r.left < q.right && q.top < r.bottom && r.top < q.bottom) hits.push({ chip: c.innerText.slice(0, 30), button: (b.innerText || b.getAttribute("aria-label") || "").trim().slice(0, 20) });
    }
    if (q.right > innerWidth + 0.5) hits.push({ chip: c.innerText.slice(0, 30), button: "off-screen" });
  }
  return hits;
});
const landscape = async (p, name) => {
  await p.setViewportSize({ width: 852, height: 393 });
  await p.waitForTimeout(1200);
  await shot(p, name);
  const hits = await chipsOverButtons(p);
  (report.layout ??= {})[name] = hits;
  if (hits.length) { await p.setViewportSize({ width: 393, height: 852 }); throw new Error(`${name}: chips over buttons ${JSON.stringify(hits)}`); }
  await p.setViewportSize({ width: 393, height: 852 });
  await p.waitForTimeout(800);
};
// ---- --inject=1: the rally engine's output is fed, everything after it is the app ----
// The live rally engine stops consuming detections (its update), and each fixture rally (real
// pipeline.js output from the public test videos, qa/end-sync-rallies.json) opens and closes
// through the engine's own startRally / endRally (rally.js), at the same wall time on both phones. So
// the event has rally.js's own shape and the app path from there is untouched: pipeline.handle ->
// app onEvent -> multiRallyEnd -> relay -> collector -> end vote -> score.
// the fixture sits beside this script (a tree under test need not have it); read only when injecting
const fixture = args.inject === "1" ? JSON.parse(readFileSync(new URL("./end-sync-rallies.json", import.meta.url), "utf8")).rallies.filter((r) => r.durS <= 4.5) : [];
let fed = 0;
const engineOff = (p) => p.evaluate(() => { const R = window.__ppv.pipeline.rally; if (!R.__fed) { R.__fed = true; R.update = () => {}; R.rally = null; } return true; });
const turned = (r) => ({ ...r, bounces: r.bounces.map((b) => ({ ...b, side: b.side === "near" ? "far" : "near", tx: 2.74 - b.tx, ty: 1.525 - b.ty })), shots: r.shots.map((x) => ({ ...x, side: x.side === "near" ? "far" : "near" })) });
const rallyOp = (p, op, a) => p.evaluate(([op, a]) => {
  const R = window.__ppv.pipeline.rally;
  const sec = (ms) => (ms - performance.timeOrigin) / 1000;
  if (op === "start") return R.startRally(sec(a.wall));
  const r = R.rally;
  if (!r) return "no open rally";
  const t0 = sec(a.wall);
  r.bounces = a.ev.bounces.map((b) => ({ tx: b.tx, ty: b.ty, side: b.side, t: t0 + b.dt }));
  r.shots = a.ev.shots.map((x) => ({ side: x.side, t: t0 + x.dt, inferred: x.inferred }));
  r.lastT = t0 + a.ev.durS;
  r.maxSpeed = a.ev.maxSpeedKmh ?? null;
  r.serveSeen = a.ev.serveSeen || null;
  r.serveNet = a.ev.serveNet || null;
  R.endRally(a.ev.why);
}, [op, a]);
// one rally seen by both phones; turnB: phone B sees it from the other end of the table
const feed = async ({ turnB = false, noBounces = false } = {}) => {
  const ev0 = fixture[fed++ % fixture.length];
  const ev = noBounces ? { ...ev0, bounces: [] } : ev0;
  await Promise.all([engineOff(pagesOf.A), engineOff(pagesOf.B)]);
  const wall = Date.now() + 200;
  await Bun.sleep(200);
  await Promise.all([rallyOp(pagesOf.A, "start", { wall }), rallyOp(pagesOf.B, "start", { wall })]);
  await Bun.sleep(ev.durS * 1000 + 50);
  const eb = await rallyOp(pagesOf.B, "end", { wall, ev: turnB ? turned(ev) : ev });
  await Bun.sleep(250);
  const ea = await rallyOp(pagesOf.A, "end", { wall, ev });
  await Bun.sleep(1500);
  const d = await syncDiag();
  (report.fed ??= []).push({ n: fed, from: ev.from, bounces: ev.bounces.length, turnB, endA: ea ?? null, endB: eb ?? null, sync: d.sync, at: new Date().toISOString() });
  return d;
};
const bId = () => pagesOf.A.evaluate(() => { const me = window.__ppv.venue.me(); return window.__ppv.multi.cams.find((c) => !me || c.id !== me.id)?.id || null; });

// the calibration guide and bar after the four corners (the snap answers within about a second)
const calibView = (p) => p.evaluate(() => ({
  step: document.querySelector(".calibbar__step")?.innerText || null,
  text: document.querySelector(".calibbar__guide")?.innerText.replace(/\s+/g, " ") || null,
  ends: [...document.querySelectorAll(".calib__end-label")].filter((t) => t.style.display !== "none").map((t) => t.textContent),
  bar: Math.round(document.querySelector(".calibbar")?.getBoundingClientRect().height || 0),
  near: window.__ppv.state.tour.near,
}));
// Settings open: every point of the sheet must show the sheet itself (nothing drawn over it: the top chip
// row once covered its title and ✕), and its own ✕ must be on top and close it. Recorded per capture name.
const sheetCover = (p) => p.evaluate(() => {
  const s = document.querySelector(".popover");
  const r = s.getBoundingClientRect();
  let covered = 0, n = 0;
  const by = {};
  for (let x = Math.ceil(r.left) + 1; x < r.right - 1; x += 4) for (let y = Math.ceil(r.top) + 1; y < r.bottom - 1; y += 4) {
    n++;
    const t = document.elementFromPoint(x, y);
    if (t && !s.contains(t)) { covered++; const k = (t.closest("[class]")?.className || t.tagName).toString().split(" ")[0]; by[k] = (by[k] || 0) + 1; }
  }
  const x = s.querySelector('button[aria-label="설정 닫기"]'), q = x.getBoundingClientRect();
  const top = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
  return { box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], coveredPx: covered * 16, samples: n, by, closeOnTop: !!(top && x.contains(top)) };
});
const settings = async (p, name, pick = null) => {
  await p.getByRole("button", { name: /^설정$/ }).last().click();
  await p.waitForTimeout(800);
  const seg = p.getByText("카메라 앞쪽", { exact: true }).first();
  await seg.scrollIntoViewIfNeeded().catch(() => {});
  if (name) {
    await shot(p, name);
    (report.sheet ??= {})[name] = await sheetCover(p);
  }
  if (pick) await p.getByText(pick, { exact: true }).click();
  await p.waitForTimeout(400);
  // the sheet's own ✕ (the back button carries the same name while settings are open)
  await p.locator('.popover button[aria-label="설정 닫기"]').click({ timeout: 5000 });
  await p.waitForTimeout(600);
  if (name) report.sheet[name].closed = await p.evaluate(() => document.querySelector(".popover").hidden);
};
const merges = async (id, since) => (await logOf(A_())).filter((e) => e.cams && e.cams.includes(id) && e.cams.includes("self") && e.at >= since);
const warnsOf = async (id, since) => (await logOf(A_())).filter((x) => x.end && x.end.cam === id && x.end.state === "mismatch" && x.at >= since);
const A_ = () => pagesOf.A;
// a capture of the notice while it shows (it lasts 3 s)
const noticeShot = async (p, text, name, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await p.evaluate((t) => { const e = document.querySelector(".toast.show"); return !!e && e.textContent === t && getComputedStyle(e).opacity > 0.9 && getComputedStyle(e).visibility !== "hidden"; }, text)) {
      await shot(p, name);
      return true;
    }
    await Bun.sleep(150);
  }
  return false;
};
// The notice over the picture against everything the end labels keep off: each drawn body, name and standing
// plate, the LOCK box and bracket, the end labels (the HUD frame's own boxes, data-ends), the table quad, and
// shown buttons and panels. Polled while it shows; returns the worst frame's overlapping px per kind.
const noticeOverlap = (p, text, ms = 2500) => p.evaluate(async ([text, ms]) => {
  const t0 = performance.now();
  let worst = null, frames = 0, hidden = 0;
  while (performance.now() - t0 < ms) {
    await new Promise((r) => requestAnimationFrame(() => r()));
    const el = document.querySelector(".toast.show");
    if (!el || el.textContent !== text || getComputedStyle(el).opacity < 0.5) continue;
    if (getComputedStyle(el).visibility === "hidden") { hidden++; continue; }
    frames++;
    const r = el.getBoundingClientRect(), T = { x: r.left, y: r.top, w: r.width, h: r.height };
    const ov = document.querySelector("canvas[data-ends]"), o = ov.getBoundingClientRect();
    const info = ov.dataset.ends ? JSON.parse(ov.dataset.ends) : {};
    const sh = (b) => ({ x: b.x + o.left, y: b.y + o.top, w: b.w, h: b.h });
    const area = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const sum = (list) => Math.round(list.filter((b) => b && b.w).reduce((n, b) => n + area(T, b), 0));
    const quad = info.quad ? info.quad.map((q) => ({ x: q.x + o.left, y: q.y + o.top })) : null;
    const inQ = (q) => { let c = false; for (let i = 0, j = 3; i < 4; j = i++) { const A = quad[i], B = quad[j]; if (A.y > q.y !== B.y > q.y && q.x < ((B.x - A.x) * (q.y - A.y)) / (B.y - A.y) + A.x) c = !c; } return c; };
    let table = 0;
    if (quad) for (let x = Math.floor(T.x); x < T.x + T.w; x++) for (let y = Math.floor(T.y); y < T.y + T.h; y++) if (inQ({ x: x + 0.5, y: y + 0.5 })) table++;
    const rect = (n) => { const q = n.getBoundingClientRect(); return { x: q.left, y: q.top, w: q.width, h: q.height }; };
    const row = {
      body: sum(Object.values(info.bodies || {}).map(sh)),
      plates: sum([...Object.values(info.tags || {}), ...Object.values(info.stands || {}).filter((s) => s && s.w && !s.labelHidden)].map(sh)),
      lock: sum([info.lock, info.bracket].filter(Boolean).map(sh)),
      endLabels: sum(Object.values(info.endTags || {}).map(sh)),
      table,
      buttons: sum([...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null).map(rect)),
      panels: sum([...document.querySelectorAll(".players, .court, .pointbar, .fix")].filter((e) => e.offsetParent !== null && !e.closest("[hidden]")).map(rect)),
      box: [Math.round(T.x), Math.round(T.y), Math.round(T.w), Math.round(T.h)], free: el.dataset.free,
    };
    row.total = row.body + row.plates + row.lock + row.endLabels + row.table + row.buttons + row.panels;
    if (!worst || row.total > worst.total) worst = row;
  }
  return { frames, hidden, worst };
}, [text, ms]);

try {
  if (args.inject !== "1") throw new Error("only --inject=1 is supported: this PC's live analysis does not pair bounces between two phones");
  await step("create-tournament", async () => {
    const r = await api("/api/tournament", { name: "끝 색 시험", players: await withCodes(`http://127.0.0.1:${ports.tour}`, ["블루선수", "레드선수", "셋째", "넷째"]), format: "double", bestOf: 5 });
    if (r.status !== 200) throw new Error(`create ${r.status}`);
    pin = r.body.pin;
    matchId = r.body.state.derived.matches.find((m) => m.status === "ready").id;
    return { matchId };
  });
  const camPreset = (extra = {}) => ({ "pp-role": "camera", "pp-pin": pin, "ppv.tourMode": JSON.stringify("all"), "ppv.tourMatch": JSON.stringify(matchId), "ppv.stableMode": JSON.stringify("off"), ...extra });
  const A = await phone("A", camPreset());
  const referee = await screen("referee", "referee", { width: 393, height: 852 }, { "pp-pin": pin });
  const tv = await screen("tv", "viewer", { width: 1920, height: 1080 });

  await step("one-camera", async () => {
    // A calibrates in landscape: the end-colour step at 852x393
    await A.setViewportSize({ width: 852, height: 393 });
    let cal = null;
    await startCamera(A, async () => {
      await A.waitForTimeout(1500);
      cal = await calibView(A);
      await shot(A, "01-A-calib-end-step-852x393");
    });
    await A.setViewportSize({ width: 393, height: 852 });
    await waitFor("A attached alone", async () => (await camView(A)).count === 1, 30000);
    await A.waitForTimeout(1500);
    const e = await endsView(A);
    await shot(A, "01-A-one-camera-393");
    await landscape(A, "01-A-one-camera-852x393");
    await settings(A, "01-A-settings-393");
    await A.setViewportSize({ width: 852, height: 393 });
    await A.waitForTimeout(1000);
    await settings(A, "01-A-settings-852x393");
    await A.setViewportSize({ width: 393, height: 852 });
    await A.waitForTimeout(800);
    if (e.chip !== "왼쪽 블루 · 오른쪽 레드") throw new Error(JSON.stringify(e));
    for (const k of ["01-A-settings-393", "01-A-settings-852x393"]) { const s = report.sheet?.[k]; if (!s || s.coveredPx || !s.closeOnTop || !s.closed) throw new Error(`${k}: ${JSON.stringify(s)}`); }
    if (cal.step !== "끝 색" || !/블루 끝이에요/.test(cal.text || "")) throw new Error(JSON.stringify(cal));
    return { chip: e.chip, near: e.near, calib: cal };
  }, [["A", A]]);

  // B films the same table from the same place: its near end is blue, but it starts set to red; the person
  // picks blue on B's calibration screen
  const B = await phone("B", camPreset({ "ppv.tourNear": "1" }));
  let joinedAt = 0;
  await step("pick-at-calibration", async () => {
    let before = null, after = null;
    await startCamera(B, async () => {
      await B.waitForTimeout(1500);
      before = await calibView(B);
      await shot(B, "02-B-calib-end-step-red-393");
      await B.getByRole("button", { name: /끝 색 바꾸기/ }).click();
      await B.waitForTimeout(500);
      after = await calibView(B);
      await shot(B, "02-B-calib-end-step-picked-blue-393");
    });
    await waitFor("primary / secondary", async () => (await camView(A)).role === "primary" && (await camView(B)).role === "secondary", 60000);
    joinedAt = Date.now();
    const a = await endsView(A), b = await endsView(B);
    await shot(A, "02-A-two-cameras-393");
    await shot(B, "02-B-two-cameras-393");
    const checking = [a.chip, b.chip].some((c) => /확인 중/.test(c || ""));
    const res = { before, after, Bnear: b.near, A: a.chip, B: b.chip };
    if (before.near !== 1 || !/레드 끝이에요/.test(before.text || "") || after.near !== 0 || !/블루 끝이에요/.test(after.text || "") || before.bar !== after.bar) throw new Error(JSON.stringify(res));
    if (b.near !== 0 || checking) throw new Error(JSON.stringify(res));
    return res;
  }, [["A", A], ["B", B]]);

  await step("merged-at-once", async () => {
    const id = await bId();
    const n0 = (await match()).points.length;
    await feed();
    await feed();
    const both = await merges(id, joinedAt);
    const n1 = (await match()).points.length;
    await shot(referee, "03-referee-393");
    await shot(tv, "03-tv-1920");
    const res = { merged: both.map((e) => ({ cams: e.cams, bounces: e.bounces, winner: e.winner, conflict: e.conflict })), points: n1 - n0, bWrites: B.__writes.length, secondsFromJoin: both.length ? (both[0].at - joinedAt) / 1000 : null };
    if (both.length < 2 || B.__writes.length || (await warnsOf(id, 0)).length) throw new Error(JSON.stringify(res));
    return res;
  }, [["A", A], ["referee", referee], ["tv", tv]]);

  await step("wrong-pick-warns", async () => {
    const id = await bId();
    // a person sets B to red by mistake (B still films from the blue end)
    await settings(B, null, "앞쪽 레드 사이드");
    await waitFor("A hears B's new pick", async () => A.evaluate((id) => window.__ppv.multi.peers[id]?.near === 1, id), 10000);
    const since = Date.now();
    let warn = [];
    const WARN = "두 폰 끝 색이 반대로 보여요 · 설정에서 확인";
    // the notice shows for 3 s when the warning comes: measured and captured while each rally is fed
    let n393 = null;
    for (let i = 0; i < 4 && !warn.length; i++) {
      const meas = noticeOverlap(A, WARN, 9000), cap = noticeShot(A, WARN, "04-A-warning-393", 9000);
      await feed();
      warn = await warnsOf(id, since);
      const [m] = await Promise.all([meas, cap]);
      if (warn.length) n393 = m;
    }
    if (!warn.length) throw new Error(`no warning after ${fed} rallies: ${JSON.stringify(report.fed.at(-1)?.sync)}`);
    const a = await endsView(A), b = await endsView(B);
    const notice = await seen(A, WARN, since);
    // the same warning again with A turned sideways: B picks blue, then red again
    await A.setViewportSize({ width: 852, height: 393 });
    await A.waitForTimeout(1200);
    await settings(B, null, "앞쪽 블루 사이드");
    await settings(B, null, "앞쪽 레드 사이드");
    await waitFor("A hears B red again", async () => A.evaluate((id) => window.__ppv.multi.peers[id]?.near === 1 && window.__ppv.multi.endSync.get(id).state === "ok", id), 10000);
    const since2 = Date.now();
    let warn2 = [], n852 = null;
    for (let i = 0; i < 4 && !warn2.length; i++) {
      const meas = noticeOverlap(A, WARN, 9000), cap = noticeShot(A, WARN, "04-A-warning-852x393", 9000);
      await feed();
      warn2 = await warnsOf(id, since2);
      const [m] = await Promise.all([meas, cap]);
      if (warn2.length) n852 = m;
    }
    report.noticeOverlap = { "393x852": n393, "852x393": n852 };
    // the warning stays on the top chip at 852 (the notice may have had no free spot), and a tap on it opens
    // settings with the same warning by 카메라 앞쪽
    const chip = await A.evaluate(() => { const c = document.querySelector(".chip--cams"); return { text: c.innerText, warn: c.classList.contains("chip--warn"), role: c.getAttribute("role") }; });
    await shot(A, "04-A-warning-chip-852x393");
    await A.locator(".chip--cams").click();
    await A.waitForTimeout(600);
    await A.locator(".screen__note--warn").scrollIntoViewIfNeeded().catch(() => {});
    // the warning line is shown and on top at its centre (a bar above settings once hid it)
    const opened = await A.evaluate(() => {
      const n = [...document.querySelectorAll(".screen__note--warn")].find((e) => !e.hidden);
      const r = n && n.getBoundingClientRect();
      const top = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      return { open: !document.querySelector(".popover").hidden, note: n ? n.innerText : null, onTop: !!(n && top && n.contains(top)) };
    });
    await shot(A, "04-A-warning-chip-open-852x393");
    const sheet = await sheetCover(A);
    await A.locator('.popover button[aria-label="설정 닫기"]').click({ timeout: 5000 });
    await A.waitForTimeout(600);
    sheet.closed = await A.evaluate(() => document.querySelector(".popover").hidden);
    (report.sheet ??= {})["04-A-warning-chip-open-852x393"] = sheet;
    if (sheet.coveredPx || !sheet.closeOnTop || !sheet.closed) throw new Error(`chip-open sheet: ${JSON.stringify(sheet)}`);
    report.chip852 = { ...chip, ...opened };
    if (!chip.warn || !/끝 색 반대\?/.test(chip.text) || !opened.open || !/반대로 보여요/.test(opened.note || "") || !opened.onTop) throw new Error(`chip 852: ${JSON.stringify(report.chip852)}`);
    await A.setViewportSize({ width: 393, height: 852 });
    await A.waitForTimeout(800);
    const at1 = Date.now();
    await feed();
    const mergedAfterWarn = (await merges(id, at1)).length;
    const res = { ralliesToWarn: report.fed.filter((f) => Date.parse(f.at) >= since).length, chip: a.chip, warn: a.warn, notice: notice.length, mergedAfterWarn, Bnear: b.near, bWrites: B.__writes.length, noticeOverlap: report.noticeOverlap };
    if (!a.warn || !/끝 색 반대\?/.test(a.chip || "") || !notice.length || !mergedAfterWarn || b.near !== 1 || B.__writes.length) throw new Error(JSON.stringify(res));
    // the notice: seen at both sizes, and over nothing the end labels keep off
    for (const [k, m] of Object.entries(report.noticeOverlap)) if (!m || !m.frames || m.worst.total) throw new Error(`notice ${k}: ${JSON.stringify(m)}`);
    return res;
  }, [["A", A], ["B", B]]);

  await step("settings-fix", async () => {
    const id = await bId();
    await settings(B, "05-B-settings-393", "앞쪽 블루 사이드");
    await waitFor("warning cleared on A", async () => A.evaluate((id) => window.__ppv.multi.endSync.get(id).state === "ok" && window.__ppv.multi.peers[id]?.near === 0, id), 10000);
    const since = Date.now();
    await feed();
    await feed();
    const merged = (await merges(id, since)).length;
    const warns = (await warnsOf(id, since)).length;
    const a = await endsView(A), b = await endsView(B);
    await shot(A, "05-A-after-fix-393");
    await B.setViewportSize({ width: 852, height: 393 });
    await B.waitForTimeout(1000);
    await settings(B, "05-B-settings-852x393");
    await B.setViewportSize({ width: 393, height: 852 });
    const res = { merged, warns, Achip: a.chip, warn: a.warn, Bnear: b.near };
    for (const k of ["05-B-settings-393", "05-B-settings-852x393"]) { const s = report.sheet?.[k]; if (!s || s.coveredPx || !s.closeOnTop || !s.closed) throw new Error(`${k}: ${JSON.stringify(s)}`); }
    res.sheet = Object.fromEntries(Object.entries(report.sheet || {}).map(([k, s]) => [k, s.coveredPx]));
    if (merged < 2 || warns || a.warn || b.near !== 0) throw new Error(JSON.stringify(res));
    return res;
  }, [["A", A], ["B", B]]);

  await step("swap", async () => {
    const id = await bId();
    const before = await endsView(A);
    await A.getByRole("button", { name: /자리 교체/ }).click();
    await waitFor("names trade ends", async () => (await endsView(A)).plates.join() !== before.plates.join(), 20000);
    const at0 = Date.now();
    await feed();
    await A.waitForTimeout(800);
    const v = await endsView(A);
    const merged = await merges(id, at0);
    await shot(A, "06-A-after-swap-393");
    await landscape(A, "06-A-after-swap-852x393");
    await shot(referee, "06-referee-after-swap-393");
    await shot(tv, "06-tv-after-swap-1920");
    const colourOf = (t) => (/^블루/.test(t) ? 0 : /^레드/.test(t) ? 1 : null);
    if (JSON.stringify(before.plates.map(colourOf)) !== JSON.stringify(v.plates.map(colourOf))) throw new Error(JSON.stringify({ before: before.plates, after: v.plates }));
    if (v.chip !== before.chip) throw new Error(`chip ${before.chip} -> ${v.chip}`);
    if (!merged.length) throw new Error("no merged rally after the swap");
    return { before: before.plates, after: v.plates, chip: v.chip, mergedAfterSwap: merged.length };
  }, [["A", A], ["referee", referee], ["tv", tv]]);

  await step("one-off", async () => {
    // phone B goes off (its page closes): A is the one camera again and scores its own rallies
    await B.context().close();
    delete pagesOf.B;
    await waitFor("A alone", async () => (await camView(A)).role === "single", 40000);
    const n0 = (await match()).points.length;
    const ev = fixture[fed++ % fixture.length];
    await engineOff(A);
    const wall = Date.now() + 200;
    await Bun.sleep(200);
    await rallyOp(A, "start", { wall });
    await Bun.sleep(ev.durS * 1000 + 50);
    await rallyOp(A, "end", { wall, ev });
    const scored = await waitFor("A judges alone", async () => judgesAlone(A, n0), 20000).catch(() => false);
    await shot(A, "07-A-alone-393");
    const v = await camView(A);
    const res = { role: v.role, count: v.count, scored: !!scored, notice: (await seen(A, "카메라 1대로 전환", 0)).length };
    if (v.role !== "single" || !scored) throw new Error(JSON.stringify(res));
    return res;
  }, [["A", A], ["referee", referee]]);
} finally {
  for (const n of ["A", "B"]) if (pagesOf[n]) report[`uploads${n}`] = await pagesOf[n].evaluate(() => window.__uploads).catch(() => null);
  writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
  await browser.close().catch(() => {});
  proxy.stop(true);
  for (const p of procs) p.kill();
  const pass = steps.filter((s) => s.pass).length;
  console.log(`RESULT ${pass}/${steps.length} pass, errors ${report.errors.length}, out ${out}`);
  process.exitCode = pass === steps.length && steps.length >= 8 ? 0 : 1;
}
