// Drives overlay draws from the video's frame callbacks (requestVideoFrameCallback). If none has come
// for STALL_MS while the video is playing (an engine can stop sending them), it draws from currentTime
// on animation frames and asks for callbacks again; when they come back it goes back to them.
export const STALL_MS = 500;
const REARM_MS = 1000;

export function frameClock(video, { onFrame, onTime, alive = () => true, setMode = () => {}, now = () => performance.now(), raf = (f) => requestAnimationFrame(f) }) {
  let last = now(), handle = 0, lastAsk = -Infinity, mode = "frames";
  const ask = () => {
    if (handle && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle);
    lastAsk = now();
    handle = video.requestVideoFrameCallback(onCallback);
  };
  function onCallback(_t, meta) {
    handle = 0;
    if (!alive()) return;
    last = now();
    if (mode !== "frames") setMode((mode = "frames"));
    onFrame(meta);
    ask();
  }
  // the watch runs on animation frames only while the video plays, so a paused or ended clip box costs
  // nothing per frame
  let watching = false;
  function watch() {
    if (!alive() || video.paused || video.ended) { watching = false; return; }
    const t = now();
    if (video.readyState >= 2 && t - last > STALL_MS) {
      if (mode !== "time") setMode((mode = "time"));
      onTime(video.currentTime);
      if (t - lastAsk > REARM_MS) ask();
    }
    raf(watch);
  }
  const startWatch = () => { if (!watching && alive()) { watching = true; raf(watch); } };
  // a paused video sends no callbacks; the wait starts again when it plays
  video.addEventListener("play", () => { last = now(); startWatch(); });
  ask();
  startWatch();
}
