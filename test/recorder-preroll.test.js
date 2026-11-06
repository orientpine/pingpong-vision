import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FrameRing } from "../public/js/frame-ring.js";
import { gunzipSync } from "node:zlib";

const canvas = (w, h) => ({ width: w, height: h, getContext: () => ({ drawImage() {} }), captureStream: () => ({ getTracks: () => [] }) });

describe("FrameRing", () => {
  test("the pool is a second and a half of pictures plus slack, never more than maxBytes", () => {
    expect(new FrameRing({ width: 960, height: 540, fps: 30, makeCanvas: canvas }).capacity).toBe(30);
    expect(new FrameRing({ width: 480, height: 270, fps: 30, makeCanvas: canvas }).capacity).toBe(94);
    expect(new FrameRing({ width: 1920, height: 1080, fps: 30, makeCanvas: canvas }).capacity).toBe(7);
  });
  test("pictures come due a second and a half later, oldest first, and canvases are reused, never more than the pool", () => {
    const r = new FrameRing({ width: 480, height: 270, fps: 30, makeCanvas: canvas });
    const seen = [];
    for (let k = 0; k < 30 * 120; k++) {
      const now = k * (1000 / 30);
      r.push({}, now, { k }, k);
      for (const e of r.due(now)) {
        seen.push(e.cam);
        expect(now - e.t0).toBeGreaterThanOrEqual(2999);
        r.release(e);
      }
    }
    expect(r.stats.canvases).toBeLessThanOrEqual(r.capacity);
    expect(r.stats.early).toBe(0);
    expect(seen).toEqual(seen.map((_, i) => i));
    expect(r.stats.held).toBeLessThanOrEqual(91);
  });
  test("a full pool hands its oldest picture over early: a shorter pre-roll, no more memory, nothing lost", () => {
    const r = new FrameRing({ width: 1920, height: 1080, fps: 30, makeCanvas: canvas });
    const early = [];
    for (let k = 0; k < 30; k++) {
      if (r.full) { const e = r.takeEarly(); early.push(e.cam); r.release(e); }
      r.push({}, k * 33, {}, k);
    }
    expect(r.stats.canvases).toBe(7);
    expect(r.stats.early).toBe(23);
    expect(early).toEqual(early.map((_, i) => i));
    expect(r.drain().map((e) => e.cam)).toEqual([23, 24, 25, 26, 27, 28, 29]);
  });
});

// A fake MediaRecorder: stop() delivers its last chunk and onstop at once.
class FakeRecorder {
  static isTypeSupported(t) {
    return t === "video/mp4";
  }
  constructor(stream, opts) {
    this.stream = stream;
    this.mimeType = opts.mimeType;
  }
  start() {}
  stop() {
    FakeRecorder.stoppedAt = clock.t;
    this.ondataavailable({ data: new Blob(["clip"]) });
    this.onstop();
  }
}

let RallyRecorder;
const saved = {};
const clock = { t: 0 };
beforeAll(async () => {
  for (const k of ["MediaRecorder", "HTMLCanvasElement", "document"]) saved[k] = globalThis[k];
  saved.now = performance.now;
  globalThis.MediaRecorder = FakeRecorder;
  globalThis.HTMLCanvasElement = class {};
  globalThis.HTMLCanvasElement.prototype.captureStream = () => ({ getTracks: () => [] });
  globalThis.document = { createElement: () => canvas(0, 0) };
  performance.now = () => clock.t;
  ({ RallyRecorder } = await import("../public/js/recorder.js"));
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (k !== "now") globalThis[k] = v;
  performance.now = saved.now;
});

// frames every 1000/30 ms; each carries its index as cam so a clip's frames can be named
function camera() {
  const r = new RallyRecorder({ overlay: true });
  r.setSize(960, 540);
  r.armed = true;
  let k = 0;
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++, k++) {
      clock.t = k * (1000 / 30);
      r.frame({}, { rally: null }, k);
    }
  };
  return { r, tick };
}
const camsOf = async (p) => {
  const clip = await p;
  const { gunzipSync } = await import("node:zlib");
  const raw = new Uint8Array(await clip.overlay.arrayBuffer());
  const text = raw[0] === 0x1f ? gunzipSync(raw).toString() : new TextDecoder().decode(raw);
  return JSON.parse(text).frames.map((f) => f.cam);
};

