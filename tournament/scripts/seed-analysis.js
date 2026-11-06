#!/usr/bin/env bun
// Writes a demo tournament with synthetic rally analysis into an isolated data dir for screen QA:
//   bun scripts/seed-analysis.js --out=/tmp/some-dir
//   PORT=8799 DATA_DIR=/tmp/some-dir bun server.js
// It refuses the app's own data dir and any dir that already holds a tournament.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { addPoint, attachClip, createTournament, derive } from '../public/engine.js';
import { analysisFileName } from '../analysis-store.js';
import { galleryPoseKey } from '../public/pose-stats.js';

// Slot that wins each point: 5-3, 3-5, 5-2. Short games keep the demo near 20 rallies.
const WINNERS = [0, 0, 1, 0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 0];
const SHOT_COUNTS = [3, 5, 2, 9, 1, 4, 13, 3, 6, 2, 7, 3, 15, 4, 1, 5, 8, 3, 6, 11, 2, 4, 5];
const CLIPPED = { 3: 'A', 6: 'B', 12: 'C', 19: 'D' };
// Points the PC desk re-analysed: every shot classified, so the screens can show desk winning over live.
const DESK_INDICES = [6, 12];
const UNKNOWN_WINNER_INDEX = 10;
const STROKE_UNSEEN_EVERY = 7;
const KIND_UNSEEN_EVERY = 5;
const LAND_UNSEEN_EVERY = 6;
const KINDS = ['드라이브', '푸시', '스매시', '드라이브', '로빙', '푸시'];
const SPEED = { 서브: 18, 스매시: 58, 드라이브: 32, 푸시: 15, 로빙: 20 };
const SHOT_GAP_S = 0.72;

const other = (side) => (side === 'near' ? 'far' : 'near');
const round = (x) => Math.round(x * 1000) / 1000;

// A fixed walk over the opponent's half, so every run writes the same picture.
function landOf(n, side) {
  const depth = 0.15 + ((n * 37) % 110) / 100;
  const tx = side === 'near' ? 1.37 + depth : 1.37 - depth;
  return { tx: round(tx), ty: round(0.12 + ((n * 53) % 130) / 100) };
}

function shotOf({ i, n, side, serve, seq }) {
  const kind = serve ? '서브' : seq % KIND_UNSEEN_EVERY === 0 ? null : KINDS[seq % KINDS.length];
  const land = seq % LAND_UNSEEN_EVERY === 0 ? null : landOf(seq, side);
  return {
    side,
    t: round(1 + n * SHOT_GAP_S),
    stroke: seq % STROKE_UNSEEN_EVERY === 0 ? null : (i + n) % 3 === 0 ? '백핸드' : '포핸드',
    kind,
    speedKmh: kind ? SPEED[kind] + (seq % 7) : null,
    arc: kind === '로빙' ? 0.4 : 0.1,
    inferred: false,
    land,
  };
}

function rallyOf({ i, winner, nearSlot, startedAt, firstSeq }) {
  const server = Math.floor(i / 2) % 2 === 0 ? 'near' : 'far';
  const count = SHOT_COUNTS[i];
  const shots = Array.from({ length: count }, (_, n) => shotOf({
    i, n, side: n % 2 === 0 ? server : other(server), serve: n === 0, seq: firstSeq + n,
  }));
  const bounces = shots.filter((s) => s.land).map((s) => ({ ...s.land, side: other(s.side), t: round(s.t + 0.3) }));
  return {
    v: 1, index: i, source: 'live', startedAt, durationMs: Math.round(count * SHOT_GAP_S * 1000) + 800, winner, nearSlot, why: 'out', shots, bounces,
  };
}

function deskOf(live) {
  const shots = live.shots.map((s, n) => ({ ...s, stroke: s.stroke ?? '포핸드', kind: s.kind ?? (n === 0 ? '서브' : '드라이브') }));
  return { ...live, source: 'desk', shots };
}

