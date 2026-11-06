// Person aliases (data/analysis/players.json) and the public person read. A merge or rename writes one
// alias and never a match record, so deleting the alias undoes it. Rules: docs/analytics.md, 선수와 달력.
// /api/players/* and the person read by key take the PIN. The public reads go by ref, a short hash of
// the resolved key, so a public URL never holds the four digits. Answers carry names only.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from './desk-results.js';
import { codeOf, displayName, isPersonKey, personKey, personLabel, resolveKey } from './public/person.js';
import { TECH_KEYS } from './public/analysis.js';
import { comparePeriods, parsePeriod, personSamples, unattributedRallies } from './public/pose-stats.js';
import { calendarMonth, kstDate, matchItems, matchesOf, peopleOf, periodTrend, recordKeys, winLossDiff } from './public/trends.js';
import { fail } from './public/i18n.js';

const MAX_NAME = 20;
const REF = /^[0-9a-f]{16}$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const PERIODS = new Set(['week', 'month']);
const ALIAS_PATH = /^\/api\/players\/aliases\/([^/]+)$/;
const PERSON_PATH = /^\/api\/analysis\/person\/([^/]+)$/;
const POSE_PATH = /^\/api\/analysis\/person\/([0-9a-f]{16})\/pose$/;

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const badKey = () => json(fail('선수 이름 형식이 맞지 않아요.', 'Invalid player name format.'), 400);

function keyFrom(text) {
  try {
    const key = personKey(decodeURIComponent(text));
    return isPersonKey(key) ? key : null;
  } catch (e) {
    if (e instanceof URIError) return null;
    throw e;
  }
}

async function readBody(req) {
  try {
    const input = await req.json();
    return isRecord(input) ? input : null;
  } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
}

export const refOf = (key) => createHash('sha256').update(key).digest('hex').slice(0, 16);

const bodyKey = (v) => (typeof v === 'string' && isPersonKey(personKey(v)) ? personKey(v) : null);

