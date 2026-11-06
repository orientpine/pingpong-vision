import { describe, expect, test } from 'bun:test';
import { derive, addPoint, createTournament } from '../public/engine.js';
import { personKey, personLabel, resolveKey, rosterKeys, displayName } from '../public/person.js';
import { calendarMonth, matchesOf, peopleOf, periodTrend, winLossDiff } from '../public/trends.js';

// The four digits here are made up.
const shot = (side, kind, stroke = '포핸드', speedKmh = 30) => ({ side, t: 0, stroke, kind, speedKmh, arc: 0, inferred: false, land: null });
const rally = (index, winner, startedAt, shots) => ({ v: 1, index, source: 'live', startedAt, durationMs: 1000, winner, nearSlot: 0, why: null, shots, bounces: [] });

// Seed 0 has a bye, so the first match is roster 1 (slot 0) against roster 2 (slot 1).
// Slot 0 serves a forehand drive that wins, or the slot 1 return fails.
const nearWins = (index, at) => rally(index, 'near', at, [shot('near', '서브'), shot('far', '드라이브', '백핸드', 50)]);
const farWins = (index, at) => rally(index, 'far', at, [shot('near', '서브', '포핸드', 10)]);

// A tournament saved before player codes: plain names and no codes field.
const plainTournament = (opts) => {
  const { codes: _codes, ...t } = createTournament({ ...opts, players: opts.players.map((p, i) => `${p},${String(i).padStart(4, '0')}`) });
  return { ...t, players: opts.players };
};
function played(players, codes, results) {
  let t = { ...plainTournament({ players, pointsToWin: 1, winBy: 1 }), ...(codes ? { codes } : {}) };
  for (const side of results) {
    const m = derive(t).matches.find((x) => x.status === 'ready' || x.status === 'live');
    t = addPoint(t, m.id, side, m.points.length);
  }
  return t;
}
const entry = (id, tournament, archivedAt = null) => ({ id, archivedAt, tournament, derived: derive(tournament) });
const noRallies = () => [];
const sources = (over) => ({ tournaments: [], gallery: [], aliases: {}, ralliesOf: noRallies, ...over });

describe('person keys', () => {
  test('a key is the NFKC-trimmed name and the four digits, or the name alone without a code', () => {
    expect(personKey(' 홍길동 ', '0712')).toBe('홍길동,0712');
    expect(personKey('홍길동，0712')).toBe('홍길동,0712');
    expect(personKey('홍길동', undefined)).toBe('홍길동');
    expect(displayName('홍길동,0712')).toBe('홍길동');
  });

  test('roster keys drop the shared-name tail and old tournaments key by name only', () => {
    const coded = { players: ['홍길동·12', '홍길동·21', '김하나'], codes: ['0712', '4821', '1111'] };
    expect(rosterKeys(coded)).toEqual(['홍길동,0712', '홍길동,4821', '김하나,1111']);
    expect(rosterKeys({ players: ['홍길동', '김하나'] })).toEqual(['홍길동', '김하나']);
  });

  test('a shared name shows two digits, or four when those match too', () => {
    expect(personLabel('홍길동,0712', ['홍길동,0712', '홍길동,4821'])).toBe('·12');
    expect(personLabel('홍길동,0712', ['홍길동,0712', '홍길동,5512'])).toBe('·0712');
    expect(personLabel('홍길동,0712', ['홍길동,0712', '김하나,0712'])).toBeNull();
    expect(personLabel('홍길동', ['홍길동', '홍길동,0712'])).toBeNull();
  });

  test('aliases are followed to the end', () => {
    expect(resolveKey('a', { a: 'b', b: 'c' })).toBe('c');
    expect(resolveKey('z', { a: 'b' })).toBe('z');
    expect(resolveKey('constructor', {})).toBe('constructor');
  });

  test('a loop settles on one key for every member', () => {
    const aliases = { b: 'a', a: 'c', c: 'b' };
    expect(['a', 'b', 'c'].map((k) => resolveKey(k, aliases))).toEqual(['a', 'a', 'a']);
    expect(resolveKey('x', { x: 'x' })).toBe('x');
  });
});

