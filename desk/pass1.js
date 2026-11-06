// The analysis desk's first pass over a gallery video: shots, bounces, kinds and winners without the pose
// model and without a browser, so they can be shown within seconds of the job starting.
//   bun desk/pass1.js --video FILE --corners JSON [--played-at MS]
// stdout: one JSON line {rallies:[Rally]} (the same desk Rally records the analyzer makes; every stroke is
// null until the full analysis fills forehand/backhand in). Errors on stderr with exit 1.
// The video is decoded in order by ffmpeg at the pipeline's processing width and goes through the app's
// own pixel path (Pipeline.processPixels: table check, shake gate, ball lock, rally), the way
// qa/ball-offline.mjs runs it. Without the pose model no body is cut out of the ball search, which on the
// labelled public videos found more real shots (docs/analysis-desk.md).
import { parseArgs } from "node:util";
import { RallyShots } from "../public/js/analysis-record.js";
import { Pipeline } from "../public/js/pipeline.js";
import { pickFps } from "./fps.js";
import { DeskRallies } from "./page/collect.js";
import { deskRally } from "./run-state.js";

const PROC_WIDTH = 640;
// the analyzer runs at most 60 analysed frames a second; a faster video is stepped through
const MAX_FPS = 60;

async function probe(video) {
  const p = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate", "-of", "csv=p=0", video], { stdout: "pipe" });
  const [w, h, r, avg] = (await new Response(p.stdout).text()).trim().split(",");
  const fps = pickFps(r, avg);
  if ((await p.exited) !== 0 || !(+w > 0) || !(+h > 0) || !fps) throw new Error(`ffprobe could not read ${video}`);
  return { width: +w, height: +h, fps };
}

// frames: an async iterable of { rgba, t } at PROC_WIDTH; returns the desk Rally records, in order.
export async function firstPassRallies({ frames, width, height, corners, playedAt }) {
  const rallies = new DeskRallies("gallery", RallyShots);
  const pipe = new Pipeline({ procWidth: PROC_WIDTH, onEvent: (e) => rallies.onEvent(e) });
  pipe.setVideoSize(width, height);
  pipe.setCalibration(corners);
  const out = [];
  const keep = (list) => { for (const r of list) out.push(deskRally(r, out.length, playedAt)); };
  let firstT = null;
  let lastT = 0;
  for await (const { rgba, t } of frames) {
    firstT ??= t;
    lastT = t;
    pipe.processPixels(rgba, t);
    keep(rallies.take());
  }
  pipe.reset();
  keep(rallies.finish(firstT ?? 0, lastT));
  return out;
}

// The video's frames in order at PROC_WIDTH, as the analyzer's frame times (frame / fps).
export async function* decodeFrames(video, { width, height, fps }) {
  const ph = Math.round((height / width) * PROC_WIDTH);
  const step = Math.max(1, Math.round(fps / Math.min(MAX_FPS, fps)));
  const ff = Bun.spawn(["ffmpeg", "-v", "error", "-i", video, "-vf", `select=not(mod(n\\,${step})),scale=${PROC_WIDTH}:${ph}`, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { stdout: "pipe", stderr: "pipe" });
  const size = PROC_WIDTH * ph * 4;
  let frame = new Uint8ClampedArray(size);
  let filled = 0;
  let i = 0;
  for await (const chunk of ff.stdout) {
    let at = 0;
    while (at < chunk.length) {
      const n = Math.min(size - filled, chunk.length - at);
      frame.set(chunk.subarray(at, at + n), filled);
      filled += n;
      at += n;
      if (filled === size) {
        yield { rgba: frame, t: (i * step) / fps };
        frame = new Uint8ClampedArray(size);
        filled = 0;
        i++;
      }
    }
  }
  if ((await ff.exited) !== 0) throw new Error(`ffmpeg could not decode ${video}: ${(await new Response(ff.stderr).text()).trim().split("\n").pop()}`);
}

if (import.meta.main) {
  const { values: args } = parseArgs({ options: { video: { type: "string" }, corners: { type: "string" }, "played-at": { type: "string", default: "0" } } });
  if (!args.video || !args.corners) {
    console.error("usage: bun desk/pass1.js --video FILE --corners JSON [--played-at MS]");
    process.exit(2);
  }
  try {
    const info = await probe(args.video);
    const rallies = await firstPassRallies({ frames: decodeFrames(args.video, info), ...info, corners: JSON.parse(args.corners), playedAt: Number(args["played-at"]) });
    process.stdout.write(`${JSON.stringify({ rallies })}\n`);
  } catch (err) {
    console.error(`first pass failed: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  }
}
