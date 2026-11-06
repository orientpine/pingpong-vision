import { describe, expect, test } from "bun:test";
import { Clock, EndHold, EndSync, HOLD_REASON, Merger, judgeRally, mergeEvents, scoreAction, shareSegment, turnSegment } from "../public/js/multicam.js";

// A rally as rally.js reports it (seconds, near / far of that camera).
const rallyEnd = (bounces, shots, { t = null, why = "ball_lost" } = {}) => {
  const ts = [...bounces.map((b) => b.t), ...shots.map((s) => s.t)];
  const end = t ?? Math.max(...ts) + 0.5;
  const start = Math.min(...ts) - 0.2;
  return { type: "rallyEnd", t: end, durationS: end - start, why, shots: shots.length, shotList: shots, bounces, serveNet: null, serveSeen: null, maxSpeedKmh: 30 };
};
const B = (side, t, tx = side === "near" ? 0.8 : 2.0, ty = 0.7) => ({ side, t, tx, ty });
const S = (side, t, inferred = false) => ({ side, t, inferred });

// serve from near: bounce near, bounce far, far returns, bounce near, near misses -> far wins
const fullRally = { bounces: [B("near", 10.3), B("far", 10.7), B("near", 11.5)], shots: [S("near", 10.0), S("far", 11.1)] };

describe("Clock", () => {
  test("offset from a symmetric ping is exact and the fastest answer is kept", () => {
    const c = new Clock();
    c.sample(1000, 50_000 + 1020, 1040); // rtt 40, true offset 50000
    c.sample(2000, 50_000 + 2100 + 30, 2200); // rtt 200, 30 ms one-sided -> off by 30
    expect(c.offset).toBe(50_000);
    expect(c.errMs).toBe(20);
    expect(c.toServer(3000)).toBe(53_000);
  });
});

describe("shareSegment", () => {
  test("a camera at the red end maps its near / far and table x / y into the blue frame", () => {
    const seg = shareSegment(rallyEnd([B("near", 1, 0.5, 0.2)], [S("near", 0.8)]), { near: 1, offset: 100, cam: "b" });
    expect(seg.bounces[0]).toEqual({ t: 1100, end: 1, x: 2.74 - 0.5, y: 1.525 - 0.2 });
    expect(seg.shots[0]).toEqual({ t: 900, end: 1, inferred: false });
  });
});

describe("judgeRally", () => {
  test("the bounce the primary lost (body in the way) comes from the other camera", () => {
    const a = shareSegment(rallyEnd(fullRally.bounces.slice(0, 2), fullRally.shots), { near: 0, cam: "self" });
    const b = shareSegment(rallyEnd(fullRally.bounces, fullRally.shots), { near: 0, offset: 30, cam: "b" });
    const alone = judgeRally([a], { near: 0 });
    const merged = judgeRally([a, b], { near: 0 });
    expect(alone.judged.winner).toBe("near"); // missed the last bounce: wrong winner, unsure
    expect(merged.judged.winner).toBe("far");
    expect(merged.judged.sure).toBe(true);
    expect(merged.filled).toBe(1);
    expect(merged.conflict).toBe(false);
  });

  test("bounces both cameras saw count once (clocks 40 ms apart)", () => {
    const a = shareSegment(rallyEnd(fullRally.bounces, fullRally.shots), { near: 0, cam: "self" });
    const b = shareSegment(rallyEnd(fullRally.bounces, fullRally.shots), { near: 0, offset: 40, cam: "b" });
    const { bounces, shots } = mergeEvents([a, b], "self");
    expect(bounces.length).toBe(3);
    expect(bounces.every((x) => x.cam === "self")).toBe(true);
    expect(shots.length).toBe(2);
  });

  test("a camera at the other end agrees with the primary after the end mapping", () => {
    const flip = (x) => (x === "near" ? "far" : "near");
    const fromRed = rallyEnd(
      fullRally.bounces.map((b) => B(flip(b.side), b.t, 2.74 - b.tx, 1.525 - b.ty)),
      fullRally.shots.map((s) => S(flip(s.side), s.t)),
    );
    const a = shareSegment(rallyEnd(fullRally.bounces.slice(0, 2), fullRally.shots), { near: 0, cam: "self" });
    const b = shareSegment(fromRed, { near: 1, cam: "b" });
    const merged = judgeRally([a, b], { near: 0 });
    expect(merged.judged.winner).toBe("far");
    expect(mergeEvents([a, b], "self").bounces.length).toBe(3);
  });

  test("two cameras that both saw the last bounce but on different ends are a conflict", () => {
    const a = shareSegment(rallyEnd([B("near", 10.3), B("far", 10.7)], [S("near", 10.0)]), { near: 0, cam: "self" });
    const b = shareSegment(rallyEnd([B("near", 10.3), B("near", 10.72, 1.2, 0.7)], [S("near", 10.0)]), { near: 0, cam: "b" });
    const r = judgeRally([a, b], { near: 0 });
    expect(r.conflict).toBe(true);
  });

  test("one camera alone gives exactly point.js's call", () => {
    const e = rallyEnd(fullRally.bounces, fullRally.shots);
    const r = judgeRally([shareSegment(e, { near: 0, cam: "self" })], { near: 0 });
    expect(r.judged.winner).toBe("far");
    expect(r.conflict).toBe(false);
    expect(r.filled).toBe(0);
  });
});

