// 카메라 판정 기록 (data/judge-log.jsonl): one JSON line per camera call and per change to a point, beside
// action.log and never mixed into it. The camera sends its call (POST /api/judge, PIN); the server writes
// what happened to the point itself from /api/action (point, undo, flip, clip), so the referee's answer is
// recorded even when the camera phone is off. Numbers, sides and ids only: no names, no PIN, no video.
// Writing never stands in the way of a score: a failed write is logged on the console and the action goes on.
// GET /api/judge/summary answers the comparison (public/judge-compare.js) for the current tournament.
// See docs/judge-log.md.
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { derive } from './public/engine.js';
import { fail } from './public/i18n.js';
import { compareJudge } from './public/judge-compare.js';

export const JUDGE_LOG = 'judge-log.jsonl';
const MAX_BYTES = 4 * 1024 * 1024;
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const WORD = /^[a-z_]{1,24}$/;
const DROPS = new Set(['replaced', 'let', 'rally', 'timeout', 'fix']);
const BY = new Set(['camera', 'camera-fix']);

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });

export class MalformedJudge extends Error {}
function need(ok, what) {
  if (!ok) throw new MalformedJudge(what);
}
const end = (v, what) => {
  need(v === 0 || v === 1, what);
  return v;
};
const endOrNull = (v, what) => (v === null || v === undefined ? null : end(v, what));
const count = (v, what) => {
  need(Number.isInteger(v) && v >= 0 && v <= 9999, what);
  return v;
};
const msOrNull = (v, what) => {
  need(v === null || v === undefined || (Number.isFinite(v) && v >= 0), what);
  return v ?? null;
};
const word = (v, what) => {
  need(v === null || v === undefined || (typeof v === 'string' && WORD.test(v)), what);
  return v ?? null;
};

// Only the documented fields are kept, so nothing else a camera sends reaches the disk.
export function parseJudge(b) {
  need(b && typeof b === 'object' && !Array.isArray(b), 'body');
  need(typeof b.id === 'string' && ID.test(b.id), 'id');
  if (b.t === 'drop') {
    need(DROPS.has(b.why), 'why');
    return { t: 'drop', id: b.id, why: b.why };
  }
  need(b.t === 'call', 't');
  need(typeof b.matchId === 'string' && ID.test(b.matchId), 'matchId');
  const c = b.call;
  need(c && typeof c === 'object', 'call');
  const rally = b.rally && typeof b.rally === 'object' ? { startMs: msOrNull(b.rally.startMs, 'startMs'), endMs: msOrNull(b.rally.endMs, 'endMs') } : null;
  need(b.camera === null || b.camera === undefined || (typeof b.camera === 'string' && ID.test(b.camera)), 'camera');
  need(b.mode === undefined || b.mode === 'confirm' || b.mode === 'auto', 'mode');
  return {
    t: 'call',
    id: b.id,
    matchId: b.matchId,
    index: count(b.index, 'index'),
    call: { end: end(c.end, 'end'), slot: end(c.slot, 'slot'), sure: c.sure === true, weak: c.weak === true, why: word(c.why, 'why'), reason: word(c.reason, 'reason'), shots: count(c.shots ?? 0, 'shots'), bounces: count(c.bounces ?? 0, 'bounces') },
    pre: endOrNull(b.pre, 'pre'),
    guess: endOrNull(b.guess, 'guess'),
    hold: b.hold === true,
    disagree: b.disagree === true,
    rally,
    camera: b.camera ?? null,
    mode: b.mode ?? 'confirm',
  };
}

export function createJudgeLog({ dataDir, getStore, checkPin, cameraToken, cameraError }) {
  const file = join(dataDir, JUDGE_LOG);

  function write(rec) {
    const t = getStore().tournament;
    if (!t) return;
    try {
      if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
      appendFileSync(file, `${JSON.stringify({ v: 1, at: Date.now(), tour: String(t.createdAt ?? ''), ...rec })}\n`);
    } catch (e) {
      console.error('judge log write failed', e);
    }
  }

  // After /api/action changed the record: before is the tournament as it was. Called inside a try by the
  // server, and only for the four kinds that move a point or its clip.
  function onAction(a, before, req) {
    const by = BY.has(req.headers.get('x-ppv-by')) ? req.headers.get('x-ppv-by') : 'referee';
    const pts = before?.log?.[a.matchId]?.points ?? [];
    // the end colour the point went to (0 blue, 1 red), from the ends it was played at
    const end = () => {
      const ends = derive(before).matches.find((m) => m.id === a.matchId)?.ends ?? [0, 1];
      return ends[0] === a.side ? 0 : 1;
    };
    if (a.type === 'point') write({ t: 'point', matchId: a.matchId, index: pts.length, side: a.side, end: end(), by });
    else if (a.type === 'undo' && pts.length) write({ t: 'undo', matchId: a.matchId, index: pts.length - 1, side: pts.at(-1), by });
    else if (a.type === 'flip' && Number.isInteger(a.index) && a.index < pts.length) write({ t: 'flip', matchId: a.matchId, index: a.index, side: 1 - pts[a.index], by });
    else if (a.type === 'clip' && Number.isInteger(a.index)) write({ t: 'clip', matchId: a.matchId, index: a.index, clip: typeof a.url === 'string' ? a.url.slice(0, 200) : null });
  }

  function read(tour) {
    const lines = [];
    for (const f of [`${file}.1`, file]) {
      if (!existsSync(f)) continue;
      for (const raw of readFileSync(f, 'utf8').split('\n')) {
        if (!raw) continue;
        try {
          const line = JSON.parse(raw);
          if (line.tour === tour) lines.push(line);
        } catch {
          // a line cut by a crash mid-write: the rest of the file still reads
        }
      }
    }
    return lines;
  }

  function summary() {
    const t = getStore().tournament;
    if (!t) return json(fail('진행 중인 대회가 없습니다.', 'There is no active tournament.'), 404);
    const d = derive(t);
    const out = compareJudge(read(String(t.createdAt ?? '')), d.matches);
    const names = Object.fromEntries(d.matches.map((m) => [m.id, m.players.map((p) => (p === null ? null : t.players[p]))]));
    return json({ tournament: { name: t.name, createdAt: t.createdAt ?? null }, names, ...out });
  }

  async function post(req) {
    if (cameraToken(req)) return json(cameraError, 403);
    const r = checkPin(req, req.headers.get('x-pin'));
    if (!r.ok) return json({ error: r.error, en: r.en }, r.status);
    let rec;
    try {
      rec = parseJudge(await req.json());
    } catch (e) {
      return json(fail('판정 기록 형식이 맞지 않아요.', 'The judge record is malformed.', { field: e instanceof MalformedJudge ? e.message : null }), 400);
    }
    write(rec);
    return json({ ok: true });
  }

  async function handle(req, url) {
    if (url.pathname === '/api/judge' && req.method === 'POST') return post(req);
    if (url.pathname === '/api/judge/summary' && req.method === 'GET') return summary();
    return null;
  }

  return { handle, onAction, file };
}
