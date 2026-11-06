// Recording must never stop scoring: the real camera screen at phone size (fake camera looping a test
// clip, calibrated, linked, PC save on) runs; after a baseline the recorder's frame hook is made to throw.
// The camera's analysis rate and its rally history must go on, recording must turn itself off once
// (PC chip and one console warning), and nothing else may break.
//   bun qa/recorder-fault.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> [--port=9680]
import { chromium } from "playwright";
import { DEVICES, fakeCamera, startCamera, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9680) });
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const log = (...a) => console.log(...a);
let ok = false;
try {
  const { defaultBrowserType: _d, ...dev } = DEVICES.phone;
  const ctx = await browser.newContext(dev);
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, { "pp-pin": app.pin, "pp-role": "camera", "ppv.uploadKey": JSON.stringify(app.key), "ppv.tourMode": JSON.stringify("all") });
  await ctx.addInitScript(() => { sessionStorage.setItem("pp-started", "1"); });
  await ctx.addInitScript(fakeCamera, `${app.origin}/__qa/cam.webm`);
  const cam = await ctx.newPage();
  const warns = [];
  const errors = [];
  cam.on("console", (m) => { if (m.type() === "warning" && m.text().includes("ppv: replay recording off")) warns.push(m.text()); });
  cam.on("pageerror", (e) => errors.push(e.message));
  await cam.goto(`${app.origin}/vision/`, { waitUntil: "load" });
  await startCamera(cam);
  const read = () => cam.evaluate(() => ({ fps: window.__ppv.state.perf && window.__ppv.state.perf.fps, history: (window.__ppv.state.history || []).length, recordOff: !!window.__ppv.state.save.recordOff, broken: !!(window.__ppv.recorder && window.__ppv.recorder.broken), chip: document.querySelector("[data-save-chip], .chip--save, .save-chip")?.textContent?.trim() ?? null, mode: window.__ppv.state.mode }));
  const watch = async (seconds) => { const xs = []; for (let i = 0; i < seconds / 5; i++) { await new Promise((r) => setTimeout(r, 5000)); xs.push(await read()); } return xs; };
  const before = await watch(40);
  log("BEFORE", JSON.stringify(before.at(-1)), "fps", JSON.stringify(before.map((x) => x.fps)));
  await cam.evaluate(() => { window.__ppv.recorder.frame = () => { throw new Error("qa: recorder fault"); }; });
  const after = await watch(120);
  log("AFTER", JSON.stringify(after.at(-1)), "fps", JSON.stringify(after.map((x) => x.fps)));
  const med = (xs) => { const s = xs.map((x) => x.fps || 0).sort((a, b) => a - b); return s[s.length >> 1]; };
  const grew = after.at(-1).history - before.at(-1).history;
  const fpsKept = med(after) >= Math.max(1, med(before) * 0.5) && new Set(after.slice(-6).map((x) => x.fps)).size >= 1 && after.at(-1).mode === "running";
  ok = fpsKept && grew >= 1 && after.at(-1).recordOff && after.at(-1).broken && warns.length === 1 && errors.length === 0;
  log("FAULT", JSON.stringify({ ok, fpsBefore: med(before), fpsAfter: med(after), historyGrew: grew, recordOff: after.at(-1).recordOff, broken: after.at(-1).broken, warnings: warns.length, pageErrors: errors.slice(0, 3) }));
} catch (err) {
  log("ERROR", err && err.stack ? err.stack : err);
} finally {
  await browser.close();
  await app.stop();
  log(`RECORDER_FAULT_DONE ${ok ? "PASS" : "FAIL"}`);
}
