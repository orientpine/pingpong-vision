// The end lines (thin see-through dotted blue / red, hud.js END_LINE) are drawn on the display overlay
// only. This measures ball recall through the real camera screen, the same public clip twice: end
// lines on, then off (state.showEnds = false). The file plays slowly so the analysis sees every frame.
//   bun qa/end-lines-recall.mjs --vision=<checkout> --name=test_2 [--to=15] [--rate=0.1] [--order=on,on,off,off] [--port=9552] [--out=<dir>]
// --order repeats a condition, so the spread between two runs of the same condition (real-time frame
// skips) can be set against the gap between on and off.
// Recall: analysed frames whose OpenTTGames ball (ball_markup.json) is in view and has the app's
// ball within --tol px (video px). Also the frames analysed and the app's ball frames off the GT ball.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const vision = resolve(args.vision || ".");
const out = args.out || "evidence/end-lines-recall";
mkdirSync(out, { recursive: true });
const catalog = JSON.parse(readFileSync(join(vision, "qa/eval-set.json"), "utf8"));
const named = catalog.videos.find((v) => v.name === (args.name || "test_2"));
const media = (p) => [join(vision, p), ...(process.env.PPV_DATA_ROOT ? [join(process.env.PPV_DATA_ROOT, p)] : [])].find((x) => existsSync(x));
const video = media(named.video);
const gtDir = media(named.markup);
if (!video || !gtDir) throw new Error(`missing ${named.video} or ${named.markup} (set PPV_DATA_ROOT)`);
const toS = Number(args.to || 15);
const rate = Number(args.rate || 0.1);
const tol = Number(args.tol || 12);
const srcFps = Number(args.srcFps || 120);
const port = Number(args.port || 9552);
const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ppv-endlines-"));
const server = spawn("bun", [join(vision, "server.js")], { cwd: vision, env: { ...process.env, PORT: String(port), PPV_TOURNAMENT_URL: "off", PPV_SAVE_DIR: join(tmp, "saves"), PPV_KEY_FILE: join(tmp, "key"), PPV_SETUP_FILE: join(tmp, "setup.json") }, stdio: ["ignore", "ignore", "inherit"] });
const origin = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${origin}/healthz`)).ok) break;
  } catch {}
  await Bun.sleep(100);
}

const gt = JSON.parse(readFileSync(join(gtDir, "ball_markup.json"), "utf8"));
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
let views = null;
async function run(showEnds, n) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((cal) => {
    sessionStorage.setItem("pp-started", "1");
    localStorage.setItem("pp-role", "camera");
    localStorage.setItem("ppv.calibration", JSON.stringify(cal));
  }, { corners: named.corners, width: 1920, height: 1080 });
  const p = await ctx.newPage();
  // page errors and console errors go to <out>/errors-<n>.json (an exception in the frame loop stops analysis)
  const errs = [];
  p.on("pageerror", (e) => errs.push({ kind: "pageerror", text: String(e && (e.stack || e.message) || e).slice(0, 2000) }));
  p.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errs.push({ kind: m.type(), text: m.text().slice(0, 600) }); });
  const flushErrs = () => writeFileSync(`${out}/errors-${n}.json`, JSON.stringify(errs, null, 2));
  const flushTimer = setInterval(flushErrs, 2000);
  await p.goto(`${origin}/vision/`, { waitUntil: "load" });
  await p.waitForFunction(() => !!window.__ppv, null, { timeout: 30000 });
  // every analysed frame: media time and the app's ball (video px), recorded where the app reads it
  await p.evaluate(([showEnds, rate]) => {
    window.__rec = [];
    window.__ppv.state.showEnds = showEnds;
    const v = document.querySelector("video.stage__video") || document.querySelector("video");
    v.addEventListener("play", () => { v.playbackRate = rate; });
    const hook = setInterval(() => {
      const pl = window.__ppv.pipeline;
      if (!pl || pl.__rec) return;
      pl.__rec = true;
      const snap = pl.snapshot.bind(pl);
      pl.snapshot = (t) => {
        const s = snap(t);
        window.__rec.push({ t, cur: s.ball && s.ball.current ? { x: s.ball.current.x, y: s.ball.current.y } : null });
        return s;
      };
      clearInterval(hook);
    }, 20);
  }, [showEnds, rate]);
  await p.locator('input[type="file"]').first().setInputFiles(video);
  // --fold=1: fold the player / court panels so both table ends are in view (landscape panels cover them);
  // --shots=K: K screenshots spread over the play, named by media time, for colour captures
  if (args.fold === "1") {
    await p.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 60000 });
    await p.getByRole("button", { name: /선수·코트/ }).first().click();
  }
  const shots = Number(args.shots || 0);
  const done = () => p.evaluate((to) => (window.__rec.at(-1)?.t ?? 0) >= to || window.__ppv.state.mode === "error", toS);
  if (shots) {
    const every = (toS / rate) * 1000 / (shots + 1);
    for (let i = 0; i < shots && !(await done()); i++) {
      await p.waitForTimeout(every);
      const mt = await p.evaluate(() => (document.querySelector("video.stage__video") || document.querySelector("video")).currentTime);
      await p.screenshot({ path: `${out}/${showEnds ? "on" : "off"}-${n}-t${mt.toFixed(2)}.png` });
    }
  }
  // --views=WxH,...: the screen as it opens (panels not folded) at each size: a capture and, for each end
  // line, how much of it the page covers (40 points along the line; the topmost element at each point)
  if (args.views) {
    await p.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 60000 });
    await p.waitForTimeout(3000);
    views = [];
    for (const vs of args.views.split(",")) {
      const [w, h] = vs.split("x").map(Number);
      await p.setViewportSize({ width: w, height: h });
      await p.waitForTimeout(2500);
      await p.screenshot({ path: `${out}/view-${vs}.png` });
      views.push({ view: vs, ...(await p.evaluate((corners) => {
        const v = document.querySelector("video.stage__video") || document.querySelector("video");
        const r = v.getBoundingClientRect(), fit = getComputedStyle(v).objectFit;
        const s = (fit === "cover" ? Math.max : Math.min)(r.width / v.videoWidth, r.height / v.videoHeight);
        const ox = r.left + (r.width - v.videoWidth * s) / 2, oy = r.top + (r.height - v.videoHeight * s) / 2;
        const at = (c) => ({ x: ox + c.x * s, y: oy + c.y * s });
        const alpha = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return 0; const p = m[1].split(/[ ,/]+/).filter(Boolean); return p.length > 3 ? Number(p[3]) : 1; };
        const covers = [...document.querySelectorAll("body *")].filter((e) => {
          if (e === v || e.tagName === "CANVAS" || e.contains(v) || !e.getClientRects().length) return false;
          const st = getComputedStyle(e);
          return st.visibility === "visible" && Number(st.opacity) > 0.1 && alpha(st.backgroundColor) > 0.2;
        }).map((e) => ({ r: e.getBoundingClientRect(), k: (e.className && e.className.toString().split(" ")[0]) || e.tagName }));
        const line = (a, b) => {
          const res = { visible: 0, covered: 0, offScreen: 0, by: {} };
          for (let i = 0; i < 40; i++) {
            const x = a.x + (b.x - a.x) * (i + 0.5) / 40, y = a.y + (b.y - a.y) * (i + 0.5) / 40;
            if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) { res.offScreen++; continue; }
            // geometry, not elementFromPoint: floating panels take no pointer events, so a hit test sees
            // through them; a point is covered when a shown element with a visible background holds it
            const e = covers.find((c) => x >= c.r.left && x < c.r.right && y >= c.r.top && y < c.r.bottom);
            if (!e) { res.visible++; continue; }
            res.covered++;
            res.by[e.k] = (res.by[e.k] || 0) + 1;
          }
          return res;
        };
        const q = corners.map(at);
        // the end marks: panel edges (DOM) and arrow tags (canvas), checked against the table quad, buttons
        // and name plates; the near end is blue in these runs (calibration near = 0)
        const ov = document.querySelector("canvas[data-ends]");
        const info = ov && ov.dataset.ends ? JSON.parse(ov.dataset.ends) : null;
        const or = ov ? ov.getBoundingClientRect() : { left: 0, top: 0 };
        const quad = info?.quad ? info.quad.map((p) => ({ x: p.x + or.left, y: p.y + or.top })) : null;
        const inQuad = (p) => { if (!quad) return false; let c = false; for (let i = 0, j = 3; i < 4; j = i++) { const A = quad[i], B = quad[j]; if (A.y > p.y !== B.y > p.y && p.x < ((B.x - A.x) * (p.y - A.y)) / (B.y - A.y) + A.x) c = !c; } return c; };
        const boxPx = (b) => { let n = 0; for (let x = Math.floor(b.x); x < b.x + b.w; x += 2) for (let y = Math.floor(b.y); y < b.y + b.h; y += 2) if (inQuad({ x, y })) n++; return n; };
        const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        const rectOf = (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
        const buttons = [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null).map((b) => ({ ...rectOf(b), name: b.innerText.trim().slice(0, 12) }));
        const plates = Object.values(info?.tags || {}).filter((t) => t && t.w).map((t) => ({ x: t.x + or.left, y: t.y + or.top, w: t.w, h: t.h }));
        const marks = [...document.querySelectorAll(".panel__end")].map((m) => ({ kind: "panel", panel: m.parentNode.classList.contains("court") ? "court" : "players", edge: m.dataset.edge, end: m.dataset.end, ...rectOf(m) }));
        // canvas: a covering panel's label just outside its edge ("panel-label"), or an arrow tag
        const tags = Object.entries(info?.endTags || {}).map(([side, t]) => ({ kind: t.kind || "arrow", side, end: t.color, x: t.x + or.left, y: t.y + or.top, w: t.w, h: t.h, dir: t.dir }));
        const panelRects = [...document.querySelectorAll(".players, .court")].filter((e) => e.offsetParent !== null).map(rectOf);
        const all = [...marks, ...tags];
        const ends = info?.ends || {};
        const truth = { near: "blue", far: "red" };
        const checks = {
          rightEnd: [...marks.map((m) => { const side = Object.entries(ends).find(([, e]) => e.by === m.panel && e.covered >= 0.5)?.[0]; return side ? truth[side] === m.end : false; }), ...tags.map((t) => truth[t.side] === t.end)].every(Boolean),
          tablePx: all.reduce((n, b) => n + boxPx(b), 0),
          overButtons: all.flatMap((b) => buttons.filter((x) => hit(b, x)).map((x) => `${b.kind}:${b.end}/${x.name}`)),
          overPlates: all.flatMap((b) => plates.filter((x) => hit(b, x)).map(() => `${b.kind}:${b.end}`)),
          overPanels: tags.flatMap((b) => panelRects.filter((x) => hit(b, x)).map(() => `${b.kind}:${b.end}`)),
          hiddenEnds: Object.entries(ends).filter(([, e]) => e.covered >= 0.5).map(([s, e]) => `${s}:${e.by}`),
        };
        // every hidden end is marked: a panel border (plus its outside label when one fits) or an arrow tag
        checks.markedWhenHidden = Object.entries(ends).filter(([, e]) => e.covered >= 0.5).every(([side, e]) => marks.some((m) => m.panel === e.by && m.end === truth[side]) || tags.some((t) => t.side === side && t.kind === "arrow"));
        checks.unmarkedWhenClear = Object.entries(ends).filter(([, e]) => e.covered < 0.5).every(([side]) => !tags.some((t) => t.side === side)) && marks.length + tags.length <= 2 * checks.hiddenEnds.length;
        checks.labels = tags.filter((t) => t.kind === "panel-label").length;
        return { fit, video: [Math.round(r.width), Math.round(r.height)], marks: all, ends, checks, near: line(q[0], q[1]), far: line(q[2], q[3]), chip: [...document.querySelectorAll(".chip")].map((c) => c.innerText).find((t) => /블루/.test(t) && /레드/.test(t)) || null };
      }, named.corners)) });
    }
  }
  await p.waitForFunction((to) => (window.__rec.at(-1)?.t ?? 0) >= to || window.__ppv.state.mode === "error", toS, { timeout: Math.round((toS / rate) * 1000 + 180000), polling: 500 });
  const rec = await p.evaluate(() => window.__rec);
  const drawn = await p.evaluate(() => ({ mode: window.__ppv.state.mode, showEnds: window.__ppv.state.showEnds, calibrated: !!window.__ppv.state.calibration }));
  await p.screenshot({ path: `${out}/${showEnds ? "on" : "off"}-${n}.png` });
  clearInterval(flushTimer);
  flushErrs();
  await ctx.close();
  const frames = new Set();
  let inView = 0, hit = 0, offGt = 0;
  for (const r of rec) {
    if (r.t > toS) continue;
    const f = Math.round(r.t * srcFps);
    frames.add(f);
    const g = gt[String(f)];
    const visible = g && g.x >= 0 && g.y >= 0;
    if (visible) {
      inView++;
      if (r.cur && Math.hypot(r.cur.x - g.x, r.cur.y - g.y) <= tol) hit++;
    }
    if (r.cur && (!visible || Math.hypot(r.cur.x - g.x, r.cur.y - g.y) > tol)) offGt++;
  }
  return { showEnds, drawn, views, analysed: rec.filter((r) => r.t <= toS).length, distinctFrames: frames.size, gtInView: inView, hits: hit, recall: inView ? hit / inView : null, ballOffGt: offGt, rec };
}

const results = [];
const order = (args.order || "on,off").split(",");
try {
  for (const [n, c] of order.entries()) {
    const r = await run(c === "on", n + 1);
    results.push({ ...r, label: `${c}${n + 1}` });
    console.log(`RUN ${c}${n + 1} analysed=${r.analysed} frames=${r.distinctFrames} gtInView=${r.gtInView} hits=${r.hits} recall=${r.recall?.toFixed(4)} offGt=${r.ballOffGt}`);
  }
  // the same media frames in two runs, compared one by one
  const byF = (r) => new Map(r.rec.filter((x) => x.t <= toS).map((x) => [Math.round(x.t * srcFps), x.cur]));
  const pairs = [];
  for (let i = 0; i < results.length; i++) for (let j = i + 1; j < results.length; j++) {
    const a = byF(results[i]), b = byF(results[j]);
    let same = 0, both = 0;
    for (const [f, c] of a) {
      if (!b.has(f)) continue;
      both++;
      const d = b.get(f);
      if ((!c && !d) || (c && d && Math.hypot(c.x - d.x, c.y - d.y) < 0.5)) same++;
    }
    pairs.push({ a: results[i].label, b: results[j].label, kind: results[i].showEnds === results[j].showEnds ? "same condition" : "on vs off", sharedFrames: both, sameBall: same });
  }
  const summary = { video: named.name, toS, rate, tol, order, runs: results.map(({ rec, ...r }) => r), pairs };
  writeFileSync(`${out}/recall.json`, JSON.stringify(summary, null, 2));
  for (const q of pairs) console.log(`PAIR ${q.a}-${q.b} ${q.kind} sameBall=${q.sameBall}/${q.sharedFrames}`);
  console.log(`END_LINES_RECALL ${results.map((r) => `${r.label}=${r.recall?.toFixed(4)}`).join(" ")}`);
} finally {
  await browser.close().catch(() => {});
  server.kill();
  rmSync(tmp, { recursive: true, force: true });
}
