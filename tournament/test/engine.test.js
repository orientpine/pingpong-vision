import { describe, expect, test } from 'bun:test';
import {
  RuleError, addPoint, attachClip, createTournament, derive, flipPoint, markPoint, scoreMatch, serveTurn, setFirstServer, setHandicap, undoPoint, updateSetup,
} from '../public/engine.js';

const NAMES = ['A', 'B', 'C', 'D'];
const ENTRIES = NAMES.map((n, i) => `${n},${1001 + i}`);
const make = (format = 'double', bestOf = 3) => createTournament({ name: 't', players: ENTRIES, format, bestOf });
const match = (t, id) => derive(t).matches.find((m) => m.id === id);

function play(t, id, side, n) {
  for (let i = 0; i < n; i++) t = addPoint(t, id, side, match(t, id).points.length);
  return t;
}

function winMatch(t, id, side) {
  const need = Math.ceil(t.bestOf / 2);
  return play(t, id, side, need * t.pointsToWin);
}

function winBy(t, id, name) {
  const m = match(t, id);
  const side = m.players.map((p) => NAMES[p]).indexOf(name);
  if (side < 0) throw new Error(`${name} is not in ${id}`);
  return winMatch(t, id, side);
}

const placeNames = (t) => derive(t).standings.map((s) => s.name);

describe('double elimination, 4 players', () => {
  test('seeding and pending slots before results', () => {
    const d = derive(make());
    expect(d.matches.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'gf1']);
    expect(d.matches[0].players).toEqual([0, 3]);
    expect(d.matches[1].players).toEqual([1, 2]);
    expect(d.matches[3].status).toBe('pending');
    expect(d.matches[3].slotLabels).toEqual(['1경기 승자', '2경기 승자']);
    expect(d.current.id).toBe('m1');
  });

  test('winners-bracket champion wins the grand final: no reset match', () => {
    let t = make();
    t = winBy(t, 'm1', 'A');
    expect(derive(t).current.id).toBe('m2');
    t = winBy(t, 'm2', 'B');
    t = winBy(t, 'm3', 'C');
    t = winBy(t, 'm4', 'A');
    t = winBy(t, 'm5', 'B');
    t = winBy(t, 'gf1', 'A');
    const d = derive(t);
    expect(d.finished).toBe(true);
    expect(d.matches.length).toBe(6);
    expect(NAMES[d.champion]).toBe('A');
    expect(placeNames(t)).toEqual(['A', 'B', 'C', 'D']);
    expect(d.standings.map((s) => s.place)).toEqual([1, 2, 3, 4]);
  });

  test('losers-bracket finalist wins grand final: reset match decides the title', () => {
    let t = make();
    for (const [id, w] of [['m1', 'A'], ['m2', 'B'], ['m3', 'C'], ['m4', 'A'], ['m5', 'B'], ['gf1', 'B']]) t = winBy(t, id, w);
    let d = derive(t);
    expect(d.finished).toBe(false);
    const reset = d.matches.find((m) => m.id === 'gf2');
    expect(reset.label).toBe('그랜드 파이널 리셋 매치');
    expect(reset.players).toEqual([0, 1]);
    expect(d.current.id).toBe('gf2');

    const champB = winBy(t, 'gf2', 'B');
    expect(NAMES[derive(champB).champion]).toBe('B');
    expect(placeNames(champB)).toEqual(['B', 'A', 'C', 'D']);
    expect(derive(champB).matches.length).toBe(7);

    const champA = winBy(t, 'gf2', 'A');
    expect(NAMES[derive(champA).champion]).toBe('A');
    expect(placeNames(champA)).toEqual(['A', 'B', 'C', 'D']);
  });
});

