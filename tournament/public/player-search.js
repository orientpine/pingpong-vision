import { baseNames } from './engine.js';

// People already registered as '이름,네자리', for the setup screen's name dropdown.

// saves: [{ tournament, at }] where `at` is when that tournament was last used (ISO time).
// Tournaments from before player codes carry no `codes` and add nobody. Newest first, one row a person.
export function registeredPlayers(saves) {
  const latest = new Map();
  for (const { tournament: t, at } of saves) {
    if (!t?.codes) continue;
    const names = baseNames(t);
    names.forEach((name, i) => {
      const key = `${name},${t.codes[i]}`;
      const seen = latest.get(key);
      if (!seen || seen.lastUsed < at) latest.set(key, { name, code: t.codes[i], lastUsed: at });
    });
  }
  return [...latest.values()].sort((a, b) => (a.lastUsed < b.lastUsed ? 1 : a.lastUsed > b.lastUsed ? -1 : 0));
}

const INITIALS = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'; // i18n-data: Korean initial-consonant (초성) matching rule
const initialOf = (ch) => {
  const c = ch.codePointAt(0) - 0xac00;
  return c >= 0 && c < 11172 ? INITIALS[Math.floor(c / 588)] : ch;
};

// A typed character matches the same character, or a syllable starting with that initial consonant
// (ㅎㄱ matches 홍길동). Matching runs from the start of '이름,네자리'.
const startsLike = (text, query) => [...query].every((q, i) => {
  const ch = text[i];
  return ch !== undefined && (ch === q || (INITIALS.includes(q) && initialOf(ch) === q));
});

// people stay in the order given (newest first). An exact '이름,네자리' already typed shows nothing.
export function matchPlayers(people, typed, limit = 6) {
  // NFC, not NFKC: NFKC turns a typed initial (U+314A) into a conjoining jamo that matches nothing.
  const query = String(typed ?? '').normalize('NFC').trim().replace(/[\s，]*,[\s，]*|\s+(?=\d)/g, ',');
  if (!query) return [];
  const entries = people.map((p) => ({ ...p, entry: `${p.name},${p.code}` }));
  if (entries.some((p) => p.entry === query)) return [];
  return entries.filter((p) => startsLike(p.entry, query)).slice(0, limit);
}
