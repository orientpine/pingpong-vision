// Rally analysis store and routes. Lives beside the tournament record and never touches it: scores,
// rev and tournament.json stay out of this file's reach. See docs/analytics.md.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { derive } from './public/engine.js';
import { TECH_KEYS } from './public/analysis.js';
import { fail } from './public/i18n.js';

const MAX_SHOTS = 200;
const MAX_BOUNCES = 400;
const MAX_WHY = 80;
const STROKES = new Set(['포핸드', '백핸드']); // i18n-data: stored shot labels
const KINDS = new Set(['서브', '스매시', '드라이브', '푸시', '로빙']); // i18n-data: stored shot labels
const SIDES = new Set(['near', 'far']);
// live: the phone camera's shot summary. desk: the PC re-analysis of the same point. Both are kept.
const SOURCES = ['live', 'desk'];

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });

export class MalformedRally extends Error {}

function need(condition, what) {
  if (!condition) throw new MalformedRally(what);
}

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function numberOrNull(v, what) {
  need(v === null || v === undefined || Number.isFinite(v), what);
  return v ?? null;
}

function parseLand(land) {
  if (land === null || land === undefined) return null;
  need(isRecord(land) && Number.isFinite(land.tx) && Number.isFinite(land.ty), 'land');
  return { tx: land.tx, ty: land.ty };
}

function parseShot(s) {
  need(isRecord(s) && SIDES.has(s.side) && Number.isFinite(s.t), 'shot');
  need(s.stroke === null || s.stroke === undefined || STROKES.has(s.stroke), 'stroke');
  need(s.kind === null || s.kind === undefined || KINDS.has(s.kind), 'kind');
  return {
    side: s.side,
    t: s.t,
    stroke: s.stroke ?? null,
    kind: s.kind ?? null,
    speedKmh: numberOrNull(s.speedKmh, 'speedKmh'),
    arc: numberOrNull(s.arc, 'arc'),
    inferred: Boolean(s.inferred),
    land: parseLand(s.land),
  };
}

// Vision leaves tx and ty null on an uncalibrated camera, so a bounce may have no position.
function parseBounce(b) {
  need(isRecord(b) && SIDES.has(b.side) && Number.isFinite(b.t), 'bounce');
  return { tx: numberOrNull(b.tx, 'tx'), ty: numberOrNull(b.ty, 'ty'), side: b.side, t: b.t };
}

// Only the documented fields are kept, so nothing but numbers and labels reaches the disk.
// Shots carry no pose: body pose comes from the desk in its own files (later stage).
export function parseRally(r, index) {
  need(isRecord(r) && r.v === 1 && r.index === index, 'rally');
  need(r.source === undefined || SOURCES.includes(r.source), 'source');
  need(Number.isFinite(r.startedAt) && Number.isFinite(r.durationMs) && r.durationMs >= 0, 'rally time');
  need(r.winner === null || SIDES.has(r.winner), 'winner');
  need(r.nearSlot === 0 || r.nearSlot === 1, 'nearSlot');
  need(r.why === null || r.why === undefined || (typeof r.why === 'string' && r.why.length <= MAX_WHY), 'why');
  need(Array.isArray(r.shots) && r.shots.length <= MAX_SHOTS, 'shots');
  need(Array.isArray(r.bounces) && r.bounces.length <= MAX_BOUNCES, 'bounces');
  return {
    v: 1,
    index,
    source: r.source ?? 'live',
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    winner: r.winner,
    nearSlot: r.nearSlot,
    why: r.why ?? null,
    shots: r.shots.map(parseShot),
    bounces: r.bounces.map(parseBounce),
  };
}

// data/analysis/t-<digits of createdAt>.json. Tournaments from before createdAt existed have no file.
export function analysisFileName(createdAt) {
  const digits = String(createdAt ?? '').replace(/\D/g, '');
  return digits ? `t-${digits}.json` : null;
}

function parseAccuracy(data) {
  if (!isRecord(data)) return null;
  const rows = TECH_KEYS.filter((key) => isRecord(data[key])).map((key) => {
    const { precision, recall, n } = data[key];
    return [key, { precision, recall, n }];
  });
  return Object.fromEntries(rows);
}