function buildDemo() {
  let tournament = createTournament({ name: '분석 화면 시험 대회', players: ['가온,1001', '나래,1002', '다온,1003', '라온,1004'], pointsToWin: 5 });
  const rallies = {};
  const startedBase = Date.parse(tournament.createdAt);
  let seq = 1;
  WINNERS.forEach((slot, i) => {
    const nearSlot = derive(tournament).matches[0].ends[0];
    const winner = i === UNKNOWN_WINNER_INDEX ? null : slot === nearSlot ? 'near' : 'far';
    const live = rallyOf({ i, winner, nearSlot, startedAt: startedBase + i * 40_000, firstSeq: seq });
    rallies[i] = DESK_INDICES.includes(i) ? { live, desk: deskOf(live) } : { live };
    seq += SHOT_COUNTS[i];
    tournament = addPoint(tournament, 'm1', slot, i);
  });
  for (const [index, letter] of Object.entries(CLIPPED)) {
    tournament = attachClip(tournament, 'm1', Number(index), `/vision/s/${letter.repeat(43)}`);
  }
  return { tournament, rallies };
}

// ---------- the desk: a queue in every state, desk videos of two people over two months ----------
// Deterministic numbers, so every run writes the same screens.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const MiB = 1024 ** 2;
const PEOPLE = { cha: '홍길동,0712', seo: '이서,0315', cha2: '홍길동,0788', typo: '이써,0315' };
// Desk videos, oldest first: who stood at the camera end, who across, the points each took, the day.
const VIDEOS = [
  { title: '연습 9월 6일', playedAt: '2026-09-06', near: 'cha', far: 'seo', score: [11, 8] },
  { title: '연습 9월 13일', playedAt: '2026-09-13', near: 'seo', far: 'cha', score: [11, 7] },
  { title: '연습 9월 20일', playedAt: '2026-09-20', near: 'cha', far: 'seo', score: [9, 11] },
  { title: '연습 9월 27일', playedAt: '2026-09-27', near: 'cha', far: 'seo', score: [11, 9] },
  { title: '연습 10월 5일', playedAt: '2026-10-05', near: 'cha', far: 'typo', score: [11, 6] },
  { title: '동호회 리그 10월 12일', playedAt: '2026-10-12', near: 'cha', far: 'cha2', score: [11, 9] },
  { title: '연습 10월 18일', playedAt: '2026-10-18', near: 'seo', far: 'cha', score: [8, 11] },
  { title: '연습 10월 25일', playedAt: '2026-10-25', near: 'cha', far: 'seo', score: [11, 5] },
];
const SHOT_PATTERN = [3, 5, 2, 7, 4, 6, 3, 9, 2, 5, 4, 8, 3, 6, 5, 2, 7, 4];
const GALLERY_KINDS = ['드라이브', '푸시', '스매시', '드라이브', '로빙', '드라이브', '푸시'];

const jobId = (n) => `${(1_790_000_000_000 + n * 7_200_000).toString(36)}${n.toString(16).padStart(10, '0')}`;

// Every shot classified (stroke and kind), the winners interleaved to reach the score. nearSlot 0: the
// camera end is players.near, as the desk records it.
function galleryRallies({ score, seed }) {
  const next = rng(seed);
  const total = score[0] + score[1];
  const winners = [];
  for (let n = 0, f = 0; n + f < total;) {
    const near = n < score[0] && (f >= score[1] || (n + f) % 2 === 0 ? true : next() < 0.5);
    if (near) { winners.push('near'); n += 1; } else { winners.push('far'); f += 1; }
  }
  const startedAt = Date.parse('2026-01-01T03:00:00Z');
  return winners.map((winner, i) => {
    const server = i % 2 === 0 ? 'near' : 'far';
    const count = SHOT_PATTERN[(seed + i) % SHOT_PATTERN.length];
    const shots = Array.from({ length: count }, (_, n) => {
      const kind = n === 0 ? '서브' : GALLERY_KINDS[(seed + i + n) % GALLERY_KINDS.length];
      const side = n % 2 === 0 ? server : other(server);
      return { side, t: round(1 + n * SHOT_GAP_S), stroke: next() < 0.65 ? '포핸드' : '백핸드', kind, speedKmh: SPEED[kind] + Math.round(next() * 8), arc: kind === '로빙' ? 0.4 : 0.1, inferred: false, land: landOf(seed * 7 + i * 3 + n, side) };
    });
    const bounces = shots.map((s) => ({ ...s.land, side: other(s.side), t: round(s.t + 0.3) }));
    return { v: 1, index: i, source: 'desk', startedAt: startedAt + i * 40_000, durationMs: Math.round(count * SHOT_GAP_S * 1000) + 800, winner, nearSlot: 0, why: 'out', shots, bounces };
  });
}

