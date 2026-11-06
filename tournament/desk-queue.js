// The 분석 데스크 job queue: data/desk/queue.json, held in memory and written whole (tmp + rename) after
// every change by this one process. The GPU work happens in a separate desk-worker; this file only keeps
// the jobs, their leases and the recovery rules. See docs/analysis-desk.md.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LEASE_MS = 90_000;
export const MAX_ATTEMPTS = 3;
export const JOB_ID_RE = /^[0-9a-z]{8,40}$/;
const KINDS = new Set(['gallery', 'rally']);
const STATES = new Set(['uploading', 'queued', 'waiting', 'running', 'done', 'failed']);
const CLAIMED = new Set(['waiting', 'running']);
export const RESTART_ERROR = '분석 중에 서버가 다시 켜졌어요.'; // i18n-data: stored job error
export const RESTART_ERROR_EN = 'The server restarted during analysis.';
export const LEASE_ERROR = '분석기 응답이 90초 동안 없었어요.'; // i18n-data: stored job error
export const LEASE_ERROR_EN = 'The analysis worker did not respond for 90 seconds.';

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// A job is kept only if the fields the server acts on have the documented shape; the rest is copied.
function isJob(j) {
  return isRecord(j) && JOB_ID_RE.test(String(j.id)) && KINDS.has(j.kind) && STATES.has(j.state)
    && isRecord(j.video) && Number.isSafeInteger(j.video.bytes) && Number.isSafeInteger(j.video.received)
    && Number.isSafeInteger(j.attempts);
}

export const newJobId = () => Date.now().toString(36) + Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex');

export function videoPath(dir, job) {
  const ext = String(job.video.name).match(/\.([a-z0-9]{1,5})$/i)?.[1]?.toLowerCase() ?? 'bin';
  return join(dir, 'videos', `${job.id}.${ext}`);
}

// a rally job's overlay track from the 다시 보기 original (gzip JSON, as the camera saved it)
export const trackPath = (dir, job) => join(dir, 'tracks', `${job.id}.json.gz`);

// The worker token lives in data/desk/worker-token (mode 600); a missing or short one is replaced.
function workerToken(dir) {
  const path = join(dir, 'worker-token');
  const old = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
  if (old.length >= 32) {
    chmodSync(path, 0o600);
    return old;
  }
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

export function openQueue({ dataDir, now = Date.now, log = console.error }) {
  const dir = join(dataDir, 'desk');
  const file = join(dir, 'queue.json');
  mkdirSync(join(dir, 'videos'), { recursive: true });
  const token = workerToken(dir);

  function load() {
    if (!existsSync(file)) return [];
    let doc;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      doc = null;
    }
    if (!isRecord(doc) || doc.v !== 1 || !Array.isArray(doc.jobs)) {
      // A broken queue is kept aside for a look and the desk starts empty, never overwriting it.
      const aside = `${file}.bad-${now()}`;
      renameSync(file, aside);
      log(`desk: ${file} is not a v1 queue; kept as ${aside}`);
      return [];
    }
    const jobs = doc.jobs.filter(isJob);
    if (jobs.length < doc.jobs.length) log(`desk: dropped ${doc.jobs.length - jobs.length} malformed job(s) from ${file}`);
    return jobs;
  }

  let jobs = load();

  function persist() {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, jobs }, null, 1));
    renameSync(tmp, file);
  }

  // Replaces one job (by id) with patch applied and stamps updatedAt; persists at once.
  function update(id, patch) {
    jobs = jobs.map((j) => (j.id === id ? { ...j, ...patch, updatedAt: now() } : j));
    persist();
    return get(id);
  }

  function get(id) {
    return jobs.find((j) => j.id === id) ?? null;
  }

  // A claimed job whose worker is gone goes back to the queue, or fails after MAX_ATTEMPTS.
  function release(job, error) {
    const attempts = job.attempts + 1;
    const state = attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
    return { ...job, state, attempts, error, lease: null, waitPos: null, progress: state === 'failed' ? job.progress : null, updatedAt: now() };
  }

  // Boot recovery: claimed jobs are released, and an upload trusts no more bytes than are on disk.
  function recover() {
    jobs = jobs.map((j) => {
      if (CLAIMED.has(j.state)) return { ...release(j, RESTART_ERROR), errorEn: RESTART_ERROR_EN };
      if (j.state !== 'uploading') return j;
      const path = videoPath(dir, j);
      const onDisk = existsSync(path) ? statSync(path).size : 0;
      return { ...j, video: { ...j.video, received: Math.min(j.video.received, onDisk) } };
    });
    if (existsSync(file) || jobs.length) persist();
  }

  function sweep() {
    const t = now();
    const expired = jobs.filter((j) => CLAIMED.has(j.state) && (j.lease?.until ?? 0) <= t);
    if (!expired.length) return;
    jobs = jobs.map((j) => (expired.includes(j) ? { ...release(j, LEASE_ERROR), errorEn: LEASE_ERROR_EN } : j));
    persist();
  }

  function add(job) {
    jobs = [...jobs, job];
    persist();
    return job;
  }

  function remove(id) {
    jobs = jobs.filter((j) => j.id !== id);
    persist();
  }

  // Oldest queued job first; the claim itself is the lease.
  function claim(worker) {
    sweep();
    const next = jobs.filter((j) => j.state === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!next) return null;
    return update(next.id, { state: 'waiting', waitPos: null, progress: null, lease: { worker, until: now() + LEASE_MS } });
  }

  recover();
  return {
    dir, token, get, add, update, remove, claim, sweep, release,
    list: () => [...jobs].sort((a, b) => a.createdAt - b.createdAt),
    isClaimed: (job) => CLAIMED.has(job.state),
  };
}
