import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesk } from '../desk-routes.js';
import { LEASE_ERROR, LEASE_MS, RESTART_ERROR } from '../desk-queue.js';
import { addPoint, createTournament } from '../public/engine.js';
import { tournamentPoseKey } from '../public/pose-stats.js';

const ROOT = join(import.meta.dir, '..');
const PIN = '1234';
const root = mkdtempSync(join(tmpdir(), 'pp-desk-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fresh = () => mkdtempSync(join(root, 'd-'));

const rally = (index, winner) => ({
  v: 1, index, source: 'desk', startedAt: 1000, durationMs: 1000, winner, nearSlot: 0, why: null, shots: [{ side: 'near', t: 0, stroke: '포핸드', kind: '서브' }], bounces: [],
});
const newJob = (extra = {}) => ({
  kind: 'gallery', title: '연습 경기', playedAt: '2026-10-30', players: { near: '홍길동,0712', far: '김하나 4821' }, video: { name: 'a.mp4', bytes: 10, type: 'video/mp4' }, ...extra,
});

// A desk over dataDir with a hand-moved clock, a fixed PIN and a switchable loopback answer.
function makeDesk(dataDir, opts = {}) {
  const clock = opts.clock ?? { t: 1_000_000 };
  const local = opts.local ?? { ok: true };
  const logged = [];
  const saved = [];
  const desk = createDesk({
    dataDir,
    checkPin: (_req, pin) => (pin === PIN ? { ok: true } : { ok: false, status: 401, error: 'PIN' }),
    isLocal: () => local.ok,
    saveDeskRally: (t, matchId, r) => saved.push({ t, matchId, r }),
    tournamentOf: opts.tournamentOf,
    // never the real saves folder
    saveDir: opts.saveDir ?? join(dataDir, 'no-saves'),
    now: () => clock.t,
    log: (m) => logged.push(m),
  });
  const call = async (method, path, { body, headers = {} } = {}) => {
    const init = { method, headers: { 'x-pin': PIN, ...headers } };
    if (body !== undefined) init.body = body instanceof Uint8Array || typeof body === 'string' ? body : JSON.stringify(body);
    const req = new Request('http://x' + path, init);
    const res = await desk.handle(req, new URL(req.url));
    const text = res && method !== 'HEAD' ? await res.text() : '';
    return { status: res?.status, body: text ? JSON.parse(text) : null, headers: res?.headers };
  };
  const token = readFileSync(join(dataDir, 'desk', 'worker-token'), 'utf8').trim();
  const worker = (method, path, body) => call(method, '/api/desk/worker' + path, { body, headers: { 'x-pin': '', 'x-desk-worker': token } });
  const upload = async (extra) => {
    const { body } = await call('POST', '/api/desk/jobs', { body: newJob(extra) });
    await call('PUT', `/api/desk/jobs/${body.job.id}/video?offset=0`, { body: new Uint8Array(body.job.video.bytes).fill(7) });
    return body.job.id;
  };
  return { desk, call, worker, upload, clock, local, logged, saved, token };
}

describe('upload', () => {
  test('chunks append at the received offset, a wrong offset is 409, and a reopened desk resumes', async () => {
    const dir = fresh();
    const a = makeDesk(dir);
    const { body } = await a.call('POST', '/api/desk/jobs', { body: newJob() });
    const id = body.job.id;
    expect(body.job.state).toBe('uploading');
    expect((await a.call('PUT', `/api/desk/jobs/${id}/video?offset=0`, { body: new Uint8Array([1, 2, 3, 4]) })).body).toEqual({ received: 4 });
    expect((await a.call('PUT', `/api/desk/jobs/${id}/video?offset=0`, { body: new Uint8Array([9]) })).status).toBe(409);
    expect((await a.call('HEAD', `/api/desk/jobs/${id}`)).headers.get('x-received')).toBe('4');
    a.desk.close();

    const b = makeDesk(dir);
    expect((await b.call('GET', `/api/desk/jobs/${id}`)).body.job.video.received).toBe(4);
    expect((await b.call('PUT', `/api/desk/jobs/${id}/video?offset=4`, { body: new Uint8Array([5, 6, 7, 8, 9, 10]) })).body).toEqual({ received: 10 });
    expect((await b.call('GET', `/api/desk/jobs/${id}`)).body.job.state).toBe('queued');
    expect([...readFileSync(join(dir, 'desk', 'videos', `${id}.mp4`))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    b.desk.close();
  });

  test('a restart trusts only the bytes on disk', async () => {
    const dir = fresh();
    const a = makeDesk(dir);
    const id = (await a.call('POST', '/api/desk/jobs', { body: newJob() })).body.job.id;
    await a.call('PUT', `/api/desk/jobs/${id}/video?offset=0`, { body: new Uint8Array([1, 2, 3, 4]) });
    a.desk.close();
    writeFileSync(join(dir, 'desk', 'videos', `${id}.mp4`), new Uint8Array([1, 2]));
    const b = makeDesk(dir);
    expect((await b.call('GET', `/api/desk/jobs/${id}`)).body.job.video.received).toBe(2);
    b.desk.close();
  });

  test('size caps answer 413, malformed 400, unknown 404, no PIN 401', async () => {
    const d = makeDesk(fresh());
    expect((await d.call('POST', '/api/desk/jobs', { body: newJob({ video: { name: 'a.mp4', bytes: 4 * 1024 ** 3 + 1 } }) })).status).toBe(413);
    expect((await d.call('POST', '/api/desk/jobs', { body: newJob({ video: { name: 'a.mp4', bytes: 4 * 1024 ** 3 } }) })).status).toBe(200);
    const id = (await d.call('POST', '/api/desk/jobs', { body: newJob({ video: { name: 'a.mp4', bytes: 9 * 1024 ** 2 } }) })).body.job.id;
    expect((await d.call('PUT', `/api/desk/jobs/${id}/video?offset=0`, { body: new Uint8Array(8 * 1024 ** 2 + 1) })).status).toBe(413);
    expect((await d.call('PUT', `/api/desk/jobs/${id}/video`, { body: new Uint8Array(1) })).status).toBe(400);
    expect((await d.call('POST', '/api/desk/jobs', { body: '{' })).status).toBe(400);
    expect((await d.call('POST', '/api/desk/jobs', { body: newJob({ players: { near: '홍길동', far: null } }) })).status).toBe(400);
    expect((await d.call('GET', '/api/desk/jobs/nosuchjob1')).status).toBe(404);
    expect((await d.call('GET', '/api/desk/jobs', { headers: { 'x-pin': '0000' } })).status).toBe(401);
    d.desk.close();
  });

  test('DELETE removes the job and its file', async () => {
    const dir = fresh();
    const d = makeDesk(dir);
    const id = await d.upload();
    expect((await d.call('DELETE', `/api/desk/jobs/${id}`)).status).toBe(200);
    expect(readdirSync(join(dir, 'desk', 'videos'))).toEqual([]);
    expect((await d.call('GET', '/api/desk/jobs')).body.jobs).toEqual([]);
    d.desk.close();
  });
});

describe('worker', () => {
  test('claim leases the oldest queued job, progress renews, an expired lease requeues', async () => {
    const d = makeDesk(fresh());
    const first = await d.upload();
    d.clock.t += 1;
    await d.upload();
    const claimed = (await d.worker('POST', '/claim', { worker: 'gpu1' })).body.job;
    expect([claimed.id, claimed.state, claimed.lease]).toEqual([first, 'waiting', { worker: 'gpu1', until: d.clock.t + LEASE_MS }]);
    expect((await d.worker('POST', '/claim')).status).toBe(200);
    expect((await d.worker('POST', '/claim')).status).toBe(204);

    d.clock.t += 60_000;
    const beat = await d.worker('POST', `/jobs/${first}/progress`, { state: 'waiting', progress: null, waitPos: 2 });
    expect([beat.body.job.waitPos, beat.body.job.lease.until]).toEqual([2, d.clock.t + LEASE_MS]);
    d.clock.t += LEASE_MS - 1;
    expect((await d.call('GET', `/api/desk/jobs/${first}`)).body.job.state).toBe('waiting');

    d.clock.t += 1;
    const { jobs, worker } = (await d.call('GET', '/api/desk/jobs')).body;
    expect(jobs.map((j) => [j.state, j.attempts, j.error, j.lease])).toEqual([['queued', 1, LEASE_ERROR, null], ['queued', 1, LEASE_ERROR, null]]);
    expect(worker).toEqual({ alive: false, lastSeen: d.clock.t - LEASE_MS });
    expect((await d.worker('POST', `/jobs/${first}/progress`, { state: 'running' })).status).toBe(409);
    d.desk.close();
  });

  test('a restart requeues claimed jobs with attempts+1 and fails them on the third', async () => {
    const dir = fresh();
    const clock = { t: 5_000_000 };
    let d = makeDesk(dir, { clock });
    const id = await d.upload();
    for (const expected of [['queued', 1], ['queued', 2], ['failed', 3]]) {
      expect((await d.worker('POST', '/claim')).body.job.id).toBe(id);
      d.desk.close();
      d = makeDesk(dir, { clock });
      const { job } = (await d.call('GET', `/api/desk/jobs/${id}`)).body;
      expect([job.state, job.attempts, job.error]).toEqual([...expected, RESTART_ERROR]);
    }
    expect((await d.worker('POST', '/claim')).status).toBe(204);
    d.desk.close();
  });

  test('a worker error is kept and retried until the third attempt fails', async () => {
    const d = makeDesk(fresh());
    const id = await d.upload();
    for (const state of ['queued', 'queued', 'failed']) {
      await d.worker('POST', '/claim');
      expect((await d.worker('POST', `/jobs/${id}/result`, { error: '디코딩 실패' })).body.job).toMatchObject({ state, error: '디코딩 실패' });
    }
    d.desk.close();
  });

  test('worker calls are refused off loopback even with the token, and with a wrong token', async () => {
    const dir = fresh();
    const d = makeDesk(dir);
    expect(statSync(join(dir, 'desk', 'worker-token')).mode & 0o777).toBe(0o600);
    expect(d.token.length).toBe(64);
    d.local.ok = false;
    expect((await d.worker('POST', '/claim')).status).toBe(403);
    d.local.ok = true;
    expect((await d.call('POST', '/api/desk/worker/claim', { headers: { 'x-desk-worker': 'x'.repeat(64) } })).status).toBe(401);
    expect((await d.call('POST', '/api/desk/worker/claim')).status).toBe(401);
    expect((await d.call('GET', '/api/desk/jobs')).body.worker.alive).toBe(false);
    await d.worker('POST', '/heartbeat');
    expect((await d.call('GET', '/api/desk/jobs')).body.worker).toEqual({ alive: true, lastSeen: d.clock.t });
    d.desk.close();
  });
});

describe('results', () => {
  test('a gallery result becomes g-<id>.json and public reads carry names only', async () => {
    const dir = fresh();
    const d = makeDesk(dir);
    const id = await d.upload();
    await d.worker('POST', '/claim');
    expect((await d.worker('POST', `/jobs/${id}/result`, { rallies: [rally(0, 'near'), { ...rally(1, 'far'), source: 'live' }] })).status).toBe(400);
    const done = await d.worker('POST', `/jobs/${id}/result`, { rallies: [rally(0, 'near'), rally(1, 'near'), rally(2, 'far')] });
    expect(done.body.job.state).toBe('done');
    const file = JSON.parse(readFileSync(join(dir, 'analysis', `g-${id}.json`), 'utf8'));
    expect([file.v, file.source, file.id, file.players.near, file.rallies.length]).toEqual([1, 'gallery', id, '홍길동,0712', 3]);

    const one = await d.call('GET', `/api/analysis/gallery/${id}`, { headers: {} });
    expect(one.body.players).toEqual({ near: '홍길동', far: '김하나' });
    const list = await d.call('GET', '/api/analysis/matches', { headers: {} });
    expect(list.body.items).toEqual([{ kind: 'gallery', id, title: '연습 경기', playedAt: '2026-10-30', players: { near: '홍길동', far: '김하나' }, score: { near: 2, far: 1 } }]);
    expect(JSON.stringify([one.body, list.body])).not.toMatch(/0712|4821/);
    expect((await d.call('GET', '/api/desk/jobs')).body.jobs[0].players.far).toBe('김하나,4821');
    d.desk.close();
  });

  test('a rally result keeps how its shot times were found in the note; anything else is dropped', async () => {
    const d = makeDesk(fresh());
    const ids = [];
    for (const timing of ['estimated', 'track', 'guess', undefined]) {
      const id = await d.upload({ kind: 'rally', matchRef: { tournament: '2026-10-31T01:02:03.000Z', matchId: 'm1', index: ids.length } });
      await d.worker('POST', '/claim');
      ids.push((await d.worker('POST', `/jobs/${id}/result`, { rallies: [rally(0, 'far')], timing })).body.job.note.timing);
    }
    expect(ids).toEqual(['estimated', 'track', undefined, undefined]);
    d.desk.close();
  });
  test('a rally result goes to the tournament analysis as desk for its matchRef', async () => {
    const d = makeDesk(fresh());
    const id = await d.upload({ kind: 'rally', matchRef: { tournament: '2026-10-31T01:02:03.000Z', matchId: 'm1', index: 0 } });
    await d.worker('POST', '/claim');
    expect((await d.worker('POST', `/jobs/${id}/result`, { rallies: [rally(0, 'far')] })).body.job.state).toBe('done');
    expect(d.saved.map((s) => [s.t.createdAt, s.matchId, s.r.index, s.r.source])).toEqual([['2026-10-31T01:02:03.000Z', 'm1', 0, 'desk']]);
    d.desk.close();
  });
});

describe('gallery first pass', () => {
  const firstPass = (index, winner) => ({ ...rally(index, winner), shots: [{ side: 'near', t: 0, stroke: null, kind: '서브' }] });
  const fileOf = (dir, id) => JSON.parse(readFileSync(join(dir, 'analysis', `g-${id}.json`), 'utf8'));

  test('an early result is saved at once with handPending, the job stays claimed, and the full result replaces it', async () => {
    const dir = fresh();
    const d = makeDesk(dir);
    const id = await d.upload();
    await d.worker('POST', '/claim');
    d.clock.t += 30_000;
    const early = await d.worker('POST', `/jobs/${id}/early`, { rallies: [firstPass(0, 'near'), firstPass(1, 'far')] });
    expect([early.status, early.body.job.state, early.body.job.note, early.body.job.lease.until]).toEqual([200, 'waiting', { handPending: true }, d.clock.t + LEASE_MS]);
    expect([fileOf(dir, id).handPending, fileOf(dir, id).rallies.length]).toEqual([true, 2]);
    expect((await d.call('GET', `/api/analysis/gallery/${id}`, { headers: {} })).body.handPending).toBe(true);

    const done = await d.worker('POST', `/jobs/${id}/result`, { rallies: [rally(0, 'near'), rally(1, 'far')] });
    expect([done.body.job.state, done.body.job.note]).toEqual(['done', null]);
    expect([fileOf(dir, id).handPending, fileOf(dir, id).rallies[0].shots[0].stroke]).toEqual([undefined, '포핸드']);
    d.desk.close();
  });

  test('a rally job has no early result, a malformed one is refused, and an unclaimed job is refused', async () => {
    const d = makeDesk(fresh());
    const id = await d.upload();
    expect((await d.worker('POST', `/jobs/${id}/early`, { rallies: [firstPass(0, 'near')] })).status).toBe(409);
    await d.worker('POST', '/claim');
    expect((await d.worker('POST', `/jobs/${id}/early`, { rallies: [{ ...firstPass(0, 'near'), source: 'live' }] })).status).toBe(400);
    d.clock.t += 1;
    const rallyId = await d.upload({ kind: 'rally', matchRef: { tournament: '1', matchId: 'm1', index: 0 } });
    await d.worker('POST', '/claim');
    expect((await d.worker('POST', `/jobs/${rallyId}/early`, { rallies: [firstPass(0, 'near')] })).status).toBe(409);
    d.desk.close();
  });

  test('a gallery job that fails for good keeps its first pass without the pending mark', async () => {
    const dir = fresh();
    const d = makeDesk(dir);
    const id = await d.upload();
    await d.worker('POST', '/claim');
    await d.worker('POST', `/jobs/${id}/early`, { rallies: [firstPass(0, 'near')] });
    for (const state of ['queued', 'queued', 'failed']) {
      await d.worker('POST', '/claim');
      const job = (await d.worker('POST', `/jobs/${id}/result`, { error: '디코딩 실패' })).body.job;
      expect([job.state, job.note?.handPending ?? false]).toEqual([state, state !== 'failed']);
    }
    expect([fileOf(dir, id).handPending, fileOf(dir, id).rallies.length]).toEqual([undefined, 1]);
    d.desk.close();
  });

  test('a lease that runs out for good also drops the pending mark', async () => {
    const dir = fresh();
    const d = makeDesk(dir);
    const id = await d.upload();
    for (let i = 0; i < 3; i++) {
      await d.worker('POST', '/claim');
      if (i === 0) await d.worker('POST', `/jobs/${id}/early`, { rallies: [firstPass(0, 'near')] });
      d.clock.t += LEASE_MS + 1;
      await d.call('GET', '/api/desk/jobs');
    }
    const { job } = (await d.call('GET', `/api/desk/jobs/${id}`)).body;
    expect([job.state, job.note]).toEqual(['failed', null]);
    expect(fileOf(dir, id).handPending).toBeUndefined();
    d.desk.close();
  });
});

describe('rally jobs', () => {
  // A best-of-3 to 11: slot 0 wins points 0..10 (game 1) and point 11 opens game 2, after the change of ends.
  let t = createTournament({ players: ['A,0001', 'B,0002', 'C,0003', 'D,0004'] });
  for (let i = 0; i < 12; i++) t = addPoint(t, 'm1', 0, i);
  const matchRef = (index) => ({ tournament: t.createdAt, matchId: 'm1', index });
  const tournamentOf = (createdAt) => (createdAt === t.createdAt ? t : null);
  const pose = { model: 'mediapipe-full', at: [-0.77, -0.4, 0], hand: 'R', frames: [null, null, null] };
  const shotPose = { pose2d: pose, pose3d: { frames: [null, null, null] } };

  async function result(d, job, body) {
    const id = await d.upload({ kind: 'rally', ...job });
    await d.worker('POST', '/claim');
    return (await d.worker('POST', `/jobs/${id}/result`, body)).body.job;
  }

  test('nearSlot is the slot at the camera end when that point was played, null when the end is unknown', async () => {
    const d = makeDesk(fresh(), { tournamentOf });
    const jobs = [
      { matchRef: matchRef(3), nearEnd: 'blue' },
      { matchRef: matchRef(11), nearEnd: 'blue' },
      { matchRef: matchRef(11), nearEnd: 'red' },
      { matchRef: matchRef(11) },
    ];
    const notes = [];
    for (const job of jobs) notes.push((await result(d, job, { rallies: [rally(0, 'near')] })).note.nearSlot);
    expect(d.saved.map((s) => s.r.nearSlot)).toEqual([0, 1, 0, null]);
    expect(notes).toEqual([0, 1, 0, null]);
    d.desk.close();
  });

  test('the clip is stored at matchRef.index with its pose; a second rally is dropped, counted and kept as the error', async () => {
    const dir = fresh();
    const d = makeDesk(dir, { tournamentOf });
    const job = await result(d, { matchRef: matchRef(7), nearEnd: 'blue' }, { rallies: [rally(0, 'far'), rally(1, 'near')], pose: { 0: { 0: shotPose }, 1: { 0: shotPose } } });
    expect(d.saved.map((s) => [s.matchId, s.r.index, s.r.winner])).toEqual([['m1', 7, 'far']]);
    const stored = JSON.parse(readFileSync(join(dir, 'analysis', 'pose', `${tournamentPoseKey(t.createdAt, 'm1')}.json`), 'utf8'));
    expect(Object.keys(stored.rallies)).toEqual(['7']);
    expect([job.state, job.note.dropped, typeof job.error]).toEqual(['done', 1, 'string']);
    d.desk.close();
  });
});

describe('queue.json on boot', () => {
  test('a missing file reads as an empty queue', async () => {
    const dir = fresh();
    const d = makeDesk(dir);
    expect((await d.call('GET', '/api/desk/jobs')).body.jobs).toEqual([]);
    expect(readdirSync(join(dir, 'desk')).filter((f) => f.includes('.bad-'))).toEqual([]);
    d.desk.close();
  });

  test.each([['broken JSON', '{"v":1,'], ['wrong v', '{"v":2,"jobs":[]}'], ['no jobs', '{"v":1}']])('%s is kept aside and the desk starts empty', async (_, text) => {
    const dir = fresh();
    mkdirSync(join(dir, 'desk'));
    writeFileSync(join(dir, 'desk', 'queue.json'), text);
    const d = makeDesk(dir);
    expect((await d.call('GET', '/api/desk/jobs')).body.jobs).toEqual([]);
    const aside = readdirSync(join(dir, 'desk')).find((f) => f.includes('.bad-'));
    expect(readFileSync(join(dir, 'desk', aside), 'utf8')).toBe(text);
    expect(d.logged.length).toBe(1);
    d.desk.close();
  });

  test('a malformed job is dropped and the good one kept', async () => {
    const dir = fresh();
    const a = makeDesk(dir);
    const id = await a.upload();
    a.desk.close();
    const path = join(dir, 'desk', 'queue.json');
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ v: 1, jobs: [...doc.jobs, { id: '../../x', kind: 'gallery' }] }));
    const b = makeDesk(dir);
    expect((await b.call('GET', '/api/desk/jobs')).body.jobs.map((j) => j.id)).toEqual([id]);
    b.desk.close();
  });
});

describe('real server', () => {
  let dir;
  let base;
  let proc;
  let token;
  let t;

  const start = async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    base = 'http://127.0.0.1:' + port;
    proc = Bun.spawn(['bun', join(ROOT, 'server.js')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir }, stdout: 'pipe', stderr: 'inherit' });
    const reader = proc.stdout.getReader();
    let out = '';
    while (!out.includes('listening')) {
      const { value, done } = await reader.read();
      if (done) throw new Error('server exited before listening: ' + out);
      out += new TextDecoder().decode(value);
    }
    reader.releaseLock();
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(root, 'srv-'));
    t = addPoint(createTournament({ players: ['A,0001', 'B,0002', 'C,0003', 'D,0004'] }), 'm1', 0, 0);
    writeFileSync(join(dir, 'tournament.json'), JSON.stringify({ rev: 1, pin: PIN, tournament: t }));
    await start();
    token = readFileSync(join(dir, 'desk', 'worker-token'), 'utf8').trim();
  });
  afterAll(() => proc?.kill());

  const req = (method, path, body, headers = { 'x-pin': PIN }) => fetch(base + path, { method, headers, body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) });
  const asWorker = (path, extra = {}) => req('POST', '/api/desk/worker' + path, undefined, { 'x-desk-worker': token, ...extra });

  test('a proxied request is refused even from loopback with the token', async () => {
    expect((await asWorker('/claim', { 'x-forwarded-for': '203.0.113.9' })).status).toBe(403);
    expect((await asWorker('/claim')).status).toBe(204);
  });

  test('a rally job survives a restart, and its desk result is read publicly for that match', async () => {
    const job = (await (await req('POST', '/api/desk/jobs', newJob({ kind: 'rally', matchRef: { tournament: t.createdAt, matchId: 'm1', index: 0 } }))).json()).job;
    expect((await req('PUT', `/api/desk/jobs/${job.id}/video?offset=0`, new Uint8Array(10))).status).toBe(200);
    expect((await (await asWorker('/claim')).json()).job.id).toBe(job.id);
    proc.kill();
    await proc.exited;
    await start();
    const after = (await (await req('GET', `/api/desk/jobs/${job.id}`)).json()).job;
    expect([after.state, after.attempts]).toEqual(['queued', 1]);
    expect((await asWorker('/claim')).status).toBe(200);
    const video = await fetch(`${base}/api/desk/worker/jobs/${job.id}/video`, { headers: { 'x-desk-worker': token } });
    expect((await video.arrayBuffer()).byteLength).toBe(10);
    const res = await fetch(`${base}/api/desk/worker/jobs/${job.id}/result`, { method: 'POST', headers: { 'x-desk-worker': token }, body: JSON.stringify({ rallies: [rally(0, 'near')] }) });
    expect(res.status).toBe(200);
    const read = await (await fetch(base + '/api/analysis/match/m1')).json();
    expect(read.rallies.map((r) => r.source)).toEqual(['desk']);
  });
});

