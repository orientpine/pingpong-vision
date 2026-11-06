import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareJudge } from '../public/judge-compare.js';
import { parseJudge } from '../judge-log.js';

let clock = 0;
const at = (ms = 1000) => (clock += ms);
const call = (id, index, slot, { call: c = {}, ...rest } = {}) => ({ t: 'call', at: at(), id, matchId: 'm1', index, call: { end: slot, slot, sure: true, weak: false, why: 'no_bounce', reason: 'no_return', shots: 3, bounces: 3, ...c }, pre: slot, ...rest });
const point = (index, side, by = 'referee', ms = 1000) => ({ t: 'point', at: at(ms), matchId: 'm1', index, side, by });
const undo = (index, side, by = 'referee', ms = 1000) => ({ t: 'undo', at: at(ms), matchId: 'm1', index, side, by });
const one = (lines) => compareJudge(lines, [{ id: 'm1', no: 1 }]);

describe('compareJudge: one line per kind of outcome', () => {
  test('same: the referee entered the camera\'s call', () => {
    const r = one([call('a', 0, 1), point(0, 1, 'referee', 2500)]);
    expect(r.points).toHaveLength(1);
    expect(r.points[0]).toMatchObject({ id: 'a', outcome: 'same', enteredSide: 1, finalSide: 1, by: 'referee', ms: 2500, index: 0 });
    expect(r.total).toMatchObject({ calls: 1, same: 1, different: 0, sure: 1, sureSame: 1, surePct: 100, agreePct: 100, avgMs: 2500 });
  });

  test('different: the referee entered the other side', () => {
    const r = one([call('a', 0, 1), point(0, 0, 'camera')]);
    expect(r.points[0]).toMatchObject({ outcome: 'different', enteredSide: 0, finalSide: 0, by: 'camera' });
    expect(r.total).toMatchObject({ calls: 1, same: 0, different: 1, sureDifferent: 1, surePct: 0 });
  });

  test('cancelled: the camera\'s 3 s cancel, and 렛 on an unanswered call, are fake calls', () => {
    const r = one([call('a', 0, 0), point(0, 0, 'camera', 200), undo(0, 0, 'camera', 2000), call('b', 0, 1), { t: 'drop', at: at(), id: 'b', why: 'let' }]);
    expect(r.points.map((p) => [p.id, p.outcome])).toEqual([['a', 'cancelled'], ['b', 'cancelled']]);
    expect(r.total).toMatchObject({ calls: 2, cancelled: 2, fake: 2, same: 0, missed: 0 });
  });

  test('no camera call: a point the referee entered by hand counts as missed by the camera', () => {
    const r = one([point(0, 1), call('a', 1, 0), point(1, 0)]);
    expect(r.points.map((p) => [p.id, p.outcome, p.index])).toEqual([[null, 'no_call', 0], ['a', 'same', 1]]);
    expect(r.total).toMatchObject({ calls: 1, missed: 1, same: 1 });
  });

  test('a later fix: a flip turns same into different, an undo much later is undone, a hand fix keeps the call', () => {
    const lines = [
      call('a', 0, 1), point(0, 1),
      call('b', 1, 0), point(1, 0, 'camera'),
      call('c', 2, 0), point(2, 0, 'camera'),
      { t: 'flip', at: at(), matchId: 'm1', index: 0, side: 0, by: 'referee' },
      // the camera phone's hand fix of point 1: undo back to it, enter it the other way, put point 2 back
      undo(2, 0, 'camera-fix', 60000), undo(1, 0, 'camera-fix'), point(1, 1, 'camera-fix'), point(2, 0, 'camera-fix'),
      undo(2, 0, 'referee', 60000),
    ];
    const r = one(lines);
    const by = Object.fromEntries(r.points.map((p) => [p.id, p]));
    expect(by.a).toMatchObject({ outcome: 'different', enteredSide: 1, finalSide: 0 });
    expect(by.a.fixes.map((f) => f.kind)).toEqual(['flip']);
    // entered at the red end, flipped: the same rally now goes to the blue end
    expect(one([call('x', 0, 1), { ...point(0, 1), end: 1 }, { t: 'flip', at: at(), matchId: 'm1', index: 0, side: 0, by: 'referee' }]).points[0]).toMatchObject({ enteredEnd: 1, finalEnd: 0, outcome: 'different' });
    expect(by.b).toMatchObject({ outcome: 'different', enteredSide: 0, finalSide: 1, by: 'camera' });
    expect(by.c).toMatchObject({ outcome: 'undone', finalSide: null });
    expect(r.total).toMatchObject({ calls: 3, same: 0, different: 2, undone: 1, fake: 1, fixed: 3, missed: 0 });
  });

  test('ignored: a call replaced by the next one before anyone tapped is not entered; weak calls count the side picked', () => {
    const weak = { call: { sure: false, weak: true }, pre: null, guess: 1 };
    const r = one([call('a', 0, 1, weak), call('b', 0, 0, weak), point(0, 1)]);
    expect(r.points.map((p) => [p.id, p.outcome, p.dropWhy])).toEqual([['a', 'ignored', 'replaced'], ['b', 'different', null]]);
    expect(r.total).toMatchObject({ calls: 2, ignored: 1, different: 1, weak: 2, weakGuess: 0, weakOther: 1, weakOut: 1, sure: 0, surePct: null });
  });

  test('a call that reaches the server just after the referee screen entered its point is joined to it', () => {
    const r = one([point(0, 1), call('a', 0, 1)]);
    expect(r.points).toHaveLength(1);
    expect(r.points[0]).toMatchObject({ id: 'a', outcome: 'same', by: 'referee' });
    expect(r.total.missed).toBe(0);
  });
});

