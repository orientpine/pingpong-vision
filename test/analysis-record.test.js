import { afterEach, expect, test } from "bun:test";
import { RallyShots, rallyRecord } from "../public/js/analysis-record.js";
import { TournamentLink } from "../public/js/tournament.js";

// Rally events in the shape rally.js sends them: a shot object is pushed once and filled in later.
function rally(shots, bounces) {
  const c = new RallyShots();
  c.onEvent({ type: "rallyStart", t: 0 });
  shots.forEach((shot) => c.onEvent({ type: "shot", t: shot.t, shot }));
  return { c, end: { type: "rallyEnd", why: "out", durationS: 2.5, bounces } };
}

test("draft keeps the speed and kind a shotUpdate filled in after the shot event", () => {
  const serve = { side: "near", t: 0.1, stroke: "포핸드", kind: "서브", speedKmh: null, arc: 0 };
  const { c, end } = rally([serve], []);
  serve.speedKmh = 31;
  serve.arc = 0.12;
  c.onEvent({ type: "shotUpdate", t: 0.4, shot: serve });
  const [s] = c.draft(end, 1).shots;
  expect([s.stroke, s.kind, s.speedKmh, s.arc]).toEqual(["포핸드", "서브", 31, 0.12]);
});

test("land is the first receiver-side bounce before the next hit", () => {
  const shots = [
    { side: "near", t: 0.1, kind: "서브" },
    { side: "far", t: 1.0, kind: "푸시" },
  ];
  const bounces = [
    { tx: 0.5, ty: 0.7, side: "near", t: 0.2 },
    { tx: 2.2, ty: 0.3, side: "far", t: 0.5 },
    { tx: 0.4, ty: 1.1, side: "near", t: 1.3 },
  ];
  const { c, end } = rally(shots, bounces);
  expect(c.draft(end, 0).shots.map((s) => s.land)).toEqual([{ tx: 2.2, ty: 0.3 }, { tx: 0.4, ty: 1.1 }]);
});

test("land is null when the receiver-side bounce comes only after the return", () => {
  const shots = [
    { side: "near", t: 0.1 },
    { side: "far", t: 0.8 },
  ];
  const { c, end } = rally(shots, [{ tx: 2.0, ty: 0.5, side: "far", t: 0.9 }]);
  expect(c.draft(end, 0).shots[0].land).toBeNull();
});

test("land is null when the bounce has no table position (uncalibrated)", () => {
  const { c, end } = rally([{ side: "near", t: 0.1 }], [{ tx: null, ty: null, side: "far", t: 0.4 }]);
  expect(c.draft(end, 0).shots[0].land).toBeNull();
});

test("an inferred shot sent after a later shot is placed in time order", () => {
  const late = { side: "near", t: 1.2 };
  const inferred = { side: "far", t: 0.7, inferred: true };
  const { c, end } = rally([late, inferred], []);
  expect(c.draft(end, 0).shots.map((s) => [s.t, s.inferred])).toEqual([[0.7, true], [1.2, false]]);
});

test("rallyStart drops the previous rally's shots", () => {
  const { c, end } = rally([{ side: "near", t: 0.1 }], []);
  c.onEvent({ type: "rallyStart", t: 3 });
  expect(c.draft(end, 0).shots).toEqual([]);
});

test("the record's winner is the end of the slot the tournament entered", () => {
  const { c, end } = rally([{ side: "near", t: 0.1 }], []);
  const draft = c.draft(end, 1);
  expect(rallyRecord(draft, { matchId: "m1", index: 4, side: 1 })).toMatchObject({ v: 1, index: 4, source: "live", nearSlot: 1, winner: "near", durationMs: 2500 });
  expect(rallyRecord(draft, { matchId: "m1", index: 4, side: 0 }).winner).toBe("far");
});

// postAnalysis against a stand-in fetch: what goes on the wire, and that a failure stays quiet.
const realFetch = globalThis.fetch;
const realWarn = console.warn;
afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
});
const link = () => new TournamentLink({ get: (k, d) => (k === "tourPin" ? "1234" : d), set: () => {} });
const point = { matchId: "m1", index: 2, side: 0, cancelled: false };
const record = { v: 1, index: 2, shots: [] };

test("postAnalysis sends the rally with the tournament PIN", async () => {
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    sent.push({ url, pin: opts.headers["x-pin"], body: JSON.parse(opts.body) });
    return new Response("{}");
  };
  await link().postAnalysis(point, record);
  expect(sent).toEqual([{ url: "/api/analysis/rally", pin: "1234", body: { matchId: "m1", index: 2, rally: record } }]);
});

test("postAnalysis resolves and only logs when the server refuses or the network is down", async () => {
  const warned = [];
  console.warn = (...a) => warned.push(a[0]);
  globalThis.fetch = async () => new Response("{}", { status: 404 });
  await link().postAnalysis(point, record);
  globalThis.fetch = async () => {
    throw new TypeError("network");
  };
  await link().postAnalysis(point, record);
  expect(warned).toEqual(["ppv: analysis write refused", "ppv: analysis write failed"]);
});

test("postAnalysis sends nothing for a cancelled point", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("{}");
  };
  await link().postAnalysis({ ...point, cancelled: true }, record);
  expect(calls).toBe(0);
});

// deskFromSave: the save id, point, camera end and corners go to the tournament PC's desk with the PIN;
// a lost request is tried again after each wait, a refusal is not, and either ends in one log line.
const SAVE = "s".repeat(43);
const corners = [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }, { x: 7, y: 8 }];
const deskLink = () => {
  const l = link();
  l.apply({ tournament: { createdAt: "2026-10-30T00:00:00.000Z", players: [] }, derived: { matches: [] } });
  l.setNear(1);
  return l;
};

test("deskFromSave sends the save id, the point, the camera's end and the corners with the PIN", async () => {
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    sent.push({ url, pin: opts.headers["x-pin"], body: JSON.parse(opts.body) });
    return Response.json({ job: { id: "j1" } }, { status: 201 });
  };
  expect(await deskLink().deskFromSave(point, SAVE, corners.map((c) => ({ ...c, extra: 1 })), [0, 0])).toEqual({ id: "j1" });
  expect(sent).toEqual([{ url: "/api/desk/jobs/from-save", pin: "1234", body: { save: SAVE, matchRef: { tournament: "2026-10-30T00:00:00.000Z", matchId: "m1", index: 2 }, nearEnd: "red", corners } }]);
});

test("deskFromSave tries again after a lost request or a server error, not after a refusal", async () => {
  const warned = [];
  console.warn = (...a) => warned.push(a[0]);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError("network");
    if (calls === 2) return new Response("{}", { status: 503 });
    return Response.json({ job: { id: "j2" } });
  };
  expect(await deskLink().deskFromSave(point, SAVE, null, [0, 0])).toEqual({ id: "j2" });
  expect(calls).toBe(3);
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("{}", { status: 404 });
  };
  expect(await deskLink().deskFromSave(point, SAVE, null, [0, 0])).toBe(null);
  expect(calls).toBe(1);
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new TypeError("network");
  };
  expect(await deskLink().deskFromSave(point, SAVE, null, [0, 0])).toBe(null);
  expect(calls).toBe(3);
  expect(warned).toEqual(["ppv: desk hand-off refused", "ppv: desk hand-off failed"]);
});

test("deskFromSave sends nothing for a cancelled point or before the tournament is known", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ job: {} });
  };
  await deskLink().deskFromSave({ ...point, cancelled: true }, SAVE, null, [0, 0]);
  await link().deskFromSave(point, SAVE, null, [0, 0]);
  expect(calls).toBe(0);
});