describe('rally track', () => {
  const { gzipSync } = require('node:zlib');
  const track = (frames = [{ t: 0, cam: 12.5, lastShot: { index: 1, t: 13.1 } }]) => new Uint8Array(gzipSync(JSON.stringify({ v: 1, meta: {}, frames, notices: [] })));
  test('a rally job takes a gzip v1 track, the worker reads it back, and delete removes it', async () => {
    const dir = fresh();
    const d = makeDesk(dir);
    const id = await d.upload({ kind: 'rally', matchRef: { tournament: '2026-10-31T01:02:03.000Z', matchId: 'm1', index: 0 } });
    const put = await d.call('PUT', `/api/desk/jobs/${id}/track`, { body: track() });
    expect(put.status).toBe(200);
    expect(put.body.job.track.frames).toBe(1);
    const req = new Request(`http://x/api/desk/worker/jobs/${id}/track`, { headers: { 'x-desk-worker': d.token } });
    const res = await d.desk.handle(req, new URL(req.url));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(track());
    expect((await d.call('DELETE', `/api/desk/jobs/${id}`)).status).toBe(200);
    expect(readdirSync(join(dir, 'desk', 'tracks'))).toEqual([]);
  });
  test('plain JSON, a broken gzip, a non-track JSON, a gallery job and an oversize body are refused', async () => {
    const d = makeDesk(fresh());
    const id = await d.upload({ kind: 'rally', matchRef: { tournament: '2026-10-31T01:02:03.000Z', matchId: 'm1', index: 0 } });
    const put = (body) => d.call('PUT', `/api/desk/jobs/${id}/track`, { body });
    expect((await put(JSON.stringify({ v: 1, frames: [] }))).status).toBe(400);
    expect((await put(new Uint8Array([0x1f, 0x8b, 1, 2, 3]))).status).toBe(400);
    expect((await put(new Uint8Array(gzipSync(JSON.stringify({ v: 2, frames: [] }))))).status).toBe(400);
    expect((await put(new Uint8Array(4 * 1024 ** 2 + 1))).status).toBe(413);
    const gid = await d.upload();
    expect((await d.call('PUT', `/api/desk/jobs/${gid}/track`, { body: track() })).status).toBe(400);
  });
  test('a job without a track answers 404 to the worker, and an old job record has no track field', async () => {
    const d = makeDesk(fresh());
    const id = await d.upload({ kind: 'rally', matchRef: { tournament: '2026-10-31T01:02:03.000Z', matchId: 'm1', index: 0 } });
    const req = new Request(`http://x/api/desk/worker/jobs/${id}/track`, { headers: { 'x-desk-worker': d.token } });
    expect((await d.desk.handle(req, new URL(req.url))).status).toBe(404);
    expect((await d.call('GET', `/api/desk/jobs/${id}`)).body.job.track).toBeUndefined();
  });
});

