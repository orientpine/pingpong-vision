// Stands in for desk/pass1.js: two first-pass rallies (strokes not known yet) on stdout, as one JSON line.
// FAKE_FIRST_PASS_FAIL=1 exits 3 the way a video ffmpeg cannot read does.
if (process.env.FAKE_FIRST_PASS_FAIL === "1") {
  console.error("ffmpeg could not decode the video");
  process.exit(3);
}
const rally = (index, t) => ({
  v: 1, index, source: "desk", startedAt: 1000 + index, durationMs: 800, winner: "far", nearSlot: 0, why: "ball_lost",
  shots: [{ side: "near", t, stroke: null, kind: "드라이브", speedKmh: 30, arc: null, inferred: false, land: null }, { side: "far", t: t + 0.4, stroke: null, kind: "푸시", speedKmh: 20, arc: null, inferred: false, land: null }],
  bounces: [],
});
console.log(JSON.stringify({ rallies: [rally(0, 0.5), rally(1, 2)] }));
