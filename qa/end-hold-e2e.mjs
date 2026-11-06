// 점수 보류 (docs/multicam.md "Score hold"), on the real apps: two Chromium phones (393x852) film the same table
// from the same place (both near ends blue), a referee screen (PIN, 심판 모드) and the tournament server. Only
// the rally engine's output is fed (--inject=1, as in qa/end-sync-e2e.mjs); relay, collector, end check, hold
// and scoring are the apps'. Steps, each PASS/FAIL with numbers and captures:
//   confirm-on-referee 확인 후 입력 (owner decision, 2026-11-01): the camera's call waits, its colour chosen, on A's 누가 땄나요 bar and on the
//                      referee screen (확정 + the card marked); nothing enters by itself; the referee's 확정 enters it and
//                      closes the camera's question
//   correct-no-hold    both picks right: each call confirmed on A, no hold anywhere, no mark
//   secondary-turned   B set to red by mistake: points B missed are still confirmed from the call (and listed); the first shared
//                      rally warns, A holds: no point enters by itself, 누가 땄나요 says 점수 보류 · 끝 색 확인, the
//                      tap enters the player at that end colour; the referee bar and B's chip say the hold
//   referee-marks      the points entered before the warning carry 끝 색 확인 on the referee screen: [반대로]
//                      gives one to the other player (later points kept), [맞음] clears the other
//   fix-resume         B back to blue: the hold ends on every screen and the next call is chosen again (one tap)
//   primary-turned     A set to red: the hold comes back; A back to blue ends it, calls chosen again
//   one-off-held       held, B goes off: A alone still asks (its pick may be the turned one) and its own chip
//                      says the hold; a pick on A ends it and A's calls are chosen again
// Layout while held: camera A/B and referee at 393x852 and 852x393, text over buttons / off-screen / cut: 0.
//   bun qa/end-hold-e2e.mjs --inject=1 --vision=<checkout> --tournament=<checkout> --clip=<webm> [--port=9660] [--out=<dir>]
import { chromium } from "playwright";
import { withCodes } from "./player-names.mjs";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out || "evidence/end-hold";
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
  const [pa, pb] = [await phase(pagesOf.A), pagesOf.B ? await phase(pagesOf.B) : null];
  a.clips = { A: await pagesOf.A.evaluate(() => window.__qaClip).catch(() => null), B: pagesOf.B ? await pagesOf.B.evaluate(() => window.__qaClip).catch(() => null) : null };
  // analysis rate on each phone (the app's own frames-analysed-per-second counter)
  a.fps = { A: await pagesOf.A.evaluate(() => window.__ppv.state.perf.fps).catch(() => null), B: pagesOf.B ? await pagesOf.B.evaluate(() => window.__ppv.state.perf.fps).catch(() => null) : null };
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
const feed = async ({ turnB = false, noBounces = false, bMissed = false } = {}) => {
  const ev0 = fixture[fed++ % fixture.length];
  const ev = noBounces ? { ...ev0, bounces: [] } : ev0;
  // bMissed: B does not see this rally (a body in the way, or B is off): only A runs it
  const withB = !bMissed && !!pagesOf.B;
  await Promise.all([engineOff(pagesOf.A), withB ? engineOff(pagesOf.B) : null]);
  const wall = Date.now() + 200;
  await Bun.sleep(200);
  await Promise.all([rallyOp(pagesOf.A, "start", { wall }), withB ? rallyOp(pagesOf.B, "start", { wall }) : null]);
  await Bun.sleep(ev.durS * 1000 + 50);
  const eb = withB ? await rallyOp(pagesOf.B, "end", { wall, ev: turnB ? turned(ev) : ev }) : null;
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


// ---- end-hold steps ----
const HOLD = "점수 보류 · 끝 색 확인";
// (a tree without the hold, such as main for the before captures, reads on: null)
const holdOf = (p) => p.evaluate(() => ({ on: window.__ppv.multi.hold ? window.__ppv.multi.hold.on : null, auto: window.__ppv.multi.hold ? window.__ppv.multi.hold.auto.slice() : [], role: window.__ppv.multi.role, pending: window.__ppv.state.tour.pending ? { choice: !!window.__ppv.state.tour.pending.choice, hold: !!window.__ppv.state.tour.pending.hold, pre: window.__ppv.state.tour.pending.pre ?? null, reason: window.__ppv.state.tour.pending.reason } : null, bar: document.querySelector(".pointbar__text")?.innerText || null, chipCams: document.querySelector(".chip--cams:not([hidden])")?.innerText || null, chipEnds: document.querySelector(".chip--ends:not([hidden])")?.innerText || null }));
const refView = (p) => p.evaluate(() => ({ cam: [...document.querySelectorAll(".ref-cam [data-hold-text], .ref-hold[data-hold-text], .ref-cam .lbl")].find((e) => e.offsetParent !== null)?.innerText.trim().replace(/ · 어느 폰이든.*$/, "") || null, hold: !!document.querySelector(".ref-cam[data-hold]"), check: document.querySelector("[data-ref-check]")?.innerText.replace(/\s+/g, " ").trim() || null, ask: document.querySelector("[data-ref-ask]")?.innerText.replace(/\s+/g, " ").trim() || null, confirm: !!document.querySelector("[data-ask-confirm]:not([disabled])"), asked: [...document.querySelectorAll(".ref-half.asked")].map((e) => e.dataset.side) }));
// 확인 후 입력: the camera's call shows on A with its colour chosen; a person taps it once
const confirmOn = async (p, n0) => {
  await waitFor("camera call on the bar", async () => (await holdOf(p)).pending?.pre != null, 15000);
  await p.locator(".pointbar__pick--pre").click();
  await waitFor("confirmed point", async () => (await pointsNow()).length === n0 + 1, 10000);
};
const rosterHold = async () => ((await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${ports.proxy}/ws`);
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === "cameras") { ws.close(); resolve(m.matches[matchId] || []); } };
  setTimeout(() => { ws.close(); resolve(null); }, 5000);
})) || []).map((c) => ({ primary: c.primary, hold: c.hold, near: c.near }));
// Every visible text-bearing element (a leaf with its own text) over a button it is not part of, and anything
// past the screen edge; the end-hold copy is the new text, the buttons are every shown button.
const textOverButtons = (p) => p.evaluate(() => {
  const vis = (e) => { const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05 && r.width > 0 && r.height > 0 && !e.closest("[hidden]"); };
  const texts = [...document.querySelectorAll("body *")].filter((e) => vis(e) && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && !e.closest("canvas, .toast, dialog:not([open])"));
  const buttons = [...document.querySelectorAll("button, [role=button]")].filter(vis);
  const hits = [];
  for (const t of texts) {
    const q = t.getBoundingClientRect();
    for (const b of buttons) {
      if (b.contains(t) || t.contains(b)) continue;
      const r = b.getBoundingClientRect();
      const ix = Math.min(q.right, r.right) - Math.max(q.left, r.left), iy = Math.min(q.bottom, r.bottom) - Math.max(q.top, r.top);
      // an element stacked above and clipping the text is still an overlap; 0.5 px is subpixel rounding
      if (ix > 0.5 && iy > 0.5) hits.push({ text: t.innerText.trim().slice(0, 30), button: (b.innerText || b.getAttribute("aria-label") || "").trim().slice(0, 20), px: Math.round(ix * iy) });
    }
    const inFixedScroll = t.closest(".popover, .screen, .ref, main, .scroll");
    // text cut by the screen edge (a screen-reader-only line placed wholly off screen is not drawn, so it is left out)
    const onScreen = q.right > 0 && q.left < innerWidth && q.bottom > 0 && q.top < innerHeight;
    if (onScreen && (q.right > innerWidth + 0.5 || q.left < -0.5) && !inFixedScroll) hits.push({ text: t.innerText.trim().slice(0, 30), button: "off-screen" });
  }
  // the hold text itself must not be cut (ellipsis) where it shows
  const cut = [...document.querySelectorAll(".ref-cam .lbl, .chip--cams, .chip--ends, .pointbar__text")].filter(vis).filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.innerText.slice(0, 40));
  return { hits, cut };
});
const layout = async (p, name, sizes) => {
  for (const [w, h] of sizes) {
    // the referee screen asks for full screen (headless Chromium grants it); a full-screen page cannot be resized
    await p.evaluate(() => document.fullscreenElement && document.exitFullscreen()).catch(() => {});
    await p.setViewportSize({ width: w, height: h });
    await p.waitForTimeout(1200);
    await p.evaluate(() => document.fonts.ready).catch(() => {});
    // the pointer left over a button from the last click would show its hover colour (a phone has none)
    await p.mouse.move(1, h - 1).catch(() => {});
    await p.waitForTimeout(200);
    const tag = `${name}-${w}x${h}`;
    await p.screenshot({ path: `${out}/${tag}.png` });
    const m = await textOverButtons(p);
    (report.layout ??= {})[tag] = m;
  }
  await p.setViewportSize({ width: sizes[0][0], height: sizes[0][1] });
  await p.waitForTimeout(600);
};
// (shot() keeps a plain list of chip hits under some names; layout() keeps { hits, cut })
const layoutFails = (names) => Object.entries(report.layout || {}).filter(([k, m]) => names.some((n) => k.startsWith(n)) && (Array.isArray(m) ? m.length : m.hits.length || m.cut.length));
const pointsNow = async () => (await match()).points.slice();
const waitHold = (p, on, ms = 15000) => waitFor(`hold ${on}`, async () => (await holdOf(p)).on === on, ms);

try {
  if (args.inject !== "1") throw new Error("only --inject=1 is supported");
  await step("create-tournament", async () => {
    const r = await api("/api/tournament", { name: "점수 보류 시험", players: await withCodes(`http://127.0.0.1:${ports.tour}`, ["블루선수", "레드선수", "셋째", "넷째"]), format: "double", bestOf: 5 });
    if (r.status !== 200) throw new Error(`create ${r.status}`);
    pin = r.body.pin;
    matchId = r.body.state.derived.matches.find((m) => m.status === "ready").id;
    return { matchId };
  });
  const camPreset = (extra = {}) => ({ "pp-role": "camera", "pp-pin": pin, "ppv.tourMode": JSON.stringify("all"), "ppv.tourMatch": JSON.stringify(matchId), "ppv.stableMode": JSON.stringify("off"), "ppv.tourNear": "0", ...extra });
  const A = await phone("A", camPreset());
  const referee = await screen("referee", "referee", { width: 393, height: 852 }, { "pp-pin": pin });
  await step("two-cameras", async () => {
    await startCamera(A);
    await waitFor("A attached alone", async () => (await camView(A)).count === 1, 30000);
    const B = await phone("B", camPreset());
    await startCamera(B);
    await waitFor("primary / secondary", async () => (await camView(A)).role === "primary" && (await camView(B)).role === "secondary", 60000);
    // the referee in 심판 모드
    await referee.locator('[data-act="ref-enter"]').click();
    await referee.waitForSelector(".ref .ref-bar", { timeout: 10000 });
    await referee.evaluate(() => document.fullscreenElement && document.exitFullscreen()).catch(() => {});
    return { A: (await camView(A)).role, B: (await camView(B)).role };
  }, [["A", A]]);
  const B = pagesOf.B;

  // --before=1 (a tree without the hold, e.g. main): the same wrong pick, and what the screens show and what is entered
  // after the warning; captures named like the held ones, for the before / after pairs
  if (args.before === "1") {
    await step("before-wrong-pick", async () => {
      await settings(B, null, "앞쪽 레드 사이드");
      const id = await bId();
      await waitFor("A hears B red", async () => A.evaluate((id) => window.__ppv.multi.peers[id]?.near === 1, id), 10000);
      const since = Date.now();
      let warned = [];
      for (let i = 0; i < 4 && !warned.length; i++) { await feed(); warned = await warnsOf(id, since); }
      if (!warned.length) throw new Error("no warning on this tree");
      const n0 = (await pointsNow()).length;
      await feed({ bMissed: true });
      await feed();
      await A.waitForTimeout(2000);
      const enteredAfterWarn = (await pointsNow()).length - n0;
      const h = await holdOf(A), r = await refView(referee);
      await layout(A, "02-A-held-bar", [[393, 852], [852, 393]]);
      await layout(B, "02-B-held", [[393, 852], [852, 393]]);
      await layout(referee, "02-referee-held", [[393, 852], [852, 393]]);
      return { enteredAfterWarn, writes: A.__writes.length, pending: h.pending, chipA: h.chipCams, referee: r };
    }, [["A", A], ["referee", referee]]);
    throw Object.assign(new Error("before captures done"), { before: true });
  }

  await step("confirm-on-referee", async () => {
    // 확인 후 입력, picks right: the call waits on A (colour chosen) and on the referee screen; nothing enters by itself
    const n0 = (await pointsNow()).length;
    await feed();
    await waitFor("camera call", async () => (await holdOf(A)).pending?.pre != null, 15000);
    await waitFor("referee sees it", async () => (await refView(referee)).confirm, 10000);
    await A.waitForTimeout(1500);
    const waiting = (await pointsNow()).length - n0;
    const h = await holdOf(A), r = await refView(referee);
    await layout(A, "01-A-confirm-bar", [[393, 852], [852, 393]]);
    await layout(referee, "01-referee-confirm", [[393, 852], [852, 393]]);
    // one tap on the referee's 확정 enters the camera's call; the camera's question closes with that point
    const m0 = await match();
    const want = m0.ends[h.pending.pre];
    await referee.locator("[data-ask-confirm]").click();
    await waitFor("referee confirmed", async () => (await pointsNow()).length === n0 + 1, 10000);
    await waitFor("camera question closed", async () => !(await holdOf(A)).pending?.choice, 10000);
    const side = (await pointsNow()).at(-1);
    await waitFor("referee row gone", async () => !(await refView(referee)).ask, 10000);
    const res = { waiting, pre: h.pending.pre, bar: h.bar, referee: r, side, want, holdA: h.on };
    if (waiting !== 0 || h.on || h.pending.hold || !/카메라는 (블루|레드) · 맞으면 눌러 확정/.test(h.bar || "") || !/카메라 판정 확인/.test(r.ask || "") || r.asked.length !== 1 || side !== want) throw new Error(JSON.stringify(res));
    const lf = layoutFails(["01-"]);
    if (lf.length) throw new Error(`layout ${JSON.stringify(lf)}`);
    return res;
  }, [["A", A], ["referee", referee]]);

  await step("correct-no-hold", async () => {
    // the next calls confirmed on the camera: entered as the camera's, still no hold, no mark
    const n0 = (await pointsNow()).length;
    await feed();
    await confirmOn(A, n0);
    await feed();
    await confirmOn(A, n0 + 1);
    const h = await holdOf(A), r = await refView(referee), m = await match();
    const roster = await rosterHold();
    const res = { entered: (await pointsNow()).length - n0, holdA: h.on, referee: r, marks: m.marks, roster, warns: (await logOf(A)).filter((x) => x.end).length };
    if (res.entered !== 2 || h.on || r.hold || r.check || Object.keys(m.marks || {}).length || roster.some((c) => c.hold) || res.warns) throw new Error(JSON.stringify(res));
    return res;
  });

  let marked = [];
  await step("secondary-turned", async () => {
    await settings(B, null, "앞쪽 레드 사이드");
    const id = await bId();
    await waitFor("A hears B red", async () => A.evaluate((id) => window.__ppv.multi.peers[id]?.near === 1, id), 10000);
    // two rallies B missed (a body in the way): judged by A alone, entered by themselves, listed
    const before = await pointsNow();
    await feed({ bMissed: true });
    await confirmOn(A, before.length);
    await feed({ bMissed: true });
    await confirmOn(A, before.length + 1);
    const mid = await pointsNow();
    const listed = (await holdOf(A)).auto;
    // a rally both saw: the end check warns, and this rally already asks
    let warned = false;
    for (let i = 0; i < 3 && !warned; i++) { await feed(); warned = (await holdOf(A)).on; }
    if (!warned) throw new Error(`no hold after ${fed} rallies: ${JSON.stringify(report.fed.at(-1)?.sync)}`);
    await waitFor("marks written", async () => Object.keys((await match()).marks || {}).length >= 2, 10000);
    const afterWarn = await pointsNow();
    const h = await holdOf(A);
    await waitFor("referee hold", async () => (await refView(referee)).hold, 10000);
    await waitFor("B hold", async () => (await holdOf(B)).on, 10000);
    const hb = await holdOf(B), r = await refView(referee), roster = await rosterHold();
    await waitFor("referee hold row", async () => /점수 보류/.test((await refView(referee)).ask || ""), 10000);
    const rAsk = await refView(referee);
    await layout(A, "02-A-held-bar", [[393, 852], [852, 393]]);
    await layout(B, "02-B-held", [[393, 852], [852, 393]]);
    await layout(referee, "02-referee-held", [[393, 852], [852, 393]]);
    // the tap names an end colour: blue's player gets the point
    const m0 = await match();
    const blueSlot = m0.ends[0];
    await A.getByRole("button", { name: /블루 득점/ }).click();
    await waitFor("tapped point", async () => (await pointsNow()).length === afterWarn.length + 1, 10000);
    const tapped = (await pointsNow()).at(-1);
    // a held rally while nobody taps: nothing enters by itself
    const nHeld = (await pointsNow()).length;
    await feed();
    await A.waitForTimeout(3500);
    const nAfter = (await pointsNow()).length;
    const h2 = await holdOf(A);
    marked = Object.keys((await match()).marks || {}).map(Number).sort((a, b) => a - b);
    const res = { rAsk, enteredWhileMissed: mid.length - before.length, listed, enteredAtWarn: afterWarn.length - mid.length, pending: h.pending, bar: h.bar, chipA: h.chipCams, chipB: hb.chipCams, Bhold: hb.on, referee: r, roster, tapped, blueSlot, heldEntered: nAfter - nHeld, heldPending: h2.pending, marked };
    if (res.enteredWhileMissed !== 2 || listed.length !== 2 || res.enteredAtWarn !== 0 || !h.pending?.hold || h.bar !== `누가 땄나요? ${HOLD}` || !/(점수 )?보류 · 끝 색 반대\?/.test(h.chipCams || "") || !hb.on || !/점수 보류/.test(hb.chipCams || "")
      || !r.hold || r.cam !== HOLD || rAsk.confirm || rAsk.asked.length || !h.pending || h.pending.pre != null || !roster.some((c) => c.primary && c.hold) || tapped !== blueSlot || res.heldEntered !== 0 || !h2.pending?.hold
      || JSON.stringify(marked) !== JSON.stringify(listed.map((p) => p.index))) throw new Error(JSON.stringify(res));
    const lf = layoutFails(["02-"]);
    if (lf.length) throw new Error(`layout ${JSON.stringify(lf)}`);
    return res;
  }, [["A", A], ["B", B], ["referee", referee]]);

  await step("referee-marks", async () => {
    const m0 = await match();
    const [i, j] = marked;
    const r0 = await refView(referee);
    await shot(referee, "03-referee-mark-393");
    // [반대로] on the first: confirm, it goes to the other player, the later points stay
    await referee.locator('[data-act="mark-flip"]').click();
    await referee.locator("dialog[open] button", { hasText: "바꾸기" }).click();
    await waitFor("flipped", async () => (await match()).points[i] === 1 - m0.points[i], 10000);
    const m1 = await match();
    const r1 = await refView(referee);
    // the result is said on its own line under the cards, not as a toast over the 끝 색 확인 row and its buttons
    const done = await referee.evaluate(() => ({ line: document.querySelector("[data-ref-done]")?.innerText || null, toast: !!document.querySelector("#toast.show") }));
    await layout(referee, "03-referee-after-flip", [[393, 852]]);
    // [맞음] on the second: the mark clears, the point stays
    await referee.locator('[data-act="mark-ok"]').click();
    await waitFor("cleared", async () => !Object.keys((await match()).marks || {}).length, 10000);
    await waitFor("referee row gone", async () => !(await refView(referee)).check, 10000);
    const m2 = await match();
    const r2 = await refView(referee);
    const res = { before: r0.check, afterFlip: r1.check, after: r2.check, flipped: [m0.points[i], m1.points[i]], laterKept: JSON.stringify(m0.points.slice(i + 1)) === JSON.stringify(m1.points.slice(i + 1)), kept: m2.points[j] === m0.points[j], count: [m0.points.length, m2.points.length] };
    res.done = done;
    if (!/득점으로 바꿨어요$/.test(done.line || "") || done.toast || layoutFails(["03-"]).length || !r0.check || !r0.check.includes(`${i + 1}번째`) || !res.laterKept || !res.kept || r2.check || m2.points.length !== m0.points.length || !(r1.check || "").includes(`${j + 1}번째`)) throw new Error(JSON.stringify(res));
    return res;
  }, [["referee", referee]]);

  await step("fix-resume", async () => {
    await A.evaluate(() => window.__ppv.state.tour.pending && document.querySelector(".pointbar__pick--red")?.click());
    await settings(B, null, "앞쪽 블루 사이드");
    await waitHold(A, false);
    await waitFor("referee back", async () => !(await refView(referee)).hold, 10000);
    await waitFor("B back", async () => !(await holdOf(B)).on, 10000);
    const n0 = (await pointsNow()).length;
    await feed();
    const back = await waitFor("camera call again", async () => (await holdOf(A)).pending?.pre != null && (await holdOf(A)).pending, 15000);
    await shot(A, "04-A-resumed-393");
    await confirmOn(A, n0);
    const n1 = (await pointsNow()).length;
    const h = await holdOf(A), r = await refView(referee);
    await shot(referee, "04-referee-resumed-393");
    const res = { entered: n1 - n0, holdA: h.on, back, referee: r, chipA: h.chipCams };
    if (res.entered !== 1 || h.on || back.hold || r.hold || /점수 보류/.test(h.chipCams || "")) throw new Error(JSON.stringify(res));
    return res;
  }, [["A", A], ["referee", referee]]);

  await step("primary-turned", async () => {
    await settings(A, null, "앞쪽 레드 사이드");
    let held = false;
    for (let i = 0; i < 3 && !held; i++) { await feed(); held = (await holdOf(A)).on; }
    const h = await holdOf(A);
    await waitFor("referee hold", async () => (await refView(referee)).hold, 10000);
    await shot(A, "05-A-primary-turned-393");
    await A.evaluate(() => document.querySelector(".pointbar__pick--blue")?.click());
    await settings(A, null, "앞쪽 블루 사이드");
    await waitHold(A, false);
    await waitFor("referee back", async () => !(await refView(referee)).hold, 10000);
    const n0 = (await pointsNow()).length;
    await feed();
    await confirmOn(A, n0);
    const n1 = (await pointsNow()).length;
    const res = { held, pending: h.pending, entered: n1 - n0, after: (await holdOf(A)).on };
    if (!held || !h.pending?.hold || res.entered !== 1 || res.after) throw new Error(JSON.stringify(res));
    return res;
  }, [["A", A], ["referee", referee]]);

  await step("one-off-held", async () => {
    await settings(B, null, "앞쪽 레드 사이드");
    const id = await bId();
    await waitFor("A hears B red", async () => A.evaluate((id) => window.__ppv.multi.peers[id]?.near === 1, id), 10000);
    let held = false;
    for (let i = 0; i < 3 && !held; i++) { await feed(); held = (await holdOf(A)).on; }
    if (!held) throw new Error("no hold");
    await A.evaluate(() => document.querySelector(".pointbar__pick--blue")?.click());
    await B.context().close();
    delete pagesOf.B;
    await waitFor("A alone", async () => (await camView(A)).role === "single", 40000);
    const n0 = (await pointsNow()).length;
    await feed();
    await A.waitForTimeout(2500);
    const h = await holdOf(A);
    const n1 = (await pointsNow()).length;
    await layout(A, "06-A-alone-held", [[393, 852], [852, 393]]);
    await waitFor("referee hold", async () => (await refView(referee)).hold, 10000);
    const r = await refView(referee);
    await A.evaluate(() => document.querySelector(".pointbar__pick--red")?.click());
    // a person sets A's colour (the same blue, confirmed): the hold ends and A scores by itself
    await settings(A, null, "앞쪽 블루 사이드");
    await waitHold(A, false);
    const n2 = (await pointsNow()).length;
    await feed();
    await confirmOn(A, n2);
    const n3 = (await pointsNow()).length;
    const res = { role: h.role, pending: h.pending, enteredHeld: n1 - n0, chipEnds: h.chipEnds, referee: r, enteredAfter: n3 - n2 };
    if (h.role !== "single" || !h.pending?.hold || res.enteredHeld !== 0 || h.chipEnds !== HOLD || !r.hold || res.enteredAfter !== 1) throw new Error(JSON.stringify(res));
    const lf = layoutFails(["06-"]);
    if (lf.length) throw new Error(`layout ${JSON.stringify(lf)}`);
    return res;
  }, [["A", A], ["referee", referee]]);
} catch (err) {
  if (!err.before) throw err;
} finally {
  writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
  await browser.close().catch(() => {});
  proxy.stop(true);
  for (const p of procs) p.kill();
  const pass = steps.filter((s) => s.pass).length;
  console.log(`RESULT ${pass}/${steps.length} pass, errors ${report.errors.length}, out ${out}`);
  process.exitCode = pass === steps.length && steps.length >= (args.before === "1" ? 3 : 9) ? 0 : 1;
}
