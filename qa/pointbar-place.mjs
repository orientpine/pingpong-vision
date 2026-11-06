// Does the 누가 땄나요 bar (확인 후 입력, after every point) lie on the table, a player or the ball's flight?
// Owner rule: no table of numbers on the table. The real camera screen with a public clip playing and a
// saved calibration; the bar is opened with a camera call waiting (state.tour.pending, as tournament.js sets
// it when a point ends: the call chosen, a player's name on each button). At each screen size, frame by frame,
// the bar is sampled on a 12 x 12 grid against the same measures as qa/panel-table.mjs:
//   table  the calibrated quad mapped to the screen
//   body   each player's joints box (the drawn bodies from data-ends, else the pipeline's landmarks)
//   ball   the quad and the quad lifted by a quarter of its far edge (convex hull), plus every trail point
// and it must also keep off the players panel, the court map, the control bar and the top rows, stay on the
// screen, and keep every button at least 44 px high (a finger). --hold=1 shows the longer 점수 보류 text.
//   bun qa/pointbar-place.mjs --vision=<checkout> [--name=clip12|test_2] [--views=393x852,852x393,1280x720,1920x1080]
//     [--frames=12] [--lang=ko|en] [--hold=0|1] [--pause=0|1] [--port=9601] [--out=<dir>]
// --pause=1 stops the clip once the bar is open (after a real point play stops; the default keeps it playing,
// the harder case: legs and the ball keep crossing the screen)
// Exit 0 only when every sample at every size passes; prints POINTBAR PASS|FAIL with the worst counts.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CORNERS } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const vision = resolve(args.vision || ".");
const out = resolve(args.out || "evidence/pointbar-place");
mkdirSync(out, { recursive: true });
const name = args.name || "clip12";
const catalog = JSON.parse(readFileSync(join(vision, "qa/eval-set.json"), "utf8"));
const named = name === "clip12" ? { name, video: "data/videos/clip12_720p60.webm", corners: CORNERS } : catalog.videos.find((v) => v.name === name);
if (!named) throw new Error(`no video ${name}`);
const media = (p) => [join(vision, p), ...(process.env.PPV_DATA_ROOT ? [join(process.env.PPV_DATA_ROOT, p)] : [])].find((x) => existsSync(x));
const video = media(named.video);
if (!video) throw new Error(`missing ${named.video} (set PPV_DATA_ROOT)`);
const views = (args.views || "393x852,852x393,1280x720,1920x1080").split(",");
const frames = Number(args.frames || 12);
const lang = args.lang === "en" ? "en" : "ko";
const hold = args.hold === "1";
const pause = args.pause === "1";
const port = Number(args.port || 9601);
const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ppv-pointbar-"));
const server = spawn("bun", [join(vision, "server.js")], { cwd: vision, env: { ...process.env, PORT: String(port), PPV_TOURNAMENT_URL: "off", PPV_SAVE_DIR: join(tmp, "saves"), PPV_KEY_FILE: join(tmp, "key"), PPV_SETUP_FILE: join(tmp, "setup.json") }, stdio: ["ignore", "ignore", "inherit"] });
const origin = `http://127.0.0.1:${port}`;
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try { up = (await fetch(`${origin}/healthz`)).ok; } catch {}
  if (!up) await Bun.sleep(100);
}
if (!up) { server.kill(); throw new Error(`server on ${port} did not start`); }

// In the page: keep a camera call waiting on the bar. The app sets state.tour from the tournament link on its
// own; a getter lays the waiting call (one object, as tournament.js keeps it while it waits) over whatever it set.
function openBar(hold) {
  const st = window.__ppv.state;
  const match = { id: "m1", names: { p1: "넷째", p2: "김블루" }, ends: ["p1", "p2"], score: [3, 2] };
  const pending = { choice: true, pre: 0, sure: false, hold, reason: "", keep: true, seq: 1 };
  let real = st.tour;
  Object.defineProperty(st, "tour", { configurable: true, get: () => ({ ...real, connected: true, matchId: "m1", match, entry: "confirm", pending }), set: (v) => { real = v; } });
}

