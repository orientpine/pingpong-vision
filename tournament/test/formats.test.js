import { describe, expect, test } from 'bun:test';
import { TEMPLATES, addPoint, createTournament, derive, eliminationBracket } from '../public/engine.js';

const NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const ENTRIES = NAMES.map((n, i) => `${n},${1001 + i}`);
const make = (format, n, bestOf = 3) => createTournament({ name: 't', players: ENTRIES.slice(0, n), format, bestOf });
const find = (t, id) => derive(t).matches.find((m) => m.id === id);
const sideOf = (m, name) => m.players.map((p) => NAMES[p]).indexOf(name);

function point(t, id, side) {
  return addPoint(t, id, side, find(t, id).points.length);
}

// One game: the loser scores `other` points first, then the winner takes 11.
function game(t, id, side, other = 0) {
  for (let i = 0; i < other; i++) t = point(t, id, 1 - side);
  for (let i = 0; i < 11; i++) t = point(t, id, side);
  return t;
}

function result(t, a, b, gameWinners, other = 0) {
  const m = derive(t).matches.find((x) => x.status !== 'done' && [a, b].every((n) => sideOf(x, n) >= 0));
  if (!m) throw new Error(`no open match ${a} v ${b}`);
  const winners = Array.isArray(gameWinners) ? gameWinners : [gameWinners, gameWinners];
  for (const w of winners) t = game(t, m.id, sideOf(m, w), other);
  if (find(t, m.id).status !== 'done') throw new Error(`${a} v ${b} not finished`);
  return t;
}

function playOut(t, pick) {
  for (let guard = 0; guard < 100; guard++) {
    const d = derive(t);
    if (d.finished) return t;
    const m = d.current;
    const side = pick(m, d);
    while (find(t, m.id).status !== 'done') t = game(t, m.id, side);
  }
  throw new Error('tournament did not finish');
}

let rnd = 7;
// The low bit of this LCG just alternates 0,1,0,1; take a high bit so paths really vary.
const coin = () => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return (rnd >>> 16) & 1; };

describe('league (round robin)', () => {
  test('everyone meets everyone exactly once, nobody plays twice in a round', () => {
    for (let n = 3; n <= 8; n++) {
      const d = derive(make('league', n));
      expect(d.matches.length).toBe((n * (n - 1)) / 2);
      const pairs = d.matches.map((m) => [...m.players].sort().join('-'));
      expect(new Set(pairs).size).toBe(pairs.length);
      const byRound = Map.groupBy(d.matches, (m) => m.round);
      for (const ms of byRound.values()) {
        const ps = ms.flatMap((m) => m.players);
        expect(new Set(ps).size).toBe(ps.length);
      }
      expect(d.matches.every((m) => m.status === 'ready')).toBe(true);
    }
  });

  test('tie on wins: head-to-head decides before game difference', () => {
    let t = make('league', 4);
    t = result(t, 'A', 'B', 'B', 9);
    t = result(t, 'A', 'C', 'A');
    t = result(t, 'A', 'D', 'A');
    t = result(t, 'B', 'C', 'B', 9);
    t = result(t, 'B', 'D', 'D');
    t = result(t, 'C', 'D', 'C');
    const d = derive(t);
    expect(d.finished).toBe(true);
    const s = d.standings;
    expect(s.map((x) => x.name)).toEqual(['B', 'A', 'C', 'D']);
    expect(s[1].pointsWon - s[1].pointsLost).toBeGreaterThan(s[0].pointsWon - s[0].pointsLost);
    expect(s[0].status).toBe('champion');
    expect(NAMES[d.champion]).toBe('B');
    expect(s.map((x) => x.place)).toEqual([1, 2, 3, 4]);
  });

  test('three-way cycle: game difference, then point difference', () => {
    let t = make('league', 3);
    t = result(t, 'A', 'B', 'A');
    t = result(t, 'B', 'C', ['C', 'B', 'B']);
    t = result(t, 'A', 'C', ['A', 'C', 'C']);
    let s = derive(t).standings;
    expect(s.every((x) => x.wins === 1 && x.h2h === 1)).toBe(true);
    expect(s.map((x) => [x.name, x.gamesWon - x.gamesLost])).toEqual([['A', 1], ['C', 0], ['B', -1]]);

    t = make('league', 3);
    t = result(t, 'A', 'B', 'A', 0);
    t = result(t, 'B', 'C', 'B', 9);
    t = result(t, 'A', 'C', 'C', 5);
    s = derive(t).standings;
    expect(s.every((x) => x.gamesWon - x.gamesLost === 0)).toBe(true);
    expect(s.map((x) => [x.name, x.pointsWon - x.pointsLost])).toEqual([['A', 10], ['C', 8], ['B', -18]]);
  });

  test('standings are provisional until the last match', () => {
    let t = make('league', 3);
    t = result(t, 'A', 'B', 'A');
    const d = derive(t);
    expect(d.finished).toBe(false);
    expect(d.champion).toBe(null);
    expect(d.standings[0].name).toBe('A');
    expect(d.standings[0].place).toBe(null);
  });
});

