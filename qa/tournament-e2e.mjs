// Vision -> tournament app end to end on one origin, as on the Funnel host: the tournament app
// owns "/" (and /api, /ws), the vision app is mounted at /vision. Both real servers run behind a
// small proxy here (WebSocket included). Chromium fake camera plays a rally that ends by itself.
// Steps: create a tournament -> camera, 4-tap calibration -> in the vision settings type the upload
// key and the tournament PIN, pick the match -> 확인 후 입력 (the default, owner decision 2026-11-01): the camera's call waits on the
// 누가 땄나요 bar and one tap on it (as a person would) enters it; with POINT_ENTRY "auto" the old auto entry "모든 포인트" is
// chosen instead -> tap 취소
// inside 3 s (the point is undone) -> the next point stays -> its clip is attached to that point
// -> a viewer on the tournament page (no PIN, opened before) sees the score and the clip live.
//   bun qa/tournament-e2e.mjs --vision=<checkout> --tournament=<checkout> --y4m=<file> --corners='<json, 1920x1080>' [--out=evidence/r3/tournament]
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCodes } from "./player-names.mjs";
import { assertPortsFree } from "./ports.mjs";
import { tx, withLang } from "./qa-lang.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out || "evidence/r3/tournament";
mkdirSync(out, { recursive: true });
const corners = JSON.parse(args.corners);
const tmp = mkdtempSync(join(tmpdir(), "ppv-tour-"));
const P = Number(args.port || 8870);
const ports = { proxy: P, tour: P + 1, vision: P + 2 };
await assertPortsFree(ports);

