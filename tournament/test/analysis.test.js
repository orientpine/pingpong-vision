import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TECH_ESTIMATE, TECH_KEYS, accuracyStatus, analyzeMatch, estimateFrom, onePerPoint, reportLine, slotOfSide, techniqueOf, zoneOf,
} from '../public/analysis.js';
import { analysisFileName, createAnalysis } from '../analysis-store.js';
import { addPoint, createTournament } from '../public/engine.js';

const ROOT = join(import.meta.dir, '..');
const shot = (side, kind = '드라이브', stroke = '포핸드', land = null) => ({ side, t: 0, stroke, kind, speedKmh: 30, arc: 0.1, inferred: false, land });
const rally = (index, winner, shots, extra = {}) => ({ v: 1, index, startedAt: 1000, durationMs: 1000, winner, nearSlot: 0, why: 'out', shots, bounces: [], ...extra });
const alternate = (count) => Array.from({ length: count }, (_, i) => shot(i % 2 === 0 ? 'near' : 'far', i === 0 ? '서브' : '드라이브'));

describe('classification', () => {
  test('slotOfSide follows nearSlot so a change of ends keeps the player', () => {
    expect(slotOfSide({ nearSlot: 1 }, 'near')).toBe(1);
    expect(slotOfSide({ nearSlot: 1 }, 'far')).toBe(0);
    expect(slotOfSide({ nearSlot: 0 }, 'far')).toBe(1);
  });

  test.each([
    ['포핸드', '서브', 'fore', 'serve', 'fore-serve'],
    ['백핸드', '스매시', 'back', 'attack', 'back-attack'],
    ['포핸드', '드라이브', 'fore', 'attack', 'fore-attack'],
    ['백핸드', '푸시', 'back', 'defence', 'back-defence'],
    ['포핸드', '로빙', 'fore', 'defence', 'fore-defence'],
    [null, '서브', null, 'serve', null],
    ['백핸드', null, 'back', null, null],
  ])('techniqueOf(%p, %p)', (stroke, kind, hand, type, key) => {
    expect(techniqueOf({ stroke, kind })).toEqual({ hand, type, key });
  });

  test('every technique is an estimate until an accuracy table exists', () => {
    expect(Object.keys(TECH_ESTIMATE).sort()).toEqual([...TECH_KEYS].sort());
    expect(Object.values(TECH_ESTIMATE).every(Boolean)).toBe(true);
  });

  test('accuracyStatus says sample below n=5, estimate under the 0.7 bar, measured otherwise', () => {
    const table = {
      'back-serve': { precision: null, recall: null, n: 0 },
      'fore-defence': { precision: 0.9, recall: 0.9, n: 4 },
      'fore-attack': { precision: 0.76, recall: 0.5, n: 26 },
      'back-attack': { precision: 0.8, recall: 0.75, n: 5 },
    };
    expect(accuracyStatus(table, 'back-serve')).toBe('sample');
    expect(accuracyStatus(table, 'fore-defence')).toBe('sample');
    expect(accuracyStatus(table, 'fore-attack')).toBe('estimate');
    expect(accuracyStatus(table, 'back-attack')).toBe('measured');
    expect(accuracyStatus(null, 'fore-attack')).toBe('sample');
  });

  test('estimateFrom marks a technique only when precision or recall is under 0.7', () => {
    const good = { precision: 0.7, recall: 0.7, n: 20 };
    const est = estimateFrom({ 'fore-attack': good, 'back-attack': { ...good, recall: 0.69 }, 'back-serve': { ...good, precision: 0.5 } });
    expect(est['fore-attack']).toBe(false);
    expect(est['back-attack']).toBe(true);
    expect(est['back-serve']).toBe(true);
    expect(est['fore-serve']).toBe(true);
  });
});