describe("RallyRecorder pre-roll", () => {
  test("rallies back to back: each stop gets its own clip; a rally refused at start gets null, never another rally's clip", async () => {
    const { r, tick } = camera();
    tick(120);
    const a = r.start();
    tick(60);
    const one = r.stop(a);
    tick(10);
    // the first clip is still drawing its last pictures: the second waits in the one queued place
    const b = r.start();
    tick(10);
    const two = r.stop(b);
    tick(5);
    // the queued place is taken: no clip for the third rally
    const c = r.start();
    expect([a > 0, b > 0, b !== a, c]).toEqual([true, true, true, false]);
    const three = r.stop(c);
    expect(r.stop(a)).toBe(one);
    tick(240);
    const [ca, cb] = [await camsOf(one), await camsOf(two)];
    expect(await three).toBe(null);
    const metaOf = async (p) => JSON.parse(gunzipSync(new Uint8Array(await (await p).overlay.arrayBuffer())).toString()).meta;
    expect([(await metaOf(one)).start.queued, (await metaOf(two)).start.queued]).toEqual([false, true]);
    expect(cb[0]).toBe(ca.at(-1) + 1);
    // a clip that has ended is not handed to a later stop, and the clip being taken now is not either
    const d = r.start();
    tick(30);
    expect(await r.stop(a)).toBe(null);
    expect(r.recording).toBe(true);
    const four = r.stop(d);
    tick(150);
    expect((await camsOf(four))[0]).toBeGreaterThan(cb.at(-1));
  });
  test("a clip begins about a second before start and ends at stop, each picture with its camera clock", async () => {
    const { r, tick } = camera();
    tick(120);
    expect(r.start()).toBeGreaterThan(0);
    tick(90);
    const clip = r.stop();
    expect(r.recording).toBe(false);
    tick(120);
    const cams = await camsOf(clip);
    // three seconds of pre-roll: 90 or 91 pictures at 30 fps (the boundary picture can land either side)
    expect(cams[0]).toBeGreaterThanOrEqual(29);
    expect(cams[0]).toBeLessThanOrEqual(30);
    expect(cams.at(-1)).toBeGreaterThanOrEqual(209);
    expect(cams).toEqual(cams.map((_, i) => cams[0] + i));
  });
  test("a rally starting inside the last clip's final second waits for it: the last clip keeps its own ending, nothing lost, nothing twice", async () => {
    const { r, tick } = camera();
    tick(120);
    r.start();
    tick(60);
    const one = r.stop();
    tick(15);
    expect(r.start()).toBeGreaterThan(0);
    tick(60);
    const two = r.stop();
    tick(120);
    const [a, b] = [await camsOf(one), await camsOf(two)];
    expect(a[0]).toBeGreaterThanOrEqual(29);
    // the first clip runs to the picture shown when its rally ended (frame 179), not the pre-roll short of it
    expect(a.at(-1)).toBeGreaterThanOrEqual(179);
    expect(b[0]).toBe(a.at(-1) + 1);
    expect([...a, ...b]).toEqual([...a, ...b].map((_, i) => a[0] + i));
  });
  test("a camera that stops sending pictures still gets its clip: what is held is drawn after the pre-roll", async () => {
    const { r, tick } = camera();
    tick(40);
    r.start();
    tick(30);
    const cams = await camsOf(r.stop());
    // the pool held all 40 pictures shown before start (under a second and a half)
    expect(cams[0]).toBe(0);
    expect(cams.at(-1)).toBe(69);
  });
  test("a failed recorder drops its clip, wants no more pictures even when armed, and takes no new clip", async () => {
    const { r, tick } = camera();
    tick(40);
    r.start();
    tick(10);
    const clip = r.stop();
    r.fail();
    expect(await clip).toBe(null);
    r.armed = true;
    expect(r.wantsFrames).toBe(false);
    expect(r.start()).toBe(false);
    expect(r.ring).toBe(null);
  });
  test("a portrait phone clip (720x1280) keeps a smaller pre-roll: long side 640, a second and a half at 30 fps under 60 MB", () => {
    const r = new RallyRecorder({ overlay: true });
    r.setSize(720, 1280);
    expect([r.canvas.width, r.canvas.height]).toEqual([720, 1280]);
    expect([r.ring.width, r.ring.height]).toEqual([270, 480]);
    expect(r.ring.capacity).toBe(94);
    expect(r.ring.capacity * r.ring.frameBytes).toBeLessThanOrEqual(60 * 1024 * 1024);
    expect(r.ring.capacity / 30).toBeGreaterThanOrEqual(3);
  });
  // camera frames at the given gaps (ms) and a screen refresh every 16 ms; one clip from startAt to stopAt
  async function feed(gaps, { startAt, stopAt, raf = true }) {
    const cbs = [];
    globalThis.requestAnimationFrame = (f) => cbs.push(f);
    const r = new RallyRecorder({ overlay: true });
    r.setSize(960, 540);
    r.armed = true;
    const drawnAt = [];
    const draw = r.draw.bind(r);
    r.draw = (...a) => { if (r.rec) drawnAt.push(clock.t); return draw(...a); };
    let k = 0, next = 0, g = 0, clip = null, blockedUntil = 0;
    for (let ms = 0; ms <= stopAt + 6000; ms++) {
      clock.t = ms;
      // a gap over 100 ms is a stall of the page's main thread: no camera frame and no screen refresh
      if (ms >= next) { r.frame({}, { rally: null }, k++); const gap = gaps[g++ % gaps.length]; next = ms + gap; blockedUntil = gap > 100 ? next : 0; }
      if (ms === startAt) r.start();
      if (ms === stopAt) clip = r.stop();
      if (raf && ms % 16 === 0 && ms >= blockedUntil) for (const f of cbs.splice(0)) f(ms);
    }
    delete globalThis.requestAnimationFrame;
    const c = await clip;
    return { drawnAt, cams: await camsOf(Promise.resolve(c)), counts: JSON.parse(gunzipSync(new Uint8Array(await c.overlay.arrayBuffer())).toString()).meta.counts };
  }
  test("a camera stall delays pictures instead of dropping them: drawn = shown, in order", async () => {
    const gaps = [...Array(100).fill(33), 450, ...Array(200).fill(33)];
    const { cams, counts: c, drawnAt } = await feed(gaps, { startAt: 2000, stopAt: 5000 });
    // the backlog after the stall drains about one picture per clip frame, never on back-to-back refreshes
    expect(Math.min(...drawnAt.slice(1).map((x, i) => x - drawnAt[i]))).toBeGreaterThanOrEqual(24);
    expect(c.skipped).toBe(0);
    expect(c.drawn).toBe(c.shown);
    expect(c.drawn).toBe(cams.length);
    expect(cams.every((x, i) => i === 0 || x === cams[i - 1] + 1)).toBe(true);
    expect(c.maxGapMs).toBe(450);
    expect(c.stallMs).toBeGreaterThan(400);
  });
  test("the stream stops two clip frames after the last picture is drawn, so that picture reaches the video", async () => {
    const { drawnAt } = await feed(Array(400).fill(33), { startAt: 2000, stopAt: 5000 });
    expect(FakeRecorder.stoppedAt - drawnAt.at(-1)).toBeGreaterThanOrEqual(60);
  });
  test("at real-phone spacing (35-58 ms, now and then up to 73 ms) every shown picture is drawn", async () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const gaps = Array.from({ length: 400 }, () => Math.round(rnd() < 0.025 ? 60 + rnd() * 13 : 35 + rnd() * 23));
    const { counts: c } = await feed(gaps, { startAt: 3000, stopAt: 9000 });
    expect(c.shown).toBeGreaterThan(100);
    expect(c.drawn).toBe(c.shown);
  });
  test("a rally that starts and ends inside the last clip's final second still gets its own clip", async () => {
    const { r, tick } = camera();
    tick(60);
    r.start();
    tick(60);
    const one = r.stop();
    tick(5);
    expect(r.start()).toBeGreaterThan(0);
    tick(10);
    const two = r.stop();
    tick(80);
    const [a, b] = [await camsOf(one), await camsOf(two)];
    expect(a.at(-1)).toBeGreaterThanOrEqual(119);
    expect(b[0]).toBe(a.at(-1) + 1);
    expect(b.at(-1)).toBeGreaterThanOrEqual(134);
  });
});

