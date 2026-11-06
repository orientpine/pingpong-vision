// Two independently occluded pixel paths, the app's merger, and OpenTTGames scoring.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Pipeline } from "../public/js/pipeline.js";
import { apply, makeCalibration, TABLE_LENGTH, TABLE_WIDTH } from "../public/js/geom.js";
import { judgePoint } from "../public/js/point.js";
import { shareSegment, judgeRally, Merger, MAX_WAIT_MS } from "../public/js/multicam.js";

const { values: args } = parseArgs({ options: Object.fromEntries(
  ["name", "video", "gt", "corners", "fps", "seed", "from", "to", "out", "summary", "mirror"]
    .map((key) => [key, { type: "string" }]),
) });
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(resolve(root, "qa/eval-set.json"), "utf8"));
const named = catalog.videos.find((v) => v.name === args.name);
if (args.name && !named) throw new RangeError(`Unknown --name=${args.name}`);
function mediaPath(path) {
  if (!path) throw new TypeError("Supply --name or --video, --gt, and --corners");
  return [resolve(root, path), ...(process.env.PPV_DATA_ROOT ? [resolve(process.env.PPV_DATA_ROOT, path)] : [])]
    .find((p) => existsSync(p)) ?? path;
}
const video = mediaPath(args.video ?? named?.video);
const gtDir = mediaPath(args.gt ?? named?.markup);
const corners = args.corners ? JSON.parse(args.corners) : named?.corners;
if (!Array.isArray(corners) || corners.length !== 4 || corners.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
  throw new TypeError("--corners must contain four finite {x,y} points");
}
const fps = Number(args.fps ?? 60), seed = Number(args.seed ?? 1);
const from = Number(args.from ?? 0), to = Number(args.to ?? 1e9), mirror = args.mirror === "1";
if (!(fps > 0 && fps <= 120) || !Number.isInteger(seed) || !(from >= 0 && to >= from)) throw new RangeError("Invalid fps, seed, or frame range");
const probe = spawnSync("ffprobe", ["-v", "error", "-threads", "1", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", video], { encoding: "utf8" });
if (probe.status !== 0) throw new Error(`ffprobe: ${probe.stderr}`);
const { width: vw, height: vh, r_frame_rate: rate } = JSON.parse(probe.stdout).streams[0];
const [num, den] = rate.split("/").map(Number), srcFps = num / den;
const step = Math.max(1, Math.round(srcFps / fps)), pw = 640, ph = Math.round(vh / vw * pw);
const cal = makeCalibration(corners);
if (!cal) throw new TypeError("Degenerate table corners");
const name = args.name ?? video.split("/").pop().replace(/\.mp4$/, "");
const out = resolve(args.out ?? `evidence/multicam-offline/${name}-s${seed}${mirror ? "-mirror" : ""}.json`);
function random(initial) {
  let state = initial >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
function occluder(initial) {
  const rng = random(initial);
  // Mean on=1s, off=1.5s gives 40% duty; phase is independent for each camera.
  return { rng, start: rng() * 2.5, end: -1, x0: 0, x1: 0, hidden: 0, spans: [] };
}
const masks = [occluder(seed ^ 0xa341316c), occluder(seed ^ 0xc8013ea4)];
function maskFrame(frame, state, t) {
  while (t >= state.start && t >= state.end) {
    if (state.end >= 0) state.start = state.end + 0.75 + state.rng() * 1.5;
    state.end = state.start + 0.5 + state.rng();
    const center = cal.myEnd.x + state.rng() * (cal.oppEnd.x - cal.myEnd.x);
    const half = cal.lengthPx * 0.22 / 2;
    state.x0 = Math.max(0, Math.floor((center - half) * pw / vw));
    state.x1 = Math.min(pw, Math.ceil((center + half) * pw / vw));
    state.spans.push({ startS: state.start, endS: state.end, x0: state.x0, x1: state.x1 });
  }
  const hidden = t >= state.start && t < state.end;
  if (!hidden) return { pixels: frame, hidden };
  state.hidden++;
  const pixels = new Uint8ClampedArray(frame);
  for (let y = 0; y < ph; y++) for (let x = state.x0; x < state.x1; x++) {
    const i = (y * pw + x) * 4;
    pixels[i] = 70; pixels[i + 1] = 70; pixels[i + 2] = 80; pixels[i + 3] = 255;
  }
  return { pixels, hidden };
}
const cameras = ["A", "B", "C"].map((id) => {
  const events = [];
  const pipe = new Pipeline({ procWidth: pw, onEvent: (e) => {
    if (e.type === "rallyEnd") events.push(structuredClone(e));
  } });
  pipe.setVideoSize(vw, vh); pipe.setCalibration(corners);
  return { id, pipe, events };
});
console.log(`WORKING: decode ${name} seed=${seed} mirroredB=${mirror}, three pixel paths at ${srcFps / step} fps`);
const ff = spawn("ffmpeg", ["-v", "error", "-threads", "1", "-i", video, "-filter_threads", "1", "-vf",
  `select=between(n\\,${from}\\,${to})*not(mod(n-${from}\\,${step})),scale=${pw}:${ph}`,
  "-fps_mode", "passthrough", "-threads", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
let stderr = "", frames = 0, bothHidden = 0, buffered = Buffer.alloc(0);
ff.stderr.on("data", (chunk) => { stderr += chunk; });
const exited = new Promise((accept, reject) => {
  ff.once("error", reject);
  ff.once("close", (code) => code === 0 ? accept() : reject(new Error(`ffmpeg exit=${code}: ${stderr}`)));
});
const bytes = pw * ph * 4, started = performance.now();
for await (const chunk of ff.stdout) {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= bytes) {
    const frame = new Uint8ClampedArray(buffered.buffer, buffered.byteOffset, bytes);
    const t = (from + frames * step) / srcFps;
    const a = maskFrame(frame, masks[0], t), b = maskFrame(frame, masks[1], t);
    cameras[0].pipe.processPixels(a.pixels, t);
    cameras[1].pipe.processPixels(b.pixels, t);
    cameras[2].pipe.processPixels(frame, t);
    if (a.hidden && b.hidden) bothHidden++;
    frames++; buffered = buffered.subarray(bytes);
  }
}
await exited;
if (buffered.length || !frames) throw new Error(`Incomplete rawvideo: frames=${frames}, remaining=${buffered.length}`);
for (const c of cameras) c.pipe.rally.update((from + frames * step) / srcFps + 5, null, null);
const finished = (c) => c.events.filter((e) => e.why !== "stop");
const singles = cameras.map((c) => finished(c).map((e) => ({
  startS: e.t - e.durationS, endS: e.t, bounces: e.bounces,
  judged: judgePoint({ shots: e.shotList, bounces: e.bounces }), conflict: false,
})));
const flip = (side) => side === "near" ? "far" : "near";
const mirrored = (e) => ({ ...e,
  bounces: e.bounces.map((b) => ({ ...b, side: flip(b.side), tx: b.tx == null ? null : TABLE_LENGTH - b.tx, ty: b.ty == null ? null : TABLE_WIDTH - b.ty })),
  shotList: e.shotList.map((s) => ({ ...s, side: flip(s.side) })),
});
const aSegs = finished(cameras[0]).map((e) => shareSegment(e, { cam: "self", near: 0, offset: 0 }));
const bSegs = finished(cameras[1]).map((e) => shareSegment(mirror ? mirrored(e) : e, { cam: "b", near: mirror ? 1 : 0, offset: 35 }));
function merge(segs) {
  const collector = new Merger(), groups = [], droppedSegments = [];
  const pending = [...segs].sort((a, b) => a.endMs - b.endMs);
  const cams = [...new Set(pending.map((s) => s.cam))];
  const collect = (now) => { for (const g of collector.poll(now)) groups.push({ ...judgeRally(g), segments: g }); };
  for (let i = 0; i < pending.length; i++) {
    const s = pending[i], now = s.endMs;
    // Replay fresh in-progress statuses, then mark the just-finished camera inactive.
    for (const cam of cams) {
      const active = pending.slice(i + 1).find((p) => p.cam === cam && p.startMs <= now && p.endMs > now);
      collector.status(cam, { active: !!active, startMs: active?.startMs ?? null }, now);
    }
    collector.status(s.cam, { active: false }, now);
    if (!collector.add(s, now)) droppedSegments.push(s);
    collect(now);
  }
  collect((pending.at(-1)?.endMs ?? 0) + MAX_WAIT_MS + 1);
  return { dropped: collector.dropped, droppedSegments, groups, entries: groups.map((g) => ({
    ...g, startS: g.startMs / 1000, endS: g.endMs / 1000,
  })) };
}
const merged = merge([...aSegs, ...bSegs]), onlyA = merge(aSegs);
const winners = (entries) => entries.filter((e) => e.judged && !e.conflict).map((e) => e.judged.winner);
const aOnlyEqual = JSON.stringify(winners(singles[0])) === JSON.stringify(winners(onlyA.entries));
const perSegmentEqual = aSegs.every((s, i) => judgeRally([s]).judged?.winner === singles[0][i].judged?.winner);
const marks = JSON.parse(readFileSync(resolve(gtDir, "events_markup.json"), "utf8"));
const ball = JSON.parse(readFileSync(resolve(gtDir, "ball_markup.json"), "utf8"));
const gtBounces = Object.entries(marks).filter(([f, type]) => type === "bounce" && ball[f]?.x >= 0 && Number(f) >= from && Number(f) <= to)
  .map(([f]) => ({ f: Number(f), t: Number(f) / srcFps, side: apply(cal.toTable, ball[f]).x < TABLE_LENGTH / 2 ? "near" : "far" })).sort((a, b) => a.f - b.f);
const runs = [];
for (const b of gtBounces) {
  const last = runs.at(-1);
  if (last && b.t - last.at(-1).t <= 1.5) last.push(b); else runs.push([b]);
}
const windows = runs.map((r) => ({ startS: r[0].t, endS: r.at(-1).t, winner: flip(r.at(-1).side), bounces: r, point: null }));
const gt = windows.filter((w) => w.bounces.length >= 3);
gt.forEach((w, i) => { w.point = i; });
const allWindows = [...gt, ...windows.filter((w) => w.point === null)];
function assigned(entry) {
  return allWindows.map((w) => ({ w, overlap: Math.min(entry.endS, w.endS) - Math.max(entry.startS, w.startS) }))
    .filter(({ w, overlap }) => overlap > 0 || (entry.endS >= w.startS && entry.startS <= w.endS + 1))
    .sort((a, b) => b.overlap - a.overlap)[0]?.w ?? null;
}
function score(entries) {
  const calls = entries.filter((e) => e.judged && !e.conflict), rows = gt.map((g) => {
    const mine = calls.filter((e) => assigned(e) === g), first = mine[0];
    return { ...g, appEntries: mine.length, appWinner: first?.judged.winner ?? null, appSure: !!first?.judged.sure,
      correct: !!first && first.judged.winner === g.winner, calls: mine };
  });
  const conflicts = entries.filter((e) => e.conflict), conflictRows = [...new Set(conflicts.map(assigned))].filter((w) => w?.point != null);
  const observed = entries.flatMap((e) => e.bounces), caught = gtBounces.filter((g) => observed.some((b) => b.side === g.side && Math.abs(b.t - g.t) <= 0.1));
  return { gtBounces: gtBounces.length, bouncesCaught: caught.length, gtPoints: gt.length,
    correct: rows.filter((r) => r.correct).length, wrong: rows.filter((r) => r.appEntries && !r.correct).length,
    missed: rows.filter((r) => !r.appEntries).length, extra: rows.reduce((n, r) => n + Math.max(0, r.appEntries - 1), 0),
    sureCorrect: rows.filter((r) => r.correct && r.appSure).length, conflicts: conflicts.length,
    conflictGtRallies: conflictRows.length, conflictGtCorrect: conflictRows.filter((w) => rows[w.point].correct).length,
    conflictGtWrong: conflictRows.filter((w) => rows[w.point].appEntries && !rows[w.point].correct).length,
    conflictSuggestedCorrect: conflicts.filter((e) => assigned(e)?.point != null && e.judged?.winner === assigned(e).winner).length,
    conflictSuggestedWrong: conflicts.filter((e) => assigned(e)?.point != null && e.judged && e.judged.winner !== assigned(e).winner).length,
    unverifiedInFragments: calls.filter((e) => assigned(e)?.point === null).length, outsideGt: calls.filter((e) => !assigned(e)).length,
    caught, rows, entries };
}
const scores = { A: score(singles[0]), B: score(singles[1]), merged: score(merged.entries), C: score(singles[2]), onlyA: score(onlyA.entries) };
const losses = scores.A.rows.filter((r, i) => r.correct && !scores.merged.rows[i].correct).map((a) => ({ point: a.point, startS: a.startS, endS: a.endS, gtWinner: a.winner, A: a, merged: scores.merged.rows[a.point] }));
const lostBounces = scores.A.caught.filter((b) => !scores.merged.caught.includes(b));
const result = { name, video, gtDir, corners, seed, mirror, fps: srcFps / step, srcFps, from, to, frames, seconds: frames * step / srcFps,
  wallS: (performance.now() - started) / 1000, masking: { A: masks[0].hidden / frames, B: masks[1].hidden / frames, overlap: bothHidden / frames, spans: masks.map((m) => m.spans) },
  aOnlyEqual, perSegmentEqual, singleWinners: winners(singles[0]), onlyAWinners: winners(onlyA.entries),
  dropped: merged.dropped, droppedSegments: merged.droppedSegments, onlyADropped: onlyA.dropped, losses, lostBounces, scores,
  methodology: "Three Pipeline.processPixels paths; no pose. B clock +35ms. Replay active statuses from segment intervals; completed camera inactive; poll after each end-ordered add and final timeout. Conflicts are withheld, not scored. GT windows and winners match point-eval.mjs. Bounce recall uses merged emitted groups, not the input union." };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 2));
const heading = `### ${name} seed=${seed}${mirror ? " mirrored B" : ""}`;
const table = [heading, "", "| camera | GT bounces | correct | wrong | missed | extra | sure-correct | conflicts |", "|---|---:|---:|---:|---:|---:|---:|---:|",
  ...Object.entries(scores).map(([id, s]) => `| ${id} | ${s.bouncesCaught}/${s.gtBounces} | ${s.correct} | ${s.wrong} | ${s.missed} | ${s.extra} | ${s.sureCorrect} | ${s.conflicts} |`),
  "", `A-only equals single: ${aOnlyEqual}; per-segment: ${perSegmentEqual}; dropped merged/A-only: ${merged.dropped}/${onlyA.dropped}.`,
  `Mask duty A/B/both: ${[result.masking.A, result.masking.B, result.masking.overlap].map((x) => (x * 100).toFixed(1) + "%").join("/")}. Frames: ${frames}; wall: ${result.wallS.toFixed(1)}s.`,
  `Conflict GT suggestions right/wrong: ${scores.merged.conflictSuggestedCorrect}/${scores.merged.conflictSuggestedWrong}; scored right/wrong: ${scores.merged.conflictGtCorrect}/${scores.merged.conflictGtWrong}.`,
  `Lost correct GT rallies: ${losses.map((r) => `#${r.point} ${r.startS.toFixed(2)}-${r.endS.toFixed(2)}s ${r.A.appWinner}->${r.merged.appWinner ?? "missed"}`).join("; ") || "none"}. Lost caught bounces: ${lostBounces.map((b) => `${b.side}@${b.t.toFixed(3)}`).join(", ") || "none"}.`,
  `Output: ${out}`, ""].join("\n");
console.log(table);
if (args.summary) {
  const summary = resolve(args.summary);
  mkdirSync(dirname(summary), { recursive: true });
  const command = `cd ${root}; nice -n 10 bun ${process.argv.slice(1).map((a) => "'" + a.replaceAll("'", "'\\''") + "'").join(" ")}`;
  appendFileSync(summary, `${table}\nCommand:\n\n\`\`\`sh\n${command}\n\`\`\`\n\n`);
}
