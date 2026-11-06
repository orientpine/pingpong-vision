import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// A fake MediaRecorder the test drives by hand: chunks arrive when the test says, and stop() only
// queues the last chunk and onstop, so the order of two back-to-back recordings can be set exactly.
class FakeRecorder {
  static made = [];
  static isTypeSupported(t) {
    return t === "video/mp4";
  }
  constructor(stream, opts) {
    this.stream = stream;
    this.mimeType = opts.mimeType;
    this.ondataavailable = null;
    this.onstop = null;
    this.pending = null;
    FakeRecorder.made.push(this);
  }
  start() {}
  emit(text) {
    this.ondataavailable({ data: new Blob([text]) });
  }
  stop() {
    this.pending = (tail) => {
      this.ondataavailable({ data: new Blob([tail]) });
      this.onstop();
    };
  }
}

let RallyRecorder;
const saved = {};
beforeAll(async () => {
  for (const k of ["MediaRecorder", "HTMLCanvasElement"]) saved[k] = globalThis[k];
  globalThis.MediaRecorder = FakeRecorder;
  globalThis.HTMLCanvasElement = class {};
  globalThis.HTMLCanvasElement.prototype.captureStream = () => ({ getTracks: () => [] });
  ({ RallyRecorder } = await import("../public/js/recorder.js"));
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) globalThis[k] = v;
});

// stop() resolves to the clip, or to { video, overlay } where the overlay track is saved beside it
const clipOf = async (p) => { const x = await p; return x && x.video !== undefined ? x.video : x; };
const recorder = () => {
  const r = new RallyRecorder({ overlay: false });
  r.canvas = { width: 960, height: 540, captureStream: () => ({ getTracks: () => [] }) };
  return r;
};

describe("RallyRecorder: back-to-back rallies", () => {
  test("a rally that starts before the last one's recorder has finished keeps its own file, header first", async () => {
    const r = recorder();
    expect(r.start()).toBeGreaterThan(0);
    const one = FakeRecorder.made.at(-1);
    one.emit("A-head|");
    one.emit("A-1|");
    const first = r.stop(); // the rally ended; this recorder's last chunk and onstop come later
    expect(r.start()).toBeGreaterThan(0); // the next rally starts at once
    const two = FakeRecorder.made.at(-1);
    two.emit("B-head|");
    one.pending("A-tail|"); // the first recorder finishes only now
    two.emit("B-1|");
    const second = r.stop();
    two.pending("B-tail|");
    expect(await (await clipOf(first)).text()).toBe("A-head|A-1|A-tail|");
    const b = await clipOf(second);
    expect(await b.text()).toBe("B-head|B-1|B-tail|");
    expect(b.type).toBe("video/mp4");
  });

  test("a recording with no chunks still gives null", async () => {
    const r = recorder();
    r.start();
    const p = r.stop();
    FakeRecorder.made.at(-1).onstop();
    expect(await clipOf(p)).toBe(null);
  });
});

describe("RallyRecorder: the last chunk after stop()", () => {
  test("stop() returns, then the last dataavailable, then onstop: the last chunk is the end of the file", async () => {
    const r = recorder();
    r.start();
    const one = FakeRecorder.made.at(-1);
    one.emit("H|");
    one.emit("M|");
    const p = r.stop();
    await Promise.resolve();
    one.pending("TAIL|");
    expect(await (await clipOf(p)).text()).toBe("H|M|TAIL|");
  });
});
