// 카메라 여러 대 (docs/multicam.md), measured on the real apps: the tournament app at "/" and vision at
// "/vision/" behind one proxy (one origin with WebSocket, as on the Funnel host), isolated data in a
// temp dir. Two Chromium phones (393x852) with fake cameras (a looping test clip in a canvas stream),
// a referee screen and a spectator TV (1920x1080). WPE WebKit cannot run two cameras at once (a second
// camera page crashes it), so both phones are Chromium here.
// The proxy can delay WebSocket messages each way (--upMs client->server, --downMs server->client),
// so the clock sync can be measured with an uneven path, and can cut one phone's socket.
//   bun qa/multicam-e2e.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm>
//     [--clipA=<webm, phone A's own clip, e.g. with a body hiding part of the table>] [--port=8960]
//     [--upMs=30 --downMs=90] [--playS=90] [--out=<dir>]
// Steps (each PASS/FAIL with numbers, screenshots in --out):
//   pin-gate      attach without / with a wrong PIN is 403; a camera phone without the PIN stays off the list
//   one-camera    A alone: "카메라 1대" on camera, referee and spectator; A scores as one camera
//   two-cameras   B with the PIN joins: "카메라 2대 합치기" everywhere, the switch toast on all three
//   clock         each phone's server-clock offset vs the true one (same host clock), with the proxy delays
//   merged-play   both film --playS s: points entered == rallies the primary judged; B never writes a point
//                 (확인 후 입력: the pre-chosen call on A's 누가 땄나요 is tapped 1.5 s after it shows, as a person would)
//   conflict      two cameras that saw the last bounce on different ends: 누가 땄나요, nothing entered
//   drop-b        B leaves: back to "카메라 1대" with the toast, A goes on scoring
//   drop-a        A leaves while B is on: B becomes primary and scores
//   rec           with --rec=1 (phones get the upload key): the secondary never uploads a rally; the phone
//                 promoted to primary uploads clips whose overlay track carries the layout and covers the
//                 video within 2 frames at both ends
import { chromium } from "playwright";
import { withCodes } from "./player-names.mjs";
import { assertPortsFree } from "./ports.mjs";
import { tx, withLang } from "./qa-lang.mjs";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out || "evidence/multicam";
mkdirSync(out, { recursive: true });
const corners = JSON.parse(args.corners || '[{"x":355,"y":634},{"x":557,"y":519},{"x":1339,"y":535},{"x":1486,"y":659}]');
const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ppv-multicam-"));
const P = Number(args.port || 8960);
const ports = { proxy: P, tour: P + 1, vision: P + 2 };
await assertPortsFree(ports);
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
const fakeCamera = (src) => {
  const target = window.MediaDevices ? window.MediaDevices.prototype : navigator.mediaDevices;
  target.getUserMedia = async () => {
    const v = document.createElement("video");
    v.src = src;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none";
    document.documentElement.append(v);
    await v.play();
    // WPE can leave a looped clip stuck at its end (currentTime = duration, not paused, not ended), which
    // freezes the fake camera: rewind 0.2 s before the end, and resume, from where it stopped, a clip whose time stood still
    // over 1 s while playing. The harness's own pauses (people fixing the score) are left alone.
    window.__qaClip = { rewinds: 0, stalls: 0 };
    let lastT = -1, sameSince = performance.now();
    setInterval(() => {
      const now = performance.now();
      if (v.paused && !v.ended) { sameSince = now; return; }
      if (v.currentTime !== lastT) { lastT = v.currentTime; sameSince = now; }
      const d = v.duration || 0;
      if (d && v.currentTime >= d - 0.2) { window.__qaClip.rewinds++; v.currentTime = 0; }
      else if (v.ended || now - sameSince > 1000) { window.__qaClip.stalls++; v.currentTime = v.ended ? 0 : v.currentTime; v.play().catch(() => {}); sameSince = now; }
    }, 100);
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
const watchTexts = (words) => {
  window.__seen = [];
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

const browser = withLang(await chromium.launch());
const pagesOf = {};
const phone = async (name, preset) => {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: `Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36 ppv-phone-${name}` });
  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  await ctx.addInitScript(fakeCamera, `${origin}/__qa/cam-${name}.webm`);
  await ctx.addInitScript(watchTexts, [tx("카메라 2대로 전환", "Switched to 2 cameras"), tx("카메라 1대로 전환", "Switched to 1 camera")]);
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
  p.__uploads = [];
  p.on("response", async (r) => {
    if (r.url().endsWith("/api/rallies") && r.request().method() === "POST" && r.status() === 201) p.__uploads.push({ at: Date.now(), id: (await r.json().catch(() => ({}))).id });
  });
  p.on("request", (r) => {
    if (r.url().endsWith("/api/action") && r.method() === "POST") p.__writes.push({ at: Date.now(), body: r.postData(), camera: r.headers()["x-ppv-camera"] || null });
  });
  pagesOf[name] = p;
  return p;
};
const screen = async (name, role, viewport, preset = {}) => {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  await ctx.addInitScript(watchTexts, [tx("카메라 2대로 전환", "Switched to 2 cameras"), tx("카메라 1대로 전환", "Switched to 1 camera")]);
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
const startCamera = async (p) => {
  await p.goto(origin + "/", { waitUntil: "load" });
  await p.waitForFunction(() => !!window.__ppv, null, { timeout: 30000 });
  await p.getByRole("button", { name: tx(/카메라 시작/, /Start camera/) }).click();
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
    await p.getByRole("button", { name: tx(/확인/, /OK/) }).click();
    await p.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 20000 });
  }
};
// the tournament's camera-vs-referee record (data/judge-log.jsonl), one parsed line each
const judgeLines = () => { try { return readFileSync(join(tmp, "tour", "judge-log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
let endColour = null; // B's camera id and near colour once decided (merged-play), used by conflict
const camView = (p) => p.evaluate(() => ({ count: window.__ppv.multi.count, role: window.__ppv.multi.role, chip: document.querySelector(".strip .chip--role")?.innerText || null, cams: document.querySelector(".chip--cams:not([hidden])")?.innerText || null, offset: window.__ppv.multi.clock.offset, errMs: window.__ppv.multi.clock.errMs, timeOrigin: performance.timeOrigin, log: window.__ppv.multi.log.slice(), attached: !!window.__ppv.venue.attached }));
const bodyHas = (p, text) => p.evaluate((t) => document.body.innerText.includes(t), text);
const seen = (p, text, since) => p.evaluate(([t, s]) => window.__seen.filter((x) => x.text === t && x.at >= s), [text, since]);
const clipPlay = (p, on) => p.evaluate((on) => { const v = [...document.querySelectorAll("video")].find((x) => x.src.includes("/__qa/cam-")); if (v) on ? v.play() : v.pause(); return !!v; }, on).catch(() => false);

let pin = null;
const recPages = { sec: [], a: null };
let matchId = null;
const match = async () => (await api("/api/state")).body.derived.matches.find((m) => m.id === matchId);
// the camera left alone keeps judging: a point entered, or its own 누가 땄나요 for an unsure call
const judgesAlone = async (p, n0) => (await match()).points.length > n0 || !!(await p.evaluate(() => window.__ppv.state.tour.pending?.choice).catch(() => false));

try {
  await step("create-tournament", async () => {
    const r = await api("/api/tournament", { name: "카메라 두 대 시험", players: await withCodes(`http://127.0.0.1:${ports.tour}`, ["블루선수", "레드선수", "셋째", "넷째"]), format: "double", bestOf: 5 });
    if (r.status !== 200) throw new Error(`create ${r.status}`);
    pin = r.body.pin;
    matchId = r.body.state.derived.matches.find((m) => m.status === "ready").id;
    return { matchId };
  });
  // --stable=off|auto sets the 판정 안정 모드 setting on both camera phones (default: the app's own, auto)
  const upKey = args.rec ? readFileSync(join(tmp, "upload-key"), "utf8").trim() : null;
  const camPreset = (withPin) => ({ ...(upKey ? { "ppv.uploadKey": JSON.stringify(upKey) } : {}), "pp-role": "camera", ...(withPin ? { "pp-pin": pin } : {}), "ppv.tourMode": JSON.stringify("all"), "ppv.tourMatch": JSON.stringify(matchId), ...(args.stable ? { "ppv.stableMode": JSON.stringify(args.stable) } : {}) });

  const A = await phone("A", camPreset(true));
  recPages.a = A;
  const referee = await screen("referee", "referee", { width: 1024, height: 768 }, { "pp-pin": pin });
  const tv = await screen("tv", "viewer", { width: 1920, height: 1080 });

  // ---- pin-gate: the attach call itself, then a camera phone with no PIN ----
  await step("pin-gate", async () => {
    const none = await api("/api/vision/attach", { conn: "x", id: "y", matchId });
    const wrong = await api("/api/vision/attach", { conn: "x", id: "y", matchId }, { "x-pin": String((Number(pin) + 1) % 10000).padStart(pin.length, "0") });
    const N = await phone("B", camPreset(false));
    await startCamera(N);
    await N.waitForTimeout(6000);
    const v = await camView(N);
    const roster = await A.evaluate(() => window.__ppv.venue.cameras.length).catch(() => null);
    await N.context().close();
    delete pagesOf.B;
    if (none.status !== 403 || wrong.status !== 403) throw new Error(`attach without PIN ${none.status}, wrong PIN ${wrong.status}`);
    if (v.attached || v.count) throw new Error(`no-PIN phone attached: ${JSON.stringify(v)}`);
    return { attachNoPin: none.status, attachWrongPin: wrong.status, noPinPhone: { attached: v.attached, count: v.count, chip: v.chip } };
  });

  await step("one-camera", async () => {
    await startCamera(A);
    await waitFor("A attached alone", async () => (await camView(A)).count === 1, 20000);
    await waitFor("referee shows 1대", () => bodyHas(referee, tx("카메라 1대", "1 camera")), 15000);
    await waitFor("tv shows 1대", () => bodyHas(tv, tx("카메라 1대", "1 camera")), 15000);
    const v = await camView(A);
    if (v.role !== "single" || !tx(/카메라 1대/, /1 camera/).test(v.chip || "")) throw new Error(JSON.stringify(v));
    return { role: v.role, chip: v.chip };
  }, [["A", A], ["referee", referee], ["tv", tv]]);

  let switchAt = Date.now();
  const B = await phone("B", camPreset(true));
  recPages.sec.push(B);
  await step("two-cameras", async () => {
    switchAt = Date.now();
    // capture each screen while its switch toast shows (it lasts about 3 s)
    const toastShot = (p, label) => p.waitForFunction((w) => {
        const el = document.getElementById("toast");
        return el?.classList.contains("show") && el.textContent.includes(w) && getComputedStyle(el).opacity === "1";
      }, tx("카메라 2대로 전환", "Switched to 2 cameras"), { timeout: 60000, polling: 50 })
      .then(async () => {
        report.toastPlace ??= {};
        // what the fully shown toast sits on: buttons, inputs, and text that is only digits (score numbers)
        report.toastPlace[label] = await p.evaluate(() => {
          const t = document.getElementById("toast").getBoundingClientRect();
          const hit = (r) => r.width > 0 && r.height > 0 && r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top;
          const under = [...document.querySelectorAll("button, a, input, select, [role=button], body *")]
            .filter((e) => e.id !== "toast" && !e.closest("#toast") && (e.matches("button, a, input, select, [role=button]") || (/^\d+$/.test(e.textContent.trim()) && !e.children.length)))
            .filter((e) => hit(e.getBoundingClientRect()))
            .map((e) => `${e.tagName.toLowerCase()}${e.className ? "." + String(e.className).split(" ")[0] : ""}:${e.textContent.trim().slice(0, 12)}`);
          return { toast: [t.left, t.top, t.width, t.height].map(Math.round), opacity: getComputedStyle(document.getElementById("toast")).opacity, under };
        });
        await p.screenshot({ path: `${out}/04-toast-${label}.png` });
      }).catch(() => {});
    const toastShots = [toastShot(referee, "referee"), toastShot(tv, "tv"), toastShot(A, "A")];
    // phone A's count over time: when it changes, the list it has and how long ago it heard each camera
    await A.evaluate(() => {
      window.__countLog = [];
      let last = null;
      setInterval(() => {
        const m = window.__ppv.multi, now = Date.now();
        const key = `${m.count}/${m.role}/${m.cams.map((c) => c.id).join(",")}`;
        if (key === last) return;
        last = key;
        window.__countLog.push({ at: now, count: m.count, role: m.role, clock: m.clock.ok, cams: m.cams.map((c) => ({ id: c.id.slice(0, 6), fresh: c.fresh, heardAgoMs: m.peers[c.id] ? now - m.peers[c.id].at : null, counted: m.counted.has(c.id) })) });
      }, 200);
    });
    await startCamera(B);
    await waitFor("both phones in 2-camera mode", async () => (await camView(A)).role === "primary" && (await camView(B)).role === "secondary", 30000);
    await waitFor("referee shows 2대 합치기", () => bodyHas(referee, tx("카메라 2대 합치기", "Merge 2 cameras")), 15000);
    await waitFor("tv shows 2대 합치기", () => bodyHas(tv, tx("카메라 2대 합치기", "Merge 2 cameras")), 15000);
    await Promise.all(toastShots);
    const toasts = {};
    for (const [n, p] of [["A", A], ["B", B], ["referee", referee], ["tv", tv]]) toasts[n] = (await seen(p, tx("카메라 2대로 전환", "Switched to 2 cameras"), switchAt)).length;
    const a = await camView(A), b = await camView(B);
    if (!toasts.A || !toasts.referee || !toasts.tv) throw new Error(`switch toast missing: ${JSON.stringify(toasts)}`);
    report.countLogA = await A.evaluate(() => window.__countLog.map((e) => ({ ...e, at: e.at - window.__countLog[0].at })));
    if (!tx(/카메라 2대 합치기/, /2 cameras merged/).test(a.chip || "") || !tx(/카메라 2대 합치기/, /2 cameras merged/).test(b.chip || "")) throw new Error(`chips ${a.chip} / ${b.chip}`);
    return { toasts, chipA: a.chip, chipB: b.chip, camsA: a.cams, camsB: b.cams };
  }, [["A", A], ["B", B], ["referee", referee], ["tv", tv]]);

  await step("clock", async () => {
    await waitFor("clock samples", async () => (await camView(A)).errMs != null && (await camView(B)).errMs != null, 15000);
    await Bun.sleep(3000);
    const r = {};
    for (const [n, p] of [["A", A], ["B", B]]) {
      const v = await camView(p);
      // same host: the server's Date.now() and this page's timeOrigin + performance.now() share one clock
      r[n] = { offsetMs: Math.round(v.offset), trueOffsetMs: Math.round(v.timeOrigin), errorMs: Math.round(Math.abs(v.offset - v.timeOrigin)), shownErrMs: v.errMs };
    }
    r.betweenPhonesMs = Math.abs(r.A.offsetMs - r.A.trueOffsetMs - (r.B.offsetMs - r.B.trueOffsetMs));
    r.proxy = delay;
    if (r.A.errorMs > 50 || r.B.errorMs > 50) throw new Error(`clock error over 50 ms: ${JSON.stringify(r)}`);
    return r;
  });

  await step("merged-play", async () => {
    // Since 1.1.9 a person picks each phone's end colour and merging reads it from the start; the shared
    // bounces only warn. Both phones film the same table from the same place, so B's pick is A's: record it
    // on A the way B's status would (EndSync.pick), so the conflict step below knows B's camera id.
    endColour = await A.evaluate(() => {
      const { multi, venue, state } = window.__ppv;
      const me = venue.me();
      const id = multi.cams.find((c) => !me || c.id !== me.id)?.id || null;
      const near = state.tour.near === 1 ? 1 : 0;
      if (id && multi.endSync) multi.endSync.pick(id, near);
      return { id, near, state: id && multi.endSync ? multi.endSync.get(id).state : null };
    });
    if (!endColour.id || endColour.state !== "ok") throw new Error(`end colour not decided: ${JSON.stringify(endColour)}`);
    const before = (await match()).points.length;
    const writesB = B.__writes.length;
    const logA0 = (await camView(A)).log.length;
    const judgeLines0 = judgeLines().length;
    // 확인 후 입력 (POINT_ENTRY "confirm", 1.1.12): every judged point waits on A's 누가 땄나요 with the camera's
    // call pre-chosen; a person taps it about 1.5 s later and it goes in with its 3 s cancel. Two cameras that
    // disagree (ask) or a hold pre-choose nothing: those are left alone, as the "all" count below already
    // leaves them out. The tapper runs until the conflict step has let the last of them settle.
    // A question already open (a rally judged before this window, from the steps above) is left as it is: the
    // count below is the rallies judged inside the window, and the next judged point replaces it.
    await A.evaluate(() => {
      const open = window.__ppv.state.tour.pending;
      if (open && open.choice) open.__qa = "before";
      window.__qaTaps = { tapped: 0, left: 0, before: open && open.choice ? 1 : 0 };
      window.__qaTapper = setInterval(() => {
        const p = window.__ppv.state.tour.pending;
        if (!p || !p.choice || p.__qa) return;
        // a weak call (point.js ask: one bounce, a short piece) pre-chooses nothing and names the camera's
        // guess in words; a referee reads it and taps that side, so it goes in too (counted apart)
        const pre = document.querySelector(".pointbar__pick--pre");
        const guess = !pre && (p.guess === 0 || p.guess === 1) ? document.querySelector(p.guess === 0 ? ".pointbar__pick--blue" : ".pointbar__pick--red") : null;
        const pick = pre || guess;
        if (!pick || pick.closest("[hidden]")) { p.__qa = "left"; window.__qaTaps.left++; return; }
        p.__seenAt = p.__seenAt || Date.now();
        if (Date.now() - p.__seenAt >= 1500) { p.__qa = "tapped"; window.__qaTaps.tapped++; if (!pre) window.__qaTaps.weak = (window.__qaTaps.weak || 0) + 1; pick.click(); }
      }, 50);
    });
    await Bun.sleep(playS * 1000);
    // stop both clips so no new rally starts, then let the last rally close (ball lost 1-2 s), be judged
    // and have its bar tapped (1.5 s) before counting: otherwise a bar tapped after the count is a judged
    // rally with no point yet
    await clipPlay(A, false);
    await clipPlay(B, false);
    await Bun.sleep(6500);
    const after = (await match()).points.length;
    const a = await camView(A), b = await camView(B);
    const merged = a.log.slice(logA0);
    const judged = merged.filter((x) => x.winner);
    // asked, not entered: two cameras disagree, or point.js marks the call ask (one bounce, a short piece)
    const asked = merged.filter((x) => x.winner && (x.conflict || x.ask)).length;
    const askedWeak = merged.filter((x) => x.winner && x.ask && !x.conflict).length;
    const bPoints = B.__writes.slice(writesB).filter((w) => /"type":"point"/.test(w.body || "")).length;
    const droppedSegs = await A.evaluate(() => window.__ppv.multi.merger?.droppedSegs || []);
    // 판정 안정 모드 entries on each phone during the play (two phones share this PC's cores)
    report.stable = {};
    for (const [n, p] of [["A", A], ["B", B]]) report.stable[n] = await p.evaluate(() => ({ setting: window.__ppv.state.stableMode, compact: window.__ppv.state.stable.compact, log: window.__ppv.state.stable.log })).catch(() => null);
    const taps = await A.evaluate(() => ({ ...window.__qaTaps }));
    const r = { taps, droppedSegs, seconds: playS, pointsEntered: after - before, rallies: merged.length, judged: judged.length, conflictsAsked: asked - askedWeak, weakAsked: askedWeak, filledBounces: merged.reduce((s, x) => s + x.filled, 0), fromBoth: merged.filter((x) => x.cams.length > 1).length, droppedLate: a.log.length ? a.log[a.log.length - 1].dropped : 0, secondaryPointWrites: bPoints, secondaryRallyLog: b.log.length };
    // "all" mode: every judged rally without a conflict is one point; none twice, none from B
    if (bPoints !== 0) throw new Error(`secondary wrote ${bPoints} points`);
    // weak calls are tapped on the guess, so only two-camera conflicts (and holds) stay out
    if (r.pointsEntered !== judged.length - (asked - askedWeak)) throw new Error(`points ${r.pointsEntered} vs judged ${judged.length} - conflicts ${asked - askedWeak}: ${JSON.stringify(r)}`);
    if (!r.pointsEntered) throw new Error(`no point in ${playS} s: ${JSON.stringify(r)}`);
    // judge log: one call line for each rally A judged in the window, and A's taps went in as the camera's
    const lines = judgeLines().slice(judgeLines0);
    r.judgeLog = { calls: lines.filter((l) => l.t === "call").length, cameraPoints: lines.filter((l) => l.t === "point" && l.by === "camera").length, refereePoints: lines.filter((l) => l.t === "point" && l.by === "referee").length };
    if (r.judgeLog.calls !== judged.length) throw new Error(`judge-log ${r.judgeLog.calls} call lines for ${judged.length} judged rallies: ${JSON.stringify(r)}`);
    if (r.judgeLog.cameraPoints !== r.pointsEntered) throw new Error(`judge-log ${r.judgeLog.cameraPoints} camera point lines for ${r.pointsEntered} entered: ${JSON.stringify(r)}`);
    return r;
  }, [["A", A], ["B", B], ["referee", referee], ["tv", tv]]);

  await step("conflict", async () => {
    await clipPlay(A, false);
    await clipPlay(B, false);
    // a real point may have just gone in: the rally cut by the pause ends (ball lost) about 1-2 s later
    // and is judged then, so wait for that, then for its 3 s cancel window (or a question) to end
    await A.waitForTimeout(2500);
    await A.waitForFunction(() => !window.__ppv.state.tour.pending && !window.__ppv.multi.merger?.segs.length, null, { timeout: 30000 });
    await A.evaluate(() => clearInterval(window.__qaTapper));
    await A.waitForTimeout(1000);
    const before = (await match()).points.length;
    // the same rally as two cameras report it: the primary's last bounce on its far end, B's on the near end
    const t0 = Date.now() + 1000;
    const pending = await A.evaluate(async ({ t0, peer, near }) => {
      const { multi } = window.__ppv;
      const seg = (cam, lastEnd) => ({ cam, near, why: "ball_lost", startMs: t0, endMs: t0 + 1600, bounces: [{ t: t0 + 300, end: 0, x: 0.8, y: 0.7 }, { t: t0 + 700, end: lastEnd, x: lastEnd ? 2.0 : 1.1, y: 0.7 }], shots: [{ t: t0, end: 0, inferred: false }], serveNet: null, serveSeen: null, maxSpeedKmh: null });
      multi.merger.add(seg("self", 1));
      multi.merger.add(seg(peer, 0));
      for (let i = 0; i < 40 && !window.__ppv.state.tour.pending?.choice; i++) await new Promise((r) => setTimeout(r, 100));
      const p = window.__ppv.state.tour.pending;
      return p ? { choice: !!p.choice, reason: p.reason } : null;
    }, { t0, peer: endColour.id, near: endColour.near });
    await A.waitForTimeout(500);
    const bar = await bodyHas(A, tx("누가 땄나요", "Who won it?"));
    await A.screenshot({ path: `${out}/conflict-A.png` }).catch(() => {});
    const after = (await match()).points.length;
    if (!pending || !pending.choice || !bar || after !== before) throw new Error(JSON.stringify({ pending, bar, before, after }));
    // the referee taps one: entered once
    await A.getByRole("button", { name: tx(/블루 득점/, /Point Blue/) }).first().click();
    await waitFor("tapped point entered", async () => (await match()).points.length === before + 1, 10000);
    return { pending, bar, pointsWhileAsking: after - before, afterTap: 1 };
  });

  await step("drop-b", async () => {
    const since = Date.now();
    await B.context().close();
    delete pagesOf.B;
    await waitFor("A back to one camera", async () => (await camView(A)).role === "single", 30000);
    await waitFor("referee 1대", () => bodyHas(referee, tx("카메라 1대", "1 camera")), 15000);
    await waitFor("tv 1대", () => bodyHas(tv, tx("카메라 1대", "1 camera")), 15000);
    const toasts = {};
    const countToasts = async () => { for (const [n, p] of [["A", A], ["referee", referee], ["tv", tv]]) toasts[n] = (await seen(p, tx("카메라 1대로 전환", "Switched to 1 camera"), since)).length; return toasts.A && toasts.referee && toasts.tv; };
    await waitFor("switch toasts", countToasts, 8000).catch(() => {});
    if (!toasts.A || !toasts.referee || !toasts.tv) {
      // what each screen did show since the drop, and whether its socket reconnected meanwhile
      const shown = {};
      for (const [n, p] of [["referee", referee], ["tv", tv]]) shown[n] = await p.evaluate((s) => window.__seen.filter((x) => x.at >= s).map((x) => x.text).slice(-12), since);
      throw new Error(`toast ${JSON.stringify(toasts)} shown ${JSON.stringify(shown)}`);
    }
    await clipPlay(A, true);
    const n0 = (await match()).points.length;
    await waitFor("A judges alone", () => judgesAlone(A, n0), 120000);
    return { toasts, chip: (await camView(A)).chip, pointsAfterDrop: (await match()).points.length - n0, askedAfterDrop: !!(await A.evaluate(() => window.__ppv.state.tour.pending?.choice)) };
  }, [["A", A], ["referee", referee], ["tv", tv]]);

  await step("drop-a", async () => {
    const B2 = await phone("B", camPreset(true));
    await startCamera(B2);
    await waitFor("2 cameras again", async () => (await camView(B2)).role === "secondary", 30000);
    await A.context().close();
    delete pagesOf.A;
    await waitFor("B is the camera now", async () => ["single", "primary"].includes((await camView(B2)).role), 30000);
    report.promotedAt = Date.now();
    const n0 = (await match()).points.length;
    await waitFor("B judges", () => judgesAlone(B2, n0), 120000);
    const v = await camView(B2);
    return { roleB: v.role, chip: v.chip, pointsAfterDrop: (await match()).points.length - n0, askedAfterDrop: !!(await B2.evaluate(() => window.__ppv.state.tour.pending?.choice)) };
  }, [["B", pagesOf.B || A], ["referee", referee]]);

  if (args.rec) await step("rec", async () => {
    const B2 = pagesOf.B;
    const late = B2.__uploads.filter((u) => u.at >= report.promotedAt);
    if (!late.length) await waitFor("a clip from the promoted phone", async () => B2.__uploads.some((u) => u.at >= report.promotedAt), 60000);
    const secondaryUploads = recPages.sec.reduce((n, p) => n + p.__uploads.length, 0) + B2.__uploads.filter((u) => u.at < report.promotedAt).length;
    const clip = (id) => {
      const d = join(tmp, "saves", id);
      const video = existsSync(d) ? readdirSync(d).find((f) => f.startsWith("video.")) : null;
      if (!video || !existsSync(join(d, "overlay.json.gz"))) return { id: id.slice(0, 6), video, track: false };
      const track = JSON.parse(gunzipSync(readFileSync(join(d, "overlay.json.gz"))).toString());
      const pts = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", join(d, video)]).toString().split("\n").map(Number).filter((x) => Number.isFinite(x));
      const ts = track.frames.map((x) => x.t);
      const videoEnd = Math.round(Math.max(...pts) * 1000), videoStart = Math.round(Math.min(...pts) * 1000);
      return { id: id.slice(0, 6), frames: ts.length, videoFrames: pts.length, layout: !!(track.meta && track.meta.picture && track.meta.layout), trackStart: ts[0], videoStart, trackEnd: ts[ts.length - 1], videoEnd };
    };
    const promoted = B2.__uploads.filter((u) => u.at >= report.promotedAt).map((u) => clip(u.id));
    const primaryA = recPages.a.__uploads.slice(-2).map((u) => clip(u.id));
    const r = { secondaryUploads, primaryAUploads: recPages.a.__uploads.length, promoted, primaryA };
    if (!r.primaryAUploads || !promoted.length) throw new Error(`no clip from the primary: ${JSON.stringify(r)}`);
    if (secondaryUploads !== 0) throw new Error(`secondary uploaded ${secondaryUploads}: ${JSON.stringify(r)}`);
    for (const c of [...promoted, ...primaryA]) {
      if (c.track === false || !c.layout || c.frames < 10) throw new Error(`clip without a full track: ${JSON.stringify(c)}`);
      if (Math.abs(c.trackStart - c.videoStart) > 67 || Math.abs(c.trackEnd - c.videoEnd) > 67) throw new Error(`track and video ends differ by more than 2 frames: ${JSON.stringify(c)}`);
    }
    return r;
  }, [["B", pagesOf.B || referee]]);
} finally {
  writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${out}/judge-log.jsonl`, judgeLines().map((l) => JSON.stringify(l)).join("\n") + "\n");
  await browser.close().catch(() => {});
  proxy.stop(true);
  for (const p of procs) p.kill();
  const pass = steps.filter((s) => s.pass).length;
  console.log(`RESULT ${pass}/${steps.length} pass, errors ${report.errors.length}, out ${out}`);
  process.exitCode = pass === steps.length && steps.length >= 9 ? 0 : 1;
}
