import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import {
  RuleError, addPoint, attachClip, createTournament, derive, flipPoint, markPoint, renamePlayer, setEnds, setFirstServer, setHandicap, undoPoint, updateSetup,
} from './public/engine.js';
import { ID_RE, STALE_MS, presenceOf } from './vision-link.js';
import { PinGuard } from './pin-guard.js';
import { registeredPlayers } from './public/player-search.js';
import { MulticamServer } from './multicam-server.js';
import { createAnalysis } from './analysis-store.js';
import { createDesk } from './desk-routes.js';
import { createPlayers } from './players-store.js';
import { createJudgeLog } from './judge-log.js';
import { fail } from './public/i18n.js';

const PORT = Number(process.env.PORT || 8792);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = import.meta.dir;
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const DATA_FILE = join(DATA_DIR, 'tournament.json');
const ARCHIVE_DIR = join(DATA_DIR, 'archive');
const TRASH_DIR = join(DATA_DIR, 'trash');
const ARCHIVE_FILE = /^tournament-(\d{1,16})\.json$/;
const ACTION_LOG = join(DATA_DIR, 'action.log');
const ACTION_LOG_MAX_BYTES = 1024 * 1024;
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
// The one version the owner sees (start screen), kept only in package.json; README says when it goes up.
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

mkdirSync(DATA_DIR, { recursive: true });
const cameras = new Map();
let speaker = null;

let store = existsSync(DATA_FILE)
  ? JSON.parse(readFileSync(DATA_FILE, 'utf8'))
  : { rev: 0, pin: null, tournament: null };

