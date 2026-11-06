import { describe, expect, test } from 'bun:test';
import { RuleError, addPoint, createTournament, derive, parsePlayerEntry, renamePlayer, undoPoint, updateSetup } from '../public/engine.js';
import { matchPlayers, registeredPlayers } from '../public/player-search.js';

// '이름,네자리' (e.g. 홍길동,0712 with any four digits): the 4 digits tell apart
// people with the same name. The digits in these tests are made up.

describe('parsePlayerEntry', () => {
  test.each(['홍길동,0712', '홍길동，0712', '홍길동 0712', '  홍길동 , 0712 ', '홍길동\t0712'])('reads name and code from %p', (text) => {
    expect(parsePlayerEntry(text)).toEqual({ name: '홍길동', code: '0712' });
  });

  test('keeps commas and spaces inside the name; only the trailing 4 digits are the code', () => {
    expect(parsePlayerEntry('홍 길동,1234')).toEqual({ name: '홍 길동', code: '1234' });
    expect(parsePlayerEntry('A,B 0001')).toEqual({ name: 'A,B', code: '0001' });
  });

  test.each(['', '홍길동', '홍길동,712', '홍길동,07123', '홍길동0712', ',0712', '홍길동,07a2', `${'가'.repeat(21)},0712`])('refuses %p', (text) => {
    expect(parsePlayerEntry(text).error).toBeString();
  });
});

const coded = (players) => createTournament({ name: 't', players });

describe('new tournaments store names and codes by slot', () => {
  test('players hold the shown names and codes the 4 digits', () => {
    const t = coded(['홍길동,0712', '김민수,1111', '이영희,2222', '박철수,3333']);
    expect(t.players).toEqual(['홍길동', '김민수', '이영희', '박철수']);
    expect(t.codes).toEqual(['0712', '1111', '2222', '3333']);
  });

  test('the same name with different codes shows the last two digits', () => {
    const t = coded(['홍길동,0712', '홍길동,1234', '이영희,2222']);
    expect(t.players).toEqual(['홍길동·12', '홍길동·34', '이영희']);
  });

  test('the same name and code twice is refused', () => {
    expect(() => coded(['홍길동,0712', '홍길동,0712', '이영희,2222'])).toThrow(RuleError);
  });

  test('the same name whose codes end in the same two digits shows all four digits for those two', () => {
    const t = coded(['홍길동,0712', '홍길동,1112', '홍길동,3456', '이영희,2222']);
    expect(t.players).toEqual(['홍길동·0712', '홍길동·1112', '홍길동·56', '이영희']);
    expect(t.codes).toEqual(['0712', '1112', '3456', '2222']);
  });

  test('four-digit tails come off again for a rename and setup edit', () => {
    const t = coded(['홍길동,0712', '홍길동,1112', '이영희,2222']);
    expect(renamePlayer(t, 1, '박철수').players).toEqual(['홍길동', '박철수', '이영희']);
    expect(updateSetup(t, { players: ['이영희', '홍길동·1112', '홍길동·0712'] }).codes).toEqual(['2222', '1112', '0712']);
    expect(registeredPlayers([{ tournament: t, at: '1' }]).map((p) => p.name)).toEqual(['홍길동', '홍길동', '이영희']);
  });

  test('a new player without a code is refused with the slot number', () => {
    expect(() => coded(['홍길동,0712', '김민수', '이영희,2222'])).toThrow('2번 참가자');
  });
});