// A body with hips at the origin and a torso of 1, y down, z toward the camera. The racket arm swings
// from behind (-) to in front (+); the month changes knee bend and trunk turn so two periods differ.
function body({ swing, knee, twist, handUp, next }) {
  const rad = (d) => (d * Math.PI) / 180;
  const rows = Array.from({ length: 23 }, () => [0, 0, 0]);
  const [sx, sz] = [0.5 * Math.cos(rad(twist)), 0.5 * Math.sin(rad(twist))];
  rows[0] = [0.05, -1.45, 0.12];
  rows[1] = [-sx, -1, -sz];
  rows[2] = [sx, -1, sz];
  rows[13] = [-0.25, 0, 0];
  rows[14] = [0.25, 0, 0];
  for (const [hip, kneeI, ankle, heel, foot] of [[13, 15, 17, 19, 21], [14, 16, 18, 20, 22]]) {
    const hx = rows[hip][0];
    const half = rad(knee) / 2;
    rows[kneeI] = [hx, Math.cos(half), Math.sin(half)];
    rows[ankle] = [hx, rows[kneeI][1] + Math.cos(half), rows[kneeI][2] - Math.sin(half)];
    rows[heel] = [hx, rows[ankle][1] + 0.06, rows[ankle][2] - 0.1];
    rows[foot] = [hx, rows[ankle][1] + 0.08, rows[ankle][2] + 0.26];
  }
  const sw = rad(swing);
  rows[4] = [rows[2][0] + 0.22 * Math.cos(sw), -1 + 0.42, rows[2][2] + 0.5 * Math.sin(sw)];
  rows[6] = [rows[4][0] + 0.3 * Math.cos(sw + 0.9), rows[4][1] - handUp, rows[4][2] + 0.5 * Math.sin(sw + 0.9)];
  rows[8] = [rows[6][0] + 0.08, rows[6][1] - 0.03, rows[6][2] + 0.12];
  rows[10] = [rows[6][0] + 0.12, rows[6][1] - 0.05, rows[6][2] + 0.14];
  rows[12] = [rows[6][0] + 0.04, rows[6][1] - 0.08, rows[6][2] + 0.1];
  rows[3] = [rows[1][0] - 0.12, -0.5, rows[1][2] + 0.22];
  rows[5] = [rows[1][0] - 0.05, -0.12, rows[1][2] + 0.46];
  rows[7] = [rows[5][0] - 0.05, rows[5][1] + 0.1, rows[5][2] + 0.08];
  rows[9] = [rows[5][0] + 0.03, rows[5][1] + 0.12, rows[5][2] + 0.1];
  rows[11] = [rows[5][0] + 0.06, rows[5][1] + 0.06, rows[5][2] + 0.06];
  return rows.map(([x, y, z]) => [x + (next() - 0.5) * 0.06, y + (next() - 0.5) * 0.06, z + (next() - 0.5) * 0.06]);
}

