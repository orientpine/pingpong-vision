// Stands in for desk/analyze.js without a browser: six frames, a rally ending at frames 1 and 4,
// driven through the real AnalysisRun and Checkpoint (one checkpoint per frame: its clock moves
// 30 s per frame). --fake-fail exits 3 at once; --fake-hang-at N stops before frame N and stays
// alive, as a run does when its worker is killed. --track FILE (a gzip file) ends with timing "track".
// --shots FILE (a first pass): at frame 2 every given shot is filled, the near ones 포핸드 with joints and
// the far ones with no stroke and no joints, and the run ends with those rallies instead of its own.
import { parseArgs } from "node:util";
import { Checkpoint, takeLock } from "../../../desk/checkpoint.js";
import { AnalysisRun } from "../../../desk/run-state.js";

const { values: a } = parseArgs({
  options: {
    checkpoint: { type: "string" },
    "played-at": { type: "string" },
    "fake-fail": { type: "boolean" },
    "fake-hang-at": { type: "string" },
    track: { type: "string" },
    shots: { type: "string" },
  },
  strict: false,
});
if (a["fake-fail"]) {
  console.error("pose model failed to load");
  process.exit(3);
}
const TOTAL = 6;
const RALLY_ENDS = new Set([1, 4]);
const draftAt = (f) => ({
  durationMs: 500,
  nearSlot: 0,
  why: "ball_lost",
  shots: [{ side: "near", t: f / 60 - 0.4, stroke: "forehand", kind: "drive", speedKmh: 30, arc: null, inferred: false, land: { tx: 0.5, ty: 0.7 } }],
  bounces: [{ tx: 0.5, ty: 0.7, side: "far", t: f / 60 - 0.2 }],
});

let frame = 0;
takeLock(`${a.checkpoint}.pid`);
const given = a.shots ? JSON.parse(await Bun.file(a.shots).text()).rallies : null;
const run = new AnalysisRun({
  given,
  checkpoint: new Checkpoint({ path: a.checkpoint, key: "fake", now: () => frame * 30_000 }),
  playedAt: Number(a["played-at"]),
  out: (line) => console.log(JSON.stringify(line)),
});
for (frame = run.startFrame; frame < TOTAL; frame++) {
  if (frame === Number(a["fake-hang-at"])) {
    setInterval(() => {}, 1 << 30);
    await new Promise(() => {});
  }
  if (given && frame === 2) {
    given.forEach((r, ri) => r.shots.forEach((s, si) => run.onMessage({ fill: { rally: ri, shot: si, stroke: s.side === "near" ? "포핸드" : null, pose: s.side === "near" ? { pose2d: { model: "fake", at: [-0.77, -0.4, 0], frames: [null, null, null] }, pose3d: { frames: [null, null, null] }, vote: "R" } : null } })));
  }
  if (!given && RALLY_ENDS.has(frame)) run.onMessage({ rally: { startT: frame / 60 - 0.5, draft: draftAt(frame), pose: { 0: { pose2d: { model: "fake", at: [-0.77, -0.4, 0], hand: "R", frames: [null, null, null] }, pose3d: { frames: [null, null, null] } } } } });
  run.onMessage({ progress: { done: frame + 1, total: TOTAL }, t: frame / 60, resumeFrame: frame + 1, resumeT: (frame + 1) / 60 });
}
run.finish(a.track && Bun.gunzipSync(await Bun.file(a.track).bytes()).length ? "track" : null);
