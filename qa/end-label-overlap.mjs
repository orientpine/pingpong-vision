// End labels ("블루 끝" / "레드 끝", canvas) against everything they must not cover, frame by frame, on the
// real camera screen with a public clip playing. For each screen size the screen opens as it does
// (panels not folded), then --frames samples are read from the overlay: each end label's box against
//   bodies   each player's joints box, from the pipeline's own landmarks (the harness maps them itself,
//            so the same check runs on a tree that does not report bodies), plus the drawn foot ring
//   plates   name tags and standing-position plates
//   lock     the LOCK box and its bracket (only where the overlay reports it)
//   buttons, panels (DOM, shown), and the table quad
// as overlapping pixels (box intersection area; table: pixels inside the quad). On a tree that reports
// the drawn bodies (data-ends.bodies), those are used instead of the harness's own boxes. A capture of the first
// frame and of the worst frame per size.
//   bun qa/end-label-overlap.mjs --vision=<checkout> --name=test_2 [--views=852x393,1280x720,393x852]
//     [--frames=40] [--every=250] [--rate=0.5] [--port=9561] [--out=<dir>]
// Exit 0 only when every size took every frame and no label overlapped anything; prints END_LABEL_OVERLAP.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const vision = resolve(args.vision || ".");
const out = resolve(args.out || "evidence/end-label-overlap");
mkdirSync(out, { recursive: true });
const catalog = JSON.parse(readFileSync(join(vision, "qa/eval-set.json"), "utf8"));
const named = catalog.videos.find((v) => v.name === (args.name || "test_2"));
const media = (p) => [join(vision, p), ...(process.env.PPV_DATA_ROOT ? [join(process.env.PPV_DATA_ROOT, p)] : [])].find((x) => existsSync(x));
const video = media(named.video);
if (!video) throw new Error(`missing ${named.video} (set PPV_DATA_ROOT)`);
const views = (args.views || "852x393,1280x720,393x852").split(",");
const frames = Number(args.frames || 40);
const every = Number(args.every || 250);
const rate = Number(args.rate || 0.5);
const port = Number(args.port || 9561);
const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ppv-endlabel-"));
const server = spawn("bun", [join(vision, "server.js")], { cwd: vision, env: { ...process.env, PORT: String(port), PPV_TOURNAMENT_URL: "off", PPV_SAVE_DIR: join(tmp, "saves"), PPV_KEY_FILE: join(tmp, "key"), PPV_SETUP_FILE: join(tmp, "setup.json") }, stdio: ["ignore", "ignore", "inherit"] });
const origin = `http://127.0.0.1:${port}`;
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try { up = (await fetch(`${origin}/healthz`)).ok; } catch {}
  if (!up) await Bun.sleep(100);
}
if (!up) { server.kill(); throw new Error(`server on ${port} did not start`); }

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const result = { video: named.name, vision, views: [] };
const errs = [];
let ok = true;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
  await ctx.addInitScript((cal) => {
    sessionStorage.setItem("pp-started", "1");
    localStorage.setItem("pp-role", "camera");
    localStorage.setItem("ppv.calibration", JSON.stringify(cal));
  }, { corners: named.corners, width: 1920, height: 1080 });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errs.push(String(e && (e.stack || e.message) || e).slice(0, 1000)));
  await p.goto(`${origin}/vision/`, { waitUntil: "load" });
  await p.waitForFunction(() => !!window.__ppv, null, { timeout: 30000 });
  await p.evaluate((rate) => {
    const v = document.querySelector("video.stage__video") || document.querySelector("video");
    v.addEventListener("play", () => { v.playbackRate = rate; });
    v.loop = true;
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
      const s = await p.evaluate(() => {
        const v = document.querySelector("video.stage__video") || document.querySelector("video");
        const r = v.getBoundingClientRect(), fit = getComputedStyle(v).objectFit;
        const k = (fit === "cover" ? Math.max : Math.min)(r.width / v.videoWidth, r.height / v.videoHeight);
        const ox = r.left + (r.width - v.videoWidth * k) / 2, oy = r.top + (r.height - v.videoHeight * k) / 2;
        const ov = document.querySelector("canvas[data-ends]");
        const info = ov && ov.dataset.ends ? JSON.parse(ov.dataset.ends) : null;
        const or = ov ? ov.getBoundingClientRect() : { left: 0, top: 0 };
        const sh = (b) => ({ x: b.x + or.left, y: b.y + or.top, w: b.w, h: b.h });
        const rectOf = (e) => { const q = e.getBoundingClientRect(); return { x: q.left, y: q.top, w: q.width, h: q.height }; };
        // the players as the HUD draws them: landmarks shown at visibility >= 0.5 (hud.js MIN_VIS)
        const bodies = [];
        for (const side of ["near", "far"]) {
          const lms = window.__ppv.state.players?.[side]?.landmarks;
          if (!lms) continue;
          const pts = lms.filter((lm) => lm && (lm.v == null || lm.v >= 0.5)).map((lm) => ({ x: ox + lm.x * k, y: oy + lm.y * k }));
          if (!pts.length) continue;
          const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
          // joint squares are 5 px and lines 2 px wide
          bodies.push({ side, x: Math.min(...xs) - 3, y: Math.min(...ys) - 3, w: Math.max(...xs) - Math.min(...xs) + 6, h: Math.max(...ys) - Math.min(...ys) + 6 });
        }
        // a tree that reports the bodies of the frame it drew (with the foot ring) is checked against those:
        // the pipeline's landmarks may already be a frame newer than the picture on screen
        const lmBodies = [...bodies];
        if (info?.bodies) bodies.splice(0, bodies.length, ...Object.entries(info.bodies).map(([side, b]) => ({ side, ...sh(b) })));
        const plates = [...Object.values(info?.tags || {}), ...Object.values(info?.stands || {}).filter((st) => st && st.w && !st.labelHidden)].filter((b) => b && b.w).map(sh);
        const lock = info && "lock" in info ? (info.lock ? [sh(info.lock)] : []) : null;
        const buttons = [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null).map((b) => ({ ...rectOf(b), name: b.innerText.trim().slice(0, 12) }));
        const panels = [...document.querySelectorAll(".players, .court")].filter((e) => e.offsetParent !== null).map(rectOf);
        const quad = info?.quad ? info.quad.map((q) => ({ x: q.x + or.left, y: q.y + or.top })) : null;
        const inQuad = (q) => { if (!quad) return false; let c = false; for (let i = 0, j = 3; i < 4; j = i++) { const A = quad[i], B = quad[j]; if (A.y > q.y !== B.y > q.y && q.x < ((B.x - A.x) * (q.y - A.y)) / (B.y - A.y) + A.x) c = !c; } return c; };
        const area = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        const tablePx = (b) => { let n = 0; for (let x = Math.floor(b.x); x < b.x + b.w; x++) for (let y = Math.floor(b.y); y < b.y + b.h; y++) if (inQuad({ x: x + 0.5, y: y + 0.5 })) n++; return n; };
        const labels = Object.entries(info?.endTags || {}).map(([side, tg]) => ({ side, end: tg.color, kind: tg.kind || "arrow", ...sh(tg) }));
        const sum = (b, list) => (list || []).reduce((n, x) => n + area(b, x), 0);
        const per = labels.map((b) => ({ side: b.side, end: b.end, kind: b.kind, box: [Math.round(b.x), Math.round(b.y), b.w, b.h],
          body: Math.round(sum(b, bodies)), bodyLandmarks: Math.round(sum(b, lmBodies)), plates: Math.round(sum(b, plates)), lock: lock ? Math.round(sum(b, lock)) : null,
          buttons: Math.round(sum(b, buttons)), panels: Math.round(sum(b, panels)), table: tablePx(b) }));
        return { t: v.currentTime, bodies: bodies.length, labels: per, hidden: Object.entries(info?.ends || {}).filter(([, e]) => e.covered >= 0.5).map(([sd, e]) => `${sd}:${e.color}:${e.by}`), reportsBodies: !!info?.bodies, reportsLock: !!(info && "lock" in info) };
      });
      const bad = s.labels.reduce((n, l) => n + l.body + l.plates + (l.lock || 0) + l.buttons + l.panels + l.table, 0);
      s.overlapPx = bad;
      samples.push(s);
      if (i === 0) await p.screenshot({ path: `${out}/${named.name}-${vs}-first.png` });
      if (bad > 0 && (!worst || bad > worst.overlapPx)) { worst = s; await p.screenshot({ path: `${out}/${named.name}-${vs}-worst.png` }); }
      await p.waitForTimeout(every);
    }
    const tot = (key) => samples.reduce((n, s) => n + s.labels.reduce((m, l) => m + (l[key] || 0), 0), 0);
    const row = {
      view: vs, frames: samples.length,
      framesWithLabel: samples.filter((s) => s.labels.length).length,
      framesWithBody: samples.filter((s) => s.bodies).length,
      framesOverlapping: samples.filter((s) => s.overlapPx > 0).length,
      px: { body: tot("body"), bodyLandmarks: tot("bodyLandmarks"), plates: tot("plates"), lock: tot("lock"), buttons: tot("buttons"), panels: tot("panels"), table: tot("table") },
      reportsLock: samples[0]?.reportsLock, worstT: worst?.t ?? null,
    };
    result.views.push({ ...row, samples });
    console.log(`VIEW ${named.name} ${vs} frames=${row.frames} withLabel=${row.framesWithLabel} withBody=${row.framesWithBody} overlapping=${row.framesOverlapping} px=${JSON.stringify(row.px)} lock=${row.reportsLock ? "reported" : "n/a"}`);
    if (row.frames !== frames || row.framesOverlapping) ok = false;
  }
  await ctx.close();
} finally {
  result.pageErrors = errs;
  writeFileSync(`${out}/${named.name}.json`, JSON.stringify(result, null, 2));
  await browser.close().catch(() => {});
  server.kill();
}
if (result.views.length !== views.length || errs.length) ok = false;
console.log(`END_LABEL_OVERLAP ${named.name} ${ok ? "PASS" : "FAIL"} views=${result.views.length}/${views.length} pageErrors=${errs.length}`);
process.exit(ok ? 0 : 1);