describe("rAF drawing loop", () => {
  // camera calls bunched in threes every 100 ms (what the phone logs showed); rAF every 16 ms unless paused
  async function run({ paused }) {
    const cbs = [];
    globalThis.requestAnimationFrame = (f) => cbs.push(f);
    const r = new RallyRecorder({ overlay: true });
    r.setSize(960, 540);
    r.armed = true;
    let k = 0, clip = null;
    for (let ms = 0; ms <= 6000; ms++) {
      clock.t = ms;
      if (ms % 100 === 0) for (let i = 0; i < 3; i++) r.frame({}, { rally: null }, k++);
      if (ms === 2000) r.start();
      if (ms === 4000) clip = r.stop();
      if (!paused && ms % 16 === 0) for (const f of cbs.splice(0)) f(ms);
    }
    delete globalThis.requestAnimationFrame;
    const c = await clip;
    return JSON.parse(gunzipSync(new Uint8Array(await c.overlay.arrayBuffer())).toString()).meta.counts;
  }
  test("rAF running: bunched calls lose nothing (drawn = shown)", async () => {
    const { gunzipSync: g } = await import("node:zlib"); globalThis.gunzipSync = g;
    const c = await run({ paused: false });
    expect(c.skipped).toBe(0);
    expect(c.drawn).toBe(c.shown);
    expect(c.drawn).toBeGreaterThanOrEqual(58);
  });
  test("rAF paused (hidden tab): the camera call still draws, the clip still ends", async () => {
    const c = await run({ paused: true });
    expect(c.drawn).toBeGreaterThan(0);
    expect(c.skipped).toBe(0);
    console.log("PAUSED_COUNTS", JSON.stringify({ drawn: c.drawn, shown: c.shown, early: c.early }));
  });
});