describe('two players', () => {
  test('round robin is one match; its winner is champion and the other is 2nd', () => {
    for (const w of ['A', 'B']) {
      let t = make('league', 2);
      expect(derive(t).matches.map((m) => m.players)).toEqual([[0, 1]]);
      t = result(t, 'A', 'B', w);
      const d = derive(t);
      expect(d.finished).toBe(true);
      expect(NAMES[d.champion]).toBe(w);
      expect(d.standings.map((s) => [s.name, s.place, s.status])).toEqual([[w, 1, 'champion'], [w === 'A' ? 'B' : 'A', 2, 'finished']]);
    }
  });

  test('elimination is a final played again until one player has the format\'s losses', () => {
    for (const [format, lives] of [['double', 2], ['triple', 3]]) {
      // Wins alternate as long as they can: the longest series is 2 * lives - 1 matches.
      for (const order of [['A', 'A', 'A'], ['B', 'A', 'B', 'A', 'B'], ['A', 'B', 'B', 'A', 'B']]) {
        let t = make(format, 2);
        const played = [];
        for (const w of order) {
          if (derive(t).finished) break;
          t = result(t, 'A', 'B', w);
          played.push(w);
        }
        const d = derive(t);
        const tally = (n) => played.filter((w) => w !== n).length;
        const winner = tally('A') === lives ? 'B' : 'A';
        expect(d.finished).toBe(true);
        expect(NAMES[d.champion]).toBe(winner);
        expect(Math.max(tally('A'), tally('B'))).toBe(lives);
        expect(d.matches.every((m) => m.label === '결승' && m.stage === 'F' && m.status === 'done')).toBe(true);
        expect(d.matches.length).toBe(played.length);
        expect(d.standings.map((s) => [NAMES[s.player], s.place, s.status])).toEqual([[winner, 1, 'champion'], [winner === 'A' ? 'B' : 'A', 2, 'eliminated']]);
      }
      // Before the last loss the next match is open and nobody is champion.
      let t = make(format, 2);
      for (let i = 0; i < lives - 1; i++) t = result(t, 'A', 'B', i % 2 ? 'A' : 'B');
      const d = derive(t);
      expect(d.finished).toBe(false);
      expect(d.current.status).toBe('ready');
      expect(d.current.players).toEqual([0, 1]);
    }
  });

  test('random paths always end in at most 2 * lives - 1 matches', () => {
    for (const [format, lives] of [['double', 2], ['triple', 3]]) {
      for (let run = 0; run < 30; run++) {
        const d = derive(playOut(make(format, 2), () => coin()));
        expect(d.matches.length).toBeLessThanOrEqual(2 * lives - 1);
        expect(d.losses[1 - d.champion]).toBe(lives);
        expect(d.losses[d.champion]).toBeLessThan(lives);
      }
    }
  });
});

describe('double elimination for 3-8 players', () => {
  test('byes go to the top seeds and the first round only has the remaining players', () => {
    for (const [n, firstRound] of [[3, 1], [5, 1], [6, 2], [7, 3], [8, 4]]) {
      const d = derive(make('double', n));
      const r1 = d.matches.filter((m) => m.label === '승자조 1라운드');
      expect(r1.length).toBe(firstRound);
      const byes = 2 ** Math.ceil(Math.log2(n)) - n;
      const inR1 = new Set(r1.flatMap((m) => m.players));
      for (let s = 0; s < byes; s++) expect(inR1.has(s)).toBe(false);
    }
    const five = derive(make('double', 5)).matches.filter((m) => m.status === 'ready');
    expect(five.map((m) => m.players.map((p) => NAMES[p]))).toEqual([['D', 'E'], ['B', 'C']]);
  });

  test('every sampled path ends with one champion and everyone else out at exactly 2 losses', () => {
    for (let n = 3; n <= 8; n++) {
      for (let run = 0; run < 30; run++) {
        const d = derive(playOut(make('double', n), () => coin()));
        expect(d.matches.some((m) => m.players.includes(null))).toBe(false);
        expect(d.losses[d.champion]).toBeLessThanOrEqual(1);
        const others = d.standings.filter((s) => s.player !== d.champion);
        expect(others.every((s) => s.status === 'eliminated' && s.lossCount === 2)).toBe(true);
        expect(d.standings.map((s) => s.place).sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
        expect([2 * n - 2, 2 * n - 1]).toContain(d.matches.length);
      }
    }
  }, 30000);

  test('losers-bracket finalist wins the grand final: a reset match decides the title', () => {
    for (const n of [3, 5, 6, 8]) {
      let t = playOut(make('double', n), (m) => (m.series === 'gf' ? 1 : 0));
      const d = derive(t);
      const gf = d.matches.filter((m) => m.series === 'gf');
      expect(gf.map((m) => m.label)).toEqual(['그랜드 파이널', '그랜드 파이널 리셋 매치']);
      expect(d.champion).toBe(gf[1].players[1]);
      expect(d.losses[d.champion]).toBe(1);
    }
    const noReset = derive(playOut(make('double', 6), () => 0));
    expect(noReset.matches.filter((m) => m.series === 'gf').length).toBe(1);
    expect(NAMES[noReset.champion]).toBe('A');
  });

  test('4 players keep the original bracket and best of 5 needs three games (double)', () => {
    const d = derive(make('double', 4, 5));
    expect(d.matches.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'gf1']);
    let t = make('double', 4, 5);
    for (let g = 0; g < 2; g++) t = game(t, 'm1', 0);
    expect(find(t, 'm1').status).toBe('live');
    t = game(t, 'm1', 0);
    expect(find(t, 'm1').status).toBe('done');
    expect(find(t, 'm1').score.won).toEqual([3, 0]);
  });
});

