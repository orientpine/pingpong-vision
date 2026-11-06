import { expect, test } from 'bun:test';
import { nameOf, normalizeKey, suggest } from '../public/people-pick.js';

const PEOPLE = [
  { entry: '홍길동,0712', name: '홍길동', code: '0712', note: '' },
  { entry: '홍길동,0788', name: '홍길동', code: '0788', note: '' },
  { entry: '이서,0315', name: '이서', code: '0315', note: '' },
  { entry: '이써,0315', name: '이써', code: '0315', note: '' },
  { entry: '가온', name: '가온', code: null, note: '' },
];

test('a typed initial consonant matches the syllable that starts with it; a full-width comma and a space read as the comma', () => {
  expect(suggest(PEOPLE, 'ㅎ').map((e) => e.entry)).toEqual(['홍길동,0712', '홍길동,0788']);
  expect(suggest(PEOPLE, 'ㅎㄱㄷ').map((e) => e.entry)).toEqual(['홍길동,0712', '홍길동,0788']);
  expect(suggest(PEOPLE, 'ㅇㅅ').map((e) => e.entry)).toEqual(['이서,0315']);
  expect(suggest(PEOPLE, '홍길동，07').map((e) => e.entry)).toEqual(['홍길동,0712', '홍길동,0788']);
  expect(suggest(PEOPLE, '홍길동 078').map((e) => e.entry)).toEqual(['홍길동,0788']);
});

test('nothing typed, or an entry already typed exactly, suggests nothing', () => {
  expect(suggest(PEOPLE, '')).toEqual([]);
  expect(suggest(PEOPLE, '이서,0315')).toEqual([]);
  expect(suggest(PEOPLE, '가온')).toEqual([]);
});

test('keys normalise the way the server stores them, and names drop the four digits', () => {
  expect(normalizeKey(' 홍길동，0712 ')).toBe('홍길동,0712');
  expect(normalizeKey('홍길동 0712')).toBe('홍길동,0712');
  expect(nameOf('홍길동,0712')).toBe('홍길동');
  expect(nameOf('가온')).toBe('가온');
  expect(nameOf(null)).toBeNull();
});