export function createPlayers({ dataDir, checkPin, tournaments, ralliesOf, galleryDocs, poseOf = () => null, now = Date.now, log = console.error }) {
  const dir = join(dataDir, 'analysis');
  const path = join(dir, 'players.json');

  // { aliases, broken }: a missing file is empty; a broken one reads as empty and is kept aside on the next write.
  function readFile() {
    if (!existsSync(path)) return { aliases: {}, broken: false };
    let doc = null;
    try {
      doc = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
    if (isRecord(doc) && doc.v === 1 && isRecord(doc.aliases)) {
      return { aliases: Object.fromEntries(Object.entries(doc.aliases).filter(([, to]) => typeof to === 'string')), broken: false };
    }
    log(`players: ignoring ${path}: not a v1 players file`);
    return { aliases: {}, broken: true };
  }

  function write(aliases, broken) {
    mkdirSync(dir, { recursive: true });
    if (broken) renameSync(path, `${path}.bad-${now()}`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, aliases }));
    renameSync(tmp, path);
  }

  // Moves the person from now is, so an earlier alias stays and its undo still works.
  function link(fromKey, toKey) {
    const { aliases, broken } = readFile();
    const from = resolveKey(fromKey, aliases);
    const to = resolveKey(toKey, aliases);
    if (from === to) return json(fail('이미 같은 사람이에요.', 'These are already the same person.'), 409);
    const next = { ...aliases, [from]: to };
    write(next, broken);
    return json({ ok: true, aliases: next });
  }

  async function merge(req) {
    const input = await readBody(req);
    const [from, to] = [bodyKey(input?.from), bodyKey(input?.to)];
    return from && to ? link(from, to) : badKey();
  }

  async function rename(req) {
    const input = await readBody(req);
    const from = bodyKey(input?.from);
    const name = typeof input?.toName === 'string' ? personKey(input.toName) : '';
    if (!from || name.length === 0 || name.length > MAX_NAME || name.includes(',')) return badKey();
    const { aliases } = readFile();
    return link(from, personKey(name, codeOf(resolveKey(from, aliases))));
  }

  function undo(text) {
    const from = keyFrom(text);
    if (!from) return badKey();
    const { aliases, broken } = readFile();
    if (!Object.hasOwn(aliases, from)) return json(fail('되돌릴 연결이 없어요.', 'No link to undo.'), 404);
    const { [from]: _gone, ...rest } = aliases;
    write(rest, broken);
    return json({ ok: true, aliases: rest });
  }

  const sources = () => ({ tournaments: tournaments(), gallery: galleryDocs(), aliases: readFile().aliases, ralliesOf, poseOf });

  function people() {
    const list = peopleOf(sources());
    const keys = list.map((p) => p.key);
    return json({
      people: list.map(({ key, matches, lastPlayed }) => {
        const label = personLabel(key, keys);
        return { ref: refOf(key), name: displayName(key), ...(label ? { label } : {}), matches, lastPlayed };
      }),
    });
  }

  // A ref also finds its person through any key in the records or aliases, so a link made before a
  // merge or rename still opens the person that key belongs to now.
  function keyOfRef(ref, from) {
    const known = [...recordKeys(from), ...Object.entries(from.aliases).flat()].find((k) => refOf(k) === ref);
    return known === undefined ? null : resolveKey(known, from.aliases);
  }

  // No header at all is refused here so a public visitor never counts toward the PIN lockout.
  function personByKey(req, text, url) {
    if (!req.headers.get('x-pin')) return json(fail('PIN이 필요해요.', 'A PIN is required.'), 403);
    const pin = checkPin(req, req.headers.get('x-pin'));
    if (!pin.ok) return json({ error: pin.error, en: pin.en }, pin.status);
    const key = keyFrom(text);
    return key ? answerPerson(key, url, sources()) : badKey();
  }

  function personByRef(ref, url) {
    const from = sources();
    const key = keyOfRef(ref, from);
    return key === null ? json(fail('선수를 찾을 수 없어요.', 'Player not found.'), 404) : answerPerson(key, url, from);
  }

  // Public: names only. The screen must say depth is an estimate, so the answer carries that too.
  function personPose(ref, url) {
    const tech = url.searchParams.get('tech');
    const [a, b] = [parsePeriod(url.searchParams.get('a')), parsePeriod(url.searchParams.get('b'))];
    if (!TECH_KEYS.includes(tech) || !a || !b) return json(fail('기술이나 기간 형식이 맞지 않아요.', 'Invalid technique or date range.'), 400);
    const from = sources();
    const key = keyOfRef(ref, from);
    if (key === null) return json(fail('선수를 찾을 수 없어요.', 'Player not found.'), 404);
    return json({ person: { ref: refOf(key), name: displayName(key) }, depthEstimated: true, unattributedRallies: unattributedRallies(key, from), ...comparePeriods(personSamples(key, from), tech, a, b) });
  }

  function answerPerson(key, url, from) {
    const monthText = url.searchParams.get('month') ?? kstDate(now()).slice(0, 7);
    const period = url.searchParams.get('period') ?? 'month';
    const month = monthText.match(MONTH);
    if (!month || !PERIODS.has(period)) return json(fail('달이나 기간 형식이 맞지 않아요.', 'Invalid month or date range.'), 400);
    const matches = matchesOf(key, from);
    const resolved = resolveKey(key, from.aliases);
    return json({
      person: { ref: refOf(resolved), name: displayName(resolved) },
      matches,
      calendar: calendarMonth(matches, Number(month[1]), Number(month[2])),
      trend: periodTrend(matches, period),
      winLoss: winLossDiff(matches),
    });
  }

  function route(req, url) {
    const { pathname } = url;
    const alias = pathname.match(ALIAS_PATH);
    if (pathname === '/api/players/aliases' && req.method === 'GET') return () => json({ aliases: readFile().aliases });
    if (pathname === '/api/players/merge' && req.method === 'POST') return () => merge(req);
    if (pathname === '/api/players/rename' && req.method === 'POST') return () => rename(req);
    return alias && req.method === 'DELETE' ? () => undo(alias[1]) : null;
  }

  // Answers the people and person reads and /api/players/*; null leaves the request to the rest of the API.
  function handle(req, url) {
    if (url.pathname === '/api/analysis/people' && req.method === 'GET') return people();
    const posed = url.pathname.match(POSE_PATH);
    if (posed && req.method === 'GET') return personPose(posed[1], url);
    const asked = url.pathname.match(PERSON_PATH);
    if (asked && req.method === 'GET') return REF.test(asked[1]) ? personByRef(asked[1], url) : personByKey(req, asked[1], url);
    const run = route(req, url);
    if (!run) return null;
    const pin = checkPin(req, req.headers.get('x-pin'));
    return pin.ok ? run() : json({ error: pin.error, en: pin.en }, pin.status);
  }

  return { handle, matchItems: () => matchItems(sources()) };
}