describe('matchesOf', () => {
  const old = played(['이도윤', '홍길동', '김하나'], null, [0, 0]);
  const coded = played(['이도윤', '홍길동', '김하나'], ['1111', '0712', '4821'], [1, 1]);

  test('an old tournament without codes belongs to the bare name until an alias joins it', () => {
    const tournaments = [entry('1', old, Date.UTC(2026, 9, 1)), entry('current', coded)];
    expect(matchesOf('홍길동', sources({ tournaments })).map((m) => m.id)).toEqual([`1/${derive(old).matches[0].id}`]);
    expect(matchesOf('홍길동,0712', sources({ tournaments }))).toHaveLength(1);
    expect(matchesOf('홍길동,0712', sources({ tournaments, aliases: { 홍길동: '홍길동,0712' } }))).toHaveLength(2);
  });

  test('a match carries opponent name, score, result, clips and the date of its first rally', () => {
    const m0 = derive(coded).matches[0].id;
    const ralliesOf = (_t, id) => (id === m0 ? [farWins(0, Date.UTC(2026, 10, 3, 1)), farWins(1, Date.UTC(2026, 10, 3, 2))] : []);
    const [m] = matchesOf('김하나,4821', sources({ tournaments: [entry('current', coded)], ralliesOf }));
    expect(m).toMatchObject({ kind: 'tournament', opponent: '홍길동', score: { me: 2, them: 0 }, won: true, date: '2026-11-03', clips: 0 });
    expect(m.analysis.serve).toEqual({ n: 0, won: 0 });
    expect(m.analysis.receive).toEqual({ n: 2, won: 2 });
  });

  test('without rallies a tournament match counts on the archive date', () => {
    const [m] = matchesOf('홍길동', sources({ tournaments: [entry('9', old, Date.UTC(2026, 9, 31, 15))] }));
    expect(m.date).toBe('2026-11-01');
    expect(m.analysis).toBeNull();
  });

  test('a gallery match counts on playedAt and scores by rally winner', () => {
    const doc = { id: 'g1', title: '연습', playedAt: '2026-10-20', players: { near: '홍길동,0712', far: null }, rallies: [nearWins(0, 0), nearWins(1, 0), farWins(2, 0)] };
    const [m] = matchesOf('홍길동,0712', sources({ gallery: [doc] }));
    expect(m).toMatchObject({ kind: 'gallery', date: '2026-10-20', opponent: '이름 없음', score: { me: 2, them: 1 }, won: true });
  });

  test('nothing returned carries the four digits', () => {
    const doc = { id: 'g1', title: '연습', playedAt: '2026-10-20', players: { near: '홍길동,0712', far: '김하나,4821' }, rallies: [nearWins(0, 0)] };
    const out = matchesOf('홍길동,0712', sources({ tournaments: [entry('current', coded)], gallery: [doc] }));
    expect(out.length).toBe(2);
    expect(JSON.stringify(out)).not.toMatch(/0712|4821|1111/);
  });

  test('an unknown person has no matches, no calendar days, no trend and empty comparisons', () => {
    const out = matchesOf('없는사람,0000', sources({ tournaments: [entry('current', coded)] }));
    expect(out).toEqual([]);
    expect(calendarMonth(out, 2026, 11).days).toEqual([]);
    expect(periodTrend(out, 'week')).toEqual([]);
    const diff = winLossDiff(out);
    expect(diff.won.matches).toBe(0);
    expect(diff.lost.serve).toEqual({ n: 0, rate: null });
    expect(diff.lost.speed.avgKmh).toBeNull();
  });
});

describe('peopleOf', () => {
  test('everyone who played is counted once per match under the resolved key, latest first', () => {
    const old = played(['이도윤', '홍길동', '김하나'], null, [0, 0]);
    const doc = { id: 'g1', title: '', playedAt: '2026-11-05', players: { near: '김하나,4821', far: null }, rallies: [] };
    const list = peopleOf(sources({ tournaments: [entry('1', old, Date.UTC(2026, 9, 1))], gallery: [doc], aliases: { 김하나: '김하나,4821' } }));
    expect(list).toEqual([
      { key: '김하나,4821', matches: 2, lastPlayed: '2026-11-05' },
      { key: '홍길동', matches: 1, lastPlayed: '2026-10-01' },
    ]);
  });
});

