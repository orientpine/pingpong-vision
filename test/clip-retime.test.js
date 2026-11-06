import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSaveStore } from "../save-server.js";
import { moveTrack, plan } from "../clip-retime.js";
import { trackShots } from "../desk/page/track-shots.js";

// A clip timed like a club phone recording (2026-11-04): pictures drawn 10, 12 then 62 ms apart while the camera
// filmed them 17, 17 then 50 ms apart. Made with ffmpeg the way the phone's MediaRecorder writes it
// (fragmented MP4, H.264 Constrained Baseline) or as Chrome's WebM.
const N = 36;
const DRAWN = [10, 12, 62], FILMED = [50 / 3, 50 / 3, 50];
const steps = (gaps) => Array.from({ length: N }, (_, k) => k).reduce((a, k) => (k ? [...a, a[k - 1] + gaps[(k - 1) % 3]] : [0]), []);
const drawnMs = steps(DRAWN).map(Math.round);
const cams = steps(FILMED).map((ms) => 512.25 + ms / 1000);

let root, store, key;
function makeClip(type) {
  const file = join(root, type === "video/mp4" ? "src.mp4" : "src.webm");
  const expr = drawnMs.map((v, n) => `eq(N\\,${n})*${v}`).join("+");
  const codec = type === "video/mp4" ? ["-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-movflags", "frag_keyframe+empty_moov"] : ["-c:v", "libvpx"];
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=160x90:rate=30`, "-frames:v", String(N), ...codec, "-bsf:v", `setts=ts=${expr}:time_base=1/1000`, file]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  return new Blob([readFileSync(file)], { type });
}
const times = (file) => spawnSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "packet=pts_time", "-of", "csv=p=0", file], { encoding: "utf8" }).stdout.trim().split("\n").map((s) => Math.round(Number(s) * 1000));
const gapsOf = (xs) => xs.slice(1).map((x, i) => x - xs[i]);
const trackOf = (frames) => new Blob([Bun.gzipSync(JSON.stringify({ v: 1, meta: {}, frames, notices: [{ t: drawnMs[20], text: "엔드 교체" }] }))]);
const upload = (video, overlay) => {
  const form = new FormData();
  form.set("record", JSON.stringify({ shots: 1, durationMs: 1200 }));
  form.set("video", video, "rally");
  form.set("overlay", overlay, "overlay.json.gz");
  return store.handle(new Request("http://x/api/rallies", { method: "POST", headers: { "x-ppv-key": key }, body: form }), "/api/rallies");
};
const saved = (id) => {
  const d = join(store.dir, id);
  const video = ["video.mp4", "video.webm"].map((f) => join(d, f)).find((f) => Bun.file(f).size > 0);
  return { d, video, record: JSON.parse(readFileSync(join(d, "record.json"), "utf8")), track: JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(join(d, "overlay.json.gz"))))) };
};

beforeAll(async () => {
  root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ppv-retime-"));
  store = createSaveStore({ dir: join(root, "saves"), keyFile: join(root, "cfg/upload-key") });
  key = (await Bun.file(join(root, "cfg/upload-key")).text()).trim();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

for (const type of ["video/mp4", "video/webm"]) {
  test(`${type}: a saved clip's pictures sit at the camera's times, the overlay track and its notices moved with them`, async () => {
    const res = await upload(makeClip(type), trackOf(drawnMs.map((t, k) => ({ t, cam: cams[k], ball: { current: { x: k, y: k } } }))));
    expect(res.status).toBe(201);
    const { video, record, track } = saved((await res.json()).id);
    const got = times(video);
    expect(got.length).toBe(N);
    const filmed = cams.map((c) => Math.round((c - cams[0]) * 1000));
    // every gap is the camera's own (17, 17, 50 ms), none of the drawn 10 / 12 / 62
    expect(gapsOf(got).map((g, i) => Math.abs(g - gapsOf(filmed)[i]) <= 1)).toEqual(Array(N - 1).fill(true));
    expect(track.frames.map((f) => f.t)).toEqual(got.map((t) => t - got[0]));
    expect(track.frames.map((f) => f.ball.current.x)).toEqual(Array.from({ length: N }, (_, k) => k));
    expect(track.meta.retimed).toBe("cam");
    expect(track.notices[0].t).toBe(filmed[20]);
    expect(record.retime.pictures).toBe(N);
    expect(record.retime.shiftMs).toBe(Math.max(...filmed.map((f, k) => Math.abs(f - drawnMs[k]))));
  });
}

test("a track without camera times, with too few frames, or not paired with the pictures leaves the clip as it came", async () => {
  const clip = makeClip("video/mp4");
  const bytes = new Uint8Array(await clip.arrayBuffer());
  const cases = [
    ["no-cam", drawnMs.map((t) => ({ t }))],
    ["count", drawnMs.slice(0, N - 5).map((t, k) => ({ t, cam: cams[k] }))],
    ["pairing", drawnMs.map((t, k) => ({ t: k * 30, cam: cams[k] }))],
    ["cam-order", drawnMs.map((t, k) => ({ t, cam: k === 9 ? cams[3] : cams[k] }))],
    // the first picture after a 7.3 s camera pause carried the analysis time from before it
    ["cam-jump", drawnMs.map((t, k) => ({ t, cam: k === 0 ? cams[0] - 7.3 : cams[k] }))],
  ];
  for (const [why, frames] of cases) {
    const res = await upload(new Blob([bytes], { type: "video/mp4" }), trackOf(frames));
    expect(res.status).toBe(201);
    const { video, record, track } = saved((await res.json()).id);
    expect([why, record.retime]).toEqual([why, { skipped: why }]);
    expect(new Uint8Array(readFileSync(video))).toEqual(bytes);
    expect(track.frames.map((f) => f.t)).toEqual(frames.map((f) => f.t));
  }
});

test("the analysis desk finds a shot at the retimed picture filmed at the shot's camera time", () => {
  const frames = drawnMs.map((t, k) => ({ t, cam: cams[k], ...(k === 20 ? { lastShot: { index: 1, t: cams[20], side: "near" } } : {}) }));
  const p = plan({ frames }, [0, ...drawnMs.map((ms) => (ms + 2) / 1000)]);
  const moved = moveTrack({ frames }, p.frameMs);
  // the picture filmed at cams[20] now sits at p.ms[21] (picture 0 is the canvas stream's opening one)
  expect(Math.round(trackShots(moved).shots[0].t * 1000)).toBe(p.ms[21]);
  // before the move the same shot pointed at the drawn time, off by the bunching
  expect(Math.round(trackShots({ frames }).shots[0].t * 1000)).toBe(drawnMs[20]);
});

test("the canvas stream's opening picture (2 ms before the first drawn one) is not paired with the first track frame", () => {
  const frames = drawnMs.map((t, k) => ({ t, cam: cams[k] }));
  const pts = [0, ...drawnMs.map((ms) => (ms + 2) / 1000)];
  const p = plan({ frames }, pts);
  expect(p.ms.length).toBe(N + 1);
  expect(p.ms[0]).toBe(0);
  expect(p.frameMs).toEqual(p.ms.slice(1));
  expect(p.frameMs.map((m) => m - p.frameMs[0])).toEqual(cams.map((c) => Math.round((c - cams[0]) * 1000)));
  expect(p.frameMs[0]).toBe(2);
});

test("one extra closing picture keeps its own distance; single pictures 27 ms off their frames still pair, two in a row do not", () => {
  const frames = drawnMs.map((t, k) => ({ t, cam: cams[k] }));
  const pts = [...drawnMs, drawnMs.at(-1) + 33].map((ms) => ms / 1000);
  const p = plan({ frames }, pts);
  expect(p.ms.length).toBe(N + 1);
  expect(p.ms.at(-1) - p.ms.at(-2)).toBe(33);
  pts[3] -= 0.027;
  expect(plan({ frames }, pts).skip).toBe(undefined);
  pts[6] -= 0.027;
  expect(plan({ frames }, pts).skip).toBe(undefined);
  pts[7] -= 0.027;
  expect(plan({ frames }, pts).skip).toBe("pairing");
});

test("a clip with two pictures closer than 1/60 s (as phones record) decodes clean: every picture, no error", async () => {
  const { decodedPictures } = await import("../clip-retime.js");
  const dir = mkdtempSync(join(tmpdir(), "pp-dec-"));
  const src = join(dir, "a.mp4"), out = join(dir, "b.mp4");
  const ts = [0, 3, 40, 52, 90, 140, 151, 190, 230, 270];
  expect(Bun.spawnSync(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=30", "-frames:v", String(ts.length), "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", src]).exitCode).toBe(0);
  const expr = ts.map((v, n) => `eq(N\\,${n})*${v}`).join("+");
  expect(Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-i", src, "-c", "copy", "-bsf:v", `setts=ts=${expr}:time_base=1/1000`, "-f", "mp4", out]).exitCode).toBe(0);
  const d = await decodedPictures(out);
  rmSync(dir, { recursive: true, force: true });
  expect(d).toEqual({ pictures: ts.length, error: "" });
});