describe('rally jobs from a 다시 보기 save on this PC', () => {
  const ref = { tournament: '2026-10-30T00:00:00.000Z', matchId: 'm1', index: 6 };
  const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const sid = (c) => c.repeat(43);
  const track = Bun.gzipSync(JSON.stringify({ v: 1, frames: [{}, {}, {}] }));
  // a save folder laid out as pingpong-vision save-server.js writes it
  function save(saveDir, id, { video = new Uint8Array(20).fill(3), name = 'video.mp4', overlay = track } = {}) {
    const d = join(saveDir, id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'record.json'), JSON.stringify({ savedAt: '2026-10-30T10:00:00.000Z' }));
    writeFileSync(join(d, name), video);
    if (overlay) writeFileSync(join(d, 'overlay.json.gz'), overlay);
    return d;
  }
  const ask = (d, body, headers) => d.call('POST', '/api/desk/jobs/from-save', { body, headers });

  test('one save makes one queued rally job with its clip and track; asking again returns the same job', async () => {
    const dataDir = fresh();
    const saveDir = mkdtempSync(join(root, 's-'));
    save(saveDir, sid('a'));
    const d = makeDesk(dataDir, { saveDir });
    const first = await ask(d, { save: sid('a'), matchRef: ref, nearEnd: 'red', corners });
    expect(first.status).toBe(201);
    const job = first.body.job;
    expect(job).toMatchObject({ kind: 'rally', state: 'queued', title: '대회 경기 · 7번째 포인트', playedAt: '2026-10-30T10:00:00.000Z', matchRef: ref, nearEnd: 'red', corners, source: { save: sid('a') }, track: { bytes: track.length, frames: 3 } });
    expect(job.video).toEqual({ name: 'video.mp4', bytes: 20, received: 20, type: 'video/mp4' });
    expect(readFileSync(join(dataDir, 'desk', 'videos', `${job.id}.mp4`))).toEqual(Buffer.from(new Uint8Array(20).fill(3)));
    expect(readFileSync(join(dataDir, 'desk', 'tracks', `${job.id}.json.gz`))).toEqual(Buffer.from(track));
    const again = await Promise.all([1, 2, 3].map(() => ask(d, { save: sid('a'), matchRef: ref, nearEnd: 'red', corners })));
    for (const r of again) expect(r.body).toMatchObject({ job: { id: job.id }, existing: true });
    expect((await d.call('GET', '/api/desk/jobs')).body.jobs.map((j) => j.id)).toEqual([job.id]);
    expect((await d.worker('POST', '/claim')).body.job.id).toBe(job.id);
  });

  test('two different saves asked at once make two jobs', async () => {
    const saveDir = mkdtempSync(join(root, 's-'));
    save(saveDir, sid('b'));
    save(saveDir, sid('c'), { name: 'video.webm' });
    const d = makeDesk(fresh(), { saveDir });
    const [b, c] = await Promise.all([sid('b'), sid('c')].map((s) => ask(d, { save: s, matchRef: ref, nearEnd: null })));
    expect([b.status, c.status]).toEqual([201, 201]);
    expect(c.body.job.video.type).toBe('video/webm');
    expect((await d.call('GET', '/api/desk/jobs')).body.jobs).toHaveLength(2);
  });

  test('a save without a valid track is still a job, without a track', async () => {
    const saveDir = mkdtempSync(join(root, 's-'));
    save(saveDir, sid('d'), { overlay: null });
    save(saveDir, sid('e'), { overlay: Bun.gzipSync('{"v":2}') });
    const d = makeDesk(fresh(), { saveDir });
    for (const s of [sid('d'), sid('e')]) {
      const { status, body } = await ask(d, { save: s, matchRef: ref, nearEnd: 'blue' });
      expect(status).toBe(201);
      expect(body.job.track).toBeUndefined();
    }
  });

  test('ids that are not a save id, saves that are not there, and symlinks out of the saves folder are refused', async () => {
    const saveDir = mkdtempSync(join(root, 's-'));
    const outside = mkdtempSync(join(root, 'out-'));
    save(outside, sid('f'));
    symlinkSync(join(outside, sid('f')), join(saveDir, sid('f')));
    const g = save(saveDir, sid('g'), { name: 'other.mp4' });
    writeFileSync(join(outside, 'v.mp4'), new Uint8Array(9));
    symlinkSync(join(outside, 'v.mp4'), join(g, 'video.mp4'));
    save(saveDir, sid('h'), { video: new Uint8Array(0) });
    const d = makeDesk(fresh(), { saveDir });
    for (const s of ['../' + sid('x').slice(3), sid('x').slice(1), 'a/b', 42]) expect((await ask(d, { save: s, matchRef: ref })).status).toBe(400);
    expect((await ask(d, { save: sid('a'), matchRef: { ...ref, index: -1 } })).status).toBe(400);
    for (const s of [sid('z'), sid('f'), sid('g'), sid('h')]) expect((await ask(d, { save: s, matchRef: ref })).status).toBe(404);
    expect((await d.call('GET', '/api/desk/jobs')).body.jobs).toEqual([]);
  });

  test('a wrong PIN is refused before anything is read', async () => {
    const saveDir = mkdtempSync(join(root, 's-'));
    save(saveDir, sid('i'));
    const d = makeDesk(fresh(), { saveDir });
    expect((await ask(d, { save: sid('i'), matchRef: ref }, { 'x-pin': '0000' })).status).toBe(401);
    expect((await d.call('GET', '/api/desk/jobs')).body.jobs).toEqual([]);
  });
});
