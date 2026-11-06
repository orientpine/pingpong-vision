// The recorder's pre-roll: the camera pictures of about the last second, each with the overlay state
// and camera clock it was shown with, so a clip started at rallyStart can begin before it.
// The pictures live in a fixed pool of canvases at the clip size: a picture is drawn into a free
// canvas and the canvas goes back to the pool once the recorder has drawn it. Memory is pool size x
// width x height x 4 bytes and never grows. The pool is capped by bytes (maxBytes): when it is full
// the oldest picture is handed over early (full() / early()), so a large clip size gets a shorter
// pre-roll instead of more memory, and no picture is lost.
// makeCanvas is passed in so tests run without a DOM.
export const PREROLL_MS = 3000;
export const MAX_RING_BYTES = 60 * 1024 * 1024;

export class FrameRing {
  constructor({ width, height, fps = 30, delayMs = PREROLL_MS, maxBytes = MAX_RING_BYTES, makeCanvas }) {
    this.width = width;
    this.height = height;
    this.delayMs = delayMs;
    this.frameBytes = width * height * 4;
    // three seconds of pictures plus slack for uneven frame times, never more than maxBytes
    this.capacity = Math.max(1, Math.min(Math.ceil((delayMs / 1000) * fps) + 4, Math.floor(maxBytes / this.frameBytes)));
    this.makeCanvas = makeCanvas;
    this.free = [];
    this.made = 0;
    this.entries = [];
    this.early = 0;
  }

  // no canvas left for the next picture: the caller takes early() first
  get full() {
    return !this.free.length && this.made >= this.capacity;
  }

  // the oldest picture before its time, to be drawn and released so its canvas can be reused
  takeEarly() {
    this.early++;
    return this.entries.shift();
  }

  take() {
    if (this.free.length) return this.free.pop();
    this.made++;
    const canvas = this.makeCanvas(this.width, this.height);
    return { canvas, ctx: canvas.getContext("2d") };
  }

  // one camera picture with the overlay state (already picked, so later changes to the live state do
  // not reach it) and its camera clock; call only when not full
  push(picture, t0, state, cam) {
    const slot = this.take();
    slot.ctx.drawImage(picture, 0, 0, this.width, this.height);
    this.entries.push({ slot, t0, state, cam });
  }

  // the pictures at least delayMs old, oldest first; each goes back to the pool with release()
  due(now) {
    let n = 0;
    // 1 ms slack: picture times are milliseconds, and a picture exactly the pre-roll old is due
    while (n < this.entries.length && this.entries[n].t0 <= now - this.delayMs + 1) n++;
    return this.entries.splice(0, n);
  }

  // every picture still held (the camera stopped, or a clip is cut short)
  drain() {
    return this.entries.splice(0);
  }

  release(entry) {
    this.free.push(entry.slot);
  }

  get stats() {
    return { held: this.entries.length, canvases: this.made, capacity: this.capacity, bytes: this.made * this.frameBytes, early: this.early };
  }
}
