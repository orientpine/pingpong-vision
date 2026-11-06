// Pre-roll soak: the real camera screen at phone size (fake camera looping a test clip, calibrated, PC
// save on) runs for some minutes; every 10 s it logs the page heap, the recorder's FrameRing (canvases,
// bytes, pictures held, early hand-overs), the camera's analysis rate and the recorder's draw cost, so a
// run with the pre-roll and one without can be compared and the memory shown not to grow.
//   bun qa/preroll-soak.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> [--minutes=4] [--port=9670]
import { chromium } from "playwright";
import { DEVICES, fakeCamera, startCamera, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const minutes = Number(args.minutes || 4);
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9670) });
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--enable-precise-memory-info"] });
const samples = [];
try {
  const { defaultBrowserType: _d, ...dev } = DEVICES.phone;
  const ctx = await browser.newContext(dev);
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, { "pp-pin": app.pin, "pp-role": "camera", "ppv.uploadKey": JSON.stringify(app.key), "ppv.tourMode": JSON.stringify("all") });
  await ctx.addInitScript(() => { sessionStorage.setItem("pp-started", "1"); });
  await ctx.addInitScript(fakeCamera, `${app.origin}/__qa/cam.webm`);
  const cam = await ctx.newPage();
  await cam.goto(`${app.origin}/vision/`);
  await startCamera(cam);
  // what each rally got from the recorder: its own clip, a clip another rally's stop already got, or none
  await cam.waitForFunction(() => window.__ppv && window.__ppv.recorder, null, { timeout: 30_000 });
  await cam.evaluate(() => {
    const r = window.__ppv.recorder;
    const c = (window.__qaClips = { starts: 0, refused: 0, stops: 0, own: 0, again: 0, none: 0 });
    // weakly held: the counter must not keep clips alive (the soak measures the page heap)
    const seen = new WeakSet();
    const start = r.start.bind(r);
    const stop = r.stop.bind(r);
    r.start = (...x) => { const id = start(...x); c.starts++; if (!id) c.refused++; return id; };
    r.stop = (...x) => {
      const p = stop(...x);
      c.stops++;
      Promise.resolve(p).then((v) => { if (!v || !v.video) c.none++; else if (seen.has(v.video)) c.again++; else { seen.add(v.video); c.own++; } });
      return p;
    };
  });
  const t0 = Date.now();
  while (Date.now() - t0 < minutes * 60_000) {
    await new Promise((r) => setTimeout(r, 10_000));
    const s = await cam.evaluate(() => {
      const r = window.__ppv.recorder;
      const st = window.__ppv.state;
      return {
        heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10 : null,
        ring: r && r.ring ? r.ring.stats : null,
        recording: !!(r && r.recording),
        fps: st.perf && st.perf.fps,
        rec: st.perf && st.perf.rec ? { frames: st.perf.rec.frames, frameMs: Math.round(st.perf.rec.frameMs * 10) / 10 } : null,
        clips: (st.history || []).length,
      };
    });
    s.t = Math.round((Date.now() - t0) / 1000);
    samples.push(s);
    console.log(`SAMPLE ${JSON.stringify(s)}`);
  }
  const heaps = samples.map((s) => s.heapMB).filter((x) => x != null);
  const fps = samples.map((s) => s.fps).filter((x) => x != null).sort((a, b) => a - b);
  const canvases = samples.map((s) => (s.ring ? s.ring.canvases : 0));
  const half = Math.floor(heaps.length / 2);
  const mean = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  await new Promise((r) => setTimeout(r, 6000));
  console.log(`CLIP_OUTCOMES ${JSON.stringify(await cam.evaluate(() => window.__qaClips))}`);
  console.log(`SOAK_SUMMARY ${JSON.stringify({ minutes, samples: samples.length, heapFirstHalfMB: mean(heaps.slice(0, half)), heapSecondHalfMB: mean(heaps.slice(half)), heapMaxMB: Math.max(...heaps), canvasesMax: Math.max(...canvases), canvasesLast: canvases.at(-1), ringBytesMax: Math.max(...samples.map((s) => (s.ring ? s.ring.bytes : 0))), fpsMedian: fps[fps.length >> 1], clips: samples.at(-1)?.clips ?? 0 })}`);
} catch (err) {
  console.log(`ERROR ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await app.stop();
  console.log("SOAK_DONE");
}
