// Calibration taps land where they were tapped: on the real calibration screen, tap the four table
// corners, press 확인, and compare the stored corners (state.calibration.corners, video px) with the video
// coordinates of the taps. Every corner must be within --tol px (default 1). Runs each viewport at two
// tap paces (a quick one catches a layout that moves the picture while the corners go in: the ⇄ end-colour
// button once grew the calibration bar after the 4th tap and every corner landed ~65 px low).
// End lines on, panels as they open (the defaults).
// Since the 정밀하게 button (2026-11-05) nothing moves the corners on its own: the fourth tap keeps them where
// they were tapped, so the 1 px gate is the tap-to-video conversion. snap=off rows still answer calib-refine.js
// with a stand-in that finds no border; --snap=on rows load the real module and only report how far the
// corners moved (0 unless the app snaps by itself again). qa/calib-snap-ui.mjs presses the button.
//   bun qa/calib-taps.mjs --vision=<tree> --tournament=<tree> --clip=<webm> [--port=9590] [--out=<dir>]
//     [--views=393x852,852x393] [--paces=250,60] [--tol=1]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { CORNERS, fakeCamera, startOneApp } from "./one-app-harness.mjs";
import { tx, withLang } from "./qa-lang.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out || "evidence/calib-taps";
mkdirSync(out, { recursive: true });
const tol = Number(args.tol || 1);
const views = (args.views || "393x852,852x393").split(",").map((v) => v.split("x").map(Number));
const paces = (args.paces || "250,60").split(",").map(Number);
const snaps = (args.snap || "off,on").split(",");
const NO_SNAP = "export function refineCorners() { return null; }\nexport function refineCornersMulti() { return null; }\nexport function combineRefines() { return null; }\n";
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9590) });
const browser = withLang(await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] }));
const rows = [];
try {
  for (const snap of snaps) for (const [w, h] of views) for (const pace of paces) {
    const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: w, height: h }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1" });
    await ctx.addInitScript(() => { sessionStorage.setItem("pp-started", "1"); });
    await ctx.addInitScript(fakeCamera, app.origin + "/__qa/cam.webm");
    await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, { "pp-pin": app.pin, "pp-role": "camera" });
    if (snap === "off") await ctx.route(/\/vision\/js\/calib-refine\.js/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: NO_SNAP }));
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message || e).slice(0, 300)));
    await page.goto(app.origin + "/vision/", { waitUntil: "load" });
    await page.getByRole("button", { name: tx(/카메라 시작/, /Start camera/) }).click();
    await page.waitForFunction(() => ["calibrating", "running", "error"].includes(window.__ppv?.state.mode), null, { timeout: 180000 });
    const vid = await page.evaluate(() => ({ mode: window.__ppv.state.mode, w: window.__ppv.state.video?.width, h: window.__ppv.state.video?.height }));
    if (vid.mode !== "calibrating") throw new Error(`not calibrating: ${vid.mode}`);
    // the calibration bar's height before the first tap and after the 4th (must not change, and match main's),
    // and whether any action button's text is cut or wrapped once the 4th corner is in
    const barOf = () => page.evaluate(() => {
      const bar = document.querySelector(".calibbar"), g = document.querySelector(".calibbar__guide"), a = document.querySelector(".calibbar__actions");
      const hgt = (e) => (e ? Math.round(e.getBoundingClientRect().height) : null);
      const btns = a ? [...a.querySelectorAll("button")].map((b) => ({ text: b.innerText.replace(/\s+/g, " ").trim(), over: b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1, disabled: b.disabled })) : [];
      return { bar: hgt(bar), guide: hgt(g), actions: hgt(a), btns };
    });
    const bar0 = await barOf();
    // each tap goes where that corner is on screen at that moment; its video coordinate is the target
    const tapped = [];
    const stageMoves = [];
    for (const c of CORNERS) {
      const target = { x: c.x * (vid.w / 1920), y: c.y * (vid.h / 1080) };
      const pt = await page.evaluate(({ x, y }) => {
        const v = document.querySelector("video");
        const r = v.getBoundingClientRect();
        const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
        return { x: r.left + (r.width - v.videoWidth * k) / 2 + x * k, y: r.top + (r.height - v.videoHeight * k) / 2 + y * k, top: r.top, height: r.height };
      }, target);
      await page.touchscreen.tap(pt.x, pt.y);
      tapped.push(target);
      stageMoves.push([Math.round(pt.top), Math.round(pt.height)]);
      await page.waitForTimeout(pace);
    }
    const after = await page.evaluate(() => { const r = document.querySelector("video").getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; });
    await page.screenshot({ path: `${out}/snap${snap}-${w}x${h}-pace${pace}-4taps.png` });
    const bar4 = await barOf();
    await page.getByRole("button", { name: tx(/^확인/, /^OK/) }).tap();
    await page.waitForFunction(() => window.__ppv.state.mode === "running" && !!window.__ppv.state.calibration, null, { timeout: 20000 });
    const stored = await page.evaluate(() => window.__ppv.state.calibration.corners);
    const err = stored.map((s, i) => Math.hypot(s.x - tapped[i].x, s.y - tapped[i].y));
    const maxErr = Math.max(...err);
    // gated: snap off (the conversion alone); snap on only reports how far the snap moved the corners
    const row = { snap, view: `${w}x${h}`, pace, maxErrPx: Math.round(maxErr * 100) / 100, errPx: err.map((e) => Math.round(e * 100) / 100), videoBox: stageMoves, videoBoxAfter4: after, bar0, bar4, pass: snap === "on" ? !errors.length : maxErr <= tol && !errors.length, errors };
    rows.push(row);
    console.log(`TAPS snap=${snap} ${row.view} pace=${pace} max=${row.maxErrPx}px ${row.pass ? "PASS" : "FAIL"} bar=${bar0.guide}+${bar0.actions}->${bar4.guide}+${bar4.actions} btns=${bar4.btns.map((b) => b.text + (b.over ? "!OVER" : "") + (b.disabled ? "(off)" : "")).join("|")} videoBox=${JSON.stringify(stageMoves)}->${JSON.stringify(after)}${errors.length ? " errors=" + errors.length : ""}`);
    await ctx.close();
  }
} finally {
  writeFileSync(`${out}/report.json`, JSON.stringify(rows, null, 2));
  await browser.close();
  await app.stop();
}
const total = snaps.length * views.length * paces.length;
const pass = rows.length === total && rows.every((r) => r.pass);
console.log(`CALIB_TAPS ${pass ? "PASS" : "FAIL"} ${rows.filter((r) => r.pass).length}/${total} (1 px gate on snap=off rows)`);
process.exit(pass ? 0 : 1);