// pose2d and pose3d of one shot: the three reference times (0.77 s before, 0.4 s before, the hit) of a
// right-hander. 2D is what a camera at that end sees, so far-end shots are mirrored and every frame has
// its own scale and place; 3D is turned by a random yaw. The server undoes all of that.
function shotPose({ kind, side, month, person, next }) {
  const attack = kind === '스매시' || kind === '드라이브';
  const later = month === '10';
  const gain = person === 'cha' ? 1 : 0.35;
  const base = { knee: (attack ? 18 : 12) + (later ? 10 * gain : 0), twist: (attack ? 22 : 10) + (later ? 12 * gain : 0), handUp: (attack ? 0.1 : 0.35) + (later ? 0.08 * gain : 0) };
  const swings = attack ? [-70, -25, 40] : kind === '서브' ? [-30, -10, 20] : [-40, -10, 25];
  const frames3d = swings.map((swing) => body({ swing: swing + (later ? 6 * gain : 0), ...base, next }));
  const yaw = (next() - 0.5) * 1.4;
  const [cy, sy] = [Math.cos(yaw), Math.sin(yaw)];
  const scale = 180 + next() * 120;
  const [ox, oy] = [400 + next() * 400, 300 + next() * 200];
  const vis = () => (next() < 0.06 ? 0.3 : 0.9);
  return {
    pose2d: { model: 'mediapipe-pose-heavy', at: [-0.77, -0.4, 0], hand: 'R', frames: frames3d.map((f) => f.map(([x, y]) => [round(ox + (side === 'far' ? -x : x) * scale), round(oy + y * scale), vis()])) },
    pose3d: { frames: frames3d.map((f) => f.map(([x, y, z]) => [round(x * cy + z * sy), round(y), round(z * cy - x * sy), vis()])) },
  };
}

function buildDesk(tournament) {
  const t0 = Date.now() - 36 * 3600_000;
  const jobs = [];
  const files = {};
  const videoOf = (n) => ({ name: `desk-${n}.mp4`, bytes: 24 * MiB, received: 24 * MiB, type: 'video/mp4' });
  const job = (n, extra) => ({ id: jobId(n), kind: 'gallery', state: 'done', createdAt: t0 + n * 3600_000, updatedAt: t0 + n * 3600_000 + 600_000, corners: null, matchRef: null, nearEnd: null, progress: null, waitPos: null, error: null, note: null, attempts: 0, lease: null, ...extra });
  VIDEOS.forEach((v, n) => {
    const id = jobId(n);
    const players = { near: PEOPLE[v.near], far: PEOPLE[v.far] };
    const rallies = galleryRallies({ score: v.score, seed: 11 + n });
    files[`analysis/g-${id}.json`] = { v: 1, source: 'gallery', id, playedAt: v.playedAt, title: v.title, players, rallies };
    const next = rng(101 + n);
    const poseRallies = Object.fromEntries(rallies.map((r) => [r.index, Object.fromEntries(r.shots.map((s, i) => [i, shotPose({ kind: s.kind, side: s.side, month: v.playedAt.slice(5, 7), person: s.side === 'near' ? v.near : v.far, next })]))]));
    files[`analysis/pose/${galleryPoseKey(id)}.json`] = { v: 1, rallies: poseRallies };
    jobs.push(job(n, { title: v.title, playedAt: v.playedAt, players, video: videoOf(n), progress: { done: 5400, total: 5400 } }));
  });
  const n0 = VIDEOS.length;
  // a desk re-analysis of one tournament point (the live and desk rallies of point 7 are in the seed)
  jobs.push(job(n0, { kind: 'rally', title: '1경기 7번째 포인트 클립', playedAt: tournament.createdAt, players: { near: null, far: null }, video: { name: 'clip-m1-7.webm', bytes: 3 * MiB, received: 3 * MiB, type: 'video/webm' }, matchRef: { tournament: tournament.createdAt, matchId: 'm1', index: 6 }, nearEnd: 'blue', note: { dropped: 0, nearSlot: 0 }, progress: { done: 420, total: 420 } }));
  jobs.push(job(n0 + 1, { state: 'failed', title: '동호회 리그 10월 26일', playedAt: '2026-10-26', players: { near: PEOPLE.cha, far: PEOPLE.seo }, video: videoOf(n0 + 1), attempts: 3, error: '분석기 응답이 90초 동안 없었어요.', progress: { done: 1180, total: 5400 } }));
  // two queued jobs for the fake worker to claim (one waits for the GPU, one runs) and one plain queued
  jobs.push(job(n0 + 2, { state: 'queued', title: '연습 10월 31일 오전', playedAt: '2026-10-31', players: { near: PEOPLE.cha, far: PEOPLE.seo }, video: videoOf(n0 + 2) }));
  jobs.push(job(n0 + 3, { state: 'queued', title: '동호회 리그 10월 31일', playedAt: '2026-10-31', players: { near: PEOPLE.cha2, far: PEOPLE.cha }, video: videoOf(n0 + 3) }));
  jobs.push(job(n0 + 4, { state: 'queued', title: '연습 10월 30일 2게임', playedAt: '2026-10-30', players: { near: PEOPLE.seo, far: null }, video: videoOf(n0 + 4) }));
  // an upload a phone did not finish: 3 MiB of 8 MiB are on disk, the same file continues it
  jobs.push(job(n0 + 5, { state: 'uploading', title: '연습 10월 30일 1게임', playedAt: '2026-10-30', players: { near: PEOPLE.cha, far: PEOPLE.seo }, video: { name: 'practice-1030-1.mp4', bytes: 8 * MiB, received: 3 * MiB, type: 'video/mp4' } }));
  files['desk/queue.json'] = { v: 1, jobs };
  return { files, partial: { path: `desk/videos/${jobId(n0 + 5)}.mp4`, bytes: 3 * MiB }, uploadName: 'practice-1030-1.mp4', uploadBytes: 8 * MiB };
}