const procs = [
  spawn("bun", [join(args.tournament, "server.js")], { cwd: args.tournament, env: { ...process.env, PORT: String(ports.tour), DATA_DIR: join(tmp, "tour") }, stdio: ["ignore", "ignore", "inherit"] }),
  spawn("bun", [join(args.vision, "server.js")], {
    cwd: args.vision,
    env: { ...process.env, PORT: String(ports.vision), PPV_SAVE_DIR: join(tmp, "saves"), PPV_TOURNAMENT_URL: `http://127.0.0.1:${ports.tour}`, PPV_TOURNAMENT_DATA: join(join(tmp, "tour"), "tournament.json"), PPV_KEY_FILE: join(tmp, "upload-key"), PPV_SETUP_FILE: join(tmp, "setup.json") },
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
await Promise.all([up(ports.tour, "/api/state"), up(ports.vision, "/healthz")]);

const target = (path) => (path === "/vision" || path.startsWith("/vision/") ? ports.vision : ports.tour);
const proxy = Bun.serve({
  port: ports.proxy,
  hostname: "127.0.0.1",
  async fetch(req, server) {
    const url = new URL(req.url);
    if (req.headers.get("upgrade") === "websocket") return server.upgrade(req, { data: { path: url.pathname + url.search } }) ? undefined : new Response("no", { status: 400 });
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
      const back = new WebSocket(`ws://127.0.0.1:${ports.tour}${ws.data.path}`);
      ws.data.back = back;
      ws.data.queue = [];
      back.onopen = () => ws.data.queue.splice(0).forEach((m) => back.send(m));
      back.onmessage = (e) => ws.send(e.data);
      back.onclose = () => ws.close();
    },
    message(ws, m) {
      if (ws.data.back.readyState === 1) ws.data.back.send(m);
      else ws.data.queue.push(m);
    },
    close(ws) {
      ws.data.back?.close();
    },
  },
});
const origin = `http://127.0.0.1:${ports.proxy}`;
const api = async (path, body, pin) => {
  const res = await fetch(origin + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(pin ? { "x-pin": pin } : {}) }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const steps = [];
let page = null;
let viewer = null;
const shot = async (p, name) => p && p.screenshot({ path: `${out}/${String(steps.length).padStart(2, "0")}-${name}.png` }).catch(() => {});
const step = async (name, fn, shotOf = () => page) => {
  try {
    steps.push({ name, pass: true, detail: await fn() });
  } catch (err) {
    steps.push({ name, pass: false, detail: String(err.message || err).split("\n")[0] });
  }
  await shot(shotOf(), name);
  return steps[steps.length - 1].pass;
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

let pin = null;
let matchId = null;
const match = async () => (await api("/api/state")).body.derived.matches.find((m) => m.id === matchId);
const browser = withLang(await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${args.y4m}`, "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
}));
try {
  await step("create-tournament", async () => {
    const r = await api("/api/tournament", { name: "비전 연동 시험", players: await withCodes(origin, ["블루선수", "레드선수", "셋째", "넷째"]), format: "double", bestOf: 3 });
    if (r.status !== 200) throw new Error(`create ${r.status} ${JSON.stringify(r.body)}`);
    pin = r.body.pin;
    matchId = r.body.state.derived.matches.find((m) => m.status === "ready").id;
    // Deciding game at 4:4 (games 1:1), so whoever wins the next point reaches 5 and the
    // players must change ends (ITTF 2.15.3): the vision app should say so and flip colours.
    const seed = [...Array(11).fill(0), ...Array(11).fill(1), 0, 1, 0, 1, 0, 1, 0, 1];
    for (let i = 0; i < seed.length; i++) {
      const p = await api("/api/action", { type: "point", matchId, side: seed[i], seq: i }, pin);
      if (p.status !== 200) throw new Error(`seed point ${i}: ${p.status}`);
    }
    return { matchId, seeded: "games 1:1, deciding game 4:4" };
  }, () => null);

  const vctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  await vctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  viewer = await vctx.newPage();
  await step("viewer-open", async () => {
    await viewer.goto(origin + "/", { waitUntil: "networkidle" });
    return { title: await viewer.title() };
  }, () => viewer);

  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, permissions: ["camera"] });

  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  // Record what the app speaks (the headless browser has no audio out).
  await ctx.addInitScript(() => {
    window.__said = [];
    const synth = window.speechSynthesis;
    if (synth) {
      const speak = synth.speak.bind(synth);
      synth.speak = (u) => {
        window.__said.push(u.text);
        try { speak(u); } catch {}
      };
    }
  });
  page = await ctx.newPage();
  // diagnostics: page errors, and the camera's state every 20 s (a missing first point otherwise just waits)
  page.on("pageerror", (e) => console.log(`PAGEERROR ${String(e && (e.stack || e.message) || e).replace(/\s+/g, " ").slice(0, 600)}`));
  page.on("console", (m) => { if (m.type() === "error") console.log(`CONSOLE_ERROR ${m.text().replace(/\s+/g, " ").slice(0, 300)}`); else if (/^ppv:/.test(m.text())) console.log(`CONSOLE_PPV ${new Date().toISOString().slice(11, 19)} ${m.text().replace(/\s+/g, " ").slice(0, 300)}`); });
  setInterval(() => page.evaluate(() => {
    const st = window.__ppv && window.__ppv.state;
    if (!st) return null;
    const t = st.tour || {};
    const pl = window.__ppv.pipeline;
    return { mode: st.mode, tracking: st.tracking, fps: st.perf && st.perf.fps, src: st.source, tour: { connected: t.connected, mode: t.mode, matchId: t.matchId, pending: !!t.pending, error: t.error || null, near: t.near }, history: (st.history || []).length, rally: !!(pl && pl.rally && pl.rally.rally), multi: st.multi && { count: st.multi.count, role: st.multi.role } };
  }).then((x) => console.log(`STATE ${new Date().toISOString().slice(11, 19)} ${JSON.stringify(x)}`)).catch(() => {}), 20000).unref();
  // The camera screen rewrites the address bar to the one address while loading (a same-document
  // navigation), so wait for the app itself rather than for network idle.
  await page.goto(origin + "/vision/", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__ppv, null, { timeout: 30000 });
  const key = readFileSync(join(tmp, "upload-key"), "utf8").trim();
  await step("camera-calibrate", async () => {
    await page.getByRole("button", { name: tx(/카메라 시작/, /Start camera/) }).tap();
    await page.waitForFunction(() => ["calibrating", "running", "error"].includes(window.__ppv.state.mode), null, { timeout: 120000 });
    const s = await page.evaluate(() => window.__ppv.state);
    if (s.mode === "error") throw new Error(JSON.stringify(s.error));
    // A value left over from an earlier run would pass the wait below without this camera calibrating.
    console.log(`CALIBRATION_BEFORE mode=${s.mode} calibration=${JSON.stringify(s.calibration)}`);
    if (s.calibration || s.mode !== "calibrating") throw new Error("camera already calibrated before the taps");
    const tapped = corners.map((c) => ({ x: c.x * (s.video.width / 1920), y: c.y * (s.video.height / 1080) }));
    for (const c of corners) {
      const pt = await page.evaluate(([x, y]) => {
        const v = document.querySelector("video");
        const r = v.getBoundingClientRect();
        const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
        return { x: r.left + (r.width - v.videoWidth * k) / 2 + x * k, y: r.top + (r.height - v.videoHeight * k) / 2 + y * k };
      }, [c.x * (s.video.width / 1920), c.y * (s.video.height / 1080)]);
      await page.touchscreen.tap(pt.x, pt.y);
      await page.waitForTimeout(250);
    }
    await page.getByRole("button", { name: tx(/확인/, /OK/) }).tap();
    const calibStart = Date.now();
    await page.waitForFunction(() => window.__ppv.state.mode === "running" && !!window.__ppv.state.calibration, null, { timeout: 30000 });
    const calibratedMs = Date.now() - calibStart;
    console.log(`CALIBRATED_MS ${calibratedMs}`);
    const applied = await page.evaluate(() => window.__ppv.state.calibration.corners);
    const worst = Math.max(...tapped.map((c, i) => Math.hypot(applied[i].x - c.x, applied[i].y - c.y)));
    console.log(`CALIBRATED_CORNERS applied=${JSON.stringify(applied)} tapped=${JSON.stringify(tapped)} worstPx=${worst.toFixed(1)}`);
    if (worst > 60) throw new Error(`applied corners are not the tapped ones: ${worst.toFixed(1)} px`);
    return { video: s.video, calibratedMs };
  });

  await step("settings-link", async () => {
    await page.getByRole("button", { name: tx(/설정/, /Settings/) }).first().tap();
    await page.locator("input[name=upload-key]").fill(key);
    await page.getByRole("button", { name: tx(/열쇠 저장/, /Save key/) }).tap();
    await page.waitForFunction(() => window.__ppv.state.save.keySet, null, { timeout: 10000 });
    await page.locator("input[name=tournament-pin]").fill(pin);
    await page.getByRole("button", { name: tx(/^연결$/, /^Connect$/) }).tap();
    await page.waitForFunction(() => window.__ppv.state.tour.connected && window.__ppv.state.tour.matchId, null, { timeout: 10000 });
    await page.locator("select.select").selectOption(matchId);
    await page.waitForFunction((id) => window.__ppv.state.tour.matchId === id, matchId, { timeout: 5000 });
    const entry = await page.evaluate(() => window.__ppv.state.tour.entry);
    if (entry === "confirm") {
      // 확인 후 입력: no auto-entry choice, the note says how points go in
      const shown = await page.evaluate((name) => ({ note: !!document.querySelector('[data-entry="confirm"]:not([hidden])'), seg: !document.querySelector(`.seg[aria-label="${name}"]`).hidden }), tx("자동 입력", "Auto entry"));
      if (!shown.note || shown.seg) throw new Error(`confirm settings: ${JSON.stringify(shown)}`);
      // a person at the camera confirms each call the moment it shows (one tap on the chosen colour)
      // a weak call (one bounce, a short piece) pre-chooses nothing and names the camera's guess in words; the
      // person reads it and taps that colour, as multicam-e2e does (else a one-bounce run never enters a point)
      await page.evaluate(() => setInterval(() => {
        const p = window.__ppv.state.tour.pending;
        if (!p?.choice) return;
        const b = document.querySelector(".pointbar__pick--pre") || (p.guess === 0 || p.guess === 1 ? document.querySelector(p.guess === 0 ? ".pointbar__pick--blue" : ".pointbar__pick--red") : null);
        if (b && !b.closest("[hidden]")) b.click();
      }, 50));
    // diagnostics: every recorder start/stop on the camera page, with whether a clip came back (ppv: lines)
    await page.evaluate(() => {
      const r = window.__ppv.recorder;
      if (!r || r.__qa) return;
      r.__qa = true;
      const t = () => new Date().toISOString().slice(11, 23);
      const pl = window.__ppv.pipeline, on = pl.onEvent;
      // analysis frame times seen by the rally engine (seconds), to tell a cut after an analysis pause
      const frames = [];
      const eng = pl.rally;
      if (eng && !eng.__qa) {
        eng.__qa = true;
        const up = eng.update.bind(eng);
        eng.update = (ft, ball, players) => { frames.push({ ft, ball: !!ball }); if (frames.length > 400) frames.shift(); return up(ft, ball, players); };
      }
      const pauseInfo = () => {
        if (frames.length < 2) return "frames=0";
        const last = frames[frames.length - 1].ft, w = frames.filter((f) => f.ft >= last - 3);
        let maxGap = 0, gaps = 0;
        for (let i = 1; i < w.length; i++) { const g = w[i].ft - w[i - 1].ft; if (g > maxGap) maxGap = g; if (g > 0.25) gaps++; }
        const lastGap = frames.length > 1 ? last - frames[frames.length - 2].ft : 0;
        return `win3s frames=${w.length} ball=${w.filter((f) => f.ball).length} maxGap=${maxGap.toFixed(2)} gaps>0.25=${gaps} lastGap=${lastGap.toFixed(2)} stable=${!!window.__ppv.state.stable?.compact}`;
      };
      const recState = () => `rec=${!!r.rec} queued=${!!r.queued} stopping=${!!r.stopping}`;
      pl.onEvent = (e) => { if (e.type === "rallyStart" || e.type === "rallyEnd") console.log(`ppv: qa rally ${e.type} ${t()} why=${e.why || ""} dur=${e.durationS != null ? e.durationS.toFixed(2) : ""} shots=${e.shots ?? ""} b=${e.bounces ? e.bounces.length : ""} ${e.type === "rallyEnd" ? pauseInfo() : ""} | before ${recState()}`); on(e); if (e.type === "rallyStart" || e.type === "rallyEnd") console.log(`ppv: qa rally ${e.type} ${t()} | after ${recState()}`); };
      const st = r.start.bind(r), sp = r.stop.bind(r);
      r.start = (m) => { const before = { rec: !!r.rec, queued: !!r.queued, stopping: !!r.stopping }; const x = st(m); console.log(`ppv: qa rec start ${t()} ${JSON.stringify(before)} -> rec=${!!r.rec} queued=${!!r.queued}`); return x; };
      r.stop = () => { const before = { rec: !!r.rec, queued: !!r.queued, stopping: !!r.stopping }; const p = sp(); console.log(`ppv: qa rec stop ${t()} ${JSON.stringify(before)}`); Promise.resolve(p).then((c) => console.log(`ppv: qa rec clip ${t()} ${c ? Math.round((c.video?.size || 0) / 1024) + "KB" : "null"}`)); return p; };
    });
    } else {
      await page.getByRole("button", { name: tx("모든 포인트 자동", "Every point") }).tap();
      await page.waitForFunction(() => window.__ppv.state.tour.mode === "all", null, { timeout: 5000 });
    }
    await page.screenshot({ path: `${out}/settings-linked.png` });
    const t = await page.evaluate(() => window.__ppv.state.tour);
    await page.locator(`.popover button[aria-label='${tx("설정 닫기", "Close settings")}']`).tap();
    return { matchId: t.matchId, near: t.near, entry: t.entry, status: await page.locator(".tourlink").count() };
  });

  // judge log: every rally the linked camera judges (ended by itself, at least one bounce) is counted here,
  // to compare with the call lines the tournament wrote to judge-log.jsonl at the end
  await page.evaluate(() => {
    const pl = window.__ppv.pipeline, on = pl.onEvent;
    window.__qaJudged = 0;
    pl.onEvent = (e) => {
      const t = window.__ppv.state.tour;
      if (e.type === "rallyEnd" && e.why !== "stop" && e.bounces && e.bounces.length && t.connected && t.matchId) window.__qaJudged++;
      on(e);
    };
  });

  await step("point-entered-then-cancelled", async () => {
    // The referee has 3 s. On a slow test machine a Playwright tap can wait for the page to
    // settle longer than that, so click 취소 inside the page the moment the first bar shows.
    const pending = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const tick = () => {
            const p = window.__ppv.state.tour.pending;
            const btn = document.querySelector(".pointbar__cancel");
            if (p && !p.choice && btn && !btn.hidden) {
              const snap = JSON.parse(JSON.stringify(p));
              btn.click();
              return resolve(snap);
            }
            requestAnimationFrame(tick);
          };
          tick();
        }),
    );
    await waitFor("undo", async () => (await match()).points.length <= 30, 5000);
    await page.waitForFunction(() => !window.__ppv.state.tour.pending || window.__ppv.state.tour.pending.seq !== 31, null, { timeout: 5000 });
    const said = await page.evaluate(() => window.__said.filter((t) => t.trim()));
    const nearAfter = await page.evaluate(() => window.__ppv.state.tour.near);
    const callout = said.find((t) => t.includes(tx("엔드를 바꾸세요", "Change ends")));
    if (pending.seq !== 31) throw new Error(`first auto point had seq ${pending.seq} (30 seeded)`);
    if (!callout || !tx(/사이드 5/, /(Blue|Red) 5/).test(callout)) throw new Error(`no end-change call-out at 5: ${JSON.stringify(said)}`);
    if (pending.flipped !== true) throw new Error("colours did not flip at 5 in the deciding game");
    if (nearAfter !== 0) throw new Error(`cancel did not flip the colours back (near=${nearAfter})`);
    if (!said.includes(tx("취소", "Cancel"))) throw new Error(`no 취소 call-out: ${JSON.stringify(said)}`);
    return { pending, afterCancel: (await match()).points.length, said, nearAfterCancel: nearAfter, notice: await page.evaluate(() => window.__ppv.state.tour.notice) };
  });

  await step("next-point-stays-with-clip", async () => {
    await page.waitForFunction(() => window.__ppv.state.tour.pending && !window.__ppv.state.tour.pending.choice, null, { timeout: 300000, polling: 50 });
    await page.locator(".pointbar").screenshot({ path: `${out}/pointbar.png`, timeout: 2500 }).catch(() => {});
    await waitFor("second point", async () => (await match()).points.length === 31, 5000);
    // the point gets its own rally's clip, or none when the recorder turned that rally down (still finishing
    // one clip with another waiting): the camera lists such points in state.clipRefused
    const refusedAt = (i) => page.evaluate((i) => (window.__ppv.state.clipRefused || []).some((r) => r.matchId === "m1" && r.index === i), i);
    const m = await waitFor("clip attached (or recorded as refused)", async () => {
      const x = await match();
      return (x.clips && x.clips[30]) || (await refusedAt(30)) ? x : null;
    }, 120000);
    // no clip may sit on two points: same share link, or the same video bytes saved twice
    const seen = new Map();
    for (const [i, url] of Object.entries(m.clips || {})) {
      const id = String(url).split("/").pop();
      const dir = join(tmp, "saves", id);
      const file = readdirSync(dir).find((n) => n.startsWith("video."));
      const key = createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");
      if (seen.has(key)) throw new Error(`point ${i} has the clip of point ${seen.get(key)}`);
      seen.set(key, i);
    }
    return { points: m.points.length, clip: m.clips?.[30] ?? null, noClip: !m.clips?.[30], clips: Object.keys(m.clips || {}).length, said: await page.evaluate(() => window.__said.filter((t) => t.trim()).slice(-2)) };
  });

  await step("viewer-sees-clip-live", async () => {
    await viewer.waitForSelector("video", { timeout: 15000 });
    const v = await viewer.evaluate(
      () =>
        new Promise((resolve) => {
          const el = document.querySelector("video");
          const done = () => resolve({ src: el.currentSrc || el.src, w: el.videoWidth, error: el.error && el.error.code, text: document.body.innerText.slice(0, 400) });
          if (el.readyState >= 1) return done();
          el.addEventListener("loadeddata", done, { once: true });
          el.addEventListener("error", done, { once: true });
          setTimeout(done, 15000);
        }),
    );
    if (!(v.w > 0) || v.error) throw new Error(`viewer video ${JSON.stringify(v)}`);
    return v;
  }, () => viewer);

  await step("judge-log", async () => {
    const file = join(tmp, "tour", "judge-log.jsonl");
    const read = () => { try { return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    const judged = await page.evaluate(() => window.__qaJudged);
    const lines = await waitFor("judge-log call lines", async () => { const l = read(); return l.filter((x) => x.t === "call").length >= judged ? l : null; }, 5000).catch(() => read());
    writeFileSync(`${out}/judge-log.jsonl`, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const calls = lines.filter((x) => x.t === "call").length;
    const summary = await (await fetch(`${origin}/api/judge/summary`)).json();
    writeFileSync(`${out}/judge-summary.json`, JSON.stringify(summary, null, 2));
    const kinds = Object.fromEntries(["call", "drop", "point", "undo", "flip", "clip"].map((k) => [k, lines.filter((x) => x.t === k).length]));
    const camera = lines.filter((x) => (x.t === "point" || x.t === "undo") && x.by === "camera").length;
    console.log(`JUDGE_LOG judged=${judged} calls=${calls} kinds=${JSON.stringify(kinds)} total=${JSON.stringify(summary.total)}`);
    if (calls !== judged) throw new Error(`judge-log has ${calls} call lines for ${judged} judged rallies`);
    if (!camera) throw new Error("no point or undo line from the camera (x-ppv-by)");
    // every point the camera entered is joined to its call (none counted as a point the camera missed), and the
    // first point, cancelled at once, is a fake call
    const unjoined = summary.points.filter((p) => p.by === "camera" && p.outcome === "no_call").length;
    if (unjoined) throw new Error(`${unjoined} camera points have no call: ${JSON.stringify(summary.total)}`);
    if (summary.total.cancelled < 1) throw new Error(`the cancelled first point is not a fake call: ${JSON.stringify(summary.total)}`);
    return { judged, calls, kinds, total: summary.total };
  });
} finally {
  const report = { steps, tmp };
  writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
  proxy.stop(true);
  for (const p of procs) p.kill();
}
console.log(`TOURNAMENT_E2E ${steps.map((s) => `${s.name}=${s.pass ? "PASS" : "FAIL"}`).join(" ")}`);
for (const s of steps) if (!s.pass) console.log(`FAIL ${s.name} ${s.detail}`);
process.exit(steps.every((s) => s.pass) ? 0 : 1);
