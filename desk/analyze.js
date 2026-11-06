// The analysis desk's analyzer: one video through the production Pipeline in headless Chromium.
//   bun desk/analyze.js --video FILE --corners JSON --checkpoint FILE [--played-at MS]
//                       [--model full] [--delegate CPU|GPU] [--fps N] [--kind gallery|rally]
// --delegate: where the pose model runs. GPU here is SwiftShader, a GPU drawn on the CPU (the browser below
// has no real GPU): one 16-frame rally took 12.3 s that way and 2.1 s with CPU (wasm). The default is CPU
// for --kind rally, whose shots come from the phone's track and only the joints are the desk's, and GPU
// for --kind gallery: there the joints also decide which shots are found, and on a labelled public clip
// the CPU joints lost 2 of 9 real shots.
// --kind rally: the video is one 다시 보기 original, sent as one rally (desk/page/collect.js).
// --track FILE (rally only): the original's overlay.json.gz; shots and bounces come from it and pose is
// taken only around them (desk/page/track-shots.js). The last line then carries timing.
// --shots FILE (gallery only): the job's first pass ({rallies}, desk/pass1.js). The page still runs pose over
// every frame, and each first-pass shot takes its forehand/backhand (rally.js strokeSide) and joints from
// the players at its own time; the last line is those rallies, filled, instead of the page's own.
import { gunzipSync } from "node:zlib";
// stdout: one JSON line per {progress:{done,total}} and a last {rallies:[Rally]}; errors on stderr
// with exit 1. A checkpoint is written every 30 s; a run started on the same checkpoint goes on
// from it. The worker (desk/worker.js) starts this through the GPU job queue.
import { statSync } from "node:fs";
import { join, normalize } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { Checkpoint, takeLock } from "./checkpoint.js";
import { AnalysisRun } from "./run-state.js";
import { pickFps } from "./fps.js";

const ROOT = join(import.meta.dir, "..");
const MOUNTS = [
  ["/desk/", "desk/page/"],
  ["/js/", "public/js/"],
  ["/models/", "public/models/"],
  ["/vendor/mediapipe/", "node_modules/@mediapipe/tasks-vision/"],
];
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };
// the camera app's policy: MediaPipe's usage logger cannot reach the network from here either
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; media-src 'self' blob:; connect-src 'self' blob:; worker-src 'self' blob:";

const { values: args } = parseArgs({
  options: {
    video: { type: "string" },
    corners: { type: "string" },
    checkpoint: { type: "string" },
    "played-at": { type: "string", default: "0" },
    model: { type: "string", default: "full" },
    delegate: { type: "string" },
    fps: { type: "string" },
    kind: { type: "string", default: "gallery" },
    track: { type: "string" },
    shots: { type: "string" },
  },
});
if (!args.video || !args.corners || !args.checkpoint) {
  console.error("usage: bun desk/analyze.js --video FILE --corners JSON --checkpoint FILE");
  process.exit(2);
}
const delegate = args.delegate ?? (args.kind === "rally" ? "CPU" : "GPU");

async function probeFps(video) {
  const p = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,avg_frame_rate", "-of", "csv=p=0", video], { stdout: "pipe" });
  const [r, avg] = (await new Response(p.stdout).text()).trim().split(",");
  const fps = pickFps(r, avg);
  if ((await p.exited) !== 0 || !fps) throw new Error(`ffprobe could not read the frame rate of ${video}`);
  return fps;
}

// a byte range of the file, as the video element asks for when it seeks
function fileResponse(path, range) {
  const file = Bun.file(path);
  const ext = path.slice(path.lastIndexOf("."));
  const headers = { "content-type": TYPES[ext] || (path === args.video ? "video/mp4" : "application/octet-stream"), "accept-ranges": "bytes", "content-security-policy": CSP };
  const m = /^bytes=(\d*)-(\d*)$/.exec(range || "");
  if (!m || !(m[1] || m[2])) return new Response(file, { headers });
  const start = m[1] ? Number(m[1]) : Math.max(0, file.size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), file.size - 1) : file.size - 1;
  if (start >= file.size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${file.size}` } });
  return new Response(file.slice(start, end + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${file.size}` } });
}

function serveAssets() {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/video") return fileResponse(args.video, req.headers.get("range"));
      if (pathname === "/shots" && given) return Response.json(pendingShots());
      if (pathname === "/track" && trackJson) return new Response(trackJson, { headers: { "content-type": "application/json", "content-security-policy": CSP } });
      const rel = normalize(decodeURIComponent(pathname));
      const mount = MOUNTS.find(([prefix]) => rel.startsWith(prefix));
      if (!mount || rel.includes("..")) return new Response("not found\n", { status: 404 });
      const path = join(ROOT, mount[1], rel.slice(mount[0].length));
      return (await Bun.file(path).exists()) ? fileResponse(path, req.headers.get("range")) : new Response("not found\n", { status: 404 });
    },
  });
}

const fps = args.fps ? Number(args.fps) : await probeFps(args.video);
const trackJson = args.kind === "rally" && args.track ? gunzipSync(await Bun.file(args.track).arrayBuffer()).toString("utf8") : null;
const releaseLock = takeLock(`${args.checkpoint}.pid`);
const given = args.kind !== "rally" && args.shots ? JSON.parse(await Bun.file(args.shots).text()).rallies : null;
// the first-pass shots still without a fill, in time order; a resumed run skips those it filled before
const pendingShots = () =>
  given
    .flatMap((r, rally) => r.shots.map((s, shot) => ({ rally, shot, t: s.t, side: s.side })))
    .filter((s) => !run.state.fills[`${s.rally}:${s.shot}`])
    .sort((x, y) => x.t - y.t);
const run = new AnalysisRun({
  given,
  checkpoint: new Checkpoint({ path: args.checkpoint, key: `${statSync(args.video).size}:${fps}` }),
  playedAt: Number(args["played-at"]),
  out: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
});
const server = serveAssets();
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
process.on("SIGTERM", () => browser.close().finally(() => process.exit(143)));

let settle;
const finished = new Promise((resolve, reject) => (settle = { resolve, reject }));
try {
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.error("[page]", m.text());
  });
  page.on("pageerror", (err) => settle.reject(err));
  await page.exposeFunction("__desk", (m) => {
    if (m.error) settle.reject(new Error(m.error));
    else if (m.done) settle.resolve(m);
    else run.onMessage(m);
  });
  const query = new URLSearchParams({ fps: String(fps), from: String(run.startFrame), corners: args.corners, model: args.model, delegate, kind: args.kind === "rally" ? "rally" : "gallery", track: trackJson ? "1" : "", shots: given ? "1" : "" });
  if (run.startFrame > 0) console.error(`resuming at frame ${run.startFrame} with ${run.state.rallies.length} rallies from ${args.checkpoint}`);
  await page.goto(`http://127.0.0.1:${server.port}/desk/analyze.html?${query}`);
  const done = await finished;
  console.error(`analyzed with pose delegate ${done.delegate}${done.timing ? `, shot times from the track (${done.timing})` : ""}`);
  run.finish(done.timing ?? null);
} catch (err) {
  console.error(`analysis failed: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.stop(true);
  releaseLock();
}
