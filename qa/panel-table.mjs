// Do the players panel and the COURT MAP lie on the table, a player or the ball's flight? Owner rule:
// no table of numbers on the table. The real camera screen with a public clip playing and a saved
// calibration, at each screen size, frame by frame: every shown panel (.players, .court) is sampled on a
// 12 x 12 grid of points (the pingpong-english census measure) against
//   table  the calibrated quad (the four corners mapped to the screen the way the picture is fitted)
//   body   each player's joints box (the drawn bodies from data-ends, else the pipeline's landmarks)
//   ball   the space the ball flies through: the quad and the same quad lifted by a quarter of its far
//          edge (convex hull), plus every ball trail point the pipeline has on screen
// then once with settings open and once with the history sheet open. It also folds and reopens the
// panels with the 선수·코트 chip, and counts how often each panel is shown: hiding the panels for good
// would pass the cover check, so --need-shown lists the sizes where both must show on most frames.
//   bun qa/panel-table.mjs --vision=<checkout> --name=test_2|test_7|clip12 [--views=852x393,1280x720,1920x1080,393x852]
//     [--frames=24] [--every=300] [--rate=0.5] [--port=9581] [--out=<dir>] [--need-shown=1920x1080] [--lang=ko|en]
// Exit 0 only when every size took every frame, no panel point lay on the table, a body or the ball zone,
// the chip folded and reopened, and the --need-shown sizes kept both panels up; prints PANEL_TABLE.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CORNERS } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const vision = resolve(args.vision || ".");
const out = resolve(args.out || "evidence/panel-table");
mkdirSync(out, { recursive: true });
const name = args.name || "test_2";
const catalog = JSON.parse(readFileSync(join(vision, "qa/eval-set.json"), "utf8"));
// clip12 is the 1280x720 cut of test_2 the other one-app tests use (its corners are the harness CORNERS, in 1920 px)
const named = name === "clip12" ? { name, video: "data/videos/clip12_720p60.webm", corners: CORNERS } : catalog.videos.find((v) => v.name === name);
if (!named) throw new Error(`no video ${name}`);
const media = (p) => [join(vision, p), ...(process.env.PPV_DATA_ROOT ? [join(process.env.PPV_DATA_ROOT, p)] : [])].find((x) => existsSync(x));
const video = media(named.video);
if (!video) throw new Error(`missing ${named.video} (set PPV_DATA_ROOT)`);
const views = (args.views || "852x393,1280x720,1920x1080,393x852").split(",");
const needShown = new Set((args["need-shown"] ?? "1920x1080").split(",").filter(Boolean));
const frames = Number(args.frames || 24);
const every = Number(args.every || 300);
const rate = Number(args.rate || 0.5);
const port = Number(args.port || 9581);
const lang = args.lang === "en" ? "en" : "ko";
const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ppv-paneltable-"));
const server = spawn("bun", [join(vision, "server.js")], { cwd: vision, env: { ...process.env, PORT: String(port), PPV_TOURNAMENT_URL: "off", PPV_SAVE_DIR: join(tmp, "saves"), PPV_KEY_FILE: join(tmp, "key"), PPV_SETUP_FILE: join(tmp, "setup.json") }, stdio: ["ignore", "ignore", "inherit"] });
const origin = `http://127.0.0.1:${port}`;
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try { up = (await fetch(`${origin}/healthz`)).ok; } catch {}
  if (!up) await Bun.sleep(100);
}
if (!up) { server.kill(); throw new Error(`server on ${port} did not start`); }