function persist() {
  const tmp = `${DATA_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, DATA_FILE);
}

// Optional fixed PIN in data/settings.json ({"pin": "<4 digits>"}), kept out of git with the rest of
// data/. When set, every tournament uses it and the stored one is switched to it at boot without a new
// rev (scores untouched). Without it, each new tournament gets a random PIN as before.
function readFixedPin() {
  if (!existsSync(SETTINGS_FILE)) return null;
  let pin = '';
  try {
    pin = String(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')).pin ?? '');
  } catch (e) {
    console.error(`${SETTINGS_FILE}: cannot read`, e);
  }
  if (/^\d{4}$/.test(pin)) return pin;
  console.error(`${SETTINGS_FILE}: pin must be 4 digits; using a random PIN per tournament`);
  return null;
}
const FIXED_PIN = readFixedPin();
if (FIXED_PIN && store.pin !== FIXED_PIN) {
  store.pin = FIXED_PIN;
  persist();
  console.log('stored tournament PIN switched to the fixed PIN from settings.json');
}

function presence() {
  return JSON.stringify({ type: 'presence', cameras: presenceOf(cameras), speaker: speaker?.data.conn ?? null });
}
const publishPresence = () => server.publish('state', presence());

// Player codes ('이름,네자리') leave the server only through GET /api/players with the PIN.
const withoutCodes = ({ codes, ...t }) => t;

function publicState() {
  const t = store.tournament;
  return {
    rev: store.rev,
    tournament: t && withoutCodes(t),
    playerCodes: Boolean(t?.codes),
    derived: t ? derive(t) : null,
    pinFixed: Boolean(FIXED_PIN),
    version: VERSION,
  };
}

let server;
function commit(next) {
  store = { ...store, ...next, rev: store.rev + 1 };
  persist();
  server.publish('state', JSON.stringify({ type: 'state', state: publicState() }));
}

const pinGuard = new PinGuard();
const multicam = new MulticamServer({
  checkPin,
  matches: () => store.tournament ? derive(store.tournament).matches : [],
  publish: (packet) => server.publish('state', packet),
});

// A camera that still holds a token from the old referee approval (no PIN) is refused before the
// PIN check, so its retries never count toward the PIN lockout.
const CAMERA_PIN_ONLY = fail('카메라도 대회 PIN을 넣어야 점수가 기록돼요.', 'Cameras need the tournament PIN to record points too.');
const cameraToken = (req) => Boolean(req.headers.get('x-vision-token') && !req.headers.get('x-pin'));

function checkPin(req, pin) {
  return pinGuard.check(clientIp(req), !!store.pin && String(pin ?? '') === store.pin);
}

// Real client address for PIN lockout and the action log. Only a proxy on this machine is believed:
// tailscale serve/Funnel connects from 127.0.0.1 and replaces X-Forwarded-For with the real device
// (measured 2026-10-30 on Funnel IPv4, Funnel IPv6 and tailnet), and the vision app forwards the one
// address it saw. The last hop is the one the nearest proxy wrote. cf-connecting-ip passes through
// tailscale untouched, so it is never believed. Any other peer is the device itself.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function clientIp(req) {
  const peer = server.requestIP(req)?.address || 'unknown';
  if (!LOOPBACK.has(peer)) return peer;
  return req.headers.get('x-forwarded-for')?.split(',').at(-1).trim() || peer;
}

async function describeRequest(req, url) {
  if (url.pathname !== '/api/action') return `${req.method} ${url.pathname}`;
  const a = await req.clone().json().catch(() => ({}));
  const parts = [`action:${a.type ?? '?'}`];
  if (a.matchId !== undefined) parts.push(String(a.matchId));
  if (a.side !== undefined) parts.push(`side=${a.side}`);
  if (a.type === 'ends' && a.blue !== undefined) parts.push(`blue=${a.blue}`);
  if (a.type === 'clip' && Number.isInteger(a.index)) parts.push(`index=${a.index}`);
  return parts.join(' ');
}

// One line per state-changing request. Request bodies are never written, so the PIN cannot leak here.
async function writeActionLog(what, res, revBefore, ip) {
  const time = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
  let outcome = `ok ${res.status}`;
  if (res.status >= 400) {
    const reason = (await res.clone().json().catch(() => ({}))).error ?? '';
    outcome = `fail ${res.status} ${reason}`.trim();
  }
  const line = `${time} KST | ${what} | ${outcome} | rev ${revBefore}->${store.rev} | ip ${ip}\n`;
  try {
    if (existsSync(ACTION_LOG) && statSync(ACTION_LOG).size > ACTION_LOG_MAX_BYTES) renameSync(ACTION_LOG, `${ACTION_LOG}.1`);
    appendFileSync(ACTION_LOG, line);
  } catch (e) {
    console.error('action log write failed', e);
  }
}

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });

async function body(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function newPin() {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
}

function applyAction(t, a) {
  switch (a.type) {
    case 'point': return addPoint(t, a.matchId, a.side, a.seq);
    case 'clip': return attachClip(t, a.matchId, a.index, a.url);
    case 'undo': return undoPoint(t, a.matchId, a.seq);
    case 'mark': return markPoint(t, a.matchId, a.index, a.side, a.on === true);
    case 'flip': return flipPoint(t, a.matchId, a.index, a.seq);
    case 'firstServer': return setFirstServer(t, a.matchId, a.side);
    case 'ends': return setEnds(t, a.matchId, a.blue);
    case 'handicap': return setHandicap(t, a.matchId, a.handicap);
    case 'rename': return renamePlayer(t, a.index, a.name);
    case 'setup': return updateSetup(t, { players: a.players, format: a.format, bestOf: a.bestOf });
    default: throw new RuleError('알 수 없는 요청입니다.', 'Unknown request.');
  }
}

function archiveCurrent() {
  if (!store.tournament) return;
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  writeFileSync(join(ARCHIVE_DIR, `tournament-${Date.now()}.json`), JSON.stringify(store, null, 2));
}

const archivePath = (id) => join(ARCHIVE_DIR, `tournament-${id}.json`);

// History entries never include the stored PIN: only the tournament and its derived results leave the server.
function summarize(id, saved, archivedAt) {
  const t = saved.tournament;
  const d = derive(t);
  return {
    id,
    current: id === 'current',
    favorite: Boolean(saved.favorite),
    name: t.name,
    createdAt: t.createdAt ?? null,
    archivedAt,
    format: t.format,
    bestOf: t.bestOf,
    players: t.players,
    champion: d.champion === null ? null : t.players[d.champion],
    played: d.matches.filter((m) => m.status === 'done').length,
    total: d.matches.length,
    points: Object.values(t.log).reduce((n, e) => n + e.points.length, 0),
  };
}

function readArchive(id) {
  const path = archivePath(id);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function listHistory() {
  const items = [];
  if (store.tournament) items.push(summarize('current', store, null));
  const files = existsSync(ARCHIVE_DIR) ? readdirSync(ARCHIVE_DIR) : [];
  const archived = [];
  for (const f of files) {
    const id = f.match(ARCHIVE_FILE)?.[1];
    if (!id) continue;
    const archivedAt = new Date(Number(id)).toISOString();
    try {
      archived.push(summarize(id, readArchive(id), archivedAt));
    } catch (e) {
      console.error(`history: cannot read ${f}`, e);
      archived.push({ id, broken: true, favorite: false, name: '읽을 수 없는 기록', archivedAt, players: [] }); // i18n-data: stored name, shown via labelText
    }
  }
  archived.sort((a, b) => Number(b.id) - Number(a.id));
  return items.concat(archived);
}

function historyDetail(id) {
  const saved = id === 'current' ? (store.tournament ? store : null) : readArchive(id);
  if (!saved) return null;
  const archivedAt = id === 'current' ? null : new Date(Number(id)).toISOString();
  return { summary: summarize(id, saved, archivedAt), tournament: withoutCodes(saved.tournament), derived: derive(saved.tournament) };
}

function listPlayers() {
  const saves = store.tournament ? [{ tournament: store.tournament, at: store.tournament.createdAt ?? '' }] : [];
  const files = existsSync(ARCHIVE_DIR) ? readdirSync(ARCHIVE_DIR) : [];
  for (const f of files) {
    const id = f.match(ARCHIVE_FILE)?.[1];
    if (!id) continue;
    try {
      saves.push({ tournament: readArchive(id).tournament, at: new Date(Number(id)).toISOString() });
    } catch (e) {
      console.error(`players: cannot read ${f}`, e);
    }
  }
  return registeredPlayers(saves);
}

const publishHistory = () => server.publish('state', JSON.stringify({ type: 'history' }));

async function handleHistory(req, id, sub) {
  if (id !== 'current' && !/^\d{1,16}$/.test(id)) return json(fail('잘못된 기록 번호입니다.', 'Invalid history ID.'), 400);

  if (!sub && req.method === 'GET') {
    const detail = historyDetail(id);
    return detail ? json(detail) : json(fail('기록을 찾을 수 없습니다.', 'History not found.'), 404);
  }

  const isFavorite = sub === '/favorite' && req.method === 'POST';
  const isDelete = !sub && req.method === 'DELETE';
  if (!isFavorite && !isDelete) return json({ error: 'Not found' }, 404);

  const r = checkPin(req, req.headers.get('x-pin'));
  if (!r.ok) return json({ error: r.error, en: r.en }, r.status);

  if (isFavorite) {
    const favorite = (await body(req)).favorite === true;
    if (id === 'current') {
      if (!store.tournament) return json(fail('기록을 찾을 수 없습니다.', 'History not found.'), 404);
      commit({ favorite });
    } else {
      const saved = readArchive(id);
      if (!saved) return json(fail('기록을 찾을 수 없습니다.', 'History not found.'), 404);
      const tmp = `${archivePath(id)}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...saved, favorite }, null, 2));
      renameSync(tmp, archivePath(id));
    }
    publishHistory();
    return json({ ok: true, favorite });
  }

  if (id === 'current') return json(fail('진행 중인 대회는 삭제할 수 없습니다. 새 대회를 만들면 기록으로 옮겨집니다.', 'The active tournament cannot be deleted. Start a new tournament to archive it.'), 400);
  if (!existsSync(archivePath(id))) return json(fail('기록을 찾을 수 없습니다.', 'History not found.'), 404);
  mkdirSync(TRASH_DIR, { recursive: true });
  renameSync(archivePath(id), join(TRASH_DIR, `tournament-${id}.json`));
  publishHistory();
  return json({ ok: true });
}

