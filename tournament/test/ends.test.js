import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuleError, addPoint, createTournament, derive, setEnds, setHandicap, undoPoint } from '../public/engine.js';

// The table's two ends (blue end, red end) stay where they are; the players move between them.
// m.ends = [player slot at the blue end, player slot at the red end]. ITTF 2.14: ends change after
// each game, and in the deciding game when one player first reaches 5 points.
const make = (bestOf = 3) => createTournament({ name: 't', players: ['A,1001', 'B,1002', 'C,1003', 'D,1004'], bestOf });
const match = (t, id = 'm1') => derive(t).matches.find((m) => m.id === id);
const play = (t, side, n, id = 'm1') => {
  for (let i = 0; i < n; i++) t = addPoint(t, id, side, match(t, id).points.length);
  return t;
};

describe('ends follow the rules', () => {
  test('a new match starts with slot 0 at the blue end; a game end swaps the players, not the ends', () => {
    let t = make();
    expect(match(t).ends).toEqual([0, 1]);
    t = play(t, 0, 10);
    expect(match(t).ends).toEqual([0, 1]);
    t = play(t, 0, 1);
    expect(match(t).ends).toEqual([1, 0]);
  });

  test('deciding game: the players change ends when one first reaches 5, and undo takes it back', () => {
    let t = play(play(make(), 0, 11), 1, 11);
    expect(match(t).score.won).toEqual([1, 1]);
    expect(match(t).ends).toEqual([0, 1]);
    t = play(play(t, 1, 3), 0, 4);
    expect(match(t).ends).toEqual([0, 1]);
    t = play(t, 0, 1);
    expect(match(t).score.current).toEqual({ a: 5, b: 3 });
    expect(match(t).ends).toEqual([1, 0]);
    t = play(t, 1, 3);
    expect(match(t).ends).toEqual([1, 0]);
    for (let i = 0; i < 4; i++) t = undoPoint(t, 'm1', match(t).points.length);
    expect(match(t).score.current).toEqual({ a: 4, b: 3 });
    expect(match(t).ends).toEqual([0, 1]);
  });

  test('best of 5: only the fifth game changes ends at 5; earlier games do not', () => {
    let t = play(play(make(5), 0, 11), 1, 11);
    t = play(play(t, 0, 11), 1, 11);
    expect(match(t).ends).toEqual([0, 1]);
    t = play(t, 0, 5);
    expect(match(t).ends).toEqual([1, 0]);
    let t3 = play(make(5), 0, 11);
    t3 = play(t3, 0, 5);
    expect(match(t3).ends).toEqual([1, 0]);
  });

  test('no change after the game that wins the match', () => {
    const t = play(make(), 0, 22);
    expect(match(t).status).toBe('done');
    expect(match(t).ends).toEqual([1, 0]);
  });

  test('a hand fix sets who stands at the blue end; the automatic changes go on from there', () => {
    let t = setEnds(make(), 'm1', 1);
    expect(match(t).ends).toEqual([1, 0]);
    expect(match(setEnds(t, 'm1', 1)).ends).toEqual([1, 0]);
    t = play(t, 1, 11);
    expect(match(t).ends).toEqual([0, 1]);
    t = setEnds(t, 'm1', 1);
    expect(match(t).ends).toEqual([1, 0]);
    expect(match(t).points.length).toBe(11);
    expect(match(t).score.won).toEqual([0, 1]);
  });

  test('a handicap set after a hand fix keeps it; bad requests are refused', () => {
    const t = setHandicap(setEnds(make(), 'm1', 1), 'm1', [0, 2]);
    expect(match(t).ends).toEqual([1, 0]);
    expect(() => setEnds(make(), 'm1', 2)).toThrow(RuleError);
    expect(() => setEnds(make(), 'm4', 0)).toThrow(RuleError);
    expect(() => setEnds(play(make(), 0, 22), 'm1', 0)).toThrow(RuleError);
  });
});

describe('ends over the API', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pp-ends-'));
  let base;
  let proc;
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
  });
  afterAll(() => {
    proc?.kill();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const post = (path, b, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(b) });
  const state = async () => (await fetch(`${base}/api/state`)).json();
  const ends = async () => (await state()).derived.matches.find((m) => m.id === 'm1').ends;

  test('a hand fix is a rev change every screen reads; a camera writes with the PIN only, the old approval is gone', async () => {
    const { pin } = await (await post('/api/tournament', { name: 't', players: ['A,1001', 'B,1002', 'C,1003', 'D,1004'] })).json();
    const rev0 = (await state()).rev;
    expect(await ends()).toEqual([0, 1]);
    expect((await post('/api/action', { type: 'ends', matchId: 'm1', blue: 1 }, { 'x-pin': pin })).status).toBe(200);
    expect((await state()).rev).toBe(rev0 + 1);
    expect(await ends()).toEqual([1, 0]);

    // no referee approval, no camera token
    expect((await post('/api/vision/approve', { id: 'a'.repeat(64) }, { 'x-pin': pin })).status).toBe(403);
    expect((await post('/api/vision/claim', { secret: 'S'.repeat(43) })).status).toBe(403);
    const token = { 'x-vision-token': 'T'.repeat(43) };
    for (let i = 0; i < 6; i++) {
      const r = await post('/api/action', { type: 'ends', matchId: 'm1', blue: 0 }, token);
      expect(r.status).toBe(403);
      expect((await r.json()).error).toContain('PIN');
    }
    expect((await post('/api/vision/say', { text: '블루 사이드 1' }, token)).status).toBe(403);
    expect(await ends()).toEqual([1, 0]);
    // a token is refused before the PIN check, so it never locks out the PIN on this address
    expect((await post('/api/action', { type: 'ends', matchId: 'm1', blue: 0 }, { 'x-pin': pin })).status).toBe(200);
    expect(await ends()).toEqual([0, 1]);
    expect((await post('/api/action', { type: 'ends', matchId: 'm1', blue: 1 })).status).toBe(403);
  });
});