function explore(format) {
  const lives = format === 'double' ? 2 : 3;
  const stats = { paths: 0, maxMatches: 0, maxGf: 0, maxLf: 0 };
  const walk = (t) => {
    const d = derive(t);
    if (d.finished) {
      stats.paths++;
      stats.maxMatches = Math.max(stats.maxMatches, d.matches.length);
      stats.maxGf = Math.max(stats.maxGf, d.matches.filter((m) => m.series === 'gf').length);
      stats.maxLf = Math.max(stats.maxLf, d.matches.filter((m) => m.series === 'lf').length);
      expect(d.matches.every((m) => m.status === 'done')).toBe(true);
      expect(d.losses[d.champion]).toBeLessThan(lives);
      expect(d.eliminated.length).toBe(3);
      for (const p of d.eliminated) expect(d.losses[p]).toBe(lives);
      expect([...d.standings.map((s) => s.place)]).toEqual([1, 2, 3, 4]);
      expect(d.standings.reduce((a, s) => a + s.wins, 0)).toBe(d.matches.length);
      return;
    }
    const ready = d.matches.filter((m) => m.status === 'ready');
    expect(ready.length).toBeGreaterThan(0);
    for (const m of d.matches) if (m.players[0] !== null) expect(m.players[0]).not.toBe(m.players[1]);
    for (const p of [0, 1, 2, 3]) expect(d.losses[p]).toBeLessThanOrEqual(lives);
    const m = ready[0];
    for (const side of [0, 1]) {
      const n = structuredClone(t);
      n.log[m.id] = { points: Array(2 * t.pointsToWin).fill(side), firstServer: 0 };
      walk(n);
    }
  };
  walk(make(format));
  return stats;
}

describe('every possible result sequence reaches a valid finish', () => {
  test('double: all paths end with 1 champion, others eliminated at 2 losses', () => {
    const s = explore('double');
    expect(s.paths).toBe(32 * 3);
    expect(s.maxMatches).toBe(7);
    expect(s.maxGf).toBe(2);
  });

  test('triple: all paths end with 1 champion, others eliminated at exactly 3 losses', () => {
    const s = explore('triple');
    expect(s.paths).toBeGreaterThan(64);
    expect(s.maxLf).toBe(2);
    expect(s.maxGf).toBe(4);
    expect(s.maxMatches).toBe(11);
  });
});