test('parseJudge keeps only the documented fields and refuses a malformed call', () => {
  const rec = parseJudge({ t: 'call', id: 'c1-1', matchId: 'm1', index: 3, call: { end: 1, slot: 0, sure: true, weak: false, why: 'no_bounce', reason: 'no_return', shots: 4, bounces: 3, name: 'x' }, pre: 1, guess: null, hold: false, rally: { startMs: 1, endMs: 2 }, camera: 'cam1', face: 'data:...' });
  expect(rec).toEqual({ t: 'call', id: 'c1-1', matchId: 'm1', index: 3, call: { end: 1, slot: 0, sure: true, weak: false, why: 'no_bounce', reason: 'no_return', shots: 4, bounces: 3 }, pre: 1, guess: null, hold: false, disagree: false, rally: { startMs: 1, endMs: 2 }, camera: 'cam1', mode: 'confirm' });
  expect(() => parseJudge({ t: 'call', id: 'c', matchId: 'm1', index: -1, call: { end: 0, slot: 0 } })).toThrow('index');
  expect(() => parseJudge({ t: 'call', id: 'c', matchId: 'm1', index: 0, call: { end: 2, slot: 0 } })).toThrow('end');
  expect(() => parseJudge({ t: 'drop', id: 'c', why: 'anything' })).toThrow('why');
  expect(() => parseJudge({ t: 'call', id: '../x', matchId: 'm1', index: 0, call: { end: 0, slot: 0 } })).toThrow('id');
});