const judgeLog = createJudgeLog({ dataDir: DATA_DIR, getStore: () => store, checkPin, cameraToken, cameraError: CAMERA_PIN_ONLY });
const analysis = createAnalysis({ dataDir: DATA_DIR, getStore: () => store, readArchive, checkPin, cameraToken, cameraError: CAMERA_PIN_ONLY, defaultAccuracyFile: join(import.meta.dir, 'analysis-accuracy.json') });

// The desk-worker is a local process: a direct loopback peer with no proxy header (tailscale serve also
// connects from 127.0.0.1 but always adds X-Forwarded-For).
const isLocalPeer = (req) => LOOPBACK.has(server.requestIP(req)?.address) && !req.headers.has('x-forwarded-for');
// Every readable tournament for the person pages; a broken archive is logged and left out.
function savedTournaments() {
  const entries = store.tournament ? [{ id: 'current', archivedAt: null, tournament: store.tournament, derived: derive(store.tournament) }] : [];
  for (const f of existsSync(ARCHIVE_DIR) ? readdirSync(ARCHIVE_DIR) : []) {
    const id = f.match(ARCHIVE_FILE)?.[1];
    if (!id) continue;
    try {
      const { tournament } = readArchive(id);
      entries.push({ id, archivedAt: Number(id), tournament, derived: derive(tournament) });
    } catch (e) {
      console.error(`players: cannot read ${f}`, e);
    }
  }
  return entries;
}
const players = createPlayers({ dataDir: DATA_DIR, checkPin, tournaments: savedTournaments, ralliesOf: analysis.ralliesOf, galleryDocs: () => desk.galleryDocs(), poseOf: (key) => desk.poseOf(key) });
const tournamentOf = (createdAt) => savedTournaments().find((e) => String(e.tournament.createdAt) === createdAt)?.tournament ?? null;
const desk = createDesk({ dataDir: DATA_DIR, checkPin, isLocal: isLocalPeer, saveDeskRally: analysis.saveRally, tournamentOf, matchItems: players.matchItems });
// Worker beats every few seconds; logging them would roll the action log over for nothing.
const DESK_BEAT = /^\/api\/desk\/worker\/(heartbeat|jobs\/[^/]+\/progress)$/;

