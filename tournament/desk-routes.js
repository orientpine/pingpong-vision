// /api/desk routes: PIN-gated upload and reads for the 분석 데스크 screen, and the worker endpoints that
// only a local desk-worker holding data/desk/worker-token may call. See docs/analysis-desk.md.
import { closeSync, copyFileSync, existsSync, ftruncateSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { JOB_ID_RE, LEASE_MS, newJobId, openQueue, trackPath, videoPath } from './desk-queue.js';
import { MalformedDesk, createGallery, isRecord, need, parsePlayer, parseResultRallies } from './desk-results.js';
import { createPoseStore, parsePose } from './pose-store.js';
import { galleryPoseKey, tournamentPoseKey } from './public/pose-stats.js';
import { derive, scoreMatch } from './public/engine.js';
import { fail } from './public/i18n.js';

export const MAX_VIDEO_BYTES = 4 * 1024 ** 3;
export const MAX_CHUNK_BYTES = 8 * 1024 ** 2;
// a rally job's overlay track: the gzip as sent, and what it may unpack to
export const MAX_TRACK_BYTES = 4 * 1024 ** 2;
const MAX_TRACK_JSON = 64 * 1024 ** 2;
export const WORKER_ALIVE_MS = 30_000;
const MAX_TITLE = 80;
const MAX_ERROR = 300;
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;
// a 다시 보기 save's id on this PC (pingpong-vision save-server.js ID_RE) and its video files
const SAVE_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const SAVE_VIDEOS = { 'video.mp4': 'video/mp4', 'video.webm': 'video/webm' };

// The v1 replay track inside gzip bytes, or null when the bytes are not one.
function readTrack(bytes) {
  try {
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return null;
    const doc = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_TRACK_JSON }).toString('utf8'));
    return isRecord(doc) && doc.v === 1 && Array.isArray(doc.frames) ? doc : null;
  } catch {
    return null;
  }
}

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const notFound = () => json(fail('일감을 찾을 수 없어요.', 'Job not found.'), 404);
const malformed = () => json(fail('요청 형식이 맞지 않아요.', 'Invalid request format.'), 400);
const tooLarge = () => json(fail('영상은 4GiB, 한 조각은 8MiB까지예요.', 'Videos are limited to 4 GiB and chunks to 8 MiB.'), 413);

const text = (v, max, what) => {
  need(typeof v === 'string' && v.trim().length > 0 && v.length <= max, what);
  return v.trim();
};

function parseMatchRef(v) {
  need(isRecord(v) && typeof v.tournament === 'string' && /\d/.test(v.tournament) && typeof v.matchId === 'string' && v.matchId.length <= 20, 'matchRef');
  // a rally job's clip is that one point, so its point number is required
  need(Number.isInteger(v.index) && v.index >= 0, 'matchRef.index');
  return { tournament: v.tournament, matchId: v.matchId, index: v.index };
}

// The table end the camera films from ('blue' or 'red', the match's ends), or null when not known.
function parseNearEnd(v) {
  need(v === null || v === undefined || v === 'blue' || v === 'red', 'nearEnd');
  return v ?? null;
}

// The slot standing at the camera's end when point `index` was played: the ends after the points
// before it (engine.js, ends = [slot at blue end, slot at red end]). null when the tournament, match,
// point or camera end is unknown, so the rally is never put on a guessed player. A hand fix of the
// ends (endsFlip) holds for the whole match, as on every screen.
export function nearSlotAt(tournament, { matchId, index }, nearEnd) {
  if (tournament === null || nearEnd === null) return null;
  const m = derive(tournament).matches.find((x) => x.id === matchId);
  if (!m || m.score === null || index >= m.points.length) return null;
  const { endSwitches } = scoreMatch(m.points.slice(0, index), m.firstServer, tournament, m.handicap);
  const blue = ((tournament.log[matchId]?.endsFlip ? 1 : 0) + endSwitches) % 2;
  return nearEnd === 'blue' ? blue : 1 - blue;
}

function parseNewJob(b, t) {
  need(isRecord(b) && (b.kind === 'gallery' || b.kind === 'rally') && isRecord(b.video) && isRecord(b.players ?? {}), 'job');
  need(typeof b.playedAt === 'string' && !Number.isNaN(Date.parse(b.playedAt)), 'playedAt');
  const { name, bytes, type } = b.video;
  need(Number.isSafeInteger(bytes) && bytes > 0, 'video.bytes');
  return {
    id: newJobId(), kind: b.kind, state: 'uploading', createdAt: t, updatedAt: t,
    title: text(b.title, MAX_TITLE, 'title'), playedAt: b.playedAt,
    players: { near: parsePlayer(b.players?.near), far: parsePlayer(b.players?.far) },
    corners: null,
    video: { name: text(name, 200, 'video.name'), bytes, received: 0, type: typeof type === 'string' && MIME_RE.test(type) ? type : 'application/octet-stream' },
    matchRef: b.kind === 'rally' ? parseMatchRef(b.matchRef) : null,
    nearEnd: b.kind === 'rally' ? parseNearEnd(b.nearEnd) : null,
    progress: null, waitPos: null, error: null, note: null, attempts: 0, lease: null,
  };
}

