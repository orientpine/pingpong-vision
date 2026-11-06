import { expect, test } from "bun:test";
import { frameClock, STALL_MS } from "../public/js/frame-clock.js";

function rig({ callbacks }) {
  let t = 0, nextId = 1;
  const pending = new Map();
  const frames = [];
  const video = {
    paused: false, ended: false, readyState: 4, currentTime: 0,
    on: {},
    addEventListener(ev, f) { (this.on[ev] ||= []).push(f); },
    requestVideoFrameCallback(cb) { const id = nextId++; pending.set(id, cb); return id; },
    cancelVideoFrameCallback(id) { pending.delete(id); },
  };
  const drawn = [], modes = [];
  frameClock(video, {
    onFrame: (meta) => drawn.push(["frame", meta.mediaTime]),
    onTime: (sec) => drawn.push(["time", sec]),
    setMode: (m) => modes.push(m),
    now: () => t,
    raf: (f) => frames.push(f),
  });
  // one 16 ms animation frame; the video advances and, when the engine delivers them, presents a picture
  const step = () => {
    t += 16;
    video.currentTime = t / 1000;
    if (callbacks.on) {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, cb] of due) cb(t, { mediaTime: video.currentTime });
    }
    const due = frames.splice(0);
    for (const f of due) f();
  };
  return { video, drawn, modes, step, pending, frames, at: () => t };
}

test("frame callbacks drive the draws while they come", () => {
  const r = rig({ callbacks: { on: true } });
  for (let i = 0; i < 60; i++) r.step();
  expect(r.drawn.every(([k]) => k === "frame")).toBe(true);
  expect(r.modes).toEqual([]);
});

test("callbacks blocked: the overlay follows currentTime after STALL_MS, and goes back when they return", () => {
  const callbacks = { on: false };
  const r = rig({ callbacks });
  for (let i = 0; i < 60; i++) r.step();
  const timeDraws = r.drawn.filter(([k]) => k === "time");
  expect(timeDraws.length).toBeGreaterThan(20);
  // nothing drawn from time before the stall window
  expect(timeDraws[0][1] * 1000).toBeGreaterThan(STALL_MS);
  // it follows the picture: the drawn times move with the video
  expect(timeDraws.at(-1)[1]).toBeCloseTo(r.video.currentTime, 3);
  expect(r.modes).toEqual(["time"]);
  // it asked for callbacks again, so they resume
  expect(r.pending.size).toBe(1);
  callbacks.on = true;
  const before = r.drawn.length;
  for (let i = 0; i < 10; i++) r.step();
  expect(r.drawn.slice(before).every(([k]) => k === "frame")).toBe(true);
  expect(r.modes).toEqual(["time", "frames"]);
});

test("a paused video is not a stall", () => {
  const r = rig({ callbacks: { on: false } });
  r.video.paused = true;
  for (let i = 0; i < 60; i++) r.step();
  expect(r.drawn.length).toBe(0);
});

test("a paused clip asks for no animation frames, and the watch starts again when it plays", () => {
  const r = rig({ callbacks: { on: false } });
  r.video.paused = true;
  r.step();
  expect(r.frames.length).toBe(0);
  for (let i = 0; i < 30; i++) r.step();
  expect(r.drawn.length).toBe(0);
  r.video.paused = false;
  for (const f of r.video.on.play) f();
  expect(r.frames.length).toBe(1);
  for (let i = 0; i < 60; i++) r.step();
  expect(r.drawn.some(([k]) => k === "time")).toBe(true);
});
