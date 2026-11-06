// Pure per-person history, shared by server, screens and tests: every match a person played, the
// month calendar, the week or month trend and the won-against-lost comparison. Rules: docs/analytics.md.
// Names only: nothing returned here carries a player's four digits.
import { TECH_KEYS, analyzeMatch, onePerPoint, slotOfSide } from './analysis.js';
import { displayName, resolveKey, rosterKeys } from './person.js';

const KST_MS = 9 * 3600_000;
const DAY_MS = 86_400_000;
// The server builds these rows, so the name stays Korean data and screens show it through labelText.
const NO_NAME = '이름 없음'; // i18n-data: server-made name, shown via labelText

export const kstDate = (ms) => new Date(ms + KST_MS).toISOString().slice(0, 10);

// A playedAt with no zone already is a local (KST) date or time.
export function galleryDate(playedAt) {
  const text = String(playedAt);
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]*)?$/.test(text)) return text.slice(0, 10);
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : kstDate(ms);
}

// Tournament matches count on the first rally, else the archive date, else the day the tournament was made.
export function tournamentDate(entry, rallies) {
  const ms = rallies[0]?.startedAt ?? entry.archivedAt ?? Date.parse(entry.tournament.createdAt);
  return Number.isFinite(ms) ? kstDate(ms) : null;
}

function summarize(rallies, slot) {
  const kept = onePerPoint(rallies, Infinity);
  if (kept.length === 0) return null;
  const a = analyzeMatch(kept);
  const received = a.serve[1 - slot];
  const speeds = kept.flatMap((r) => r.shots
    .filter((s) => slotOfSide(r, s.side) === slot && Number.isFinite(s.speedKmh))
    .map((s) => s.speedKmh));
  return {
    n: a.n,
    serve: a.serve[slot],
    receive: { n: received.n, won: received.n - received.won },
    tech: a.tech[slot],
    length: a.length.map((l) => ({ label: l.label, n: l.n, won: l.won[slot] })),
    speed: { n: speeds.length, sumKmh: speeds.reduce((sum, v) => sum + v, 0) },
  };
}

function tournamentMatches(entry, target, { aliases, ralliesOf }) {
  const keys = rosterKeys(entry.tournament).map((k) => resolveKey(k, aliases));
  return entry.derived.matches.flatMap((m) => {
    if (m.score === null || m.points.length === 0) return [];
    const slot = m.players.findIndex((p) => keys[p] === target);
    if (slot < 0) return [];
    const rallies = ralliesOf(entry.tournament, m.id);
    return [{
      kind: 'tournament',
      id: `${entry.id}/${m.id}`,
      title: entry.tournament.name,
      date: tournamentDate(entry, rallies),
      opponent: displayName(keys[m.players[1 - slot]]),
      score: { me: m.score.won[slot], them: m.score.won[1 - slot] },
      won: m.status === 'done' ? m.score.winner === slot : null,
      clips: Object.keys(m.clips).length,
      analysis: summarize(rallies, slot),
    }];
  });
}

const galleryScore = (rallies) => [0, 1].map((slot) => rallies.filter((r) => r.winner !== null && slotOfSide(r, r.winner) === slot).length);

function galleryMatches(doc, target, aliases) {
  const keys = [doc.players.near, doc.players.far].map((k) => (k ? resolveKey(k, aliases) : null));
  const slot = keys.indexOf(target);
  if (slot < 0) return [];
  const rallies = onePerPoint(doc.rallies, Infinity);
  const points = galleryScore(rallies);
  const [me, them] = [points[slot], points[1 - slot]];
  const other = keys[1 - slot];
  return [{
    kind: 'gallery',
    id: doc.id,
    title: doc.title,
    date: galleryDate(doc.playedAt),
    opponent: other === null ? NO_NAME : displayName(other),
    score: { me, them },
    won: me === them ? null : me > them,
    clips: 0,
    analysis: summarize(rallies, slot),
  }];
}

// One row per played match: its raw keys, and its date on demand because that reads the rallies.
function playedRows({ tournaments, gallery, ralliesOf }) {
  const inTournaments = tournaments.flatMap((entry) => {
    const keys = rosterKeys(entry.tournament);
    return entry.derived.matches.filter((m) => m.score !== null && m.points.length > 0).map((m) => ({
      keys: m.players.map((p) => keys[p]),
      date: () => tournamentDate(entry, ralliesOf(entry.tournament, m.id)),
    }));
  });
  const inGallery = gallery.map((doc) => ({
    keys: [doc.players.near, doc.players.far].filter(Boolean),
    date: () => galleryDate(doc.playedAt),
  }));
  return [...inTournaments, ...inGallery];
}

export const recordKeys = (sources) => [...new Set(playedRows(sources).flatMap((row) => row.keys))];

// Everyone who played, by resolved key, latest match first: [{ key, matches, lastPlayed }].
export function peopleOf(sources) {
  const people = new Map();
  for (const row of playedRows(sources)) {
    const date = row.date();
    for (const key of new Set(row.keys.map((k) => resolveKey(k, sources.aliases)))) {
      const seen = people.get(key) ?? { key, matches: 0, lastPlayed: null };
      const latest = String(date ?? '') > String(seen.lastPlayed ?? '') ? date : seen.lastPlayed;
      people.set(key, { key, matches: seen.matches + 1, lastPlayed: latest });
    }
  }
  return [...people.values()].toSorted((a, b) => String(b.lastPlayed ?? '').localeCompare(String(a.lastPlayed ?? '')) || a.key.localeCompare(b.key));
}