// In the page: every shown panel against the table, the bodies and the ball zone, as grid points.
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
  // bodies: the boxes the HUD drew this frame (with the foot ring), else the landmarks shown at visibility >= 0.5
  let bodies = [];
  if (info?.bodies && Object.keys(info.bodies).length) bodies = Object.values(info.bodies).map((b) => ({ x: b.x + or.left, y: b.y + or.top, w: b.w, h: b.h }));
  else for (const side of ["near", "far"]) {
    const pts = (st.players?.[side]?.landmarks || []).filter((lm) => lm && (lm.v == null || lm.v >= 0.5)).map(toScreen);
    if (!pts.length) continue;
    const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
    bodies.push({ x: Math.min(...xs) - 3, y: Math.min(...ys) - 3, w: Math.max(...xs) - Math.min(...xs) + 6, h: Math.max(...ys) - Math.min(...ys) + 6 });
  }
  const inPoly = (poly, x, y) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c; } return c; };
  // the ball zone: hull of the quad and the quad lifted by a quarter of the far edge (the far edge is the shorter one)
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
  const shown = (e) => e && !e.closest("[hidden]") && e.offsetParent !== null && getComputedStyle(e).visibility !== "hidden" && e.getBoundingClientRect().width > 2;
  const panels = [];
  for (const sel of [".players", ".court"]) {
    const e = document.querySelector(sel);
    if (!shown(e)) { panels.push({ panel: sel.slice(1), shown: false }); continue; }
    const b = e.getBoundingClientRect();
    let table = 0, body = 0, ball = 0;
    for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) {
      const x = b.left + ((i + 0.5) * b.width) / 12, y = b.top + ((j + 0.5) * b.height) / 12;
      if (quad && inPoly(quad, x, y)) table++;
      if (bodies.some((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h)) body++;
      if (zone && inPoly(zone, x, y)) ball++;
    }
    const trailUnder = trail.filter((p) => p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom).length;
    panels.push({ panel: sel.slice(1), shown: true, box: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)], table, body, ball, trailUnder });
  }
  const app = document.querySelector(".app");
  return { t: v.currentTime, layout: app?.dataset.layout, fit: app?.dataset.fit, quad: !!quad, bodies: bodies.length, trail: trail.length, size: app?.dataset.psize || null, panels };
}
const cover = (s) => s.panels.reduce((n, p) => n + (p.shown ? p.table + p.body + p.ball + p.trailUnder : 0), 0);

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const shot = lang === "en" ? `${named.name}-en` : named.name;
const result = { video: named.name, lang, vision, views: [] };
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
  await p.evaluate((rate) => {
    const v = document.querySelector("video.stage__video") || document.querySelector("video");
    v.addEventListener("play", () => { v.playbackRate = rate; });
    v.loop = true;
    // a short clip (clip12 is 12 s) must not sit on its last frame: the players and the ball would stand still
    setInterval(() => { if (v.duration && (v.ended || v.currentTime >= v.duration - 0.1)) { v.currentTime = 0; v.play().catch(() => {}); } }, 200);
  }, rate);
  await p.locator('input[type="file"]').first().setInputFiles(video);
  await p.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 90000 });
  await p.waitForTimeout(3000);
  for (const vs of views) {
    const [w, h] = vs.split("x").map(Number);
    await p.setViewportSize({ width: w, height: h });
    await p.waitForTimeout(2500);
    const samples = [];
    let worst = null;
    for (let i = 0; i < frames; i++) {
      const s = await p.evaluate(measure);
      s.cover = cover(s);
      samples.push(s);
      if (i === 0) await p.screenshot({ path: `${out}/${shot}-${vs}-running.png` });
      if (s.cover > 0 && (!worst || s.cover > worst.cover)) { worst = s; await p.screenshot({ path: `${out}/${shot}-${vs}-worst.png` }); }
      await p.waitForTimeout(every);
    }
    // settings open, then the history sheet open: the panels under them still count
    const states = {};
    const settingsBtn = p.locator(".bar .btn--bar[aria-haspopup=dialog]");
    await settingsBtn.click();
    await p.waitForSelector(".popover:not([hidden])", { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(400);
    states.settings = await p.evaluate(measure);
    await p.screenshot({ path: `${out}/${shot}-${vs}-settings.png` });
    // open settings disable their own button; the back chip closes them (named 설정 닫기 then)
    await p.locator("[data-back]").filter({ visible: true }).first().click();
    await p.waitForFunction(() => !document.querySelector(".popover:not([hidden])"), null, { timeout: 5000 });
    await p.waitForTimeout(300);
    // the fourth bar button is 기록 / History in either language
    await p.locator(".bar .btn--bar").nth(3).click();
    await p.waitForTimeout(600);
    states.history = await p.evaluate(measure);
    await p.screenshot({ path: `${out}/${shot}-${vs}-history.png` });
    // the back chip closes the sheet (its name is 기록 닫기 while the sheet is open)
    await p.locator("[data-back]").filter({ visible: true }).first().click();
    await p.waitForFunction(() => !document.querySelector(".bar .btn--bar[aria-haspopup=dialog]")?.disabled, null, { timeout: 5000 });
    await p.waitForTimeout(300);
    for (const s of Object.values(states)) s.cover = cover(s);
    // the 선수·코트 chip folds both panels and opens them again
    const dock = p.locator(".dock");
    let fold = { folded: null, reopened: null };
    if (await dock.isVisible()) {
      await dock.click();
      await p.waitForTimeout(400);
      fold.folded = (await p.evaluate(measure)).panels.every((q) => !q.shown);
      await dock.click();
      await p.waitForTimeout(800);
      const again = await p.evaluate(measure);
      fold.reopened = again.panels.some((q) => q.shown) || again.size === "fold";
      fold.afterCover = cover(again);
    }
    const shownBoth = samples.filter((s) => s.panels.every((q) => q.shown)).length;
    const row = {
      view: vs, frames: samples.length, layout: samples[0]?.layout, fit: samples[0]?.fit,
      framesWithBody: samples.filter((s) => s.bodies).length, framesWithTrail: samples.filter((s) => s.trail).length,
      framesCovering: samples.filter((s) => s.cover > 0).length,
      points: Object.fromEntries(["table", "body", "ball", "trailUnder"].map((key) => [key, samples.reduce((n, s) => n + s.panels.reduce((m, q) => m + (q[key] || 0), 0), 0)])),
      shown: Object.fromEntries(["players", "court"].map((pn) => [pn, samples.filter((s) => s.panels.find((q) => q.panel === pn)?.shown).length])),
      shownBoth, settingsCover: states.settings.cover, historyCover: states.history.cover, fold,
      worst: worst && { t: worst.t, panels: worst.panels.filter((q) => q.shown) },
    };
    result.views.push({ ...row, samples, states });
    const needBoth = needShown.has(vs);
    const pass = row.frames === frames && !row.framesCovering && !row.settingsCover && !row.historyCover && fold.folded === true && fold.reopened === true && !fold.afterCover && (!needBoth || shownBoth >= frames * 0.8);
    console.log(`VIEW ${named.name} ${vs} ${row.layout}/${row.fit} frames=${row.frames} withBody=${row.framesWithBody} withTrail=${row.framesWithTrail} covering=${row.framesCovering} points=${JSON.stringify(row.points)} shown=${JSON.stringify(row.shown)} both=${shownBoth}${needBoth ? "(need)" : ""} settings=${row.settingsCover} history=${row.historyCover} fold=${JSON.stringify(fold)} ${pass ? "PASS" : "FAIL"}`);
    if (row.worst) console.log(`  worst t=${row.worst.t.toFixed(2)} ${JSON.stringify(row.worst.panels)}`);
    if (!pass) ok = false;
  }
  await ctx.close();
} finally {
  result.pageErrors = errs;
  writeFileSync(`${out}/${shot}.json`, JSON.stringify(result, null, 2));
  await browser.close().catch(() => {});
  server.kill();
}
if (result.views.length !== views.length || errs.length) ok = false;
console.log(`PANEL_TABLE ${named.name} ${lang} ${ok ? "PASS" : "FAIL"} views=${result.views.length}/${views.length} pageErrors=${errs.length}`);
process.exit(ok ? 0 : 1);