const sameShape = (generated, template) => {
  const ids = new Map(generated.map((m, i) => [m.id ?? m.series, template[i].id ?? template[i].series]));
  const ref = (r) => ('winner' in r ? { winner: ids.get(r.winner) } : 'loser' in r ? { loser: ids.get(r.loser) } : r);
  return generated.map((m) => ({ id: ids.get(m.id ?? m.series), stage: m.stage, series: m.series, a: ref(m.a), b: ref(m.b) }));
};
const shape = (tpl) => tpl.map((m) => ({ id: m.id ?? m.series, stage: m.stage, series: m.series, a: m.a, b: m.b }));

describe('triple elimination for 3-8 players', () => {
  test('the generator reproduces the hand-made 4-player brackets (double and triple)', () => {
    expect(sameShape(eliminationBracket(4, 3), TEMPLATES.triple)).toEqual(shape(TEMPLATES.triple));
    expect(sameShape(eliminationBracket(4, 2), TEMPLATES.double)).toEqual(shape(TEMPLATES.double));
  });

  test('byes go to the top seeds; losers bracket B and the losers final exist for every size', () => {
    for (const [n, firstRound] of [[3, 1], [5, 1], [6, 2], [7, 3], [8, 4]]) {
      const d = derive(make('triple', n));
      const r1 = d.matches.filter((m) => m.label === '승자조 1라운드');
      expect(r1.length).toBe(firstRound);
      const byes = 2 ** Math.ceil(Math.log2(n)) - n;
      const inR1 = new Set(r1.flatMap((m) => m.players));
      for (let s = 0; s < byes; s++) expect(inR1.has(s)).toBe(false);
      expect(d.lives).toBe(3);
      expect(d.matches.map((m) => m.stage)).toContain('L2');
      expect(d.matches.at(-2).label).toBe('패자조 최종전');
      expect(d.matches.at(-1).label).toBe('그랜드 파이널');
    }
  });

  test('random results close the bracket for every size: all matches decided, 3 losses out, places 1..N', () => {
    for (let n = 3; n <= 8; n++) {
      for (let run = 0; run < 60; run++) {
        const d = derive(playOut(make('triple', n), () => coin()));
        expect(d.finished).toBe(true);
        expect(d.matches.every((m) => m.status === 'done')).toBe(true);
        expect(d.losses[d.champion]).toBeLessThanOrEqual(2);
        const others = d.standings.filter((s) => s.player !== d.champion);
        expect(others.every((s) => s.status === 'eliminated' && s.lossCount === 3)).toBe(true);
        expect(d.standings.map((s) => s.place).sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
        expect(d.matches.length).toBeGreaterThanOrEqual(3 * n - 3);
        expect(d.matches.length).toBeLessThanOrEqual(3 * n - 1);
      }
    }
  }, 30000);

  test('series resets: the 2-loss B winner must beat the A winner twice, then the unbeaten champion three times', () => {
    for (let n = 3; n <= 8; n++) {
      const t = playOut(make('triple', n), (m) => (m.series ? 1 : 0));
      const d = derive(t);
      expect(d.matches.filter((m) => m.series === 'lf').map((m) => m.label)).toEqual(['패자조 최종전', '패자조 최종전 리셋 매치']);
      const gf = d.matches.filter((m) => m.series === 'gf');
      expect(gf.map((m) => m.label)).toEqual(['그랜드 파이널', '그랜드 파이널 리셋 매치', '그랜드 파이널 리셋 매치 2']);
      expect(d.champion).toBe(gf[0].players[1]);
      expect(d.losses[d.champion]).toBe(2);
      expect(d.standings.find((s) => s.place === 2).player).toBe(gf[0].players[0]);
    }
  });

  test('the unbeaten finalist wins the first grand final: no reset', () => {
    for (let n = 3; n <= 8; n++) {
      const d = derive(playOut(make('triple', n), (m) => (m.series === 'gf' ? 0 : coin())));
      expect(d.matches.filter((m) => m.series === 'gf').length).toBeLessThanOrEqual(2);
      expect(d.losses[d.champion]).toBe(0);
    }
  });
});