const at = (date, won, extra = {}) => ({ kind: 'gallery', id: date, title: '', date, opponent: 'x', score: { me: 1, them: 0 }, won, clips: 1, analysis: null, ...extra });

describe('calendar and trend', () => {
  test('a month lists only its days with score and clip count', () => {
    const cal = calendarMonth([at('2026-10-31', true), at('2026-11-01', false, { clips: 3 }), at('2026-11-01', true)], 2026, 11);
    expect(cal.month).toBe('2026-11');
    expect(cal.days.map((d) => [d.date, d.matches.length, d.clips])).toEqual([['2026-11-01', 2, 4]]);
    expect(cal.days[0].matches[0].score).toEqual({ me: 1, them: 0 });
  });

  test('weeks start on Monday in KST: Sunday 23:59 and Monday 00:00 KST fall in different weeks', () => {
    const tournaments = [
      entry('1', played(['이도윤', '홍길동', '김하나'], null, [0, 0]), Date.UTC(2026, 10, 1, 14, 59)),
      entry('2', played(['이도윤', '홍길동', '김하나'], null, [1, 1]), Date.UTC(2026, 10, 1, 15, 0)),
    ];
    const matches = matchesOf('홍길동', sources({ tournaments }));
    expect(matches.map((m) => m.date).toSorted()).toEqual(['2026-11-01', '2026-11-02']);
    expect(periodTrend(matches, 'week').map((r) => [r.period, r.played, r.won, r.winRate])).toEqual([['2026-10-26', 1, 1, 1], ['2026-11-02', 1, 0, 0]]);
  });

  test('months split at KST midnight and undecided matches stay out of the trend', () => {
    const rows = periodTrend([at('2026-10-31', true), at('2026-11-01', false), at('2026-11-30', true), at('2026-11-02', null)], 'month');
    expect(rows.map((r) => [r.period, r.played, r.won])).toEqual([['2026-10', 1, 1], ['2026-11', 2, 1]]);
  });

  test('the trend adds technique counts of the period', () => {
    const tech = { 'fore-attack': { n: 2, ok: 1 }, 'fore-defence': { n: 0, ok: 0 }, 'fore-serve': { n: 1, ok: 1 }, 'back-attack': { n: 0, ok: 0 }, 'back-defence': { n: 0, ok: 0 }, 'back-serve': { n: 0, ok: 0 } };
    const [row] = periodTrend([at('2026-11-02', true, { analysis: { tech } }), at('2026-11-03', false, { analysis: { tech } })], 'week');
    expect(row.tech['fore-attack']).toEqual({ n: 4, ok: 2 });
  });
});

describe('winLossDiff', () => {
  test('rates are pooled over won and lost matches with their n', () => {
    const t = played(['이도윤', '홍길동', '김하나'], null, [0, 0]);
    const ralliesOf = () => [nearWins(0, 1), nearWins(1, 1)];
    const won = matchesOf('홍길동', sources({ tournaments: [entry('1', t, 1)], ralliesOf }));
    const lost = matchesOf('김하나', sources({ tournaments: [entry('1', t, 1)], ralliesOf }));
    const diff = winLossDiff([...won, ...lost]);
    expect(diff.won.matches).toBe(1);
    expect(diff.won.serve).toEqual({ n: 2, rate: 1 });
    expect(diff.lost.receive).toEqual({ n: 2, rate: 0 });
    expect(diff.lost.tech['back-attack']).toEqual({ n: 2, rate: 0 });
    expect(diff.won.length[0]).toEqual({ label: '1~2구', n: 2, rate: 1 });
    expect(diff.won.speed).toEqual({ n: 2, avgKmh: 30 });
    expect(diff.lost.speed).toEqual({ n: 2, avgKmh: 50 });
  });
});