function targetDir() {
  const out = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
  if (!out) throw new SeedRefused('사용법: bun scripts/seed-analysis.js --out=<빈 폴더>');
  const dir = resolve(out);
  mkdirSync(dirname(dir), { recursive: true });
  const real = existsSync(dir) ? realpathSync(dir) : dir;
  const live = [join(import.meta.dir, '..', 'data')].map((p) => resolve(p));
  if (live.includes(real)) throw new SeedRefused(`운영 데이터 폴더에는 쓰지 않아요: ${real}`);
  if (existsSync(join(real, 'tournament.json'))) throw new SeedRefused(`이미 대회가 있는 폴더예요: ${real}`);
  return real;
}

class SeedRefused extends Error {}

try {
  const dir = targetDir();
  const { tournament, rallies } = buildDemo();
  const pin = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
  mkdirSync(join(dir, 'analysis'), { recursive: true });
  writeFileSync(join(dir, 'tournament.json'), JSON.stringify({ rev: WINNERS.length, pin, tournament, favorite: false }, null, 2));
  const doc = { v: 1, tournament: tournament.createdAt, matches: { m1: { rallies } } };
  writeFileSync(join(dir, 'analysis', analysisFileName(tournament.createdAt)), JSON.stringify(doc));
  const desk = buildDesk(tournament);
  for (const [rel, content] of Object.entries(desk.files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), JSON.stringify(content));
  }
  mkdirSync(dirname(join(dir, desk.partial.path)), { recursive: true });
  writeFileSync(join(dir, desk.partial.path), new Uint8Array(desk.partial.bytes));
  console.log(`seeded ${WINNERS.length} rallies into ${dir}`);
  console.log(`seeded ${VIDEOS.length} desk videos (${Object.keys(desk.files).length - 1} files) and a queue of ${desk.files['desk/queue.json'].jobs.length} jobs; the unfinished upload continues with a ${desk.uploadBytes / MiB} MiB file named ${desk.uploadName}`);
} catch (e) {
  if (!(e instanceof SeedRefused)) throw e;
  console.error(e.message);
  process.exit(1);
}