describe("pre-roll at a phone's own frame rate", () => {
  // camera pictures every 16 then 34 ms (about 39 a second, what a real phone clip showed), each with its
  // camera time in seconds; rAF every 16 ms; armed from armAt, one clip from startAt to stopAt
  async function phone({ armAt = 0, startAt, stopAt, resizeAt = null }) {
    const cbs = [];
    globalThis.requestAnimationFrame = (f) => cbs.push(f);
    const r = new RallyRecorder({ overlay: true });
    r.setSize(960, 540);
    let next = 0, flip = false, clip = null;
    for (let ms = 0; ms <= stopAt + 6000; ms++) {
      clock.t = ms;
      r.armed = ms >= armAt;
      if (ms === resizeAt) r.setSize(960, 544);
      if (ms >= next) { if (r.wantsFrames) r.frame({}, { rally: null }, ms / 1000); next = ms + ((flip = !flip) ? 16 : 34); }
      if (ms === startAt) r.start();
      if (ms === stopAt) clip = r.stop();
      if (ms % 16 === 0) for (const f of cbs.splice(0)) f(ms);
    }
    delete globalThis.requestAnimationFrame;
    const c = await clip;
    const doc = JSON.parse(gunzipSync(new Uint8Array(await c.overlay.arrayBuffer())).toString());
    return { cams: doc.frames.map((f) => f.cam), meta: doc.meta };
  }

  test("a camera faster than the clip still gets the whole three seconds before the start, in the same pool", async () => {
    const { cams, meta } = await phone({ startAt: 10000, stopAt: 12000 });
    expect(meta.counts.early).toBe(0);
    expect(meta.counts.thinned).toBeGreaterThan(0);
    expect(10 - cams[0]).toBeGreaterThanOrEqual(2.95);
    // about the clip's 30 pictures a second, never two closer than a 60 Hz refresh
    const perS = cams.length / (cams.at(-1) - cams[0]);
    expect(perS).toBeGreaterThan(27);
    expect(perS).toBeLessThan(33);
    expect(Math.min(...cams.slice(1).map((c, i) => c - cams[i]))).toBeGreaterThanOrEqual(0.015);
  });

  test("the clip's meta says what the pre-roll had at the start: armed 300 ms ago, so 300 ms of pictures", async () => {
    const { cams, meta } = await phone({ armAt: 9700, startAt: 10000, stopAt: 11000 });
    expect(meta.start.armedMs).toBe(300);
    expect(meta.start.preRollMs).toBeGreaterThanOrEqual(280);
    expect(meta.start.preRollMs).toBeLessThanOrEqual(300);
    expect(meta.start.held).toBeGreaterThan(5);
    expect(meta.start.rings).toBe(1);
    expect(10 - cams[0]).toBeLessThan(0.31);
  });

  test("a picture size change makes a new pool: the meta counts it and says how young the pool is", async () => {
    const { meta } = await phone({ startAt: 10000, stopAt: 11000, resizeAt: 9500 });
    expect(meta.start.rings).toBe(2);
    expect(meta.start.ringMs).toBe(500);
    expect(meta.start.armedMs).toBe(10000);
  });
});