const newestFirst = (a, b) => String(b.date).localeCompare(String(a.date));

// sources: { tournaments:[{ id, archivedAt, tournament, derived }], gallery:[doc], aliases, ralliesOf(tournament, matchId) }
export function matchesOf(person, { tournaments, gallery, aliases, ralliesOf }) {
  const target = resolveKey(person, aliases);
  return [
    ...tournaments.flatMap((entry) => tournamentMatches(entry, target, { aliases, ralliesOf })),
    ...gallery.flatMap((doc) => galleryMatches(doc, target, aliases)),
  ].toSorted(newestFirst);
}

// The list behind GET /api/analysis/matches: played tournament matches and gallery matches, newest first.
export function matchItems({ tournaments, gallery, aliases, ralliesOf }) {
  const name = (key) => (key ? displayName(resolveKey(key, aliases)) : null);
  const played = tournaments.flatMap((entry) => {
    const keys = rosterKeys(entry.tournament);
    return entry.derived.matches.filter((m) => m.score !== null && m.points.length > 0).map((m) => ({
      kind: 'tournament',
      id: `${entry.id}/${m.id}`,
      title: entry.tournament.name,
      playedAt: tournamentDate(entry, ralliesOf(entry.tournament, m.id)),
      players: { near: name(keys[m.players[0]]), far: name(keys[m.players[1]]) },
      score: { near: m.score.won[0], far: m.score.won[1] },
    }));
  });
  const videos = gallery.map((doc) => {
    const [near, far] = galleryScore(onePerPoint(doc.rallies, Infinity));
    return { kind: 'gallery', id: doc.id, title: doc.title, playedAt: doc.playedAt, players: { near: name(doc.players.near), far: name(doc.players.far) }, score: { near, far } };
  });
  return [...played, ...videos].toSorted((a, b) => String(b.playedAt).localeCompare(String(a.playedAt)));
}

// month is 1..12. Only days with a match are listed, oldest first.
export function calendarMonth(matches, year, month) {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const byDate = Map.groupBy(matches.filter((m) => m.date?.startsWith(prefix)), (m) => m.date);
  const days = [...byDate.entries()].map(([date, list]) => ({
    date,
    matches: list.map(({ kind, id, title, opponent, score, won, clips }) => ({ kind, id, title, opponent, score, won, clips })),
    clips: list.reduce((sum, m) => sum + m.clips, 0),
  }));
  return { month: prefix, days: days.toSorted((a, b) => a.date.localeCompare(b.date)) };
}

// KST dates are compared as plain days: the UTC calendar below only does date arithmetic.
function mondayOf(date) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  const sinceMonday = (new Date(ms).getUTCDay() + 6) % 7;
  return new Date(ms - sinceMonday * DAY_MS).toISOString().slice(0, 10);
}

const addTech = (total, tech) => Object.fromEntries(TECH_KEYS.map((key) => [key, { n: total[key].n + tech[key].n, ok: total[key].ok + tech[key].ok }]));
const emptyTech = () => Object.fromEntries(TECH_KEYS.map((key) => [key, { n: 0, ok: 0 }]));

// period: 'week' (named by its Monday, KST) or 'month'. Only decided matches count, oldest period first.
export function periodTrend(matches, period) {
  const label = period === 'week' ? mondayOf : (date) => date.slice(0, 7);
  const decided = matches.filter((m) => m.date !== null && m.won !== null);
  const rows = [...Map.groupBy(decided, (m) => label(m.date)).entries()].map(([name, list]) => {
    const won = list.filter((m) => m.won).length;
    return {
      period: name,
      played: list.length,
      won,
      winRate: won / list.length,
      tech: list.reduce((total, m) => (m.analysis ? addTech(total, m.analysis.tech) : total), emptyTech()),
    };
  });
  return rows.toSorted((a, b) => a.period.localeCompare(b.period));
}

const rateOf = (won, n) => ({ n, rate: n === 0 ? null : won / n });

function pool(matches) {
  const rows = matches.flatMap((m) => (m.analysis ? [m.analysis] : []));
  const total = (pick, field) => rows.reduce((sum, a) => sum + pick(a)[field], 0);
  const rate = (pick, wonField = 'won') => rateOf(total(pick, wonField), total(pick, 'n'));
  const speedN = total((a) => a.speed, 'n');
  return {
    matches: rows.length,
    serve: rate((a) => a.serve),
    receive: rate((a) => a.receive),
    tech: Object.fromEntries(TECH_KEYS.map((key) => [key, rate((a) => a.tech[key], 'ok')])),
    length: analyzeMatch([]).length.map(({ label }, i) => ({ label, ...rate((a) => a.length[i]) })),
    speed: { n: speedN, avgKmh: speedN === 0 ? null : total((a) => a.speed, 'sumKmh') / speedN },
  };
}

// Pooled over the matches, so a rate's n is the points or shots behind it. Undecided matches and
// matches without analysis stay out.
export function winLossDiff(matches) {
  return { won: pool(matches.filter((m) => m.won === true)), lost: pool(matches.filter((m) => m.won === false)) };
}
