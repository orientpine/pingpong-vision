// Which clock the camera analysis runs on (app.js frameTime: captureTime, presentationTime or the
// display tick) and how evenly the analysed frames are spaced, on the real camera screen with the
// fake camera. Prints CAM_CLOCK {...}; exit 1 if the camera never runs.
//   bun qa/cam-clock.mjs --vision=<tree> --tournament=<tree> --clip=<webm> [--port=9600] [--seconds=8] [--engine=webkit]
// (webkit: PPV_WEBKIT may point at a user-space WebKit, as the other WebKit harnesses)
import { chromium, webkit } from "playwright";
import { DEVICES, fakeCamera, startCamera, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9600) });
const browser = args.engine === "webkit" ? await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {}) : await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
let code = 0;
try {
  const ctx = await browser.newContext({ ...DEVICES.phone, serviceWorkers: "block" });
  await ctx.addInitScript(() => { sessionStorage.setItem("pp-started", "1"); });
  await ctx.addInitScript(fakeCamera, app.origin + "/__qa/cam.webm");
  await ctx.addInitScript(() => localStorage.setItem("pp-role", "camera"));
  const page = await ctx.newPage();
  await page.goto(app.origin + "/vision/");
  await startCamera(page);
  // record the analysis time of each processed frame for a few seconds
  const res = await page.evaluate(async (ms) => {
    const p = window.__ppv.pipeline;
    const orig = p.process.bind(p);
    const ts = [];
    p.process = (src, t) => { ts.push(t); return orig(src, t); };
    await new Promise((r) => setTimeout(r, ms));
    p.process = orig;
    const d = ts.slice(1).map((t, i) => (t - ts[i]) * 1000);
    const mean = d.reduce((a, b) => a + b, 0) / (d.length || 1);
    const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (d.length || 1));
    const q = (p) => { const s = [...d].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10 : null; };
    return { clock: window.__ppv.state.perf.clock || null, frames: ts.length, meanMs: Math.round(mean * 10) / 10, sdMs: Math.round(sd * 10) / 10, p10: q(0.1), p50: q(0.5), p90: q(0.9), zero: d.filter((x) => x === 0).length, negative: d.filter((x) => x < 0).length, under1ms: d.filter((x) => x > 0 && x < 1).length, fps: window.__ppv.state.perf.fps, mode: window.__ppv.state.mode };
  }, Number(args.seconds || 8) * 1000);
  console.log("CAM_CLOCK " + JSON.stringify(res));
  if (res.mode !== "running" || !res.frames) code = 1;
} catch (e) {
  console.log("CAM_CLOCK_FAIL " + e.message);
  code = 1;
} finally {
  await browser.close();
  await app.stop?.();
}
process.exit(code);
