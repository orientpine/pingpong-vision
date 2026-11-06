import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checkpoint } from "../desk/checkpoint.js";
import { AnalysisRun } from "../desk/run-state.js";
import { RallyShots } from "../public/js/analysis-record.js";
import { AT, JOINTS, ShotPoses, joints2d, joints3d } from "../desk/page/pose-buffer.js";

// 33 landmarks in pixels: hips around (hx, hy), shoulders one torso above, the rest offset by index
function body({ hx = 300, hy = 400, torso = 100, v = 0.9 } = {}) {
  const lm = Array.from({ length: 33 }, (_, i) => ({ x: hx + (i * torso) / 10, y: hy - (i * torso) / 20, v }));
  lm[23] = { x: hx - torso / 4, y: hy, v };
  lm[24] = { x: hx + torso / 4, y: hy, v };
  lm[11] = { x: hx - torso / 3, y: hy - torso, v };
  lm[12] = { x: hx + torso / 3, y: hy - torso, v };
  return lm;
}

const withWorld = (lm) => Object.assign(lm, { world: lm.map((p, i) => ({ x: i / 100, y: -i / 100, z: i / 1000, visibility: 0.8 })) });
const playersAt = (t, near, far = null) => ({
  near: { hand: "R", landmarks: near, seenT: near ? t : -Infinity },
  far: { hand: "L", landmarks: far, seenT: far ? t : -Infinity },
});
const FRAME_S = 0.05;
// frames from 0 to `to` seconds, the near player seen on each
function run(poses, to, lm = withWorld(body())) {
  for (let f = 0; f * FRAME_S <= to + 1e-9; f++) poses.frame(f * FRAME_S, playersAt(f * FRAME_S, lm));
}

