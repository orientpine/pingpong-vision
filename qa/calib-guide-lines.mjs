// Every calibration guide message fits in two lines on the portrait calibration screen, and the guide keeps
// one height whatever message shows (a guide that grew moved the picture while the corners were tapped).
// The messages are read from public/js/ui.js (CALIB_STEPS and every CALIB_* string); each is put in the guide
// in turn after the fonts load.
//   bun qa/calib-guide-lines.mjs --vision=<tree> --tournament=<tree> --clip=<webm> [--port=9595] [--views=393x852] [--out=<dir>]
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCamera, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out || "evidence/calib-guide-lines";
mkdirSync(out, { recursive: true });
const src = readFileSync(join(args.vision, "public/js/ui.js"), "utf8");
const steps = (src.match(/const CALIB_STEPS = \[([\s\S]*?)\];/) || [, ""])[1].match(/"[^"]*"/g) || [];
const singles = [...src.matchAll(/^const CALIB_[A-Z_]+ = ("[^"]*");/gm)].map((m) => m[1]);
const messages = [...steps, ...singles].map((s) => JSON.parse(s));
const views = (args.views || "393x852").split(",").map((v) => v.split("x").map(Number));
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9595) });
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const rows = [];
let pass = messages.length >= 8;
try {
  for (const [w, h] of views) {
    const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: w, height: h }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await ctx.addInitScript(() => { sessionStorage.setItem("pp-started", "1"); });
    await ctx.addInitScript(fakeCamera, app.origin + "/__qa/cam.webm");
    await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, { "pp-pin": app.pin, "pp-role": "camera" });
    const page = await ctx.newPage();
    await page.goto(app.origin + "/vision/", { waitUntil: "load" });
    await page.getByRole("button", { name: /카메라 시작/ }).click();
    await page.waitForFunction(() => window.__ppv?.state.mode === "calibrating", null, { timeout: 180000 });
    await page.evaluate(() => document.fonts.ready);
    const res = await page.evaluate((msgs) => {
      const t = document.querySelector(".calibbar__text"), g = document.querySelector(".calibbar__guide"), v = document.querySelector("video");
      const lh = parseFloat(getComputedStyle(t).lineHeight);
      const keep = t.textContent;
      const r = msgs.map((m) => {
        t.textContent = m;
        // natural height of the text itself (min-height aside): its line boxes
        const range = document.createRange();
        range.selectNodeContents(t);
        const lines = new Set([...range.getClientRects()].map((x) => Math.round(x.top))).size;
        return { m, lines, guide: Math.round(g.getBoundingClientRect().height), videoTop: Math.round(v.getBoundingClientRect().top), videoH: Math.round(v.getBoundingClientRect().height) };
      });
      t.textContent = keep;
      return { lh, r };
    }, messages);
    const guides = new Set(res.r.map((x) => x.guide)), tops = new Set(res.r.map((x) => `${x.videoTop}/${x.videoH}`));
    const maxLines = Math.max(...res.r.map((x) => x.lines));
    const ok = maxLines <= 2 && guides.size === 1 && tops.size === 1;
    pass = pass && ok;
    for (const x of res.r) console.log(`LINE ${w}x${h} lines=${x.lines} guide=${x.guide} video=${x.videoTop}/${x.videoH} ${x.m}`);
    console.log(`VIEW ${w}x${h} messages=${messages.length} maxLines=${maxLines} guideHeights=${[...guides].join(",")} videoBoxes=${[...tops].join(",")} ${ok ? "PASS" : "FAIL"}`);
    rows.push({ view: `${w}x${h}`, lh: res.lh, maxLines, guideHeights: [...guides], videoBoxes: [...tops], ok, rows: res.r });
    await page.screenshot({ path: `${out}/${w}x${h}-calibrating.png` });
    await ctx.close();
  }
} finally {
  writeFileSync(`${out}/report.json`, JSON.stringify(rows, null, 2));
  await browser.close();
  await app.stop();
}
console.log(`CALIB_GUIDE_LINES ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
