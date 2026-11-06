// Does the court map say which end is blue and which is red? Owner (2026-11-01): colour both ends of the
// table on the map, not one panel border. The real camera screen with a public clip playing and a saved
// calibration, at each screen size: the map's two short edges (.cm-end--near / --far) must be drawn in the
// colour of that end (state.players[side].end, the same colour the camera's end lines use), then again after
// the near end's colour is swapped in settings (카메라 앞쪽 / Near end) and after 자리 교체 (Swap), which keeps
// the ends' colours. A court map never carries an end mark (.panel__end) or a label/arrow for a line under it.
//   bun qa/courtmap-ends.mjs --vision=<checkout> [--name=clip12] [--views=393x852,852x393,1920x1080] [--lang=ko|en]
//     [--port=9591] [--out=<dir>] [--shrink=1]
// --shrink=0.6 moves the saved corners that far toward their centre: on the public clips the landscape court map
// has no free spot off the table and folds itself, and a smaller table leaves it one (a capture of the map at 852)
// Writes <out>/<lang>-<view>-<step>.png (screen) and -map.png (the court map), and result.json. Exit 0 only
// when every step at every size passes; prints COURTMAP_ENDS PASS|FAIL.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CORNERS } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const vision = resolve(args.vision || ".");
const out = resolve(args.out || "evidence/courtmap-ends");
mkdirSync(out, { recursive: true });
const name = args.name || "clip12";
const catalog = JSON.parse(readFileSync(join(vision, "qa/eval-set.json"), "utf8"));
const named = name === "clip12" ? { name, video: "data/videos/clip12_720p60.webm", corners: CORNERS } : catalog.videos.find((v) => v.name === name);
if (!named) throw new Error(`no video ${name}`);
const media = (p) => [join(vision, p), ...(process.env.PPV_DATA_ROOT ? [join(process.env.PPV_DATA_ROOT, p)] : [])].find((x) => existsSync(x));
const video = media(named.video);
if (!video) throw new Error(`missing ${named.video} (set PPV_DATA_ROOT)`);
const views = (args.views || "393x852,852x393,1920x1080").split(",");
const lang = args.lang === "en" ? "en" : "ko";
const port = Number(args.port || 9591);
const shrink = Number(args.shrink || 1);
const cx = named.corners.reduce((a, c) => a + c.x, 0) / 4, cy = named.corners.reduce((a, c) => a + c.y, 0) / 4;
const corners = named.corners.map((c) => ({ x: Math.round(cx + (c.x - cx) * shrink), y: Math.round(cy + (c.y - cy) * shrink) }));
const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ppv-courtmap-"));
const server = spawn("bun", [join(vision, "server.js")], { cwd: vision, env: { ...process.env, PORT: String(port), PPV_TOURNAMENT_URL: "off", PPV_SAVE_DIR: join(tmp, "saves"), PPV_KEY_FILE: join(tmp, "key"), PPV_SETUP_FILE: join(tmp, "setup.json") }, stdio: ["ignore", "ignore", "inherit"] });
const origin = `http://127.0.0.1:${port}`;
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try { up = (await fetch(`${origin}/healthz`)).ok; } catch {}
  if (!up) await Bun.sleep(100);
}
if (!up) { server.kill(); throw new Error(`server on ${port} did not start`); }

