// Corner snapping accuracy: perturb each video's read corners like rough taps, run calib-refine.js on a
// second of frames (median per corner), and compare taps and result against the read corners.
//   bun qa/corner-refine.mjs [--set=qa/eval-set.json] [--frames=600,1500,3000,4500,6000 | --every=3 --count=10]
//     [--radii=8,15,25,40] [--angles=6] [--shake=0] [--offtable=1] [--impl=public/js/calib-refine.js] [--out=evidence/r4/corner-refine.json]
// --shake=0,3,6,10 moves every frame by a fixed pseudo-random offset up to that many px (a shaking tripod);
// the error is still measured against the still corners. --impl points at another tree's calib-refine.js
// (main) for a before/after table. Besides the corner px it reports, per trial, the largest distance of a
// read side from the fitted side (px) and the largest miss on the table top (cm), qa/calib-error.mjs. A set entry may carry its own "frame" to start the frames at.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { quadError } from "./calib-error.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const set = JSON.parse(readFileSync(args.set || "qa/eval-set.json", "utf8"));
const { refineCorners, refineCornersMulti } = await import(resolve(args.impl || "public/js/calib-refine.js"));
const fixedFrames = args.frames ? args.frames.split(",").map(Number) : null;
const every = Number(args.every || 3);
const count = Number(args.count || 10);
const out = args.out || "evidence/r4/corner-refine.json";
const RADII = (args.radii || "8,15,25,40").split(",").map(Number);
const SHAKES = (args.shake || "0").split(",").map(Number);
const ANGLES = Number(args.angles || 6);