describe("joints", () => {
  test("23 joints: the nose and 11..32, no other face point", () => {
    expect(JOINTS).toEqual([0, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
  });

  test("a shifted and scaled body gives the same 2D joints", () => {
    expect(joints2d(body({ hx: 900, hy: 120, torso: 37 }))).toEqual(joints2d(body()));
  });

  test("2D has the hip centre at the origin and a torso of 1, at 3 decimals", () => {
    const j = joints2d(body());
    const [leftHip, rightHip, leftShoulder, rightShoulder] = [13, 14, 1, 2].map((i) => j[i]);
    expect([leftHip[0] + rightHip[0], leftHip[1] + rightHip[1]]).toEqual([0, 0]);
    expect((leftShoulder[1] + rightShoulder[1]) / 2).toBe(-1);
    expect(leftHip).toEqual([-0.25, 0, 0.9]);
    expect(leftShoulder[0]).toBe(-0.333);
  });

  test("a torso of no length has no 2D joints", () => {
    expect(joints2d(body({ torso: 0 }))).toBeNull();
  });

  test("3D keeps world metres and their visibility; a pose without world has none", () => {
    expect(joints3d(withWorld(body()))[1]).toEqual([0.11, -0.11, 0.011, 0.8]);
    expect(joints3d(body())).toBeNull();
  });
});

describe("shot poses", () => {
  test("a shot gets three frames with its model and reference times", () => {
    const poses = new ShotPoses("mediapipe-full");
    run(poses, 1);
    const shot = { side: "near", t: 0.8 };
    poses.onEvent({ type: "shot", shot });
    const { pose2d, pose3d } = poses.rallyPose([shot])[0];
    expect(pose2d).toMatchObject({ model: "mediapipe-full", at: AT });
    expect(pose2d.frames.map((f) => f.length)).toEqual([23, 23, 23]);
    expect(pose3d.frames.map((f) => f[0].length)).toEqual([4, 4, 4]);
  });

  test("a reference time older than the buffer is null, the others stay", () => {
    const poses = new ShotPoses("m");
    run(poses, 2);
    const shot = { side: "near", t: 1.3 };
    // reported 0.7 s after the hit: -0.4 and the hit are in the 1.2 s buffer, -0.77 is not
    poses.onEvent({ type: "shot", shot });
    poses.settle();
    const { frames } = poses.rallyPose([shot])[0].pose2d;
    expect(frames.map((f) => f !== null)).toEqual([false, true, true]);
  });

  test("a frame missing around a reference time gives null, not a far neighbour", () => {
    const poses = new ShotPoses("m");
    const lm = withWorld(body());
    for (const t of [0, 0.05, 0.1, 0.8]) poses.frame(t, playersAt(t, lm));
    const shot = { side: "near", t: 0.8 };
    poses.onEvent({ type: "shot", shot });
    poses.frame(0.85, playersAt(0.85, lm));
    expect(poses.rallyPose([shot])[0].pose2d.frames.map((f) => f !== null)).toEqual([true, false, true]);
  });

  test("a frame the player was not seen in adds nothing, and the other end is kept apart", () => {
    const poses = new ShotPoses("m");
    const stale = { near: { hand: "R", landmarks: withWorld(body()), seenT: 0.1 }, far: { hand: "L", landmarks: null, seenT: -Infinity } };
    poses.frame(0.2, stale);
    expect(poses.hist.near).toEqual([]);
    const shot = { side: "far", t: 0.2 };
    poses.onEvent({ type: "shot", shot });
    expect(poses.rallyPose([shot])).toEqual({});
  });

  test("a shot votes for the wrist that moved fastest in the 0.3 s before it", () => {
    const poses = new ShotPoses("m");
    const shot = { side: "near", t: 0.5 };
    swingRun(poses, [shot], 0.5, WRIST_L);
    expect(poses.rallyPose([shot])[0].vote).toBe("L");
  });

  test("a shot and rally ending inside one frame still see that frame", () => {
    const poses = new ShotPoses("m");
    run(poses, 0.75);
    const shot = { side: "near", t: 0.8 };
    poses.onEvent({ type: "shot", shot });
    poses.frame(0.8, playersAt(0.8, withWorld(body())));
    expect(poses.rallyPose([shot])[0].pose2d.frames[2]).not.toBeNull();
  });

  test("indices follow the draft's shot order when a shot was inferred late", () => {
    const shots = new RallyShots();
    const poses = new ShotPoses("m");
    const later = { side: "near", t: 0.9 };
    const earlier = { side: "far", t: 0.8 };
    const events = [{ type: "rallyStart" }, { type: "shot", shot: later }, { type: "shot", shot: earlier }];
    run(poses, 1);
    for (const e of events) {
      shots.onEvent(e);
      poses.onEvent(e);
    }
    const draft = shots.draft({ durationS: 1, why: "out", bounces: [] }, 0);
    expect(draft.shots.map((s) => s.side)).toEqual(["far", "near"]);
    expect(Object.keys(poses.rallyPose(shots.shots))).toEqual(["1"]);
  });

  test("a shotUpdate of a recorded shot does not read it twice", () => {
    const poses = new ShotPoses("m");
    const shot = { side: "near", t: 0.5 };
    poses.onEvent({ type: "shot", shot });
    poses.onEvent({ type: "shotUpdate", shot });
    expect(poses.pending).toHaveLength(1);
  });
});

// Frames every 0.05 s up to `to`; the given wrist swings 40 px a frame, the other stays still. Each
// shot is reported in the frame of its hit. Players carry hand "R", the value the camera defaults to.
const WRIST_L = 15;
function swingRun(poses, shots, to, wrist) {
  for (let f = 0; f * FRAME_S <= to + 1e-9; f++) {
    const t = f * FRAME_S;
    const lm = withWorld(body());
    lm[wrist] = { x: 100 + f * 40, y: 300, v: 0.9 };
    poses.frame(t, playersAt(t, lm));
    for (const shot of shots) if (Math.abs(shot.t - t) < 1e-9) poses.onEvent({ type: "shot", shot });
  }
}

// One near rally of `count` shots through the analyzer's run; the pose it puts out.
function handedRun(count) {
  const dir = mkdtempSync(join(tmpdir(), "pp-pose-"));
  const shots = Array.from({ length: count }, (_, i) => ({ side: "near", t: 0.5 + i * 0.5 }));
  const poses = new ShotPoses("m");
  swingRun(poses, shots, 0.5 + count * 0.5, WRIST_L);
  const draft = { durationMs: 1, why: "out", shots: shots.map(({ side, t }) => ({ side, t })), bounces: [] };
  const lines = [];
  const run = new AnalysisRun({ checkpoint: new Checkpoint({ path: join(dir, "c.json"), key: "k" }), playedAt: 0, out: (l) => lines.push(l) });
  run.onMessage({ rally: { startT: 0, draft, pose: poses.rallyPose(shots) } });
  run.finish();
  rmSync(dir, { recursive: true });
  return lines[0].pose[0];
}

describe("racket hand over the job", () => {
  test("a left wrist swinging before five shots makes the end left-handed, whatever the camera's default", () => {
    const pose = handedRun(5);
    expect(Object.values(pose).map((p) => p.pose2d.hand)).toEqual(["L", "L", "L", "L", "L"]);
    expect(Object.values(pose).some((p) => "vote" in p)).toBe(false);
    expect(Object.values(pose).map((p) => p.pose2d.vote)).toEqual(["L", "L", "L", "L", "L"]);
  });

  test("under five voting shots the hand is null, not a guess", () => {
    expect(Object.values(handedRun(4)).map((p) => p.pose2d.hand)).toEqual([null, null, null, null]);
    // each shot's own vote still goes to the server, which can count it with the player's other shots
    expect(Object.values(handedRun(4)).map((p) => p.pose2d.vote)).toEqual(["L", "L", "L", "L"]);
  });
});

test("pose in a checkpoint survives a restart and comes out with the rallies", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-pose-"));
  const path = join(dir, "c.json");
  const draft = { durationMs: 1, why: "out", shots: [], bounces: [], nearSlot: 0 };
  const pose = { 0: { pose2d: { frames: [] }, pose3d: { frames: [] } } };
  const first = new AnalysisRun({ checkpoint: new Checkpoint({ path, key: "k" }), playedAt: 0, out: () => {} });
  first.onMessage({ rally: { startT: 0, draft, pose } });
  first.onMessage({ rally: { startT: 1, draft, pose: {} } });
  first.checkpoint.save(first.state);
  const lines = [];
  const second = new AnalysisRun({ checkpoint: new Checkpoint({ path, key: "k" }), playedAt: 0, out: (l) => lines.push(l) });
  second.finish();
  rmSync(dir, { recursive: true });
  expect(lines[0].rallies).toHaveLength(2);
  expect(lines[0].pose).toEqual({ 0: { 0: { pose2d: { frames: [], hand: null }, pose3d: { frames: [] } } } });
});

test("a checkpoint from before pose reads as no pose", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-pose-"));
  const path = join(dir, "c.json");
  writeFileSync(path, JSON.stringify({ v: 1, key: "k", lastFrame: 0, lastT: 0, resumeFrame: 0, resumeT: 0, rallies: [] }));
  const run = new AnalysisRun({ checkpoint: new Checkpoint({ path, key: "k" }), playedAt: 0, out: () => {} });
  rmSync(dir, { recursive: true });
  expect(run.state.pose).toEqual({});
});