describe('zoneOf', () => {
  test.each([
    [{ tx: 1.37, ty: 0 }, 'near', { col: 0, row: 0 }],
    [{ tx: 1.37 + 0.45, ty: 0.5 }, 'near', { col: 0, row: 0 }],
    [{ tx: 1.37 + 1.37 / 3, ty: 1.525 / 3 }, 'near', { col: 1, row: 1 }],
    [{ tx: 1.37 + (2 * 1.37) / 3, ty: (2 * 1.525) / 3 }, 'near', { col: 2, row: 2 }],
    [{ tx: 2.74, ty: 1.525 }, 'near', { col: 2, row: 2 }],
    [{ tx: 0, ty: 1.525 }, 'far', { col: 0, row: 2 }],
    [{ tx: 0, ty: 0 }, 'far', { col: 2, row: 2 }],
    [{ tx: 1.37, ty: 0.76 }, 'far', { col: 1, row: 0 }],
    [{ tx: 0.8, ty: 0.1 }, 'far', { col: 2, row: 1 }],
  ])('%p from %s', (land, side, expected) => {
    expect(zoneOf(land, side)).toEqual(expected);
  });

  test.each([
    [null, 'near'],
    [{ tx: 1.0, ty: 0.5 }, 'near'],
    [{ tx: 2.0, ty: 0.5 }, 'far'],
    [{ tx: 2.75, ty: 0.5 }, 'near'],
    [{ tx: 2.0, ty: 1.6 }, 'near'],
    [{ tx: 2.0, ty: -0.01 }, 'near'],
  ])('no zone for %p shot from %s', (land, side) => {
    expect(zoneOf(land, side)).toBeNull();
  });
});