describe('scoring rules', () => {
  const cfg = { pointsToWin: 11, winBy: 2, bestOf: 3 };

  test('serve rotates every 2 points, then every point from 10-10', () => {
    const servers = [];
    const pts = [];
    for (let i = 0; i < 24; i++) {
      servers.push(scoreMatch(pts, 0, cfg).server);
      pts.push(i % 2);
    }
    expect(servers.slice(0, 8)).toEqual([0, 0, 1, 1, 0, 0, 1, 1]);
    expect(servers.slice(20, 24)).toEqual([0, 1, 0, 1]);
    expect(serveTurn(10, 10, 11)).toBe(0);
    expect(serveTurn(11, 10, 11)).toBe(1);
  });

  test('deuce: 11-10 is game point, not a game; 12-10 wins the game', () => {
    const pts = [];
    for (let i = 0; i < 20; i++) pts.push(i % 2);
    let s = scoreMatch(pts, 0, cfg);
    expect(s.current).toEqual({ a: 10, b: 10 });
    expect(s.deuce).toBe(true);
    s = scoreMatch([...pts, 0], 0, cfg);
    expect(s.games.length).toBe(0);
    expect(s.gamePoint).toBe(0);
    s = scoreMatch([...pts, 0, 0], 0, cfg);
    expect(s.games).toEqual([{ a: 12, b: 10, winner: 0 }]);
  });

  test('next game starts with the other player serving', () => {
    const s = scoreMatch(Array(11).fill(1), 0, cfg);
    expect(s.gameNo).toBe(2);
    expect(s.server).toBe(1);
  });

  test('best of 3 ends at 2 games and refuses further points; best of 5 needs 3', () => {
    let t = make();
    t = play(t, 'm1', 0, 22);
    expect(match(t, 'm1').status).toBe('done');
    expect(() => addPoint(t, 'm1', 0, 22)).toThrow(RuleError);

    let t5 = make('double', 5);
    t5 = play(t5, 'm1', 1, 22);
    expect(match(t5, 'm1').status).toBe('live');
    expect(match(t5, 'm1').score.matchPoint).toBe(null);
    t5 = play(t5, 'm1', 1, 10);
    expect(match(t5, 'm1').score.matchPoint).toBe(1);
    t5 = play(t5, 'm1', 1, 1);
    expect(match(t5, 'm1').status).toBe('done');
    expect(match(t5, 'm1').score.won).toEqual([0, 3]);
  });

  test('undo restores score and serve, including across a finished game', () => {
    let t = play(make(), 'm1', 0, 11);
    expect(match(t, 'm1').score.gameNo).toBe(2);
    t = undoPoint(t, 'm1', 11);
    const s = match(t, 'm1').score;
    expect(s.gameNo).toBe(1);
    expect(s.current).toEqual({ a: 10, b: 0 });
    expect(s.server).toBe(scoreMatch(Array(10).fill(0), 0, cfg).server);
  });

  test('undo of a finished match is refused once a dependent match has started', () => {
    let t = make();
    t = winBy(t, 'm1', 'A');
    t = winBy(t, 'm2', 'B');
    t = play(t, 'm4', 0, 1);
    expect(() => undoPoint(t, 'm1', 22)).toThrow(/4경기/);
    t = undoPoint(t, 'm4', 1);
    t = undoPoint(t, 'm1', 22);
    expect(match(t, 'm1').status).toBe('live');
    expect(match(t, 'm4').status).toBe('pending');
    expect(match(t, 'm3').status).toBe('pending');
  });

  test('stale sequence numbers, pending matches and serve changes on pending/finished matches are rejected', () => {
    let t = play(make(), 'm1', 0, 3);
    expect(() => addPoint(t, 'm1', 0, 2)).toThrow(RuleError);
    expect(() => undoPoint(t, 'm1', 2)).toThrow(RuleError);
    expect(() => addPoint(t, 'm4', 0, 0)).toThrow(RuleError);
    expect(() => setFirstServer(t, 'm4', 1)).toThrow(RuleError);
    expect(() => setFirstServer(winMatch(make(), 'm1', 0), 'm1', 1)).toThrow(RuleError);
    const t2 = setFirstServer(make(), 'm2', 1);
    expect(match(t2, 'm2').score.server).toBe(1);
    expect(() => updateSetup(t, { format: 'triple' })).toThrow(RuleError);
    expect(updateSetup(make(), { format: 'triple', players: ['D', 'C', 'B', 'A'] }).format).toBe('triple');
  });

  test('serve change mid-game flips the current server and later rotation follows the new basis', () => {
    const t = setFirstServer(play(make(), 'm1', 0, 3), 'm1', 1);
    expect(match(t, 'm1').points).toEqual([0, 0, 0]);
    const servers = [];
    let u = t;
    for (let i = 0; i < 4; i++) {
      servers.push(match(u, 'm1').score.server);
      u = play(u, 'm1', 1, 1);
    }
    expect(servers).toEqual([0, 1, 1, 0]);
    const g2 = play(t, 'm1', 0, 8);
    expect(match(g2, 'm1').score.gameNo).toBe(2);
    expect(match(g2, 'm1').score.server).toBe(0);
  });

  test('serve change at deuce keeps changing every rally', () => {
    let t = make();
    for (let i = 0; i < 20; i++) t = play(t, 'm1', i % 2, 1);
    expect(match(t, 'm1').score.server).toBe(0);
    t = setFirstServer(t, 'm1', 1);
    const servers = [match(t, 'm1').score.server];
    for (let i = 0; i < 2; i++) {
      t = play(t, 'm1', i % 2, 1);
      servers.push(match(t, 'm1').score.server);
    }
    expect(servers).toEqual([1, 0, 1]);
  });

  test('undo after a serve change keeps the changed basis', () => {
    let t = setFirstServer(play(make(), 'm1', 0, 3), 'm1', 1);
    t = undoPoint(t, 'm1', 3);
    expect(match(t, 'm1').firstServer).toBe(1);
    expect(match(t, 'm1').score.server).toBe(0);
    expect(match(play(make(), 'm1', 0, 2), 'm1').score.server).toBe(1);
  });

  test('serve change in a handicap match keeps the handicap and the score', () => {
    let t = play(setHandicap(make(), 'm1', [0, 3]), 'm1', 0, 3);
    expect(match(t, 'm1').score.server).toBe(1);
    t = setFirstServer(t, 'm1', 1);
    expect(match(t, 'm1').handicap).toEqual([0, 3]);
    expect(match(t, 'm1').score.current).toEqual({ a: 3, b: 3 });
    expect(match(t, 'm1').score.server).toBe(0);
  });

  test('handicap: every game of the match starts from the handicap score', () => {
    let t = setHandicap(make(), 'm1', [0, 3]);
    expect(match(t, 'm1').score.current).toEqual({ a: 0, b: 3 });
    t = play(t, 'm1', 1, 8);
    const s = match(t, 'm1').score;
    expect(s.games).toEqual([{ a: 0, b: 11, winner: 1 }]);
    expect(s.current).toEqual({ a: 0, b: 3 });
  });

  test('handicap: game still ends at 11 with deuce from 10:10', () => {
    const pts = [];
    for (let i = 0; i < 7; i++) pts.push(0, 1);
    pts.push(0, 0, 0);
    let s = scoreMatch(pts, 0, cfg, [0, 3]);
    expect(s.current).toEqual({ a: 10, b: 10 });
    expect(s.deuce).toBe(true);
    expect(scoreMatch([...pts, 0], 0, cfg, [0, 3]).games.length).toBe(0);
    s = scoreMatch([...pts, 0, 0], 0, cfg, [0, 3]);
    expect(s.games).toEqual([{ a: 12, b: 10, winner: 0 }]);
  });

  test('handicap: serve rotates by rallies actually played, every rally from 10:10', () => {
    const pts = [];
    for (let i = 0; i < 7; i++) pts.push(0, 1);
    pts.push(1, 1, 1, 0, 1);
    const servers = [];
    for (let r = 0; r <= pts.length; r++) servers.push(scoreMatch(pts.slice(0, r), 0, cfg, [3, 0]).server);
    expect(servers.slice(0, 6)).toEqual([0, 0, 1, 1, 0, 0]);
    expect(scoreMatch(pts.slice(0, 17), 0, cfg, [3, 0]).current).toEqual({ a: 10, b: 10 });
    expect(servers.slice(16, 20)).toEqual([0, 0, 1, 0]);
  });

  test('handicap 0 keeps the original serve rule for every score', () => {
    for (let a = 0; a <= 13; a++) {
      for (let b = 0; b <= 13; b++) {
        const t = a + b;
        const old = (t < 20 ? Math.floor(t / 2) : 10 + (t - 20)) % 2;
        expect(serveTurn(a, b, 11)).toBe(old);
      }
    }
    expect(match(make(), 'm1').handicap).toEqual([0, 0]);
  });

  test('handicap: undo never goes below the handicap', () => {
    let t = play(setHandicap(make(), 'm1', [2, 0]), 'm1', 0, 1);
    expect(match(t, 'm1').score.current).toEqual({ a: 3, b: 0 });
    t = undoPoint(t, 'm1', 1);
    expect(match(t, 'm1').score.current).toEqual({ a: 2, b: 0 });
    expect(() => undoPoint(t, 'm1', 0)).toThrow(RuleError);
  });

  test('handicap 10: the first point wins the game at 11:0 and is reported until the next point', () => {
    let t = play(setHandicap(make(), 'm1', [10, 0]), 'm1', 0, 1);
    let s = match(t, 'm1').score;
    expect(s.games).toEqual([{ a: 11, b: 0, winner: 0 }]);
    expect(s.won).toEqual([1, 0]);
    expect(s.current).toEqual({ a: 10, b: 0 });
    expect(s.lastGame).toEqual({ no: 1, a: 11, b: 0, winner: 0 });
    t = undoPoint(t, 'm1', 1);
    expect(match(t, 'm1').status).toBe('ready');
    expect(match(t, 'm1').score.lastGame).toBe(null);
    t = play(t, 'm1', 0, 1);
    expect(match(t, 'm1').score.lastGame).toEqual({ no: 1, a: 11, b: 0, winner: 0 });
    t = play(t, 'm1', 1, 1);
    s = match(t, 'm1').score;
    expect(s.current).toEqual({ a: 10, b: 1 });
    expect(s.lastGame).toBe(null);
    t = play(t, 'm1', 0, 1);
    expect(match(t, 'm1').status).toBe('done');
    expect(match(t, 'm1').score.won).toEqual([2, 0]);
    expect(match(t, 'm1').score.lastGame).toEqual({ no: 2, a: 11, b: 1, winner: 0 });
  });

  test('handicap 10:10 starts in deuce: one point is not a game, two in a row are', () => {
    const s = scoreMatch([0], 0, cfg, [10, 10]);
    expect(s.games).toEqual([]);
    expect(s.current).toEqual({ a: 11, b: 10 });
    expect(s.gamePoint).toBe(0);
    expect(scoreMatch([0, 0], 0, cfg, [10, 10]).lastGame).toEqual({ no: 1, a: 12, b: 10, winner: 0 });
  });

  test('undo that changes who plays a later match drops the handicap and first serve set for the old pairing', () => {
    let t = make();
    t = winBy(t, 'm1', 'A');
    t = winBy(t, 'm2', 'B');
    t = setFirstServer(setHandicap(t, 'm4', [10, 0]), 'm4', 1);
    expect(match(t, 'm4').handicap).toEqual([10, 0]);
    t = undoPoint(t, 'm2', 22);
    expect(match(t, 'm4').status).toBe('pending');
    t = winBy(undoPoint(t, 'm2', 21), 'm2', 'C');
    expect(match(t, 'm4').players.map((p) => NAMES[p])).toEqual(['A', 'C']);
    expect(match(t, 'm4').handicap).toEqual([0, 0]);
    expect(match(t, 'm4').firstServer).toBe(0);
  });

  test('best of 5 with handicap: undo across a game boundary and the match-ending point', () => {
    let t = setHandicap(make('double', 5), 'm1', [0, 8]);
    t = play(t, 'm1', 1, 3);
    t = play(t, 'm1', 1, 3);
    expect(match(t, 'm1').score.won).toEqual([0, 2]);
    expect(match(t, 'm1').score.matchPoint).toBe(null);
    t = play(t, 'm1', 1, 2);
    expect(match(t, 'm1').score.matchPoint).toBe(1);
    t = play(t, 'm1', 1, 1);
    expect(match(t, 'm1').status).toBe('done');
    expect(match(t, 'm1').score.won).toEqual([0, 3]);
    t = undoPoint(t, 'm1', 9);
    expect(match(t, 'm1').status).toBe('live');
    expect(match(t, 'm1').score.current).toEqual({ a: 0, b: 10 });
    t = undoPoint(undoPoint(undoPoint(t, 'm1', 8), 'm1', 7), 'm1', 6);
    expect(match(t, 'm1').score.won).toEqual([0, 1]);
    expect(match(t, 'm1').score.current).toEqual({ a: 0, b: 10 });
    t = play(t, 'm1', 0, 11);
    expect(match(t, 'm1').score.current).toEqual({ a: 11, b: 10 });
    t = play(t, 'm1', 0, 1);
    expect(match(t, 'm1').score.games.map((g) => g.winner)).toEqual([1, 0]);
    expect(match(t, 'm1').score.current).toEqual({ a: 0, b: 8 });
  });

  test('handicap: only before the first point, within 0..10, kept by first-serve change', () => {
    const t = setHandicap(make(), 'm1', [0, 3]);
    expect(() => setHandicap(play(t, 'm1', 0, 1), 'm1', [0, 0])).toThrow(RuleError);
    for (const bad of [[0, 11], [-1, 0], [1.5, 0], [0], 'x']) expect(() => setHandicap(make(), 'm1', bad)).toThrow(RuleError);
    expect(() => setHandicap(make(), 'm4', [1, 0])).toThrow(RuleError);
    const t2 = setFirstServer(t, 'm1', 1);
    expect(match(t2, 'm1').handicap).toEqual([0, 3]);
    expect(match(t2, 'm1').score.server).toBe(1);
  });

  test('registration validation', () => {
    expect(() => createTournament({ players: ['A,1001'] })).toThrow(RuleError);
    expect(createTournament({ players: ['A,1001', 'B,1002'] }).players).toEqual(['A', 'B']);
    expect(() => createTournament({ players: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] })).toThrow(RuleError);
    expect(createTournament({ players: ENTRIES.concat('E,1005'), format: 'triple' }).format).toBe('triple');
    expect(() => createTournament({ players: ENTRIES, format: 'swiss' })).toThrow(RuleError);
    expect(() => createTournament({ players: ['A,1001', 'A,1001', 'C,1003', 'D,1004'] })).toThrow(RuleError);
    expect(() => createTournament({ players: ENTRIES, bestOf: 4 })).toThrow(RuleError);
  });
});

