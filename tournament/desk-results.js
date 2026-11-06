// Desk results and their public reads: player keys (이름,네자리), gallery match files
// data/analysis/g-<jobId>.json and the /api/analysis/gallery and /api/analysis/matches answers.
// Public answers carry names only; the four digits never leave through them.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MalformedRally, parseRally } from './analysis-store.js';
import { JOB_ID_RE } from './desk-queue.js';
import { fail } from './public/i18n.js';

const MAX_NAME = 20;
const MAX_RALLIES = 2000;
const GALLERY_FILE = /^g-([0-9a-z]{8,40})\.json$/;

export class MalformedDesk extends Error {}

export function need(condition, what) {
  if (!condition) throw new MalformedDesk(what);
}

export const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// '홍길동,0712', '홍길동，0712' or '홍길동 0712' -> '홍길동,0712' (NFKC, trimmed). null stays null.
export function parsePlayer(v) {
  if (v === null || v === undefined) return null;
  need(typeof v === 'string', 'player');
  const m = v.normalize('NFKC').trim().match(/^(.+?)[\s,]*[,\s](\d{4})$/u);
  const name = m?.[1].trim() ?? '';
  need(name.length > 0 && name.length <= MAX_NAME && !name.includes(','), 'player');
  return `${name},${m[2]}`;
}

const nameOf = (key) => (key === null ? null : key.slice(0, key.lastIndexOf(',')));
export const publicPlayers = (p) => ({ near: nameOf(p.near), far: nameOf(p.far) });

// The worker's rallies, each parsed by the same rules as /api/analysis/rally and marked desk.
export function parseResultRallies(input) {
  need(Array.isArray(input) && input.length <= MAX_RALLIES, 'rallies');
  return input.map((r) => {
    need(isRecord(r) && Number.isInteger(r.index) && r.index >= 0 && r.source === 'desk', 'rally');
    try {
      return parseRally(r, r.index);
    } catch (e) {
      if (e instanceof MalformedRally) throw new MalformedDesk(e.message);
      throw e;
    }
  });
}

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });

export function createGallery({ dataDir, matchItems = null, log = console.error }) {
  const dir = join(dataDir, 'analysis');
  const pathOf = (id) => join(dir, `g-${id}.json`);

  // handPending: the rallies are a first pass (no forehand/backhand yet); the full result saves without it
  function save(job, rallies, { handPending = false } = {}) {
    mkdirSync(dir, { recursive: true });
    const doc = { v: 1, source: 'gallery', id: job.id, playedAt: job.playedAt, title: job.title, players: job.players, rallies, ...(handPending ? { handPending: true } : {}) };
    const tmp = `${pathOf(job.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc));
    renameSync(tmp, pathOf(job.id));
  }

  function read(id) {
    const path = pathOf(id);
    if (!existsSync(path)) return null;
    try {
      const doc = JSON.parse(readFileSync(path, 'utf8'));
      if (doc?.v === 1 && doc.source === 'gallery' && Array.isArray(doc.rallies) && isRecord(doc.players)) return doc;
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
    log(`desk: ignoring ${path}: not a v1 gallery file`);
    return null;
  }

  // A failed job's first pass stays as it is, without the pending mark: forehand/backhand will not come.
  function settle(id) {
    const doc = read(id);
    if (!doc?.handPending) return;
    const { handPending: _pending, ...rest } = doc;
    const tmp = `${pathOf(id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(rest));
    renameSync(tmp, pathOf(id));
  }

  const score = (rallies) => ({
    near: rallies.filter((r) => r.winner === 'near').length,
    far: rallies.filter((r) => r.winner === 'far').length,
  });

  const publicDoc = (doc) => ({ ...doc, players: publicPlayers(doc.players) });

  function docs() {
    const files = existsSync(dir) ? readdirSync(dir) : [];
    return files
      .map((f) => f.match(GALLERY_FILE)?.[1])
      .filter(Boolean)
      .map(read)
      .filter(Boolean);
  }

  function list() {
    return docs()
      .map((doc) => ({ kind: 'gallery', id: doc.id, title: doc.title, playedAt: doc.playedAt, players: publicPlayers(doc.players), score: score(doc.rallies) }))
      .sort((a, b) => String(b.playedAt).localeCompare(String(a.playedAt)));
  }

  // GET /api/analysis/gallery/:id and GET /api/analysis/matches, no PIN; null leaves the request alone.
  function handle(req, url) {
    if (req.method !== 'GET') return null;
    if (url.pathname === '/api/analysis/matches') return json({ items: matchItems ? matchItems() : list() });
    const m = url.pathname.match(/^\/api\/analysis\/gallery\/([^/]+)$/);
    if (!m) return null;
    if (!JOB_ID_RE.test(m[1])) return json(fail('잘못된 경기 번호예요.', 'Invalid match ID.'), 400);
    const doc = read(m[1]);
    return doc ? json(publicDoc(doc)) : json(fail('경기를 찾을 수 없어요.', 'Match not found.'), 404);
  }

  return { save, settle, handle, docs };
}
