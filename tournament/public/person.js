// A person is a key string, '이름,0712', or just '이름' for tournaments from before player codes.
// There is no account or id. Rules: docs/analytics.md, 선수와 달력.

const CODE_TAIL = /,(\d{4})$/;
const KEY = /^[^,]{1,20}(,\d{4})?$/u;

export function personKey(name, code) {
  const clean = String(name ?? '').normalize('NFKC').trim();
  return code ? `${clean},${code}` : clean;
}

export const isPersonKey = (key) => KEY.test(key);
export const codeOf = (key) => key.match(CODE_TAIL)?.[1] ?? null;
export const displayName = (key) => key.replace(CODE_TAIL, '');

// Same rule as the tournament roster: a person sharing a name with someone else shows the last two
// digits, or all four when those match too. null when the name is unique or the key has no code.
export function personLabel(key, keys) {
  const code = codeOf(key);
  const same = keys.filter((k) => k !== key && displayName(k) === displayName(key));
  if (!code || same.length === 0) return null;
  const clash = same.some((k) => codeOf(k)?.slice(-2) === code.slice(-2));
  return clash ? `·${code}` : `·${code.slice(-2)}`;
}

// Follows aliases to the end. Aliases that loop (only a hand-edited file can) settle on the loop's
// smallest key, so every key on the loop still reads as one person.
export function resolveKey(key, aliases) {
  const path = [key];
  let at = key;
  while (Object.hasOwn(aliases, at)) {
    at = aliases[at];
    const seen = path.indexOf(at);
    if (seen >= 0) return path.slice(seen).toSorted()[0];
    path.push(at);
  }
  return at;
}

// The roster's keys. Two players sharing a name show as '홍길동·12' (feat/player-code); the tail is
// display only, so it is dropped from the key. Tournaments without codes key by name alone.
export function rosterKeys(t) {
  if (!t.codes) return t.players.map((p) => personKey(p));
  const strip = (p, i) => {
    const tail = [`·${t.codes[i]}`, `·${t.codes[i].slice(-2)}`].find((s) => p.endsWith(s));
    return tail ? p.slice(0, -tail.length) : p;
  };
  const stripped = t.players.map(strip);
  const base = t.players.map((p, i) => (stripped.some((s, j) => j !== i && s === stripped[i]) ? stripped[i] : p));
  return base.map((name, i) => personKey(name, t.codes[i]));
}