// In the page: what the map draws for each end against the end's colour, and every end mark on the map.
function read() {
  const st = window.__ppv.state;
  const app = document.querySelector(".app");
  const cs = getComputedStyle(app);
  const want = (side) => (st.players?.[side]?.end === 1 ? cs.getPropertyValue("--c-red") : cs.getPropertyValue("--c-blue")).trim();
  const rgb = (c) => { const e = document.createElement("i"); e.style.color = c; document.body.append(e); const v = getComputedStyle(e).color; e.remove(); return v; };
  const court = document.querySelector(".court");
  const ends = {};
  for (const side of ["near", "far"]) {
    const l = court?.querySelector(`.cm-end--${side}`);
    ends[side] = { end: st.players?.[side]?.end, want: rgb(want(side)), drawn: l ? getComputedStyle(l).stroke : null, px: l ? Number.parseFloat(getComputedStyle(l).strokeWidth) : 0 };
  }
  const ov = document.querySelector("canvas[data-ends]");
  const info = ov && ov.dataset.ends ? JSON.parse(ov.dataset.ends) : null;
  const underCourt = Object.entries(info?.ends || {}).filter(([, e]) => e.by === "court" && e.covered >= 0.5).map(([s]) => s);
  return {
    layout: app?.dataset.layout,
    courtShown: !!court && !court.closest("[hidden]") && court.getBoundingClientRect().width > 2,
    ends,
    camera: Object.fromEntries(Object.entries(info?.ends || {}).map(([s, e]) => [s, e.color])),
    courtMarks: court ? court.querySelectorAll(".panel__end").length : -1,
    playerMarks: document.querySelectorAll(".players .panel__end").length,
    underCourt,
    tagsForCourt: underCourt.filter((s) => info?.endTags?.[s]).length,
    labels: { near: st.players?.near?.label, far: st.players?.far?.label },
  };
}
const passOf = (r) => ["near", "far"].every((s) => r.ends[s].drawn === r.ends[s].want && r.ends[s].px >= 2 && (!r.camera[s] || (r.camera[s] === "red") === (r.ends[s].end === 1))) && r.courtMarks === 0 && r.tagsForCourt === 0;

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const result = { video: named.name, lang, vision, shrink, views: [] };
const errs = [];
let ok = true;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
  await ctx.addInitScript(({ cal, lang }) => {
    sessionStorage.setItem("pp-started", "1");
    localStorage.setItem("pp-role", "camera");
    localStorage.setItem("pp-lang", lang);
    localStorage.setItem("ppv.calibration", JSON.stringify(cal));
  }, { cal: { corners, width: 1920, height: 1080 }, lang });
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
  const near = lang === "en" ? "Near end" : "카메라 앞쪽";
  const swapName = lang === "en" ? /^Swap places/ : /^자리 교체/;
  const settingsName = lang === "en" ? "Settings" : "설정";
  for (const vs of views) {
    const [w, h] = vs.split("x").map(Number);
    await p.setViewportSize({ width: w, height: h });
    await p.waitForTimeout(2500);
    const steps = [];
    result.views.push({ view: vs, steps });
    // landscape: a court map with no free spot off the table folds by itself (dot on the 선수·코트 chip) and
    // retries every 3 s; wait up to 30 s for it, and say so when it stayed folded (colours are still read)
    const snap = async (step) => {
      await p.waitForTimeout(800);
      const waited = Date.now();
      await p.waitForFunction(() => { const c = document.querySelector(".court"); return !!c && !c.closest("[hidden]") && c.getBoundingClientRect().width > 2; }, null, { timeout: 30000 }).catch(() => {});
      const waitMs = Date.now() - waited;
      const r = await p.evaluate(read);
      const base = `${lang}-${vs}-${step}`;
      await p.screenshot({ path: join(out, `${base}.png`) });
      if (r.courtShown) await p.locator(".court").screenshot({ path: join(out, `${base}-map.png`) });
      const pass = passOf(r);
      if (!pass) ok = false;
      steps.push({ step, pass, waitMs, folded: !r.courtShown, ...r });
    };
    await snap("start");
    // swap the near end's colour where a person does it: settings, 카메라 앞쪽 / Near end
    const before = await p.evaluate(() => window.__ppv.state.players.near.end);
    await p.getByRole("button", { name: settingsName, exact: true }).click();
    const grp = p.getByRole("group", { name: near, exact: true });
    await grp.getByRole("button").nth(before === 1 ? 0 : 1).click();
    await p.waitForFunction((b) => window.__ppv.state.players.near.end !== b, before, { timeout: 5000 });
    await p.locator(".popover__title button").click();
    await snap("ends-swapped");
    const swapped = steps.at(-1);
    if (swapped.ends.near.end === before) { ok = false; swapped.pass = false; swapped.why = "near end colour did not change"; }
    // 자리 교체: the players trade ends, the ends keep their colours
    await p.getByRole("button", { name: swapName }).click();
    await snap("players-swapped");
    const ps = steps.at(-1);
    if (ps.ends.near.end !== swapped.ends.near.end) { ok = false; ps.pass = false; ps.why = "end colours moved with 자리 교체"; }
    // back to the start for the next size
    await p.getByRole("button", { name: swapName }).click();
    await p.getByRole("button", { name: settingsName, exact: true }).click();
    await p.getByRole("group", { name: near, exact: true }).getByRole("button").nth(before === 1 ? 1 : 0).click();
    await p.locator(".popover__title button").click();
    console.log(vs, steps.map((s) => `${s.step}:${s.pass ? "ok" : "FAIL"}${s.folded ? "(folded)" : ""} near=${s.ends.near.drawn} far=${s.ends.far.drawn} courtMarks=${s.courtMarks} underCourt=${s.underCourt} tags=${s.tagsForCourt}`).join(" | "));
  }
  await ctx.close();
} catch (e) {
  ok = false;
  errs.push(String(e && (e.stack || e.message) || e).slice(0, 2000));
  // what the page was doing when it stopped: mode, loading, error, and a screen
  for (const pg of browser.contexts().flatMap((c) => c.pages())) {
    errs.push(JSON.stringify(await pg.evaluate(() => { const s = window.__ppv?.state; return { mode: s?.mode, loading: s?.loading, error: s?.error, video: !!document.querySelector("video")?.src }; }).catch((x) => String(x))));
    await pg.screenshot({ path: join(out, `${lang}-stuck.png`) }).catch(() => {});
  }
} finally {
  await browser.close();
  server.kill();
}
result.errors = errs;
result.folded = result.views.flatMap((v) => v.steps.filter((x) => x.folded).map((x) => `${v.view} ${x.step}`));
result.pass = ok && !errs.length;
writeFileSync(join(out, `result-${lang}.json`), JSON.stringify(result, null, 2));
console.log(`COURTMAP_ENDS ${result.pass ? "PASS" : "FAIL"} ${lang}${result.folded.length ? ` folded=${result.folded.length}` : ""}${errs.length ? ` errors=${errs.length}: ${errs[0].slice(0, 300)}` : ""}`);
process.exit(result.pass ? 0 : 1);