describe('server: /api/judge and the lines /api/action writes', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pp-judgelog-'));
  let base;
  let proc;
  let pin;
  beforeAll(async () => {
    proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'server.js')], { env: { ...process.env, PORT: '0', DATA_DIR: dataDir }, stdout: 'pipe', stderr: 'inherit' });
    const reader = proc.stdout.getReader();
    let out = '';
    while (!out.includes('listening')) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`server exited before listening: ${out}`);
      out += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    base = `http://127.0.0.1:${out.match(/:(\d+) \(data:/)[1]}`;
    pin = (await (await post('/api/tournament', { name: 't', players: ['A,1001', 'B,1002', 'C,1003', 'D,1004'] })).json()).pin;
  });
  afterAll(() => {
    proc?.kill();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const lines = () => readFileSync(join(dataDir, 'judge-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const callBody = (id, index, slot) => ({ t: 'call', id, matchId: 'm1', index, call: { end: slot, slot, sure: true, weak: false, why: 'no_bounce', reason: 'no_return', shots: 3, bounces: 3 }, pre: slot });

  test('a camera call, the camera\'s tap and a referee screen point become lines; the summary compares them', async () => {
    expect((await post('/api/judge', callBody('k1', 0, 0))).status).toBe(403);
    expect((await post('/api/judge', { t: 'call', id: 'k1' }, { 'x-pin': pin })).status).toBe(400);
    expect((await post('/api/judge', callBody('k1', 0, 0), { 'x-pin': pin })).status).toBe(200);
    expect((await post('/api/action', { type: 'point', matchId: 'm1', side: 0, seq: 0 }, { 'x-pin': pin, 'x-ppv-by': 'camera' })).status).toBe(200);
    expect((await post('/api/judge', callBody('k2', 1, 0), { 'x-pin': pin })).status).toBe(200);
    expect((await post('/api/action', { type: 'point', matchId: 'm1', side: 1, seq: 1 }, { 'x-pin': pin })).status).toBe(200);
    expect((await post('/api/action', { type: 'point', matchId: 'm1', side: 1, seq: 2 }, { 'x-pin': pin })).status).toBe(200);
    expect((await post('/api/action', { type: 'clip', matchId: 'm1', index: 0, url: '/vision/s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, { 'x-pin': pin })).status).toBe(200);

    const got = lines();
    expect(got.map((l) => [l.t, l.by ?? null, l.index ?? null])).toEqual([['call', null, 0], ['point', 'camera', 0], ['call', null, 1], ['point', 'referee', 1], ['point', 'referee', 2], ['clip', null, 0]]);
    expect(new Set(got.map((l) => l.tour)).size).toBe(1);
    expect(JSON.stringify(got)).not.toContain(pin);
    // the camera's posts stay out of action.log; the points stay in it as before
    const actionLog = readFileSync(join(dataDir, 'action.log'), 'utf8');
    expect(actionLog).not.toContain('/api/judge');
    expect(actionLog.match(/action:point/g)).toHaveLength(3);

    const s = await (await fetch(`${base}/api/judge/summary`)).json();
    expect(s.points.map((p) => [p.id, p.outcome, p.by])).toEqual([['k1', 'same', 'camera'], ['k2', 'different', 'referee'], [null, 'no_call', 'referee']]);
    expect(got.filter((l) => l.t === 'point').map((l) => [l.side, l.end])).toEqual([[0, 0], [1, 1], [1, 1]]);
    expect(s.points.map((p) => p.finalEnd)).toEqual([0, 1, 1]);
    expect(s.points[0].clip).toBe('/vision/s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(s.matches).toHaveLength(1);
    expect(s.matches[0]).toMatchObject({ matchId: 'm1', no: 1, calls: 2, same: 1, different: 1, missed: 1, surePct: 50 });
    expect(s.names.m1).toHaveLength(2);
  });

  test('a judge log that cannot be written never refuses a point', async () => {
    rmSync(join(dataDir, 'judge-log.jsonl'));
    mkdirSync(join(dataDir, 'judge-log.jsonl'));
    const res = await post('/api/action', { type: 'point', matchId: 'm1', side: 0, seq: 3 }, { 'x-pin': pin });
    expect(res.status).toBe(200);
    expect((await res.json()).state.derived.matches.find((m) => m.id === 'm1').points).toHaveLength(4);
    expect((await post('/api/judge', callBody('k3', 4, 0), { 'x-pin': pin })).status).toBe(200);
    rmSync(join(dataDir, 'judge-log.jsonl'), { recursive: true });
  });
});