// All sample frames of one video in a single decode (frames past the end are dropped).
function framesOf(video, ns) {
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", video], { encoding: "utf8" });
  const [w, h] = probe.stdout.trim().split(",").map(Number);
  const sel = ns.map((n) => `eq(n\\,${n})`).join("+");
  const ff = spawnSync("ffmpeg", ["-v", "error", "-i", video, "-vf", `select=${sel}`, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: ns.length * w * h * 4 + 1024 });
  const size = w * h * 4;
  const frames = [];
  for (let o = 0; o + size <= ff.stdout.length; o += size) frames.push({ w, h, rgba: new Uint8ClampedArray(ff.stdout.buffer, ff.stdout.byteOffset + o, size) });
  return frames;
}
// the frame moved by (dx, dy) whole px, edges repeated
function shifted({ rgba, w, h }, dx, dy) {
  const o = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(h - 1, Math.max(0, y - dy));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - dx));
      o.set(rgba.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * w + x) * 4);
    }
  }
  return { rgba: o, w, h };
}
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const err = (a, b) => a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y));
const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
const pct = (v, q) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * q))];
const report = { set: args.set || "qa/eval-set.json", impl: args.impl || "public/js/calib-refine.js", radii: RADII, shakes: SHAKES, angles: ANGLES, videos: {} };
for (const v of set.videos) {
  if (!v.corners || v.name.includes("oldcorners")) continue;
  const start = v.frame || 0;
  const ns = fixedFrames || Array.from({ length: count }, (_, k) => start + k * every);
  const still = framesOf(v.video, ns);
  const gt = v.corners;
  const byCase = {};
  for (const amp of SHAKES) {
    seed = 7;
    const frames = amp ? still.map((f) => { const t = rnd() * 2 * Math.PI; const a = amp * Math.sqrt(rnd()); return shifted(f, Math.round(a * Math.cos(t)), Math.round(a * Math.sin(t))); }) : still;
    for (const r of RADII) {
      const before = [];
      const after = [];
      const afterOk = [];
      const lines = [];
      const tables = [];
      const linesOk = [];
      const tablesOk = [];
      let ok = 0;
      let warn = 0;
      const reasons = {};
      let single = 0;
      for (let a = 0; a < ANGLES; a++) {
        // Each corner pushed r px in its own direction, so the quad is skewed, not shifted.
        const taps = gt.map((p, i) => {
          const th = ((a * 4 + i) * 2.399963) % (2 * Math.PI);
          return { x: Math.round(p.x + r * Math.cos(th)), y: Math.round(p.y + r * Math.sin(th)) };
        });
        const res = refineCornersMulti(frames, taps);
        if (refineCorners(frames[0].rgba, frames[0].w, frames[0].h, taps).ok) single++;
        if (!res.ok) reasons[res.code || res.reason] = (reasons[res.code || res.reason] || 0) + 1;
        if (res.ok) ok++;
        if (res.shake === "warn") warn++;
        const e = err(res.corners, gt);
        before.push(...err(taps, gt));
        after.push(...e);
        if (res.ok) afterOk.push(...e);
        const q = quadError(res.corners, gt);
        lines.push(q.lineMaxPx);
        tables.push(q.tableMaxCm);
        if (res.ok) {
          linesOk.push(q.lineMaxPx);
          tablesOk.push(q.tableMaxCm);
        }
      }
      byCase[`shake${amp}-r${r}`] = { shake: amp, rough: r, trials: ANGLES, frames: frames.length, snapped: ok, shakeWarn: warn, snappedSingleFrame: single, reasons, meanErrBeforePx: +mean(before).toFixed(1), meanErrAfterPx: +mean(after).toFixed(1), p90ErrAfterPx: +pct(after, 0.9).toFixed(1), maxErrAfterPx: +Math.max(...after).toFixed(1), meanErrSnappedPx: afterOk.length ? +mean(afterOk).toFixed(1) : null, meanLineMaxPx: +mean(lines).toFixed(1), maxLineMaxPx: +Math.max(...lines).toFixed(1), meanTableMaxCm: +mean(tables).toFixed(1), maxTableMaxCm: +Math.max(...tables).toFixed(1), snappedMeanLinePx: linesOk.length ? +mean(linesOk).toFixed(1) : null, snappedMaxLinePx: linesOk.length ? +Math.max(...linesOk).toFixed(1) : null, snappedMeanTableCm: tablesOk.length ? +mean(tablesOk).toFixed(1) : null, snappedMaxTableCm: tablesOk.length ? +Math.max(...tablesOk).toFixed(1) : null };
    }
  }
  report.videos[v.name] = byCase;
  console.log(v.name, JSON.stringify(byCase));
}
// --offtable=1: rough quads put where there is no table edge to find (the table quad moved onto the floor,
// the wall, to the left of the table, and shrunk to half inside the top), each corner jittered like a rough
// tap. Any fit taken there is a wrong accept; the count must be 0.
if (args.offtable) {
  const off = { trials: 0, accepted: 0, byPlace: {} };
  for (const v of set.videos) {
    if (!v.corners || v.name.includes("oldcorners")) continue;
    const k = v.corners.reduce((s, p) => Math.max(s, p.x), 0) > 1000 ? 2 : 1;
    const start = v.frame || 0;
    const frames = framesOf(v.video, fixedFrames || Array.from({ length: count }, (_, i) => start + i * every));
    const mid = { x: v.corners.reduce((s, p) => s + p.x, 0) / 4, y: v.corners.reduce((s, p) => s + p.y, 0) / 4 };
    const places = { floor: [0, 140 * k], wall: [0, -110 * k], left: [-170 * k, 0], inside: null };
    for (const [place, d] of Object.entries(places)) {
      for (let a = 0; a < ANGLES; a++) {
        const taps = v.corners.map((p, i) => {
          const th = ((a * 4 + i) * 2.399963) % (2 * Math.PI);
          const base = d ? { x: p.x + d[0], y: p.y + d[1] } : { x: mid.x + (p.x - mid.x) * 0.5, y: mid.y + (p.y - mid.y) * 0.5 };
          return { x: Math.round(base.x + 15 * k * Math.cos(th)), y: Math.round(base.y + 15 * k * Math.sin(th)) };
        }).map((p) => ({ x: Math.max(1, Math.min(frames[0].w - 2, p.x)), y: Math.max(1, Math.min(frames[0].h - 2, p.y)) }));
        const res = refineCornersMulti(frames, taps);
        off.trials++;
        const b = (off.byPlace[place] ||= { trials: 0, accepted: 0, reasons: {}, accepts: [] });
        b.trials++;
        if (res.ok) {
          off.accepted++;
          b.accepted++;
          b.accepts.push({ video: v.name, a, lineMaxPx: +quadError(res.corners, v.corners).lineMaxPx.toFixed(1) });
        } else b.reasons[res.code || res.reason] = (b.reasons[res.code || res.reason] || 0) + 1;
      }
    }
    console.log("offtable", v.name, JSON.stringify(Object.fromEntries(Object.entries(off.byPlace).map(([p, b]) => [p, `${b.accepted}/${b.trials}`]))));
  }
  report.offTable = off;
}
const old = set.videos.find((v) => v.name === "test_2_oldcorners");
const t2 = set.videos.find((v) => v.name === "test_2");
if (old && t2) {
  const res = refineCornersMulti(framesOf(t2.video, fixedFrames || [600, 1500, 3000, 4500, 6000]), old.corners);
  report.test2OldCorners = { ok: res.ok, reason: res.reason, errBeforePx: err(old.corners, t2.corners).map((x) => +x.toFixed(1)), errAfterPx: err(res.corners, t2.corners).map((x) => +x.toFixed(1)), corners: res.corners };
  console.log("test_2 old corners", JSON.stringify(report.test2OldCorners));
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2));