describe("why a clip's pre-roll was short", () => {
  test("meta.start names the last reason the recorder was off and for how long", async () => {
    const r = new RallyRecorder({ overlay: true });
    r.setSize(960, 540);
    let k = 0, clip = null;
    for (let ms = 0; ms <= 9000; ms += 33) {
      clock.t = ms;
      const why = ms >= 3000 && ms < 5000 ? "mode:calibrating" : null;
      r.arm(why === null, why);
      if (r.wantsFrames) r.frame({}, { rally: null }, ms / 1000);
      if (ms === 5313) r.start();
      if (ms === 6006) clip = r.stop();
    }
    const c = await clip;
    const meta = JSON.parse(gunzipSync(new Uint8Array(await c.overlay.arrayBuffer())).toString()).meta;
    expect(meta.start.off.why).toBe("mode:calibrating");
    expect(meta.start.off.forMs).toBeGreaterThanOrEqual(1980);
    expect(meta.start.off.forMs).toBeLessThanOrEqual(2020);
    expect(meta.start.armedMs).toBeLessThan(400);
  });

  test("a stall shorter than the pre-roll (main thread busy) keeps the pictures before it", async () => {
    const r = new RallyRecorder({ overlay: true });
    r.setSize(960, 540);
    r.armed = true;
    let clip = null;
    for (let ms = 0; ms <= 12000; ms += 33) {
      clock.t = ms;
      if (ms < 7000 || ms > 8500) r.frame({}, { rally: null }, ms / 1000);
      if (ms === 8712) r.start();
      if (ms === 9702) clip = r.stop();
    }
    const c = await clip;
    const meta = JSON.parse(gunzipSync(new Uint8Array(await c.overlay.arrayBuffer())).toString()).meta;
    expect(meta.start.resumedMs).toBeLessThan(250);
    expect(meta.start.preRollMs).toBeGreaterThan(2900);
  });

  test("after a pause, a picture still stamped with the time from before it is left out: no gap inside the clip", async () => {
    const r = new RallyRecorder({ overlay: true });
    r.setSize(960, 540);
    r.armed = true;
    let clip = null, staleOnce = true;
    for (let ms = 0; ms <= 16000; ms += 33) {
      clock.t = ms;
      if (ms >= 4000 && ms <= 9000) continue;
      // the first call after the pause carries an analysis time from well before it (the analysis clock stood
      // still while the corner screen was up), then fresh times
      const cam = ms > 9000 && staleOnce ? ((staleOnce = false), 1.0) : ms / 1000;
      r.frame({}, { rally: null }, cam);
      if (ms === 10494) r.start();
      if (ms === 11484) clip = r.stop();
    }
    const cams = await camsOf(clip);
    expect(cams[0]).toBeGreaterThan(9);
    expect(Math.max(...cams.slice(1).map((c, i) => c - cams[i]))).toBeLessThan(0.2);
  });

  test("a camera that sent nothing for a while (hidden page) shows as resumedMs", async () => {
    const r = new RallyRecorder({ overlay: true });
    r.setSize(960, 540);
    r.armed = true;
    let clip = null;
    for (let ms = 0; ms <= 14000; ms += 33) {
      clock.t = ms;
      if (ms < 4000 || ms > 9000) r.frame({}, { rally: null }, ms / 1000);
      if (ms === 9504) r.start();
      if (ms === 10494) clip = r.stop();
    }
    const c = await clip;
    const meta = JSON.parse(gunzipSync(new Uint8Array(await c.overlay.arrayBuffer())).toString()).meta;
    expect(meta.start.resumedMs).toBeGreaterThan(450);
    expect(meta.start.resumedMs).toBeLessThan(520);
    expect(meta.start.pauseMs).toBeGreaterThan(4950);
    expect(meta.start.pauseMs).toBeLessThan(5050);
    expect(meta.start.preRollMs).toBeLessThan(520);
  });
});