describe("Merger", () => {
  const seg = (cam, startMs, endMs) => ({ cam, startMs, endMs, why: "ball_lost", bounces: [], shots: [] });

  test("waits for a camera still in the rally, then closes it once", () => {
    const m = new Merger();
    m.status("b", { active: true, startMs: 900 }, 0);
    m.add(seg("self", 1000, 3000), 100);
    expect(m.poll(200)).toEqual([]);
    m.add(seg("b", 900, 3200), 300);
    m.status("b", { active: false }, 300);
    const ready = m.poll(310);
    expect(ready.length).toBe(1);
    expect(ready[0].length).toBe(2);
    // a late piece reaching into the closed rally is dropped, never judged again
    expect(m.add(seg("b", 2500, 3600), 400)).toBe(false);
    expect(m.poll(500)).toEqual([]);
  });

  test("an occlusion that splits one camera's rally in two still gives one rally", () => {
    const m = new Merger();
    m.add(seg("self", 1000, 2000), 0);
    m.add(seg("self", 2800, 4000), 0);
    m.add(seg("b", 1000, 4000), 0);
    expect(m.poll(10).length).toBe(1);
  });

  test("does not wait past MAX_WAIT_MS, nor for a camera that went quiet", () => {
    const m = new Merger();
    m.status("b", { active: true, startMs: 900 }, 0);
    m.add(seg("self", 1000, 3000), 0);
    m.status("b", { active: true, startMs: 900 }, 14900);
    expect(m.poll(14900)).toEqual([]);
    m.status("b", { active: true, startMs: 900 }, 15100);
    expect(m.poll(15100).length).toBe(1);
    const q = new Merger();
    q.status("b", { active: true, startMs: 900 }, 0);
    q.add(seg("self", 1000, 3000), 3500);
    expect(q.poll(3600).length).toBe(1);
  });

  test("one camera's rallies right after each other stay separate rallies, none dropped", () => {
    // rally.js ends a rally on no_bounce / no_shot while the ball is still seen; the next starts a frame later
    const m = new Merger();
    m.add(seg("self", 1000, 3000), 0);
    m.status("self", { active: true, startMs: 3017 }, 0);
    expect(m.poll(10)).toEqual([[expect.objectContaining({ startMs: 1000 })]]);
    expect(m.add(seg("self", 3017, 5000), 20)).toBe(true);
    m.status("self", { active: false }, 20);
    expect(m.poll(30).length).toBe(1);
    expect(m.dropped).toBe(0);
  });

  test("a rally starting just after the other camera's last one ended is a new rally, not a late piece", () => {
    const m = new Merger();
    m.add(seg("self", 1000, 3000), 0);
    m.add(seg("b", 1035, 3035), 0);
    expect(m.poll(10).length).toBe(1);
    // 16 ms after b's end, with b's clock 35 ms off: shares no real time with the judged rally
    expect(m.add(seg("self", 3051, 6000), 20)).toBe(true);
    expect(m.add(seg("b", 3086, 6035), 20)).toBe(true);
    const next = m.poll(30);
    expect(next.length).toBe(1);
    expect(next[0].length).toBe(2);
    expect(m.dropped).toBe(0);
  });

  test("waits for the other camera's long rally while it keeps reporting", () => {
    const m = new Merger();
    m.status("b", { active: true, startMs: 900 }, 0);
    m.add(seg("self", 1000, 3000), 0);
    m.status("b", { active: true, startMs: 900 }, 9000);
    expect(m.poll(9000)).toEqual([]);
    m.add(seg("b", 900, 9500), 9500);
    m.status("b", { active: false }, 9500);
    expect(m.poll(9510)[0].length).toBe(2);
  });

  test("a rally the other camera starts later is not waited for", () => {
    const m = new Merger();
    m.status("b", { active: true, startMs: 9000 }, 0);
    m.add(seg("self", 1000, 3000), 0);
    expect(m.poll(10).length).toBe(1);
  });
});