describe('끝 색 확인 marks and the referee flip', () => {
  const live = (t) => derive(t).matches.find((m) => m.status === 'ready' || m.status === 'live');
  const clip = '/vision/s/' + 'a'.repeat(43);
  test('a mark names a point as the camera entered it; a changed point is refused; 맞음 clears it', () => {
    let t = make();
    const id = live(t).id;
    t = play(t, id, 0, 2);
    t = play(t, id, 1, 1);
    t = markPoint(t, id, 1, 0, true);
    t = markPoint(t, id, 2, 1, true);
    expect(match(t, id).marks).toEqual({ 1: 'ends', 2: 'ends' });
    expect(() => markPoint(t, id, 0, 1, true)).toThrow(RuleError); // point 0 went to slot 0
    expect(() => markPoint(t, id, 3, 0, true)).toThrow(RuleError); // no such point
    t = markPoint(t, id, 1, null, false);
    expect(match(t, id).marks).toEqual({ 2: 'ends' });
  });

  test('undo drops the mark of the point it takes back', () => {
    let t = make();
    const id = live(t).id;
    t = play(t, id, 0, 3);
    t = markPoint(t, id, 2, 0, true);
    t = undoPoint(t, id, 3);
    expect(match(t, id).marks).toEqual({});
  });

  test('flip gives one point to the other player, keeps the later points and clips, clears its mark', () => {
    let t = make();
    const id = live(t).id;
    t = play(t, id, 0, 3);
    t = attachClip(t, id, 1, clip);
    t = markPoint(t, id, 1, 0, true);
    t = markPoint(t, id, 2, 0, true);
    t = flipPoint(t, id, 1, 3);
    const m = match(t, id);
    expect(m.points).toEqual([0, 1, 0]);
    expect(m.score.current).toMatchObject({ a: 2, b: 1 });
    expect(m.clips).toEqual({ 1: clip });
    expect(m.marks).toEqual({ 2: 'ends' });
    expect(() => flipPoint(t, id, 0, 2)).toThrow(RuleError); // stale count on the screen
  });

  test('a flip that would end the match before its last point is refused', () => {
    let t = make('double', 3);
    const id = live(t).id;
    t = play(t, id, 0, 11); // game 1 11:0
    t = play(t, id, 0, 10);
    t = play(t, id, 1, 1);
    t = play(t, id, 0, 1); // game 2 11:1, match over at index 22
    expect(match(t, id).status).toBe('done');
    // index 21 to slot 0 would end game 2 (and the match) at 11:0 with index 22 still after it
    expect(() => flipPoint(t, id, 21, 23)).toThrow('이 포인트를 바꾸면 경기가 더 일찍 끝나요');
    // the last point to slot 1 reopens the match at 10:2
    const back = match(flipPoint(t, id, 22, 23), id);
    expect(back.status).toBe('live');
    expect(back.score.current).toMatchObject({ a: 10, b: 2 });
  });
});