describe('coded tournaments keep codes on rename and setup edit', () => {
  const t = coded(['홍길동,0712', '김민수,1111', '이영희,2222', '박철수,3333']);

  test('a rename keeps the slot code', () => {
    const n = renamePlayer(t, 1, '김민준');
    expect(n.players[1]).toBe('김민준');
    expect(n.codes).toEqual(t.codes);
  });

  test('a rename onto a name already there adds the two digits to both', () => {
    const n = renamePlayer(t, 1, '홍길동');
    expect(n.players.slice(0, 2)).toEqual(['홍길동·12', '홍길동·11']);
    expect(renamePlayer(n, 1, '김민수').players.slice(0, 2)).toEqual(['홍길동', '김민수']);
  });

  test('a setup edit that reorders the shown names moves each code with its person', () => {
    const n = updateSetup(t, { players: ['박철수', '이영희', '김민수', '홍길동'] });
    expect(n.codes).toEqual(['3333', '2222', '1111', '0712']);
  });

  test('a setup edit adding a person without a code is refused; with a code it is kept', () => {
    expect(() => updateSetup(t, { players: [...t.players, '새선수'] })).toThrow(RuleError);
    expect(updateSetup(t, { players: [...t.players, '새선수,4444'] }).codes).toEqual([...t.codes, '4444']);
  });
});

describe('tournaments saved before player codes', () => {
  const old = { name: '옛 대회', format: 'double', bestOf: 3, pointsToWin: 11, winBy: 2, players: ['A', 'B', 'C', 'D'], log: {}, createdAt: '2026-10-01T00:00:00.000Z' };

  test('derive, score and undo work without codes', () => {
    const scored = addPoint(old, 'm1', 0, 0);
    expect(derive(scored).matches[0].points).toEqual([0]);
    expect(undoPoint(scored, 'm1', 1).log.m1.points).toEqual([]);
  });

  test('rename and setup edit keep plain names and add no codes', () => {
    const renamed = renamePlayer(old, 0, '에이');
    expect(renamed.players).toEqual(['에이', 'B', 'C', 'D']);
    expect('codes' in renamed).toBe(false);
    const edited = updateSetup(old, { players: ['D', 'C', 'B', 'A'], format: 'triple' });
    expect(edited.players).toEqual(['D', 'C', 'B', 'A']);
    expect('codes' in edited).toBe(false);
  });
});

describe('name dropdown', () => {
  const people = [
    { name: '홍길동', code: '0712', lastUsed: '3' },
    { name: '한민수', code: '1111', lastUsed: '2' },
    { name: '김철수', code: '2222', lastUsed: '1' },
  ];
  const entries = (q) => matchPlayers(people, q).map((p) => p.entry);

  test('initial consonants match syllables: ㅎㄱ finds 홍길동 and not 한민수', () => {
    expect(entries('ㅎㄱ')).toEqual(['홍길동,0712']);
  });

  test('leading characters and mixed input match in the given (newest first) order', () => {
    expect(entries('ㅎ')).toEqual(['홍길동,0712', '한민수,1111']);
    expect(entries('홍ㄱ')).toEqual(['홍길동,0712']);
    expect(entries('홍길동 07')).toEqual(['홍길동,0712']);
  });

  test('nothing typed, no match, or an exact entry shows no list', () => {
    expect(entries('')).toEqual([]);
    expect(entries('ㅍ')).toEqual([]);
    expect(entries('홍길동,0712')).toEqual([]);
  });

  test('registered people come newest first, one row each, with the shared-name tail removed', () => {
    const older = coded(['홍길동,0712', '홍길동,1234', '이영희,2222']);
    const newer = coded(['홍길동,0712', '박철수,3333', '김민수,1111']);
    const plain = { ...older, codes: undefined };
    const list = registeredPlayers([
      { tournament: older, at: '2026-10-01T00:00:00.000Z' },
      { tournament: newer, at: '2026-10-31T00:00:00.000Z' },
      { tournament: plain, at: '2026-11-01T00:00:00.000Z' },
    ]);
    expect(list.map((p) => `${p.name},${p.code}`)).toEqual(['홍길동,0712', '박철수,3333', '김민수,1111', '홍길동,1234', '이영희,2222']);
    expect(list[0].lastUsed).toBe('2026-10-31T00:00:00.000Z');
  });
});