describe("EndSync (사람이 고른 끝 색, 바운드는 경고만)", () => {
  const flip = (x) => (x === "near" ? "far" : "near");
  // what a phone behind the red end sees of fullRally (its near / far and table x / y)
  const seenFromRed = (r, dt = 0) => rallyEnd(
    r.bounces.map((b) => B(flip(b.side), b.t + dt, 2.74 - b.tx, 1.525 - b.ty)),
    r.shots.map((s) => S(flip(s.side), s.t + dt)),
  );
  const shift = (r, dt) => ({ bounces: r.bounces.map((b) => ({ ...b, t: b.t + dt })), shots: r.shots.map((s) => ({ ...s, t: s.t + dt })) });
  const own = (dt) => shareSegment(rallyEnd(shift(fullRally, dt).bounces, shift(fullRally, dt).shots), { near: 0, cam: "self" });

  test("both picks right: no warning, and the merged rally is judged as with one camera", () => {
    const sync = new EndSync();
    expect(sync.get("b").state).toBe("ok"); // nothing to wait for before the first shared bounce
    expect(sync.pick("b", 1)).toEqual([]);
    const b = shareSegment(seenFromRed(fullRally), { near: 1, cam: "b" }); // behind the red end, picked red
    for (let k = 0; k < 4; k++) expect(sync.observe([own(k * 5), shareSegment(seenFromRed(fullRally, k * 5), { near: 1, cam: "b" })])).toEqual([]);
    expect(sync.get("b")).toMatchObject({ state: "ok", near: 1 });
    const r = judgeRally([own(0), b], { near: 0 });
    expect(r.judged.winner).toBe("far");
    expect(r.conflict).toBe(false);
  });

  test("a pick that is turned (both phones said blue from opposite ends): the shared bounces warn, the pick stays", () => {
    const sync = new EndSync();
    sync.pick("b", 0);
    const wrong = shareSegment(seenFromRed(fullRally), { near: 0, cam: "b" });
    // one rally: its three shared bounces all say the pick is turned
    expect(sync.observe([own(0), wrong])).toEqual([{ cam: "b", state: "mismatch", near: 0 }]);
    expect(sync.get("b")).toMatchObject({ state: "mismatch", near: 0 });
    // warned once; the pick is not changed by the bounces
    expect(sync.observe([own(5), shareSegment(seenFromRed(fullRally, 5), { near: 0, cam: "b" })])).toEqual([]);
    // a person picks the other colour on that phone: the warning clears and its check starts again
    expect(sync.pick("b", 1)).toEqual([{ cam: "b", state: "ok", near: 1 }]);
    expect(sync.observe([own(10), shareSegment(seenFromRed(fullRally, 10), { near: 1, cam: "b" })])).toEqual([]);
    expect(sync.get("b").state).toBe("ok");
  });

  test("two shared bounces against the pick are not yet a warning", () => {
    const sync = new EndSync();
    const a = shareSegment(rallyEnd(fullRally.bounces.slice(0, 2), fullRally.shots), { near: 0, cam: "self" });
    expect(sync.observe([a, shareSegment(seenFromRed(fullRally), { near: 0, cam: "b" })])).toEqual([]);
    expect(sync.get("b").state).toBe("ok");
  });
});

describe("점수 보류 (끝 색 반대일 때)", () => {
  const a = () => shareSegment(rallyEnd(fullRally.bounces, fullRally.shots), { near: 0, cam: "self" });
  test("no hold: one camera, or two that agree, enter; two that disagree ask", () => {
    const one = judgeRally([a()], { near: 0 });
    expect(scoreAction(one)).toEqual({ ask: false, reason: null, hold: false });
    const both = judgeRally([a(), shareSegment(rallyEnd(fullRally.bounces, fullRally.shots), { near: 0, offset: 20, cam: "b" })], { near: 0 });
    expect(both.agreed).toBe(true);
    expect(scoreAction(both).ask).toBe(false);
    const turned = judgeRally([a(), shareSegment(rallyEnd(fullRally.bounces, fullRally.shots), { near: 1, cam: "b" })], { near: 0 });
    expect(turned.agreed).toBe(false);
    expect(scoreAction(turned)).toMatchObject({ ask: true, hold: false });
  });

  test("while held every judged rally asks with the hold reason, agreed or not", () => {
    for (const r of [judgeRally([a()], { near: 0 }), { conflict: false, agreed: true }, { conflict: true }]) {
      expect(scoreAction(r, { hold: true })).toEqual({ ask: true, reason: HOLD_REASON, hold: true });
    }
  });

  test("the warning hands back the points entered since the picks changed, once; a pick ends the hold", () => {
    const h = new EndHold();
    h.for("m1");
    h.entered({ index: 0, side: 1 });
    h.picked(); // a person changed a pick: the points before were judged with other picks
    h.entered({ index: 1, side: 0 });
    h.entered({ index: 2, side: 1 });
    expect(h.warn()).toEqual([{ index: 1, side: 0 }, { index: 2, side: 1 }]);
    expect(h.on).toBe(true);
    h.entered({ index: 3, side: 0 }); // held points are asked, never listed
    expect(h.warn()).toEqual([]);
    expect(h.picked()).toBe(true);
    expect(h.on).toBe(false);
    expect(h.warn()).toEqual([]);
  });

  test("the hold belongs to one match and survives a reload", () => {
    const h = new EndHold();
    h.for("m1");
    h.warn();
    const back = new EndHold(JSON.parse(JSON.stringify(h)));
    expect(back.for("m1")).toBe(false);
    expect(back.on).toBe(true);
    expect(back.for("m2")).toBe(true);
    expect(back.on).toBe(false);
  });
});
