// The frame rate the desk samples a video at. A browser recording (MediaRecorder, variable frame rate)
// can report r_frame_rate as the container tick (30000/1), which would turn a 5 s clip into 150,000 frames;
// above MAX_FPS the average frame rate is used instead.
export const MAX_FPS = 240;

const rate = (s) => {
  const [num, den = 1] = String(s ?? "").trim().split("/").map(Number);
  return num > 0 && den > 0 ? num / den : 0;
};

export function pickFps(rFrameRate, avgFrameRate) {
  const r = rate(rFrameRate);
  if (r > 0 && r <= MAX_FPS) return r;
  const avg = rate(avgFrameRate);
  return avg > 0 && avg <= MAX_FPS ? avg : 0;
}
