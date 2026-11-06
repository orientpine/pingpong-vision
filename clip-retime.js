// A rally clip's pictures moved onto the times the camera filmed them (docs/save-to-pc.md).
//
// The phone draws each clip picture on its page's main thread, and the canvas stream stamps a picture
// with the moment it was drawn. While the analysis holds the page (a pose read takes about 50 ms), no
// picture is drawn; afterwards two or three are drawn within 25 ms. A club clip filmed on a phone (2026-11-04)
// held its pictures 10-12 ms apart, then 50-65 ms apart, so a phone replay showed about 20 of the
// 33 pictures a second and each sat up to 287 ms away from when it was filmed. The overlay track keeps
// each picture's camera time (cam, seconds), so the PC rewrites the picture times from it, without
// re-encoding (ffmpeg -c copy, the setts filter), and moves the track's t onto the same times.
//
// A clip is left as it came (and the reason returned) when its track has no camera time on every picture,
// the camera times do not rise, the picture count is not the track's (one extra closing picture is
// allowed), or a picture is not where its track frame says (the pairing is checked before anything moves).
import { spawn } from "node:child_process";

// a picture and its track frame are drawn together (recorder.js draw()): club clips paired within 10 ms but for
// a few single pictures 27-79 ms off (1-2 in 165-213, the frames on each side in place). More than 1 in 50 off,
// or two in a row, and they are not pairs.
export const PAIR_MS = 10;
export const CAM_JUMP_MS = 1000;

function run(cmd, args) {
  return new Promise((resolve) => {
    let out = "", err = "";
    let p;
    try {
      p = spawn(cmd, args);
    } catch (e) {
      resolve({ code: -1, out, err: String(e) });
      return;
    }
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

// picture times in decode order (seconds); the clips have no B-frames, so decode order is picture order
async function packetTimes(file) {
  const r = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", file]);
  if (r.code !== 0) return null;
  return r.out.trim().split("\n").filter(Boolean).map(Number);
}

// Every picture of a file decoded at its own time (no frame-rate grid: "ffmpeg -f null" forces 60 fps and warns
// when two pictures fall inside 1/60 s, which phone clips do straight from the camera). Answers the number of
// pictures decoded and ffmpeg's error text ("" when clean).
export async function decodedPictures(file) {
  const r = await run("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "framecrc", "-"]);
  const pictures = r.out.split("\n").filter((l) => l && !l.startsWith("#")).length;
  return { pictures, error: r.code !== 0 ? `exit ${r.code}` : (r.err || "").trim() };
}

// The new picture times (ms from the first picture) for a track, or { skip } with the reason. pts: the clip's
// picture times in seconds, in decode order. A clip can hold one picture more than its track: the canvas
// stream's opening picture (2-3 ms before the first drawn one, club clips) or a closing one. ms is per
// picture, frameMs per track frame.
export function plan(track, pts) {
  const frames = track && Array.isArray(track.frames) ? track.frames : [];
  if (frames.length < 2) return { skip: "track-short" };
  if (!frames.every((f) => Number.isFinite(f.cam) && Number.isFinite(f.t))) return { skip: "no-cam" };
  for (let k = 1; k < frames.length; k++) if (!(frames[k].cam > frames[k - 1].cam)) return { skip: "cam-order" };
  // a camera time more than CAM_JUMP_MS further from its neighbour than the pictures were drawn apart is not
  // when that picture was filmed: after a 7.3 s camera pause the first picture came back with the analysis
  // time from before the pause (pingpong-analytics, 2026-11-04), and moving it there froze the replay 7 s
  for (let k = 1; k < frames.length; k++) if ((frames[k].cam - frames[k - 1].cam) * 1000 - (frames[k].t - frames[k - 1].t) > CAM_JUMP_MS) return { skip: "cam-jump" };
  if (!pts || !pts.every(Number.isFinite)) return { skip: "no-pts" };
  for (let i = 1; i < pts.length; i++) if (!(pts[i] > pts[i - 1])) return { skip: "pts-order" };
  if (pts.length !== frames.length && pts.length !== frames.length + 1) return { skip: "count" };
  const t0 = frames[0].t;
  const fits = (s) => {
    const off = frames.map((f, k) => Math.abs((pts[k + s] - pts[s]) * 1000 - (f.t - t0)));
    const bad = off.map((d) => d > PAIR_MS);
    return bad.filter(Boolean).length <= Math.max(2, frames.length / 50) && !bad.some((b, k) => b && bad[k + 1]);
  };
  const s = fits(0) ? 0 : pts.length > frames.length && fits(1) ? 1 : -1;
  if (s < 0) return { skip: "pairing" };
  const c0 = frames[0].cam;
  const gap = (i) => Math.max(1, Math.round((pts[i] - pts[i - 1]) * 1000));
  // a picture with no track frame keeps its own distance to its neighbour
  const lead = s ? gap(1) : 0;
  const frameMs = frames.map((f) => lead + Math.round((f.cam - c0) * 1000));
  const ms = s ? [0, ...frameMs] : [...frameMs];
  if (ms.length < pts.length) ms.push(ms.at(-1) + gap(pts.length - 1));
  for (let i = 1; i < ms.length; i++) if (!(ms[i] > ms[i - 1])) return { skip: "cam-order" };
  const shiftMs = Math.max(...ms.map((m, i) => Math.abs(m - Math.round((pts[i] - pts[0]) * 1000))));
  return { ms, frameMs, shiftMs };
}

// The track with its frames (and notices) on the new times: frame k is picture k.
export function moveTrack(track, ms) {
  const frames = track.frames;
  const at = (t) => {
    let j = 0;
    while (j + 1 < frames.length && frames[j + 1].t <= t) j++;
    return ms[j] + (t - frames[j].t);
  };
  return {
    ...track,
    meta: { ...(track.meta || {}), retimed: "cam" },
    frames: frames.map((f, k) => ({ ...f, t: ms[k] })),
    notices: (track.notices || []).map((n) => ({ ...n, t: Math.max(0, Math.round(at(n.t))) })),
  };
}

// src: the saved video file, dst: where the retimed one goes, type: "video/mp4" | "video/webm".
// Answers { track, pictures, shiftMs } (the moved track to save beside dst) or { skip }.
export async function retimeClip({ src, dst, type, track }) {
  const pts = await packetTimes(src);
  if (!pts) return { skip: "ffprobe" };
  const p = plan(track, pts);
  if (p.skip) return p;
  const expr = p.ms.map((v, n) => `eq(N\\,${n})*${v}`).join("+");
  const args = ["-v", "error", "-y", "-i", src, "-map", "0:v:0", "-c", "copy", "-bsf:v", `setts=ts=${expr}:time_base=1/1000`];
  if (type === "video/mp4") args.push("-movflags", "+faststart", "-f", "mp4");
  else args.push("-f", "webm");
  const r = await run("ffmpeg", [...args, dst]);
  if (r.code !== 0) return { skip: "ffmpeg" };
  // read back: every picture where the plan put it
  const got = await packetTimes(dst);
  if (!got || got.length !== p.ms.length || got.some((s, i) => Math.abs(Math.round(s * 1000) - Math.round(got[0] * 1000) - p.ms[i]) > 1)) return { skip: "readback" };
  // and every picture still decodes: a file that does not is not saved, the original stays
  const dec = await decodedPictures(dst);
  if (dec.error || dec.pictures !== p.ms.length) return { skip: "decode" };
  return { track: moveTrack(track, p.frameMs), pictures: p.ms.length, shiftMs: p.shiftMs };
}