describe('analyzeMatch', () => {
  test('empty match has zero counts and no report', () => {
    const a = analyzeMatch([], { pointsLen: 0, clips: {} });
    expect(a.n).toBe(0);
    expect(a.bounces).toEqual([]);
    expect(a.zones[1]).toEqual([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    expect(a.tech[0]['fore-attack']).toEqual({ n: 0, ok: 0 });
    expect(a.length.map((b) => b.label)).toEqual(['1~2구', '3~4구', '5~6구', '7구 이상']);
    expect(a.top5).toEqual([]);
    expect(a.timeline).toEqual([[], []]);
    expect(a.reportBy).toEqual([null, null]);
    expect(a.report).toBeNull();
  });

  test('a desk rally with no known end falls back to the live rally of that point, and stands alone when there is none', () => {
    const live = rally(0, 'near', alternate(3));
    const deskUnknown = rally(0, 'far', alternate(5), { source: 'desk', nearSlot: null });
    expect(onePerPoint([live, deskUnknown], 1)).toEqual([live]);
    expect(onePerPoint([deskUnknown, live], 1)).toEqual([live]);
    expect(onePerPoint([deskUnknown], 1)).toEqual([deskUnknown]);
  });

  test('desk wins over live for the same point, a rally without source is live', () => {
    const live = rally(0, 'near', alternate(3), { source: 'live' });
    const desk = rally(0, 'far', alternate(5), { source: 'desk' });
    const unnamed = rally(1, 'far', alternate(2));
    const a = analyzeMatch([live, desk, unnamed]);
    expect(a.n).toBe(2);
    expect(a.timeline).toEqual([[], [0, 1]]);
    expect(a.top5.find((r) => r.index === 0).shots).toBe(5);
  });

  test('a rally left behind by undo is ignored', () => {
    const a = analyzeMatch([rally(0, 'near', alternate(3)), rally(1, 'far', alternate(3))], { pointsLen: 1, clips: {} });
    expect(a.n).toBe(1);
    expect(a.timeline).toEqual([[0], []]);
    expect(a.tech[0]['fore-attack'].n).toBe(1);
  });

  test('only the loser\'s last shot fails', () => {
    const shots = [shot('near', '서브'), shot('far'), shot('near'), shot('far'), shot('near', '푸시')];
    const { tech } = analyzeMatch([rally(0, 'far', shots)]);
    expect(tech[0]['fore-serve']).toEqual({ n: 1, ok: 1 });
    expect(tech[0]['fore-attack']).toEqual({ n: 1, ok: 1 });
    expect(tech[0]['fore-defence']).toEqual({ n: 1, ok: 0 });
    expect(tech[1]['fore-attack']).toEqual({ n: 2, ok: 2 });
  });

  test('a winner the loser could not return leaves the loser\'s earlier shots successful', () => {
    const shots = [shot('near', '서브'), shot('far'), shot('near', '푸시'), shot('far')];
    const { tech } = analyzeMatch([rally(0, 'far', shots)]);
    expect(tech[0]['fore-serve']).toEqual({ n: 1, ok: 1 });
    expect(tech[0]['fore-defence']).toEqual({ n: 1, ok: 1 });
    expect(tech[1]['fore-attack']).toEqual({ n: 2, ok: 2 });
  });

  test('an ace leaves nothing failed because the loser never hit', () => {
    const { tech, length } = analyzeMatch([rally(0, 'near', [shot('near', '서브')])]);
    expect(tech[0]['fore-serve']).toEqual({ n: 1, ok: 1 });
    expect(length[0]).toEqual({ label: '1~2구', n: 1, won: [1, 0] });
  });

  test('a rally without a winner counts for zones and top 5 but not for success, length, serve or timeline', () => {
    const land = { tx: 2.5, ty: 0.1 };
    const a = analyzeMatch([rally(0, null, [shot('near', '서브', '포핸드', land)])]);
    expect(a.n).toBe(1);
    expect(a.zones[0][2][0]).toBe(1);
    expect(a.tech[0]['fore-serve']).toEqual({ n: 0, ok: 0 });
    expect(a.length.every((b) => b.n === 0)).toBe(true);
    expect(a.serve[0].n).toBe(0);
    expect(a.timeline).toEqual([[], []]);
    expect(a.top5[0].winner).toBeNull();
  });

  test('shots without a technique are counted per player and left out of success', () => {
    const shots = [shot('near', '서브', null), shot('far', null), shot('near')];
    const a = analyzeMatch([rally(0, 'near', shots)]);
    expect(a.unclassified).toEqual([1, 1]);
    expect(a.tech[0]['fore-attack'].n).toBe(1);
    expect(a.tech[1]['fore-attack'].n).toBe(0);
  });

  test('players stay themselves across a change of ends', () => {
    const swapped = rally(1, 'near', [shot('near', '서브')], { nearSlot: 1 });
    const a = analyzeMatch([rally(0, 'near', [shot('near', '서브')]), swapped]);
    expect(a.timeline).toEqual([[0], [1]]);
    expect(a.serve).toEqual([{ n: 1, won: 1 }, { n: 1, won: 1 }]);
  });

  test('a point whose near player is unknown is counted apart and goes to no player', () => {
    const unknown = rally(1, 'near', [shot('near', '서브')], { nearSlot: null, source: 'desk' });
    const a = analyzeMatch([rally(0, 'near', [shot('near', '서브')]), unknown]);
    expect(a.unattributed).toBe(1);
    expect(a.timeline).toEqual([[0], []]);
    expect(a.serve).toEqual([{ n: 1, won: 1 }, { n: 0, won: 0 }]);
  });

  test.each([[1, 0], [2, 0], [3, 1], [4, 1], [5, 2], [6, 2], [7, 3], [30, 3]])('%i shots fall in length bucket %i', (shots, bucket) => {
    expect(analyzeMatch([rally(0, 'far', alternate(shots))]).length[bucket].won).toEqual([0, 1]);
  });

  test('serve counts who hit the first shot, and won rallies', () => {
    const a = analyzeMatch([
      rally(0, 'near', alternate(3)),
      rally(1, 'far', alternate(4)),
      rally(2, 'near', [shot('far', '서브'), shot('near')]),
    ]);
    expect(a.serve).toEqual([{ n: 2, won: 1 }, { n: 1, won: 0 }]);
  });

  test('bounces belong to the last hitter, and those without a position are skipped', () => {
    const shots = [{ ...shot('near', '서브'), t: 1 }, { ...shot('far'), t: 2 }];
    const bounces = [
      { tx: 0.5, ty: 0.5, side: 'near', t: 0.9 },
      { tx: 2, ty: 0.5, side: 'far', t: 1.3 },
      { tx: 0.4, ty: 0.2, side: 'near', t: 2.3 },
      { tx: null, ty: null, side: 'far', t: 2.5 },
    ];
    expect(analyzeMatch([rally(0, 'near', shots, { bounces })]).bounces).toEqual([
      { tx: 0.5, ty: 0.5, slot: 0 }, { tx: 2, ty: 0.5, slot: 0 }, { tx: 0.4, ty: 0.2, slot: 1 },
    ]);
  });

  test('top 5 is longest first, ties by duration then index, with the clip of that point', () => {
    const clip = '/vision/s/' + 'A'.repeat(43);
    const rallies = [
      rally(0, 'near', alternate(3)),
      rally(1, 'near', alternate(5), { durationMs: 2000 }),
      rally(2, 'far', alternate(5), { durationMs: 3000 }),
      rally(3, 'near', alternate(5), { durationMs: 2000 }),
      rally(4, 'near', alternate(1)),
      rally(5, 'near', alternate(9)),
    ];
    const { top5 } = analyzeMatch(rallies, { pointsLen: 6, clips: { 5: clip } });
    expect(top5.map((r) => r.index)).toEqual([5, 2, 1, 3, 0]);
    expect(top5[0]).toEqual({ index: 5, shots: 9, durationMs: 1000, winner: 0, clip });
    expect(top5[1].clip).toBeNull();
  });
});

describe('report', () => {
  const lost = (index, count) => rally(index, 'far', alternate(count));

  test('below five points with a decided winner the line says so, however many shots there are', () => {
    const a = analyzeMatch([0, 1, 2, 3].map((i) => lost(i, 9)));
    expect(a.decided).toBe(4);
    expect(reportLine(a, 0)).toBe('아직 득점이 정해진 포인트가 적어요(4개).');
    expect(reportLine(a, 1)).toBe('아직 득점이 정해진 포인트가 적어요(4개).');
  });

  test('points without a winner do not count towards the five', () => {
    const open = (index) => ({ ...lost(index, 9), winner: null });
    const a = analyzeMatch([lost(0, 9), lost(1, 9), open(2), open(3), open(4), open(5)]);
    expect(a.decided).toBe(2);
    expect(reportLine(a, 0)).toContain('(2개)');
  });

  test('five samples are enough and the line names the number', () => {
    const a = analyzeMatch([0, 1, 2, 3, 4].map((i) => lost(i, 1)));
    expect(reportLine(a, 0)).toContain('0%(5번 중 0번)');
    expect(a.reportBy[0].slot).toBe(0);
    expect(a.report).toEqual(a.reportBy[0]);
  });

  test('the weakest metric wins, not the first one', () => {
    const analysis = {
      serve: [{ n: 10, won: 8 }, { n: 10, won: 2 }],
      tech: [Object.fromEntries(TECH_KEYS.map((k) => [k, { n: 10, ok: k === 'back-defence' ? 3 : 9 }])), {}],
      length: [{ label: '1~2구', n: 2, won: [0, 2] }],
    };
    expect(reportLine(analysis, 0)).toContain('30%(10번 중 3번)');
  });

  test('all metrics at 100% name no lowest: the most-sampled one is praised', () => {
    const analysis = { serve: [{ n: 5, won: 5 }, { n: 0, won: 0 }], tech: [Object.fromEntries(TECH_KEYS.map((k) => [k, { n: k === 'fore-attack' ? 14 : 0, ok: k === 'fore-attack' ? 14 : 0 }])), {}], length: [] };
    const line = reportLine(analysis, 0);
    expect(line).not.toContain('가장 낮');
    expect(line).toContain('14번 중 14번 모두 성공');
    expect(line).toContain('아직 약점이 안 보여요');
  });

  test('metrics tied below 100% name no lowest either', () => {
    const analysis = { serve: [{ n: 10, won: 5 }, { n: 0, won: 0 }], tech: [Object.fromEntries(TECH_KEYS.map((k) => [k, { n: k === 'fore-attack' ? 6 : 0, ok: k === 'fore-attack' ? 3 : 0 }])), {}], length: [] };
    const line = reportLine(analysis, 0);
    expect(line).not.toContain('가장 낮');
    expect(line).toContain('50%(10번 중 5번)');
  });
});

describe('store files', () => {
  const tournament = addPoint(createTournament({ players: ['A,0001', 'B,0002', 'C,0003', 'D,0004'] }), 'm1', 0, 0);
  const make = (dataDir, defaultAccuracyFile = null) => {
    const logged = [];
    const analysis = createAnalysis({
      dataDir, getStore: () => ({ tournament }), readArchive: () => null, checkPin: () => ({ ok: true }), cameraToken: () => false, cameraError: 'x', defaultAccuracyFile, log: (m) => logged.push(m),
    });
    const get = async () => (await analysis.handle(new Request('http://x/'), new URL('http://x/api/analysis/match/m1'))).json();
    return { logged, get, analysis };
  };
  const placeFile = (dataDir, text) => {
    mkdirSync(join(dataDir, 'analysis'));
    const path = join(dataDir, 'analysis', analysisFileName(tournament.createdAt));
    writeFileSync(path, text);
    return path;
  };
  let dataDir;
  beforeAll(() => { dataDir = mkdtempSync(join(tmpdir(), 'pp-analysis-files-')); });
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
  const fresh = () => mkdtempSync(join(dataDir, 'd-'));

  test('no file reads as empty and creates nothing', async () => {
    const dir = fresh();
    expect(await make(dir).get()).toEqual({ rallies: [], accuracy: null });
    expect(existsSync(join(dir, 'analysis'))).toBe(false);
  });

  test.each([['broken JSON', '{"v":1,'], ['no v field', '{"matches":{}}'], ['wrong v', '{"v":2,"matches":{}}']])('%s is logged once and read as empty', async (_, text) => {
    const dir = fresh();
    placeFile(dir, text);
    const { get, logged } = make(dir);
    expect(await get()).toEqual({ rallies: [], accuracy: null });
    await get();
    expect(logged.length).toBe(1);
  });

  test('a bare rally written before sources existed reads as live', async () => {
    const dir = fresh();
    placeFile(dir, JSON.stringify({ v: 1, tournament: tournament.createdAt, matches: { m1: { rallies: { 0: rally(0, 'near', []) } } } }));
    const { rallies } = await make(dir).get();
    expect(rallies.map((r) => [r.index, r.source])).toEqual([[0, 'live']]);
  });

  test('a write over a broken file keeps the broken file aside', async () => {
    const dir = fresh();
    const path = placeFile(dir, 'broken');
    const { analysis, get } = make(dir);
    const req = new Request('http://x/api/analysis/rally', { method: 'POST', body: JSON.stringify({ matchId: 'm1', index: 0, rally: rally(0, 'near', []) }) });
    expect((await analysis.handle(req, new URL(req.url))).status).toBe(200);
    expect((await get()).rallies.length).toBe(1);
    const aside = readdirSync(join(dir, 'analysis')).find((f) => f.includes('.bad-'));
    expect(readFileSync(join(dir, 'analysis', aside), 'utf8')).toBe('broken');
    expect(JSON.parse(readFileSync(path, 'utf8')).v).toBe(1);
  });

  test('the shipped accuracy table is served when the data dir has none, and a data-dir table overrides it', async () => {
    const shipped = join(import.meta.dir, '..', 'analysis-accuracy.json');
    const dir = fresh();
    const served = (await make(dir, shipped).get()).accuracy;
    expect(Object.keys(served).sort()).toEqual([...TECH_KEYS].sort());
    expect(TECH_KEYS.map((key) => accuracyStatus(served, key)).filter((s) => s === 'estimate')).toHaveLength(2);
    expect(TECH_KEYS.map((key) => accuracyStatus(served, key)).filter((s) => s === 'sample')).toHaveLength(4);
    mkdirSync(join(dir, 'analysis'));
    const row = { precision: 0.9, recall: 0.9, n: 40 };
    writeFileSync(join(dir, 'analysis', 'accuracy.json'), JSON.stringify({ 'fore-attack': row }));
    expect((await make(dir, shipped).get()).accuracy).toEqual({ 'fore-attack': row });
  });

  test('accuracy table is served when present, a broken one reads as null', async () => {
    const dir = fresh();
    mkdirSync(join(dir, 'analysis'));
    const row = { precision: 0.8, recall: 0.75, n: 40 };
    writeFileSync(join(dir, 'analysis', 'accuracy.json'), JSON.stringify({ 'fore-attack': row, junk: row }));
    expect((await make(dir).get()).accuracy).toEqual({ 'fore-attack': row });
    writeFileSync(join(dir, 'analysis', 'accuracy.json'), 'nope');
    expect((await make(dir).get()).accuracy).toBeNull();
  });
});

describe('routes on a real server', () => {
  const sha = (path) => new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex');
  let dir;
  let archiveId;
  let port;
  let base;
  let proc;
  let pin;
  let saved;

  // Given: an older data dir with a tournament and an archive and no analysis folder.
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-analysis-'));
    let t = createTournament({ players: ['A,0001', 'B,0002', 'C,0003', 'D,0004'] });
    t = addPoint(addPoint(t, 'm1', 0, 0), 'm1', 1, 1);
    saved = { rev: 7, pin: '4827', tournament: t, favorite: false };
    pin = saved.pin;
    writeFileSync(join(dir, 'tournament.json'), JSON.stringify(saved, null, 2));
    archiveId = '1700000000000';
    mkdirSync(join(dir, 'archive'));
    const old = { ...saved, tournament: { ...t, createdAt: '2025-01-01T00:00:00.000Z' } };
    writeFileSync(join(dir, 'archive', 'tournament-' + archiveId + '.json'), JSON.stringify(old, null, 2));
    port = 20000 + Math.floor(Math.random() * 20000);
    base = 'http://127.0.0.1:' + port;
    proc = Bun.spawn(['bun', join(ROOT, 'server.js')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir }, stdout: 'pipe', stderr: 'inherit' });
    const reader = proc.stdout.getReader();
    let out = '';
    while (!out.includes('listening')) {
      const { value, done } = await reader.read();
      if (done) throw new Error('server exited before listening: ' + out);
      out += new TextDecoder().decode(value);
    }
    reader.releaseLock();
  });

  afterAll(() => {
    proc?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (body, headers = { 'x-pin': pin }) => fetch(base + '/api/analysis/rally', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const good = (index = 0) => ({ matchId: 'm1', index, rally: rally(index, 'near', alternate(3)) });
  const getJson = async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
  };

  test('migration: older records read unchanged and a POST changes no record, rev or sha', async () => {
    const files = [join(dir, 'tournament.json'), join(dir, 'archive', 'tournament-' + archiveId + '.json')];
    const before = files.map(sha);
    const revBefore = (await getJson('/api/state')).body.rev;
    expect((await getJson('/api/analysis/match/m1')).body.rallies).toEqual([]);
    expect((await getJson('/api/analysis/history/' + archiveId + '/m1')).body.rallies).toEqual([]);
    expect(existsSync(join(dir, 'analysis'))).toBe(false);

    expect((await post(good())).status).toBe(200);

    expect(files.map(sha)).toEqual(before);
    expect((await getJson('/api/state')).body.rev).toBe(revBefore);
    const name = analysisFileName(saved.tournament.createdAt);
    expect(readdirSync(join(dir, 'analysis'))).toEqual([name]);
    expect(JSON.parse(readFileSync(join(dir, 'analysis', name), 'utf8')).tournament).toBe(saved.tournament.createdAt);
    expect((await getJson('/api/analysis/match/m1')).body.rallies.map((r) => r.index)).toEqual([0]);
    expect((await getJson('/api/analysis/history/current/m1')).body.rallies.length).toBe(1);
    expect((await getJson('/api/analysis/history/' + archiveId + '/m1')).body.rallies).toEqual([]);
  });

  test('a write logs one line without its body', async () => {
    const log = () => readFileSync(join(dir, 'action.log'), 'utf8').trim().split('\n');
    const before = log().length;
    expect((await post(good(1))).status).toBe(200);
    const lines = log();
    expect(lines.length).toBe(before + 1);
    expect(lines.at(-1)).toMatch(/\| POST \/api\/analysis\/rally \| ok 200 \| rev 7->7 \| ip 127\.0\.0\.1$/);
    expect(lines.at(-1)).not.toContain(pin);
  });

  test('a camera token is refused before the PIN check', async () => {
    const res = await post(good(), { 'x-vision-token': 'old' });
    expect(res.status).toBe(403);
    expect((await post(good(), {})).status).toBe(403);
  });

  test.each([
    ['not JSON', '{'],
    ['no match', { index: 0, rally: rally(0, 'near', []) }],
    ['negative index', { matchId: 'm1', index: -1, rally: rally(-1, 'near', []) }],
    ['index mismatch', { matchId: 'm1', index: 0, rally: rally(1, 'near', []) }],
    ['no rally', { matchId: 'm1', index: 0 }],
    ['bad winner', { matchId: 'm1', index: 0, rally: rally(0, 'left', []) }],
    ['bad nearSlot', { matchId: 'm1', index: 0, rally: rally(0, 'near', [], { nearSlot: 2 }) }],
    ['bad shot side', { matchId: 'm1', index: 0, rally: rally(0, 'near', [shot('up')]) }],
    ['bad source', { matchId: 'm1', index: 0, rally: rally(0, 'near', [], { source: 'phone' }) }],
  ])('malformed: %s', async (_, body) => {
    expect((await post(body)).status).toBe(400);
  });

  test.each([
    ['index at points', 'm1', 2],
    ['unknown match', 'nope', 0],
    ['prototype name', '__proto__', 0],
  ])('404: %s', async (_, matchId, index) => {
    expect((await post({ matchId, index, rally: rally(index, 'near', []) })).status).toBe(404);
  });

  test('saved rally keeps documented fields only, and a repeat index overwrites', async () => {
    const body = good(0);
    body.rally.durationMs = 4321;
    body.rally.shots[0].secret = 'x';
    body.rally.extra = 'y';
    expect((await post(body)).status).toBe(200);
    const [first] = (await getJson('/api/analysis/match/m1')).body.rallies;
    expect(first.durationMs).toBe(4321);
    expect(first.extra).toBeUndefined();
    expect(first.shots[0].secret).toBeUndefined();
  });

  test('a pose on a shot is not stored', async () => {
    const body = good(0);
    body.rally.shots[0].pose = { at: [-0.77, -0.4, 0], frames: [null, null, null] };
    expect((await post(body)).status).toBe(200);
    const [first] = (await getJson('/api/analysis/match/m1')).body.rallies;
    expect(first.shots[0].pose).toBeUndefined();
    expect(first.source).toBe('live');
  });

  test('undo hides a rally on read', async () => {
    expect((await getJson('/api/analysis/match/m1')).body.rallies.length).toBe(2);
    await fetch(base + '/api/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pin': pin }, body: JSON.stringify({ type: 'undo', matchId: 'm1', seq: 2 }) });
    expect((await getJson('/api/analysis/match/m1')).body.rallies.map((r) => r.index)).toEqual([0]);
  });

  test('desk and live of one point are both kept, and a repeat of one source replaces only that source', async () => {
    const desk = { matchId: 'm1', index: 0, rally: rally(0, 'far', alternate(5), { source: 'desk' }) };
    expect((await post(desk)).status).toBe(200);
    desk.rally.durationMs = 777;
    expect((await post(desk)).status).toBe(200);
    const rallies = (await getJson('/api/analysis/match/m1')).body.rallies;
    expect(rallies.map((r) => [r.index, r.source])).toEqual([[0, 'live'], [0, 'desk']]);
    expect(rallies[1].durationMs).toBe(777);
    expect(rallies[0].shots.length).toBe(3);
  });

  test('reads answer an empty list for an unknown match, 404 for an unknown archive, 400 for a bad id', async () => {
    expect((await getJson('/api/analysis/match/nope')).body.rallies).toEqual([]);
    expect((await getJson('/api/analysis/history/999/m1')).status).toBe(404);
    expect((await getJson('/api/analysis/history/abc/m1')).status).toBe(400);
  });
});

