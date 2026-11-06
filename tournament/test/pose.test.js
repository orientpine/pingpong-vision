import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesk } from '../desk-routes.js';
import { createPlayers, refOf } from '../players-store.js';
import { createPoseStore, parsePose } from '../pose-store.js';
import { AT, averageSkeleton, comparePeriods, galleryPoseKey, metrics, parsePeriod, personSamples, tournamentPoseKey, votedHand } from '../public/pose-stats.js';

const root = mkdtempSync(join(tmpdir(), 'pp-pose-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fresh = () => mkdtempSync(join(root, 'd-'));

const NOSE = 0; const L_SHOULDER = 1; const R_SHOULDER = 2; const L_ELBOW = 3; const R_ELBOW = 4; const L_WRIST = 5; const R_WRIST = 6;
const L_HIP = 13; const R_HIP = 14; const L_KNEE = 15; const R_KNEE = 16; const L_ANKLE = 17; const R_ANKLE = 18;

// Hips centred at the origin, torso 1, y down. Right elbow 90 degrees, left arm straight, left leg
// straight, right knee bent 90 degrees, right wrist 0.5 above the hips, shoulders level with the hips.
function joints(overrides = {}) {
  const rows = Array.from({ length: 23 }, () => [0, 0, 0]);
  Object.assign(rows, {
    [NOSE]: [0, -1.4, 0],
    [L_SHOULDER]: [-0.5, -1, 0], [R_SHOULDER]: [0.5, -1, 0],
    [L_ELBOW]: [-0.5, -0.5, 0], [R_ELBOW]: [0.5, -0.5, 0],
    [L_WRIST]: [-0.5, 0, 0], [R_WRIST]: [1, -0.5, 0],
    [L_HIP]: [-0.25, 0, 0], [R_HIP]: [0.25, 0, 0],
    [L_KNEE]: [-0.25, 1, 0], [R_KNEE]: [0.25, 1, 0],
    [L_ANKLE]: [-0.25, 2, 0], [R_ANKLE]: [1.25, 1, 0],
    ...overrides,
  });
  return rows;
}
const frame2d = (rows = joints(), v = 0.9) => rows.map(([x, y]) => [x, y, v]);
const frame3d = (rows = joints(), v = 0.9) => rows.map(([x, y, z]) => [x, y, z, v]);
const moved = (frame, { scale = 1, dx = 0, dy = 0 }) => frame.map(([x, y, ...rest]) => [x * scale + dx, y * scale + dy, ...rest]);
const turned = (frame, deg) => {
  const [c, s] = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
  return frame.map(([x, y, z, v]) => [x * c + z * s, y, z * c - x * s, v]);
};
const expectSameJoints = (actual, expected) => actual.joints.forEach((joint, i) => joint.forEach((v, axis) => expect(v).toBeCloseTo(expected.joints[i][axis], 9)));

const sample = (overrides = {}) => ({
  date: '2026-09-10', tech: 'fore-attack', side: 'near', hand: 'R',
  frames2d: [frame2d(), frame2d(), frame2d()], frames3d: [frame3d(), frame3d(), frame3d()], ...overrides,
});
const times = (n, overrides) => Array.from({ length: n }, () => sample(overrides));
const SEPT = { from: '2026-09-01', to: '2026-09-30' };
const OCT = { from: '2026-10-01', to: '2026-10-31' };

describe('averageSkeleton', () => {
  test('a scaled and shifted body gives the same average, in 2D and 3D', () => {
    expectSameJoints(averageSkeleton([moved(frame2d(), { scale: 3.5, dx: 400, dy: 120 })]), averageSkeleton([frame2d()]));
    expectSameJoints(averageSkeleton([moved(frame3d(), { scale: 0.4, dx: 2, dy: -1 })]), averageSkeleton([frame3d()]));
  });

  test('bodies of different size and place average as one body', () => {
    const big = moved(frame2d(), { scale: 200, dx: 900 });
    expectSameJoints(averageSkeleton([frame2d(), big]), averageSkeleton([frame2d()]));
  });

  test('a 3D body facing another way averages as the same body', () => {
    expectSameJoints(averageSkeleton([turned(frame3d(), 180), turned(frame3d(), 70)]), averageSkeleton([frame3d()]));
  });

  test('null frames are not counted', () => {
    const avg = averageSkeleton([null, frame2d(), null]);
    expect(avg.n).toBe(1);
    expectSameJoints(avg, averageSkeleton([frame2d()]));
  });

  test('a joint below visibility 0.5 stays out of that joint only', () => {
    const blurred = frame2d(joints({ [R_WRIST]: [9, 9, 0] }));
    blurred[R_WRIST][2] = 0.49;
    const avg = averageSkeleton([frame2d(), blurred]);
    expect([avg.n, avg.counts[R_WRIST], avg.counts[NOSE]]).toEqual([2, 1, 2]);
    expect(avg.joints[R_WRIST][0]).toBeCloseTo(1, 9);
  });

  test('visibility of exactly 0.5 counts', () => {
    const edge = frame2d();
    edge[R_WRIST][2] = 0.5;
    expect(averageSkeleton([edge]).counts[R_WRIST]).toBe(1);
  });

  test('a joint never seen is null', () => {
    const unseen = frame2d();
    unseen[NOSE][2] = 0;
    expect(averageSkeleton([unseen]).joints[NOSE]).toBeNull();
  });

  test('a frame without a measurable torso is left out', () => {
    const hidden = frame2d();
    hidden[L_HIP][2] = 0.1;
    const flat = frame2d().map(([, , v]) => [0, 0, v]);
    expect(averageSkeleton([hidden, flat]).n).toBe(0);
  });

  test('no frames give no joints', () => {
    expect(averageSkeleton([])).toEqual({ n: 0, joints: [], counts: [] });
  });
});

describe('metrics', () => {
  test('a hand-built right-hander reads its known numbers', () => {
    const m = metrics({ joints: joints().map(([x, y]) => [x, y]) });
    expect(m.elbowDeg).toBeCloseTo(90, 9);
    expect(m.kneeBendDeg).toBeCloseTo(45, 9);
    expect(m.trunkRotationDeg).toBeCloseTo(0, 9);
    expect(m.handHeight).toBeCloseTo(0.5, 9);
  });

  test('a left-hander reads the left arm', () => {
    const m = metrics({ joints: joints() }, 'L');
    expect(m.elbowDeg).toBeCloseTo(180, 9);
    expect(m.handHeight).toBeCloseTo(0, 9);
  });

  test('trunk rotation is the angle between shoulder and hip lines in 3D', () => {
    const [c, s] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
    const rows = joints({ [L_SHOULDER]: [-0.5 * c, -1, 0.5 * s], [R_SHOULDER]: [0.5 * c, -1, -0.5 * s] });
    expect(metrics({ joints: rows }).trunkRotationDeg).toBeCloseTo(30, 9);
  });

  test('the same rotation survives the 3D squaring of an averaged body turned any way', () => {
    const [c, s] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
    const rows = joints({ [L_SHOULDER]: [-0.5 * c, -1, 0.5 * s], [R_SHOULDER]: [0.5 * c, -1, -0.5 * s] });
    expect(metrics(averageSkeleton([turned(frame3d(rows), 123)])).trunkRotationDeg).toBeCloseTo(30, 9);
  });

  test('missing joints leave only their numbers null', () => {
    const rows = joints();
    rows[R_ELBOW] = null;
    rows[L_KNEE] = null;
    const m = metrics({ joints: rows });
    expect(m.elbowDeg).toBeNull();
    expect(m.kneeBendDeg).toBeCloseTo(90, 9);
    expect(m.trunkRotationDeg).toBeCloseTo(0, 9);
  });
});

describe('comparePeriods', () => {
  const straighter = joints({ [R_WRIST]: [0.5, 0, 0] });
  const october = (n) => times(n, { date: '2026-10-05', frames2d: Array(3).fill(frame2d(straighter)), frames3d: Array(3).fill(frame3d(straighter)) });

  test('five shots a period give the differences, B minus A, per reference time', () => {
    const r = comparePeriods([...times(5), ...october(6)], 'fore-attack', SEPT, OCT);
    expect([r.a.n, r.b.n, r.reason]).toEqual([5, 6, null]);
    expect(r.diffs.d2).toHaveLength(AT.length);
    expect(r.diffs.d2[2].elbowDeg).toBeCloseTo(90, 9);
    expect(r.diffs.d3[0].handHeight).toBeCloseTo(-0.5, 9);
  });

  test('below five in either period it refuses with a reason, still showing n', () => {
    const r = comparePeriods([...times(4), ...october(9)], 'fore-attack', SEPT, OCT);
    expect(r.diffs).toBeNull();
    expect([r.a.n, r.b.n]).toEqual([4, 9]);
    expect(typeof r.reason).toBe('string');
  });

  test('shots with no frame at the hit do not count toward n', () => {
    const blind = times(5, { frames2d: [frame2d(), frame2d(), null] });
    expect(comparePeriods([...blind, ...october(5)], 'fore-attack', SEPT, OCT).a.n).toBe(0);
  });

  test('another technique and dates outside the periods stay out', () => {
    const r = comparePeriods([...times(5), ...times(5, { tech: 'back-attack' }), ...times(5, { date: '2026-08-31' }), ...times(5, { date: null })], 'fore-attack', SEPT, OCT);
    expect([r.a.n, r.b.n]).toEqual([5, 0]);
  });

  test('a period holds both of its end dates', () => {
    const ends = [...times(3, { date: SEPT.from }), ...times(2, { date: SEPT.to })];
    expect(comparePeriods(ends, 'fore-attack', SEPT, OCT).a.n).toBe(5);
  });

  test('the far end is mirrored, so one body seen from both ends averages as one', () => {
    const fromFar = frame2d().map(([x, y, v]) => [-x, y, v]);
    const far = times(1, { side: 'far', frames2d: [fromFar, fromFar, fromFar] });
    const r = comparePeriods([...times(1), ...far], 'fore-attack', SEPT, OCT);
    expectSameJoints(r.a.skeletons.d2[2], averageSkeleton([frame2d()]));
  });

  test('a joint seen in fewer than five shots gives no number, the others stay', () => {
    const blurred = frame2d();
    blurred[R_ELBOW][2] = 0.1;
    const shots = [...times(1), ...times(5, { frames2d: Array(3).fill(blurred) }), ...october(5)];
    const r = comparePeriods(shots, 'fore-attack', SEPT, OCT);
    expect(r.a.metrics.d2[2].elbowDeg).toBeNull();
    expect(r.diffs.d2[2].elbowDeg).toBeNull();
    expect(r.diffs.d2[2].kneeBendDeg).toBeCloseTo(0, 9);
  });

  test('an unknown racket hand leaves the arm numbers out instead of measuring the right arm', () => {
    const r = comparePeriods(times(5, { hand: null }), 'fore-attack', SEPT, OCT);
    expect(r.a.hand).toBeNull();
    expect([r.a.metrics.d2[2].elbowDeg, r.a.metrics.d2[2].handHeight]).toEqual([null, null]);
    expect(r.a.metrics.d2[2].kneeBendDeg).not.toBeNull();
  });

  test('a left-hander is measured on the left arm', () => {
    const r = comparePeriods(times(5, { hand: 'L' }), 'fore-attack', SEPT, OCT);
    expect(r.a.hand).toBe('L');
    expect(r.a.metrics.d2[2].elbowDeg).toBeCloseTo(180, 9);
  });

  test('point clips with no hand of their own take the hand from five or more votes over all the person\'s shots', () => {
    // three votes on this technique and two on another: five over the person, so left-handed
    const person = [...times(3, { hand: null, vote: 'L' }), ...times(2, { hand: null, vote: 'L', tech: 'back-attack' })];
    expect(comparePeriods(person, 'fore-attack', SEPT, OCT).a.hand).toBe('L');
    // and the arm numbers are then measured on that arm (five shots, so every joint is trusted)
    expect(comparePeriods(times(5, { hand: null, vote: 'L' }), 'fore-attack', SEPT, OCT).a.metrics.d2[2].elbowDeg).toBeCloseTo(180, 9);
  });

  test('under five votes, a tie, or shots from before votes leave the hand unknown', () => {
    expect(comparePeriods(times(4, { hand: null, vote: 'R' }), 'fore-attack', SEPT, OCT).a.hand).toBeNull();
    const tie = [...times(3, { hand: null, vote: 'R' }), ...times(3, { hand: null, vote: 'L' })];
    expect(comparePeriods(tie, 'fore-attack', SEPT, OCT).a.hand).toBeNull();
    expect(comparePeriods(times(6, { hand: null }), 'fore-attack', SEPT, OCT).a.hand).toBeNull();
    expect(votedHand(times(6, { hand: null, vote: null }))).toBeNull();
  });

  test('a hand the desk decided wins over the votes', () => {
    const person = [...times(5, { hand: 'R', vote: 'L' })];
    expect(comparePeriods(person, 'fore-attack', SEPT, OCT).a.hand).toBe('R');
  });
});

describe('parsePeriod', () => {
  test('reads a month and a date range, and refuses anything else', () => {
    expect(parsePeriod('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-31' });
    expect(parsePeriod('2026-09-01..2026-09-30')).toEqual(SEPT);
    for (const bad of [null, '', '2026-13', '2026-09-30..2026-09-01', '2026-09-01']) expect(parsePeriod(bad)).toBeNull();
  });
});

const shotPose = (frames2d = [null, null, frame2d()], frames3d = [null, null, frame3d()], hand = 'R') => ({
  pose2d: { model: 'mediapipe-full', at: AT, hand, frames: frames2d },
  pose3d: { frames: frames3d },
});
const SHOT = { side: 'near', t: 1, stroke: '포핸드', kind: '드라이브' };
const deskRally = (index, shots = [SHOT]) => ({ v: 1, index, source: 'desk', startedAt: 1000, durationMs: 1000, winner: 'near', nearSlot: 0, why: null, shots, bounces: [] });

describe('parsePose', () => {
  const rallies = [deskRally(0, [SHOT, { ...SHOT, side: 'far' }])];
  const bad = (pose) => expect(() => parsePose(pose, rallies)).toThrow();

  test('no pose is null, and a good one keeps only its fields', () => {
    expect(parsePose(undefined, rallies)).toBeNull();
    expect(parsePose({ 0: { 1: { ...shotPose(), extra: 1 } } }, rallies)).toEqual({ 0: { 1: shotPose() } });
  });

  test('a shot\'s racket-hand vote is kept; a pose from before votes reads unchanged; a bad vote is refused', () => {
    const voted = (vote) => ({ ...shotPose(), pose2d: { ...shotPose().pose2d, vote } });
    expect(parsePose({ 0: { 0: voted('L') } }, rallies)[0][0].pose2d.vote).toBe('L');
    expect(parsePose({ 0: { 0: voted(null) } }, rallies)[0][0].pose2d.vote).toBeNull();
    expect('vote' in parsePose({ 0: { 0: shotPose() } }, rallies)[0][0].pose2d).toBe(false);
    bad({ 0: { 0: voted('X') } });
    bad({ 0: { 0: voted(1) } });
  });

  test('refuses a rally or shot the result does not hold', () => {
    bad({ 1: { 0: shotPose() } });
    bad({ 0: { 2: shotPose() } });
    bad({ 0: { x: shotPose() } });
  });

  test('refuses malformed frames', () => {
    bad({ 0: { 0: shotPose([null, null]) } });
    bad({ 0: { 0: shotPose([null, null, frame2d().slice(1)]) } });
    bad({ 0: { 0: shotPose([null, null, frame3d()]) } });
    bad({ 0: { 0: shotPose([null, null, frame2d(joints({ [NOSE]: [NaN, 0, 0] }))]) } });
    bad({ 0: { 0: shotPose(undefined, [null, null, frame2d()]) } });
    bad({ 0: { 0: shotPose(undefined, undefined, 'X') } });
    bad({ 0: [] });
  });
});

describe('pose store', () => {
  const storeOver = (dir, clock = 5) => {
    const logged = [];
    return { store: createPoseStore({ dataDir: dir, now: () => clock, log: (m) => logged.push(m) }), logged };
  };
  const poseDir = (dir) => join(dir, 'analysis', 'pose');

  test('saves outside the match files and merges by rally', () => {
    const dir = fresh();
    const { store } = storeOver(dir);
    store.save('g-1', { 0: { 0: 'a' } });
    store.save('g-1', { 2: { 0: 'b' } });
    expect(store.read('g-1')).toEqual({ 0: { 0: 'a' }, 2: { 0: 'b' } });
    expect(readdirSync(join(dir, 'analysis'))).toEqual(['pose']);
    expect(readdirSync(poseDir(dir))).toEqual(['g-1.json']);
  });

  test('a write that fails leaves the old file whole', () => {
    const dir = fresh();
    const { store } = storeOver(dir);
    store.save('g-1', { 0: { 0: 'a' } });
    const before = readFileSync(join(poseDir(dir), 'g-1.json'), 'utf8');
    mkdirSync(join(poseDir(dir), 'g-1.json.tmp'));
    expect(() => store.save('g-1', { 1: { 0: 'b' } })).toThrow();
    expect(readFileSync(join(poseDir(dir), 'g-1.json'), 'utf8')).toBe(before);
  });

  test('a missing file reads as null without a log', () => {
    const { store, logged } = storeOver(fresh());
    expect(store.read('g-1')).toBeNull();
    expect(logged).toEqual([]);
  });

  test.each([['{broken'], ['{"v":2,"rallies":{}}'], ['{"v":1,"rallies":[]}'], ['null']])('a malformed file %s reads as null and is kept aside on the next write', (text) => {
    const dir = fresh();
    const { store, logged } = storeOver(dir);
    mkdirSync(poseDir(dir), { recursive: true });
    writeFileSync(join(poseDir(dir), 'g-1.json'), text);
    expect(store.read('g-1')).toBeNull();
    expect(logged).toHaveLength(1);
    store.save('g-1', { 0: { 0: 'a' } });
    expect(store.read('g-1')).toEqual({ 0: { 0: 'a' } });
    expect(readFileSync(join(poseDir(dir), 'g-1.json.bad-5'), 'utf8')).toBe(text);
  });

  test('a tournament key stays inside the folder', () => {
    expect(tournamentPoseKey('2026-10-31T01:02:03.000Z', '../../x')).toBe('t-20261031010203000-..%2F..%2Fx'.replaceAll('..', '%2E%2E'));
    expect(tournamentPoseKey('no date', 'm1')).toBeNull();
    expect(galleryPoseKey('abc')).toBe('g-abc');
  });
});

describe('personSamples', () => {
  const doc = (overrides = {}) => ({ id: 'abc', playedAt: '2026-09-10', players: { near: '홍길동,0712', far: '김하나,4821' }, rallies: [deskRally(0, [SHOT, { ...SHOT, side: 'far', kind: '서브' }])], ...overrides });
  const empty = { tournaments: [], gallery: [], aliases: {}, ralliesOf: () => [], poseOf: () => null };
  const poseOf = () => ({ 0: { 0: shotPose(), 1: shotPose() } });

  test('a gallery match gives each person their own shots with technique, date and end', () => {
    const shots = personSamples('김하나,4821', { ...empty, gallery: [doc()], poseOf });
    expect(shots.map(({ date, tech, side }) => [date, tech, side])).toEqual([['2026-09-10', 'fore-serve', 'far']]);
  });

  test('a tournament match reads its pose by match key and an alias reaches the merged person', () => {
    const entry = {
      archivedAt: null,
      tournament: { createdAt: '2026-10-31T01:02:03.000Z', players: ['홍길동', '김하나'], codes: ['0712', '4821'] },
      derived: { matches: [{ id: 'm1', players: [0, 1], score: { won: [1, 0] }, points: [{}] }] },
    };
    const asked = [];
    const shots = personSamples('새이름,0712', {
      ...empty,
      tournaments: [entry],
      aliases: { '홍길동,0712': '새이름,0712' },
      ralliesOf: () => [{ ...deskRally(0), startedAt: Date.parse('2026-10-31T01:02:03.000Z') }],
      poseOf: (key) => { asked.push(key); return { 0: { 0: shotPose() } }; },
    });
    expect(asked).toEqual(['t-20261031010203000-m1']);
    expect(shots.map((s) => s.date)).toEqual(['2026-10-31']);
  });

  test('a shot without pose, a live rally and an unclassified shot give no sample', () => {
    const unclassified = { ...SHOT, stroke: null };
    const live = { ...deskRally(1), source: 'live' };
    const shots = personSamples('홍길동,0712', { ...empty, gallery: [doc({ rallies: [deskRally(0, [SHOT, unclassified, SHOT]), live] })], poseOf: () => ({ 0: { 0: shotPose(), 1: shotPose() }, 1: { 0: shotPose() } }) });
    expect(shots).toHaveLength(1);
  });
});

describe('desk result and public read', () => {
  const PIN = '1234';
  const NEAR = '홍길동,0712';
  const posedShots = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [i, shotPose([frame2d(), frame2d(), frame2d()], [frame3d(), frame3d(), frame3d()])]));

  async function setup({ playedAt = '2026-09-10', pose = { 0: posedShots } } = {}) {
    const dir = fresh();
    const desk = createDesk({ dataDir: dir, checkPin: (_r, pin) => (pin === PIN ? { ok: true } : { ok: false, status: 401, error: 'PIN' }), isLocal: () => true, saveDeskRally: () => {}, log: () => {} });
    const players = createPlayers({ dataDir: dir, checkPin: () => ({ ok: true }), tournaments: () => [], ralliesOf: () => [], galleryDocs: desk.galleryDocs, poseOf: desk.poseOf, log: () => {} });
    const call = async (method, path, body, headers = { 'x-pin': PIN }) => {
      const req = new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) });
      return desk.handle(req, new URL(req.url));
    };
    const { job } = await (await call('POST', '/api/desk/jobs', { kind: 'gallery', title: '연습', playedAt, players: { near: NEAR, far: '김하나,4821' }, video: { name: 'a.mp4', bytes: 1 } })).json();
    await call('PUT', `/api/desk/jobs/${job.id}/video?offset=0`, new Uint8Array(1));
    const token = { 'x-desk-worker': readFileSync(join(dir, 'desk', 'worker-token'), 'utf8').trim() };
    await call('POST', '/api/desk/worker/claim', {}, token);
    const result = await call('POST', `/api/desk/worker/jobs/${job.id}/result`, { rallies: [deskRally(0, Array(6).fill(SHOT))], pose }, token);
    const read = (query) => {
      const req = new Request(`http://x/api/analysis/person/${refOf(NEAR)}/pose?${query}`);
      return players.handle(req, new URL(req.url));
    };
    return { dir, job, result, read, close: desk.close };
  }

  test('a result with pose lands in its own file and the public read compares it, names only', async () => {
    const s = await setup();
    expect(s.result.status).toBe(200);
    expect(existsSync(join(s.dir, 'analysis', 'pose', `g-${s.job.id}.json`))).toBe(true);
    expect(readFileSync(join(s.dir, 'analysis', `g-${s.job.id}.json`), 'utf8')).not.toContain('pose2d');
    const res = await s.read('tech=fore-attack&a=2026-09&b=2026-09-01..2026-09-30');
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.person).toEqual({ ref: refOf(NEAR), name: '홍길동' });
    expect([body.a.n, body.b.n, body.depthEstimated]).toEqual([6, 6, true]);
    expect(body.diffs.d3[2].elbowDeg).toBeCloseTo(0, 9);
    expect(text).not.toContain('0712');
    s.close();
  });

  test('a malformed pose refuses the whole result and writes nothing', async () => {
    const s = await setup({ pose: { 9: posedShots } });
    expect(s.result.status).toBe(400);
    expect(existsSync(join(s.dir, 'analysis'))).toBe(false);
    s.close();
  });

  test('a result without pose still lands, and the read answers n 0 with a reason', async () => {
    const s = await setup({ pose: null });
    expect(s.result.status).toBe(200);
    const body = await (await s.read('tech=fore-attack&a=2026-09&b=2026-10')).json();
    expect([body.a.n, body.diffs]).toEqual([0, null]);
    s.close();
  });

  test('a bad technique or period is 400, an unknown person 404', async () => {
    const s = await setup();
    expect((await s.read('tech=nope&a=2026-09&b=2026-10')).status).toBe(400);
    expect((await s.read('tech=fore-attack&a=x&b=2026-10')).status).toBe(400);
    expect((await s.read('tech=fore-attack&b=2026-10')).status).toBe(400);
    s.close();
    const dir = fresh();
    const players = createPlayers({ dataDir: dir, checkPin: () => ({ ok: true }), tournaments: () => [], ralliesOf: () => [], galleryDocs: () => [], log: () => {} });
    const req = new Request(`http://x/api/analysis/person/${'0'.repeat(16)}/pose?tech=fore-attack&a=2026-09&b=2026-10`);
    expect((await players.handle(req, new URL(req.url))).status).toBe(404);
  });
});