export function createAnalysis({ dataDir, getStore, readArchive, checkPin, cameraToken, cameraError, defaultAccuracyFile = null, log = console.error }) {
  const dir = join(dataDir, 'analysis');
  const warned = new Set();

  function warnOnce(path, why) {
    if (warned.has(path)) return;
    warned.add(path);
    log(`analysis: ignoring ${path}: ${why}`);
  }

  function readJson(path) {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      warnOnce(path, e.message);
      return null;
    }
  }

  function readDoc(path) {
    const doc = readJson(path);
    if (doc === null || (doc.v === 1 && isRecord(doc.matches))) return doc;
    warnOnce(path, 'not a v1 analysis file');
    return null;
  }

  const pointsOf = (tournament, matchId) => derive(tournament).matches.find((m) => m.id === matchId)?.points ?? null;

  // A point holds { live, desk }. A bare rally (written before sources existed) reads as live.
  function entryOf(slot) {
    if (!isRecord(slot)) return {};
    return slot.v === 1 ? { live: slot } : slot;
  }

  function ralliesOf(tournament, matchId) {
    const points = tournament ? pointsOf(tournament, matchId) : null;
    const name = analysisFileName(tournament?.createdAt);
    if (points === null || name === null) return [];
    const doc = readDoc(join(dir, name));
    if (doc === null || !Object.hasOwn(doc.matches, matchId)) return [];
    const entries = Object.values(doc.matches[matchId].rallies ?? {}).map(entryOf);
    return entries
      .flatMap((entry) => SOURCES.filter((source) => isRecord(entry[source])).map((source) => ({ ...entry[source], source })))
      .filter((r) => r.index < points.length)
      .sort((a, b) => a.index - b.index || SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source));
  }

  function saveRally(tournament, matchId, rally) {
    const path = join(dir, analysisFileName(tournament.createdAt));
    mkdirSync(dir, { recursive: true });
    const doc = readDoc(path);
    // A broken file is kept aside for a look, never overwritten.
    if (doc === null && existsSync(path)) renameSync(path, `${path}.bad-${Date.now()}`);
    const base = doc ?? { v: 1, tournament: tournament.createdAt, matches: {} };
    const old = base.matches[matchId]?.rallies;
    const rallies = { ...old, [rally.index]: { ...entryOf(old?.[rally.index]), [rally.source]: rally } };
    const next = { ...base, matches: { ...base.matches, [matchId]: { rallies } } };
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(next));
    renameSync(tmp, path);
  }

  async function postRally(req) {
    if (cameraToken(req)) return json(cameraError, 403);
    const pin = checkPin(req, req.headers.get('x-pin'));
    if (!pin.ok) return json({ error: pin.error, en: pin.en }, pin.status);

    let rally;
    let matchId;
    try {
      const input = await req.json();
      need(isRecord(input) && typeof input.matchId === 'string' && Number.isInteger(input.index) && input.index >= 0, 'request');
      matchId = input.matchId;
      rally = parseRally(input.rally, input.index);
    } catch (e) {
      if (!(e instanceof SyntaxError || e instanceof MalformedRally)) throw e;
      return json(fail('랠리 기록 형식이 맞지 않아요.', 'Invalid rally record format.'), 400);
    }

    const { tournament } = getStore();
    if (!tournament) return json(fail('진행 중인 대회가 없어요.', 'There is no active tournament.'), 409);
    if (analysisFileName(tournament.createdAt) === null) return json(fail('이 대회는 분석을 저장할 수 없어요.', 'Analysis cannot be saved for this tournament.'), 409);
    const points = pointsOf(tournament, matchId);
    if (points === null || rally.index >= points.length) return json(fail('그 경기나 포인트를 찾을 수 없어요.', 'Match or point not found.'), 404);

    saveRally(tournament, matchId, rally);
    return json({ ok: true });
  }

  const answer = (tournament, matchId) => json({
    rallies: ralliesOf(tournament, matchId),
    accuracy: parseAccuracy(readJson(join(dir, 'accuracy.json'))) ?? (defaultAccuracyFile ? parseAccuracy(readJson(defaultAccuracyFile)) : null),
  });

  function getHistory(id, matchId) {
    if (id !== 'current' && !/^\d{1,16}$/.test(id)) return json(fail('잘못된 기록 번호예요.', 'Invalid history ID.'), 400);
    const saved = id === 'current' ? getStore() : readArchive(id);
    if (!saved?.tournament) return json(fail('기록을 찾을 수 없어요.', 'History not found.'), 404);
    return answer(saved.tournament, matchId);
  }

  // Answers a request under /api/analysis; null leaves it to the rest of the API.
  async function handle(req, url) {
    if (url.pathname === '/api/analysis/rally' && req.method === 'POST') return postRally(req);
    if (req.method !== 'GET') return null;
    const live = url.pathname.match(/^\/api\/analysis\/match\/([^/]+)$/);
    if (live) return answer(getStore().tournament, live[1]);
    const past = url.pathname.match(/^\/api\/analysis\/history\/([^/]+)\/([^/]+)$/);
    return past ? getHistory(past[1], past[2]) : null;
  }

  return { handle, saveRally, ralliesOf };
}