function parseCorners(v) {
  if (v === null) return null;
  need(Array.isArray(v) && v.length === 4 && v.every((c) => isRecord(c) && Number.isFinite(c.x) && Number.isFinite(c.y)), 'corners');
  return v.map(({ x, y }) => ({ x, y }));
}

function parseProgress(b) {
  need(isRecord(b) && (b.state === 'waiting' || b.state === 'running'), 'state');
  const p = b.progress ?? null;
  need(p === null || (isRecord(p) && Number.isSafeInteger(p.done) && Number.isSafeInteger(p.total) && p.done >= 0 && p.total >= p.done), 'progress');
  const waitPos = b.waitPos ?? null;
  need(waitPos === null || (Number.isSafeInteger(waitPos) && waitPos >= 0), 'waitPos');
  return { state: b.state, progress: p && { done: p.done, total: p.total }, waitPos: b.state === 'waiting' ? waitPos : null };
}

// tournamentOf(createdAt): the current or archived tournament with that createdAt, or null.
// saveDir: the pingpong-vision saves folder on this PC (same default and env as its save-server.js).
export function createDesk({ dataDir, checkPin, isLocal, saveDeskRally, tournamentOf = () => null, matchItems = null, now = Date.now, log = console.error, saveDir = process.env.PPV_SAVE_DIR || join(homedir(), 'pingpong-vision-saves') }) {
  const queue = openQueue({ dataDir, now, log });
  const gallery = createGallery({ dataDir, matchItems, log });
  const poses = createPoseStore({ dataDir, now, log });
  const tokenBytes = Buffer.from(queue.token);
  let lastSeen = null;
  const timer = setInterval(() => sweep(), 5000);
  timer.unref?.();

  const workerState = () => ({ alive: lastSeen !== null && now() - lastSeen < WORKER_ALIVE_MS, lastSeen });

  function workerRefusal(req) {
    if (!isLocal(req)) return json(fail('분석기는 이 컴퓨터 안에서만 접속할 수 있어요.', 'The analysis worker can only connect from this computer.'), 403);
    const given = Buffer.from(req.headers.get('x-desk-worker') ?? '');
    if (given.length !== tokenBytes.length || !timingSafeEqual(given, tokenBytes)) return json(fail('분석기 열쇠가 맞지 않아요.', 'The analysis worker key is incorrect.'), 401);
    lastSeen = now();
    return null;
  }

  // Writes the chunk at offset and cuts anything after it, so a half-written chunk from a crash is replaced.
  function writeChunk(job, offset, bytes) {
    const path = videoPath(queue.dir, job);
    const fd = openSync(path, existsSync(path) ? 'r+' : 'w');
    try {
      writeSync(fd, bytes, 0, bytes.length, offset);
      ftruncateSync(fd, offset + bytes.length);
    } finally {
      closeSync(fd);
    }
  }

  async function putVideo(req, job, url) {
    const offset = Number(url.searchParams.get('offset'));
    const declared = Number(req.headers.get('content-length') ?? 0);
    if (declared > MAX_CHUNK_BYTES) return tooLarge();
    if (!url.searchParams.has('offset') || !Number.isSafeInteger(offset) || offset < 0) return malformed();
    const bytes = new Uint8Array(await req.arrayBuffer());
    const current = queue.get(job.id);
    if (!current) return notFound();
    if (current.state !== 'uploading' || offset !== current.video.received) return json(fail('이어 올릴 위치가 맞지 않아요.', 'The upload offset is incorrect.', { received: current.video.received }), 409);
    if (bytes.length > MAX_CHUNK_BYTES) return tooLarge();
    if (bytes.length === 0 || offset + bytes.length > current.video.bytes) return malformed();
    writeChunk(current, offset, bytes);
    const received = offset + bytes.length;
    const done = received === current.video.bytes;
    queue.update(job.id, { video: { ...current.video, received }, state: done ? 'queued' : 'uploading' });
    return json({ received });
  }

  // A rally job's overlay track (overlay.json.gz of the 다시 보기 original): gzip of a v1 track JSON
  // only, sent before the worker takes the job. The worker reads its shot times from it.
  async function putTrack(req, job) {
    if (job.kind !== 'rally') return json(fail('트랙은 랠리 일감에만 올려요.', 'Tracks can only be uploaded for rally jobs.'), 400);
    if (job.state !== 'uploading' && job.state !== 'queued') return json(fail('분석을 시작한 일감에는 트랙을 올릴 수 없어요.', 'A track cannot be uploaded after analysis starts.', { state: job.state }), 409);
    if (Number(req.headers.get('content-length') ?? 0) > MAX_TRACK_BYTES) return json(fail('트랙은 4MiB까지예요.', 'Tracks are limited to 4 MiB.'), 413);
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length > MAX_TRACK_BYTES) return json(fail('트랙은 4MiB까지예요.', 'Tracks are limited to 4 MiB.'), 413);
    const doc = readTrack(bytes);
    if (!doc) return json(fail('다시 보기 트랙(gzip JSON)이 아니에요.', 'This is not a replay track (gzip JSON).'), 400);
    const path = trackPath(queue.dir, job);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    const current = queue.get(job.id);
    return current ? json({ job: queue.update(job.id, { track: { bytes: bytes.length, frames: doc.frames.length } }) }) : notFound();
  }

  async function handleJob(req, url, id, sub) {
    const job = JOB_ID_RE.test(id) ? queue.get(id) : null;
    if (!job) return notFound();
    if (!sub && req.method === 'HEAD') return new Response(null, { headers: { 'x-received': String(job.video.received), 'cache-control': 'no-store' } });
    if (!sub && req.method === 'GET') return json({ job });
    if (!sub && req.method === 'DELETE') {
      rmSync(videoPath(queue.dir, job), { force: true });
      rmSync(trackPath(queue.dir, job), { force: true });
      queue.remove(id);
      return json({ ok: true });
    }
    if (sub === 'video' && req.method === 'PUT') return putVideo(req, job, url);
    if (sub === 'track' && req.method === 'PUT') return putTrack(req, job);
    if (sub === 'corners' && req.method === 'POST') {
      const b = await req.json();
      const corners = parseCorners(isRecord(b) ? b.corners : undefined);
      return queue.get(id) ? json({ job: queue.update(id, { corners }) }) : notFound();
    }
    return null;
  }

  // The save's own folder under saveDir, or null: a real directory (no symlink) whose real path stays
  // inside saveDir, holding one plain video file.
  function saveFiles(id) {
    let root, d;
    try {
      root = realpathSync(saveDir);
      d = join(root, id);
      if (!lstatSync(d).isDirectory() || realpathSync(d) !== d || !d.startsWith(root + sep)) return null;
    } catch {
      return null;
    }
    const name = readdirSync(d).find((n) => n in SAVE_VIDEOS && lstatSync(join(d, n)).isFile());
    if (!name) return null;
    const overlay = join(d, 'overlay.json.gz');
    const record = join(d, 'record.json');
    return {
      video: join(d, name), name, type: SAVE_VIDEOS[name], bytes: lstatSync(join(d, name)).size,
      overlay: existsSync(overlay) && lstatSync(overlay).isFile() ? overlay : null,
      record: existsSync(record) && lstatSync(record).isFile() ? record : null,
    };
  }

  // A rally job from a 다시 보기 clip already saved on this PC: the phone sends only the save id, the
  // point and the camera's end and corners; the clip (linked, or copied across disks) and its track come from the save. One save
  // makes one job: asking again returns the job it already made. Lookup, copies and add run with no
  // await between them, so two requests for the same save cannot both add a job.
  async function jobFromSave(req) {
    const b = await req.json();
    need(isRecord(b) && typeof b.save === 'string' && SAVE_ID_RE.test(b.save), 'save');
    const matchRef = parseMatchRef(b.matchRef);
    const nearEnd = parseNearEnd(b.nearEnd);
    const corners = parseCorners(b.corners ?? null);
    const existing = queue.list().find((j) => j.source?.save === b.save);
    if (existing) return json({ job: existing, existing: true });
    const files = saveFiles(b.save);
    if (!files || files.bytes <= 0) return json(fail('저장된 랠리를 찾을 수 없어요.', 'Saved rally not found.'), 404);
    if (files.bytes > MAX_VIDEO_BYTES) return tooLarge();
    let savedAt = null;
    try {
      savedAt = files.record ? JSON.parse(readFileSync(files.record, 'utf8')).savedAt : null;
    } catch {
      savedAt = null;
    }
    const t = now();
    const job = {
      id: newJobId(), kind: 'rally', state: 'queued', createdAt: t, updatedAt: t,
      title: `대회 경기 · ${matchRef.index + 1}번째 포인트`, // i18n-data: stored job title
      playedAt: typeof savedAt === 'string' && !Number.isNaN(Date.parse(savedAt)) ? savedAt : new Date(t).toISOString(),
      players: { near: null, far: null }, corners,
      video: { name: files.name, bytes: files.bytes, received: files.bytes, type: files.type },
      matchRef, nearEnd, source: { save: b.save },
      progress: null, waitPos: null, error: null, note: null, attempts: 0, lease: null,
    };
    const track = files.overlay ? readFileSync(files.overlay) : null;
    const doc = track && track.length <= MAX_TRACK_BYTES ? readTrack(track) : null;
    // a hard link when the saves and the desk share a disk (no second copy of the clip), else a copy
    try {
      linkSync(files.video, videoPath(queue.dir, job));
    } catch {
      copyFileSync(files.video, videoPath(queue.dir, job));
    }
    if (doc) {
      const path = trackPath(queue.dir, job);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, track);
      job.track = { bytes: track.length, frames: doc.frames.length };
    }
    return json({ job: queue.add(job) }, 201);
  }

  async function handlePinned(req, url) {
    const pin = checkPin(req, req.headers.get('x-pin'));
    if (!pin.ok) return json({ error: pin.error, en: pin.en }, pin.status);
    if (url.pathname === '/api/desk/jobs' && req.method === 'GET') {
      sweep();
      return json({ jobs: queue.list(), worker: workerState() });
    }
    if (url.pathname === '/api/desk/jobs' && req.method === 'POST') {
      const job = parseNewJob(await req.json(), now());
      if (job.video.bytes > MAX_VIDEO_BYTES) return tooLarge();
      return json({ job: queue.add(job) });
    }
    if (url.pathname === '/api/desk/jobs/from-save' && req.method === 'POST') return jobFromSave(req);
    const m = url.pathname.match(/^\/api\/desk\/jobs\/([^/]+)(?:\/(video|corners|track))?$/);
    return m ? handleJob(req, url, m[1], m[2]) : null;
  }

  // Lease expiry and restarts fail jobs inside the queue; a failed gallery job's first pass loses its
  // pending mark there and in its file, so no screen waits for forehand/backhand that will not come.
  function settleFailed() {
    for (const j of queue.list()) {
      if (j.state !== 'failed' || !j.note?.handPending) continue;
      gallery.settle(j.id);
      const { handPending: _pending, ...note } = j.note;
      queue.update(j.id, { note: Object.keys(note).length ? note : null });
    }
  }

  function sweep() {
    queue.sweep();
    settleFailed();
  }

  function postResult(b, job) {
    need(isRecord(b), 'result');
    if (typeof b.error === 'string') {
      const error = b.error.slice(0, MAX_ERROR) || '분석 실패'; // i18n-data: stored job error
      const errorEn = b.error ? b.error.slice(0, MAX_ERROR) : 'Analysis failed.';
      const failed = { ...queue.release(job, error), errorEn };
      queue.update(job.id, failed);
      settleFailed();
      return json({ job: queue.get(job.id) });
    }
    const rallies = parseResultRallies(b.rallies);
    const pose = parsePose(b.pose, rallies);
    // how a rally job's shot times were found: from its 다시 보기 track's camera clock, or estimated
    const timing = b.timing === 'track' || b.timing === 'estimated' ? b.timing : null;
    if (job.kind === 'rally') return saveRallyJob(job, rallies, pose, timing);
    if (pose) poses.save(galleryPoseKey(job.id), pose);
    gallery.save(job, rallies);
    const { handPending: _done, ...note } = job.note ?? {};
    return json({ job: queue.update(job.id, { state: 'done', lease: null, waitPos: null, error: null, errorEn: null, note: Object.keys(note).length ? note : null }) });
  }

  // A gallery job's first pass: shots, bounces, kinds and winners found without the pose model, saved and
  // shown at once while the worker goes on to the full analysis for forehand/backhand and the joints. The
  // job stays claimed; its final result replaces these rallies and clears handPending.
  function postEarly(b, job) {
    need(isRecord(b), 'result');
    if (job.kind !== 'gallery') return json(fail('랠리 일감에는 먼저 보낼 결과가 없어요.', 'Rally jobs have no early result.'), 409);
    const rallies = parseResultRallies(b.rallies);
    gallery.save(job, rallies, { handPending: true });
    return json({ job: queue.update(job.id, { note: { ...(job.note ?? {}), handPending: true }, lease: { ...job.lease, until: now() + LEASE_MS } }) });
  }

  // A rally job's clip is the one point at matchRef.index: the clip's first rally is stored there, with
  // its pose under the same index. More rallies in the clip are dropped, counted in the note and kept
  // as the job's error. A job from before index was required (null) fails, storing nothing.
  function saveRallyJob(job, rallies, pose, timing = null) {
    const ref = job.matchRef;
    if (!Number.isInteger(ref.index)) {
      return json({ job: queue.update(job.id, { state: 'failed', lease: null, waitPos: null, error: '랠리 일감에 포인트 번호가 없어 저장하지 않았어요.', errorEn: 'No point number was provided for this rally job, so it was not saved.' }) }); // i18n-data: stored job error
    }
    const [first, ...dropped] = rallies.toSorted((a, b) => a.index - b.index);
    const nearSlot = first ? nearSlotAt(tournamentOf(ref.tournament), ref, job.nearEnd ?? null) : null;
    if (first) {
      saveDeskRally({ createdAt: ref.tournament }, ref.matchId, { ...first, index: ref.index, nearSlot });
      const shots = pose?.[first.index];
      if (shots) poses.save(tournamentPoseKey(ref.tournament, ref.matchId), { [ref.index]: shots });
    }
    const error = dropped.length ? `클립에 랠리가 ${rallies.length}개 있어요. 랠리 일감은 한 랠리만 담아야 해서 첫 랠리만 저장했어요.` : null; // i18n-data: stored job error
    const errorEn = dropped.length ? `This clip contains ${rallies.length} rallies. Rally jobs should contain only one, so only the first rally was saved.` : null;
    const note = { dropped: dropped.length, nearSlot: first ? nearSlot : null, ...(timing ? { timing } : {}) };
    return json({ job: queue.update(job.id, { state: 'done', lease: null, waitPos: null, error, errorEn, note }) });
  }

  async function handleWorker(req, url) {
    const refused = workerRefusal(req);
    if (refused) return refused;
    if (url.pathname === '/api/desk/worker/heartbeat' && req.method === 'POST') return json({ ok: true });
    if (url.pathname === '/api/desk/worker/claim' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const worker = typeof b?.worker === 'string' && b.worker.length <= 40 ? b.worker : 'desk-worker';
      const job = queue.claim(worker);
      return job ? json({ job }) : new Response(null, { status: 204 });
    }
    const m = url.pathname.match(/^\/api\/desk\/worker\/jobs\/([^/]+)\/(progress|result|early|video|track)$/);
    if (!m) return null;
    // The body is read first: everything after this runs without yielding, on the job as it is now.
    const input = req.method === 'POST' ? await req.json() : null;
    sweep();
    const job = JOB_ID_RE.test(m[1]) ? queue.get(m[1]) : null;
    if (!job) return notFound();
    if (m[2] === 'video' && req.method === 'GET') {
      if (job.state === 'uploading') return json(fail('영상이 아직 다 올라오지 않았어요.', 'The video has not finished uploading.'), 409);
      return new Response(Bun.file(videoPath(queue.dir, job)), { headers: { 'content-type': job.video.type } });
    }
    if (m[2] === 'track' && req.method === 'GET') {
      if (!job.track || !existsSync(trackPath(queue.dir, job))) return json(fail('이 일감에는 트랙이 없어요.', 'This job has no track.'), 404);
      return new Response(Bun.file(trackPath(queue.dir, job)), { headers: { 'content-type': 'application/gzip' } });
    }
    if (req.method !== 'POST') return null;
    if (!queue.isClaimed(job)) return json(fail('이 일감은 지금 분석기가 맡고 있지 않아요.', 'This job is not currently claimed by an analysis worker.', { state: job.state }), 409);
    if (m[2] === 'result') return postResult(input, job);
    if (m[2] === 'early') return postEarly(input, job);
    const p = parseProgress(input);
    return json({ job: queue.update(job.id, { ...p, lease: { ...job.lease, until: now() + LEASE_MS } }) });
  }

  // Answers /api/desk/* and the public gallery reads; null leaves the request to the rest of the API.
  async function handle(req, url) {
    const path = url.pathname;
    if (!path.startsWith('/api/desk/')) return gallery.handle(req, url);
    try {
      const res = path.startsWith('/api/desk/worker/') ? await handleWorker(req, url) : await handlePinned(req, url);
      return res ?? json({ error: 'Not found', en: 'Not found' }, 404);
    } catch (e) {
      if (e instanceof MalformedDesk || e instanceof SyntaxError) return malformed();
      throw e;
    }
  }

  return { handle, galleryDocs: gallery.docs, poseOf: poses.read, close: () => clearInterval(timer) };
}