function measure() {
  const v = document.querySelector("video.stage__video") || document.querySelector("video");
  const r = v.getBoundingClientRect(), fit = getComputedStyle(v).objectFit;
  const k = (fit === "cover" ? Math.max : Math.min)(r.width / v.videoWidth, r.height / v.videoHeight);
  const ox = r.left + (r.width - v.videoWidth * k) / 2, oy = r.top + (r.height - v.videoHeight * k) / 2;
  const toScreen = (p) => ({ x: ox + p.x * k, y: oy + p.y * k });
  const st = window.__ppv.state;
  const cal = st.calibration?.corners;
  const quad = cal && cal.length === 4 ? cal.map(toScreen) : null;
  const ov = document.querySelector("canvas[data-ends]");
  const info = ov && ov.dataset.ends ? JSON.parse(ov.dataset.ends) : null;
  const or = ov ? ov.getBoundingClientRect() : { left: 0, top: 0 };
  let bodies = [];
  if (info?.bodies && Object.keys(info.bodies).length) bodies = Object.values(info.bodies).map((b) => ({ x: b.x + or.left, y: b.y + or.top, w: b.w, h: b.h }));
  else for (const side of ["near", "far"]) {
    const pts = (st.players?.[side]?.landmarks || []).filter((lm) => lm && (lm.v == null || lm.v >= 0.5)).map(toScreen);
    if (!pts.length) continue;
    const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
    bodies.push({ x: Math.min(...xs) - 3, y: Math.min(...ys) - 3, w: Math.max(...xs) - Math.min(...xs) + 6, h: Math.max(...ys) - Math.min(...ys) + 6 });
  }
  const inPoly = (poly, x, y) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c; } return c; };
  let zone = null;
  if (quad) {
    const lift = 0.25 * Math.min(Math.hypot(quad[1].x - quad[2].x, quad[1].y - quad[2].y), Math.hypot(quad[0].x - quad[3].x, quad[0].y - quad[3].y));
    const pts = [...quad, ...quad.map((p) => ({ x: p.x, y: p.y - lift }))].sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lo = [], hi = [];
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (const p of [...pts].reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
    zone = [...lo.slice(0, -1), ...hi.slice(0, -1)];
  }
  const trail = (st.ball?.trail || []).filter((p) => p && Number.isFinite(p.x)).map(toScreen);
  // offsetParent is null for a position: fixed element (the bar, the control rail): read the box and the style
  const shown = (e) => e && !e.closest("[hidden]") && getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden" && e.getBoundingClientRect().width > 2;
  const pb = document.querySelector(".pointbar");
  if (!shown(pb)) return { shown: false };
  const b = pb.getBoundingClientRect();
  let table = 0, body = 0, ball = 0;
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) {
    const x = b.left + ((i + 0.5) * b.width) / 12, y = b.top + ((j + 0.5) * b.height) / 12;
    if (quad && inPoly(quad, x, y)) table++;
    if (bodies.some((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h)) body++;
    if (zone && inPoly(zone, x, y)) ball++;
  }
  const trailUnder = trail.filter((p) => p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom).length;
  // px of the bar over each other piece of UI that is shown
  const overUi = {};
  for (const [id, sel] of [["players", ".players"], ["court", ".court"], ["bar", ".bar"], ["strip", ".strip"], ["glance", ".glance"], ["dock", ".dock"]]) {
    const e = document.querySelector(sel);
    if (!shown(e)) continue;
    const q = e.getBoundingClientRect();
    const w = Math.min(b.right, q.right) - Math.max(b.left, q.left), h = Math.min(b.bottom, q.bottom) - Math.max(b.top, q.top);
    if (w > 0.5 && h > 0.5) overUi[id] = Math.round(w * h);
  }
  const buttons = [...pb.querySelectorAll("button")].filter(shown).map((x) => { const q = x.getBoundingClientRect(); return { text: x.textContent.trim(), w: Math.round(q.width), h: Math.round(q.height), cut: x.scrollWidth > x.clientWidth + 1 || x.scrollHeight > x.clientHeight + 1 }; });
  const text = pb.querySelector(".pointbar__text");
  const app = document.querySelector(".app");
  return {
    shown: true, t: v.currentTime, layout: app?.dataset.fit, box: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
    onScreen: b.left >= 0 && b.top >= 0 && b.right <= innerWidth + 0.5 && b.bottom <= innerHeight + 0.5,
    table, body, ball, trailUnder, overUi, quad: !!quad, bodies: bodies.length,
    minBtn: Math.min(...buttons.map((x) => x.h)), buttons, textCut: !!text && (text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1), text: text?.textContent || "",
    spot: pb.dataset.spot || "",
  };
}
const bad = (s) => !s.shown || !s.onScreen || s.table + s.body + s.ball + s.trailUnder > 0 || Object.keys(s.overUi).length > 0 || s.minBtn < 44 || s.textCut || s.buttons.some((x) => x.cut);

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const result = { video: named.name, lang, hold, pause, vision, views: [] };
const errs = [];
let ok = true;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
  await ctx.addInitScript(({ cal, lang }) => {
    sessionStorage.setItem("pp-started", "1");
    localStorage.setItem("pp-role", "camera");
    localStorage.setItem("pp-lang", lang);
    localStorage.setItem("ppv.calibration", JSON.stringify(cal));
  }, { cal: { corners: named.corners, width: 1920, height: 1080 }, lang });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errs.push(String(e && (e.stack || e.message) || e).slice(0, 1000)));
  await p.goto(`${origin}/vision/`, { waitUntil: "load" });
  await p.waitForFunction(() => !!window.__ppv, null, { timeout: 30000 });
  await p.evaluate(() => {
    const v = document.querySelector("video.stage__video") || document.querySelector("video");
    v.addEventListener("play", () => { v.playbackRate = 0.5; });
    v.loop = true;
  });
  await p.locator('input[type="file"]').first().setInputFiles(video);
  await p.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 90000 });
  await p.waitForTimeout(2000);
  await p.evaluate(openBar, hold);
  if (pause) await p.evaluate(() => (document.querySelector("video.stage__video") || document.querySelector("video")).pause());
  for (const vs of views) {
    const [w, h] = vs.split("x").map(Number);
    await p.setViewportSize({ width: w, height: h });
    await p.waitForTimeout(3000);
    const samples = [];
    const tag = `${lang}${hold ? "-hold" : ""}${pause ? "-pause" : ""}-${named.name}-${vs}`;
    for (let i = 0; i < frames; i++) {
      const s = await p.evaluate(measure);
      samples.push(s);
      if (i === 0 || (bad(s) && !samples.slice(0, -1).some(bad))) await p.screenshot({ path: join(out, `${tag}-${i === 0 ? "first" : "firstbad"}.png`) });
      await p.waitForTimeout(500);
    }
    const fails = samples.filter(bad).length;
    if (fails) ok = false;
    const worst = (k) => Math.max(...samples.map((s) => s[k] || 0));
    const v = { view: vs, fails, samples: samples.length, worst: { table: worst("table"), body: worst("body"), ball: worst("ball"), trail: worst("trailUnder") }, overUi: [...new Set(samples.flatMap((s) => Object.keys(s.overUi || {})))], minBtn: Math.min(...samples.map((s) => s.minBtn ?? 0)), boxes: [...new Set(samples.map((s) => (s.box || []).join(",")))], spot: [...new Set(samples.map((s) => s.spot))], textCut: samples.some((s) => s.textCut), offScreen: samples.filter((s) => s.shown && !s.onScreen).length, text: samples[0]?.text };
    result.views.push({ ...v, all: samples });
    console.log(`${vs} ${fails ? "FAIL" : "ok"} fails=${fails}/${samples.length} table=${v.worst.table} body=${v.worst.body} ball=${v.worst.ball} trail=${v.worst.trail} overUi=${v.overUi.join("+") || "-"} minBtn=${v.minBtn} boxes=${v.boxes.join(" ")} spot=${v.spot.join("/") || "-"} textCut=${v.textCut}`);
  }
  await ctx.close();
} catch (e) {
  ok = false;
  errs.push(String(e && (e.stack || e.message) || e).slice(0, 2000));
} finally {
  await browser.close();
  server.kill();
}
result.errors = errs;
result.pass = ok && !errs.length;
writeFileSync(join(out, `result-${lang}${hold ? "-hold" : ""}${pause ? "-pause" : ""}-${named.name}.json`), JSON.stringify(result, null, 2));
console.log(`POINTBAR ${result.pass ? "PASS" : "FAIL"} ${lang}${hold ? " hold" : ""} ${named.name}${errs.length ? ` errors=${errs.length}: ${errs[0].slice(0, 300)}` : ""}`);
process.exit(result.pass ? 0 : 1);
