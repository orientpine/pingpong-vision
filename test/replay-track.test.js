import { expect, test } from "bun:test";
import { LEAD_MS, Track, TrackWriter, packTrack, pick, replayStartMs } from "../public/js/replay-track.js";

const lm = (x, y) => ({ x, y, z: -0.3, v: 0.987 });
const state = (i) => ({
  mode: "running",
  save: { keySet: true },
  rally: { active: true, timeMs: i * 33, shots: i > 5 ? 2 : 1, speedKmh: 27, maxSpeedKmh: 30 },
  ball: { trail: [{ x: 100 + i, y: 50.04, t: i / 30 }], current: { x: 100 + i, y: 50 }, lock: i > 3 ? { x: 100 + i, y: 50, side: "far" } : null },
  bounces: [{ tx: 0.5, ty: 0.25, side: "far", t: 1 }],
  lastShot: null,
  players: { near: { label: "레드 · 김", end: 1, hand: "R", landmarks: [lm(10.123, 20.987)], moveM: 1.2, stand: { img: { x: 5, y: 6 }, behindM: 0.4 } }, far: { label: "블루 사이드", end: 0, landmarks: null } },
  tracking: i > 3 ? "locked" : "searching",
  calibrationIssue: null,
  calibration: { corners: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }, { x: 7, y: 8 }] },
});

test("a frame keeps only the drawn parts that changed, positions to 0.1 px", () => {
  const w = new TrackWriter({ layout: "phone" });
  w.add(1000, state(0));
  w.add(1033, state(1));
  w.add(1066, state(1));
  const [f0, f1, f2] = w.frames;
  expect(f0.t).toBe(0);
  expect(Object.keys(f0)).not.toContain("save");
  expect(Object.keys(f0)).not.toContain("mode");
  expect(f0.players.near.landmarks[0]).toEqual({ x: 10.1, y: 21, v: 0.99 });
  expect(f0.ball.trail[0]).toEqual({ x: 100, y: 50 });
  expect(f1.t).toBe(33);
  expect(Object.keys(f1).sort()).toEqual(["ball", "rally", "t"]);
  expect(f2).toEqual({ t: 66 });
});

test("the read track gives the state recorded with the picture nearest a time", async () => {
  const w = new TrackWriter({ layout: "phone", source: { width: 1280, height: 720 } });
  for (let i = 0; i < 10; i++) w.add(5000 + i * 33.4, state(i));
  w.notice(5000 + 100, "엔드 교체");
  const packed = await packTrack(w.json());
  expect(packed.type).toBe("application/gzip");
  const t = Track.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await packed.arrayBuffer()))));
  expect(t.meta.source).toEqual({ width: 1280, height: 720 });
  expect(t.stateAt(0).ball.current.x).toBe(100);
  expect(t.stateAt(5 * 33.4).ball.current.x).toBe(105);
  // a decoder time a hair before the picture's own still gets that picture's overlay
  expect(t.stateAt(5 * 33.4 - 3).ball.current.x).toBe(105);
  expect(t.stateAt(5 * 33.4 + 15).ball.current.x).toBe(105);
  expect(t.stateAt(99999).ball.current.x).toBe(109);
  // a still video (paused, seeked) shows the last picture at or before its time, never the next one
  expect(t.stateAtOrBefore(5 * 33.4 + 30).ball.current.x).toBe(105);
  expect(t.stateAtOrBefore(5 * 33.4 - 1).ball.current.x).toBe(105);
  expect(t.stateAtOrBefore(5 * 33.4 - 5).ball.current.x).toBe(104);
  expect(t.stateAt(2 * 33.4).ball.lock).toBe(null);
  expect(t.stateAt(5 * 33.4).ball.lock.side).toBe("far");
  // parts that did not change are carried forward
  expect(t.stateAt(9 * 33.4).players.near.label).toBe("레드 · 김");
  expect(t.noticeAt(50)).toBe(null);
  expect(t.noticeAt(150).text).toBe("엔드 교체");
  expect(t.noticeAt(3200)).toBe(null);
});

test("pick drops everything the screen does not draw", () => {
  expect(Object.keys(pick(state(4))).sort()).toEqual(["ball", "bounces", "calibration", "calibrationIssue", "lastShot", "players", "rally", "tracking"]);
});

test("a file that is not a v1 track is refused", () => {
  expect(() => Track.parse(JSON.stringify({ v: 2, frames: [] }))).toThrow();
  expect(() => Track.parse("{}")).toThrow();
});

test("without CompressionStream the track goes up as its JSON", async () => {
  const saved = globalThis.CompressionStream;
  globalThis.CompressionStream = undefined;
  try {
    const packed = await packTrack('{"v":1,"frames":[]}');
    expect(packed.type.split(";")[0]).toBe("application/json");
    expect(await packed.text()).toBe('{"v":1,"frames":[]}');
  } finally {
    globalThis.CompressionStream = saved;
  }
});

test("each frame keeps the camera clock; a file without it reads the same states with null cams", () => {
  const w = new TrackWriter({});
  w.add(1000, { rally: null }, 12.3456);
  w.add(1033, { rally: null }, 12.3789);
  w.add(1066, { rally: null });
  expect(w.frames.map((f) => f.cam)).toEqual([12.346, 12.379, undefined]);
  const withCam = new Track({ v: 1, frames: w.frames });
  expect(withCam.cams).toEqual([12.346, 12.379, null]);
  expect(withCam.states.every((s) => !("cam" in s))).toBe(true);
  const old = new Track({ v: 1, frames: w.frames.map(({ cam, ...f }) => f) });
  expect(old.cams).toEqual([null, null, null]);
  expect(old.states).toEqual(withCam.states);
});

// a rally's own state, recorded with the picture at clip ms t
const rallyFrame = (t, rally) => ({ t, rally });
test("the rally starts where its first active frame says, less the time it already shows", () => {
  // frame 0 still carries the rally before (not active, its time and shots); the serve is seen at 2600 ms
  const t = new Track({ v: 1, meta: {}, frames: [rallyFrame(0, { active: false, timeMs: 1169, shots: 1 }), rallyFrame(1300, {}), rallyFrame(2633, { active: true, timeMs: 33, shots: 0 }), rallyFrame(2666, { active: true, timeMs: 66 })] });
  expect(t.rallyStartMs()).toBe(2600);
});

test("a clip that starts inside its rally starts there; a clip with no rally gives null", () => {
  const inside = new Track({ v: 1, meta: {}, frames: [rallyFrame(2, { active: true, timeMs: 367 }), rallyFrame(40, { active: true, timeMs: 405 })] });
  expect(inside.rallyStartMs()).toBe(0);
  const none = new Track({ v: 1, meta: {}, frames: [rallyFrame(0, { active: false, timeMs: 0 }), { t: 33 }] });
  expect(none.rallyStartMs()).toBe(null);
});

test("a replay starts a second before the rally, the pre-roll before that stays in the clip", () => {
  expect(LEAD_MS).toBe(1000);
  // A club clip: the rally (the serve's ball) at 2633 ms, the toss from about 1900 ms
  expect(replayStartMs(2633)).toBe(1633);
  // a short pre-roll (a rally 151 ms in, yYRw3f) or one barely over the lead plays from the start
  expect(replayStartMs(151)).toBe(0);
  expect(replayStartMs(1200)).toBe(0);
  expect(replayStartMs(1300)).toBe(300);
  expect(replayStartMs(null)).toBe(0);
});