test('409 when there is a PIN but no tournament', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-analysis-empty-'));
  const analysis = createAnalysis({
    dataDir: dir, getStore: () => ({ tournament: null }), readArchive: () => null, checkPin: () => ({ ok: true }), cameraToken: () => false, cameraError: 'x',
  });
  const req = new Request('http://x/api/analysis/rally', { method: 'POST', body: JSON.stringify({ matchId: 'm1', index: 0, rally: rally(0, 'near', []) }) });
  const res = await analysis.handle(req, new URL(req.url));
  rmSync(dir, { recursive: true, force: true });
  expect(res.status).toBe(409);
});

describe('seed script', () => {
  test('writes an isolated demo whose first match is finished and analysable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-seed-'));
    const out = join(dir, 'demo');
    const run = (arg) => Bun.spawn(['bun', join(ROOT, 'scripts', 'seed-analysis.js'), arg], { stdout: 'pipe', stderr: 'pipe' });
    expect(await run('--out=' + out).exited).toBe(0);
    const store = JSON.parse(readFileSync(join(out, 'tournament.json'), 'utf8'));
    const log = store.tournament.log.m1;
    const doc = JSON.parse(readFileSync(join(out, 'analysis', analysisFileName(store.tournament.createdAt)), 'utf8'));
    const a = analyzeMatch(Object.values(doc.matches.m1.rallies).flatMap((entry) => Object.values(entry)), { pointsLen: log.points.length, clips: log.clips });
    expect(a.n).toBe(log.points.length);
    expect(a.n).toBeGreaterThanOrEqual(17);
    expect(a.unclassified[0] + a.unclassified[1]).toBeGreaterThan(0);
    expect(a.top5[0].shots).toBeGreaterThanOrEqual(7);
    expect(a.top5.some((r) => r.clip)).toBe(true);
    expect(a.bounces.length).toBeGreaterThan(20);
    expect(a.reportBy.some(Boolean)).toBe(true);
    expect(Object.values(doc.matches.m1.rallies).filter((e) => e.desk).length).toBe(2);
    expect(await run('--out=' + out).exited).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
