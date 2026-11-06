import { describe, expect, test } from "bun:test";
import { RallyShots } from "../public/js/analysis-record.js";
import { DeskRallies } from "../desk/page/collect.js";

const shot = (side, t) => ({ side, t, stroke: "fore", kind: null, speedKmh: null, arc: 0 });
const bounce = (side, t) => ({ tx: 1, ty: 0.5, side, t });

// rally.js on a short clip: it ends one rally when the ball is lost, opens another, and the clip stops mid-play.
function feed(r) {
  const a = shot("near", 0.1), b = shot("far", 0.6);
  r.onEvent({ type: "rallyStart", t: 0 });
  r.onEvent({ type: "shot", t: a.t, shot: a });
  r.onEvent({ type: "bounce", t: 0.3, bounce: bounce("far", 0.3) });
  r.onEvent({ type: "rallyEnd", t: 0.4, why: "ball_lost", durationS: 0.4, bounces: [bounce("far", 0.3)] });
  r.onEvent({ type: "rallyStart", t: 0.5 });
  r.onEvent({ type: "shot", t: b.t, shot: b });
}

describe("desk rallies", () => {
  test("a rally clip is one rally with every shot and bounce, even when rally.js splits it and never closes", () => {
    const r = new DeskRallies("rally", RallyShots);
    feed(r);
    expect(r.take()).toEqual([]);
    expect(r.resumable()).toBe(false);
    const out = r.finish(0, 1.2);
    expect(out.length).toBe(1);
    expect(out[0].startT).toBe(0);
    expect(out[0].draft.why).toBe("clip");
    expect(out[0].draft.durationMs).toBe(1200);
    expect(out[0].draft.shots.map((s) => [s.side, s.t])).toEqual([["near", 0.1], ["far", 0.6]]);
    expect(out[0].draft.bounces.length).toBe(1);
    expect(out[0].shots.length).toBe(2);
  });

  test("a rally clip with no shot sends nothing", () => {
    const r = new DeskRallies("rally", RallyShots);
    r.onEvent({ type: "rallyStart", t: 0 });
    expect(r.finish(0, 1)).toEqual([]);
  });

  test("a gallery video keeps rally.js's rallies: a closed one is sent, one still open at the end is not", () => {
    const r = new DeskRallies("gallery", RallyShots);
    feed(r);
    const sent = r.take();
    expect(sent.length).toBe(1);
    expect(sent[0].draft.why).toBe("ball_lost");
    expect(sent[0].draft.shots.map((s) => s.side)).toEqual(["near"]);
    expect(r.resumable()).toBe(false);
    expect(r.finish(0, 1.2)).toEqual([]);
  });
});