async function handleApi(req, url) {
  if (url.pathname === '/api/state' && req.method === 'GET') return json(publicState());

  const person = await players.handle(req, url);
  if (person) return person;

  const desked = await desk.handle(req, url);
  if (desked) return desked;

  const analysed = await analysis.handle(req, url);
  if (analysed) return analysed;

  const judged = await judgeLog.handle(req, url);
  if (judged) return judged;

  if (url.pathname === '/api/history' && req.method === 'GET') return json({ items: listHistory() });

  if (url.pathname === '/api/players' && req.method === 'GET') {
    const r = checkPin(req, req.headers.get('x-pin'));
    if (!r.ok) return json({ error: r.error, en: r.en }, r.status);
    return json({ players: listPlayers() });
  }

  const hm = url.pathname.match(/^\/api\/history\/([^/]+)(\/favorite)?$/);
  if (hm) return handleHistory(req, decodeURIComponent(hm[1]), hm[2]);

  if (url.pathname === '/api/pin/verify' && req.method === 'POST') {
    const { pin } = await body(req);
    const r = checkPin(req, pin);
    return r.ok ? json({ ok: true }) : json({ error: r.error, en: r.en }, r.status);
  }

  if (url.pathname === '/api/tournament' && req.method === 'POST') {
    const b = await body(req);
    if (store.tournament) {
      const r = checkPin(req, req.headers.get('x-pin'));
      if (!r.ok) return json({ error: r.error, en: r.en }, r.status);
    }
    const tournament = createTournament(b);
    const pin = FIXED_PIN ?? (b.keepPin && store.pin ? store.pin : newPin());
    archiveCurrent();
    commit({ tournament, pin, favorite: false });
    publishHistory();
    publishPresence();
    return json({ pin, state: publicState() });
  }

  if (url.pathname === '/api/action' && req.method === 'POST') {
    if (cameraToken(req)) return json(CAMERA_PIN_ONLY, 403);
    const r = checkPin(req, req.headers.get('x-pin'));
    if (!r.ok) return json({ error: r.error, en: r.en }, r.status);
    const a = await body(req);
    if (!store.tournament) return json(fail('진행 중인 대회가 없습니다.', 'There is no active tournament.'), 409);
    // 카메라 여러 대: an automatic point from a camera that is not this match's primary is refused
    if (a.type === 'point' && req.headers.has('x-ppv-camera') && !multicam.roster.canWritePoint(req.headers.get('x-ppv-camera'), a.matchId)) {
      return json(fail('보조 카메라는 점수를 넣지 않아요', 'A secondary camera cannot record points.'), 409);
    }
    const before = store.tournament;
    commit({ tournament: applyAction(store.tournament, a) });
    // the camera-vs-referee record (data/judge-log.jsonl): a failure there never undoes or refuses the point
    try {
      judgeLog.onAction(a, before, req);
    } catch (e) {
      console.error('judge log failed', e);
    }
    return json({ ok: true, state: publicState() });
  }

  if (['/api/vision/attach', '/api/vision/detach'].includes(url.pathname) && req.method === 'POST') {
    return multicam.api(req, url.pathname);
  }

  // The referee approval of a camera is gone (owner decision): a camera writes with the tournament PIN only.
  if ((url.pathname === '/api/vision/approve' || url.pathname === '/api/vision/claim') && req.method === 'POST') {
    return json(CAMERA_PIN_ONLY, 403);
  }

  // Camera call-outs go to the one screen that took the sound; the camera speaks itself otherwise.
  if (url.pathname === '/api/vision/say' && req.method === 'POST') {
    if (cameraToken(req)) return json(CAMERA_PIN_ONLY, 403);
    const r = checkPin(req, req.headers.get('x-pin'));
    if (!r.ok) return json({ error: r.error, en: r.en }, r.status);
    const { text, en } = await body(req);
    if (typeof text !== 'string' || !text.trim() || text.length > 160) return json(fail('읽을 문장이 없습니다.', 'There is no text to read.'), 400);
    if (!speaker) return json({ delivered: false });
    // the English line rides along, so an English viewer screen reads a Korean camera's call-out in English
    speaker.send(JSON.stringify({ type: 'say', text, en: typeof en === 'string' && en.length <= 160 ? en : undefined }));
    return json({ delivered: true });
  }

  return json({ error: 'Not found', en: 'Not found' }, 404);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

function serveStatic(url) {
  const rel = url.pathname === '/' ? 'index.html' : normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (rel.includes('..')) return new Response('Not found', { status: 404 });
  const path = join(PUBLIC_DIR, rel);
  if (!existsSync(path)) return new Response('Not found', { status: 404 });
  const ext = rel.slice(rel.lastIndexOf('.'));
  return new Response(Bun.file(path), { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' } });
}

server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (srv.upgrade(req, { data: { conn: crypto.randomUUID(), camera: null } })) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }
    if (url.pathname.startsWith('/api/')) {
      const audited = (req.method === 'POST' || req.method === 'DELETE') && !['/api/vision/say', '/api/vision/attach', '/api/vision/detach', '/api/judge'].includes(url.pathname) && !DESK_BEAT.test(url.pathname);
      const revBefore = store.rev;
      const what = audited ? await describeRequest(req, url) : null;
      let res;
      try {
        res = await handleApi(req, url);
      } catch (e) {
        if (e instanceof RuleError) res = json({ error: e.message, en: e.en, state: publicState() }, 409);
        else {
          console.error(e);
          res = json(fail('서버 오류가 발생했습니다.', 'A server error occurred.'), 500);
        }
      }
      // the desk worker asks for a job every few seconds: an empty answer (204) changes nothing and is not
      // written, so the log stays a record of changes and of anything odd (a refused or failed claim is)
      const emptyClaim = url.pathname === '/api/desk/worker/claim' && res.status === 204;
      if (audited && !emptyClaim) await writeActionLog(what, res, revBefore, clientIp(req));
      return res;
    }
    if (url.pathname === '/healthz') return new Response('ok');
    return serveStatic(url);
  },
  websocket: {
    idleTimeout: 120,
    open(ws) {
      ws.subscribe('state');
      ws.send(JSON.stringify({ type: 'hello', conn: ws.data.conn }));
      ws.send(JSON.stringify({ type: 'state', state: publicState() }));
      ws.send(presence());
      multicam.open(ws);
    },
    message(ws, msg) {
      multicam.roster.touch(ws.data.conn, Date.now());
      if (msg === 'ping') return ws.send('pong');
      let m;
      try {
        m = JSON.parse(String(msg));
      } catch {
        return;
      }
      if (m?.type === 'mc' && Buffer.byteLength(msg) > 65536) return;
      if (m && typeof m === 'object') multicam.message(ws, m);
      if (m?.type === 'camera' && ID_RE.test(String(m.id))) {
        const known = cameras.get(m.id);
        if (!known && cameras.size >= 20) return;
        const next = { online: true, lastSeen: Date.now(), mode: String(m.mode ?? '').slice(0, 20), matchId: typeof m.matchId === 'string' ? m.matchId.slice(0, 20) : null, linked: !!m.linked };
        const changed = !known || !known.online || known.mode !== next.mode || known.matchId !== next.matchId || known.linked !== next.linked;
        cameras.set(m.id, next);
        ws.data.camera = m.id;
        multicam.hello(ws, m);
        if (changed) publishPresence();
      } else if (m?.type === 'speaker') {
        if (m.on) speaker = ws;
        else if (speaker === ws) speaker = null;
        publishPresence();
      }
    },
    close(ws) {
      multicam.close(ws);
      let changed = false;
      if (speaker === ws) { speaker = null; changed = true; }
      const c = ws.data.camera && cameras.get(ws.data.camera);
      if (c?.online) { c.online = false; changed = true; }
      if (changed) publishPresence();
    },
  },
});

// A camera that stops saying hello (phone asleep, network gone) shows as cut off on every screen.
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, c] of cameras) {
    if (c.online && now - c.lastSeen > STALE_MS) { c.online = false; changed = true; }
    if (!c.online && now - c.lastSeen > 30 * 60_000) { cameras.delete(id); changed = true; }
  }
  if (changed) publishPresence();
}, 3000).unref?.();

console.log(`pingpong server listening on http://${HOST}:${server.port} (data: ${DATA_FILE})`);
