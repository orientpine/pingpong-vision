import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlayers, refOf } from '../players-store.js';
import { analysisFileName } from '../analysis-store.js';
import { addPoint, createTournament, derive } from '../public/engine.js';

// The PIN and the four digits here are made up.
const PIN = '1234';
const root = mkdtempSync(join(tmpdir(), 'pp-players-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fresh = () => mkdtempSync(join(root, 'd-'));

function makePlayers(dataDir, logged = []) {
  const players = createPlayers({
    dataDir,
    checkPin: (_req, pin) => (pin === PIN ? { ok: true } : { ok: false, status: 401, error: 'PIN' }),
    tournaments: () => [],
    ralliesOf: () => [],
    galleryDocs: () => [],
    now: () => Date.UTC(2026, 10, 1),
    log: (m) => logged.push(m),
  });
  const call = async (method, path, body, pin = PIN) => {
    const init = { method, headers: { 'x-pin': pin } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const req = new Request('http://x' + path, init);
    const res = await players.handle(req, new URL(req.url));
    return { status: res?.status, body: res ? await res.json() : null };
  };
  return { call, logged };
}
const fileOf = (dir) => join(dir, 'analysis', 'players.json');

describe('aliases', () => {
  test('merge writes one alias and the reads follow it', async () => {
    const dir = fresh();
    const { call } = makePlayers(dir);
    expect((await call('POST', '/api/players/merge', { from: '홍길동', to: '홍길동，0712' })).status).toBe(200);
    expect(JSON.parse(readFileSync(fileOf(dir), 'utf8'))).toEqual({ v: 1, aliases: { 홍길동: '홍길동,0712' } });
    expect((await call('GET', '/api/players/aliases')).body).toEqual({ aliases: { 홍길동: '홍길동,0712' } });
  });

  test('rename keeps the four digits and moves the person as it is now', async () => {
    const dir = fresh();
    const { call } = makePlayers(dir);
    await call('POST', '/api/players/merge', { from: '홍길동', to: '홍길동,0712' });
    const res = await call('POST', '/api/players/rename', { from: '홍길동', toName: ' 홍길돈 ' });
    expect(res.body.aliases).toEqual({ 홍길동: '홍길동,0712', '홍길동,0712': '홍길돈,0712' });
  });

  test('a merge into the same person or back along a chain is refused', async () => {
    const { call } = makePlayers(fresh());
    expect((await call('POST', '/api/players/merge', { from: 'a,0001', to: 'a,0001' })).status).toBe(409);
    await call('POST', '/api/players/merge', { from: 'a,0001', to: 'b,0002' });
    await call('POST', '/api/players/merge', { from: 'b,0002', to: 'c,0003' });
    expect((await call('POST', '/api/players/merge', { from: 'c,0003', to: 'a,0001' })).status).toBe(409);
  });

  test('deleting an alias undoes it and a second delete is 404', async () => {
    const dir = fresh();
    const { call } = makePlayers(dir);
    await call('POST', '/api/players/merge', { from: '홍길동', to: '홍길동,0712' });
    expect((await call('DELETE', `/api/players/aliases/${encodeURIComponent('홍길동')}`)).status).toBe(200);
    expect(JSON.parse(readFileSync(fileOf(dir), 'utf8')).aliases).toEqual({});
    expect((await call('DELETE', `/api/players/aliases/${encodeURIComponent('홍길동')}`)).status).toBe(404);
  });

  test('every players route needs the PIN', async () => {
    const dir = fresh();
    const { call } = makePlayers(dir);
    expect((await call('GET', '/api/players/aliases', undefined, '')).status).toBe(401);
    expect((await call('POST', '/api/players/merge', { from: 'a', to: 'b' }, '')).status).toBe(401);
    expect((await call('POST', '/api/players/rename', { from: 'a', toName: 'b' }, '')).status).toBe(401);
    expect((await call('DELETE', '/api/players/aliases/a', undefined, '')).status).toBe(401);
    expect(existsSync(fileOf(dir))).toBe(false);
  });

  test('bad keys and names are 400', async () => {
    const { call } = makePlayers(fresh());
    expect((await call('POST', '/api/players/merge', { from: 'a', to: 'b,12' })).status).toBe(400);
    expect((await call('POST', '/api/players/rename', { from: 'a', toName: 'x,y' })).status).toBe(400);
    expect((await call('DELETE', '/api/players/aliases/%E0')).status).toBe(400);
  });

  test('a malformed players.json reads as empty and is kept aside on the next write', async () => {
    const dir = fresh();
    mkdirSync(join(dir, 'analysis'));
    writeFileSync(fileOf(dir), '{"v":1,"aliases":');
    const { call, logged } = makePlayers(dir);
    expect((await call('GET', '/api/players/aliases')).body).toEqual({ aliases: {} });
    expect(logged.length).toBe(1);
    await call('POST', '/api/players/merge', { from: 'a', to: 'b' });
    expect(readdirSync(join(dir, 'analysis')).filter((f) => f.startsWith('players.json.bad-'))).toHaveLength(1);
    expect(JSON.parse(readFileSync(fileOf(dir), 'utf8')).aliases).toEqual({ a: 'b' });
  });

  test('the person read rejects a bad month or period', async () => {
    const { call } = makePlayers(fresh());
    expect((await call('GET', '/api/analysis/person/a?month=2026-13')).status).toBe(400);
    expect((await call('GET', '/api/analysis/person/a?period=day')).status).toBe(400);
    expect((await call('GET', '/api/analysis/person/a')).body.calendar.month).toBe('2026-11');
  });
});

// The real server over a data dir holding a coded current tournament, an old archive without codes,
// the current tournament's analysis file and a gallery match.
// A tournament saved before player codes: plain names and no codes field.
const plainTournament = (opts) => {
  const { codes: _codes, ...t } = createTournament({ ...opts, players: opts.players.map((p, i) => `${p},${String(i).padStart(4, '0')}`) });
  return { ...t, players: opts.players };
};
describe('server', () => {
  const dir = fresh();
  const coded = (() => {
    let t = { ...plainTournament({ players: ['이도윤', '홍길동', '김하나'], pointsToWin: 1, winBy: 1 }), codes: ['1111', '0712', '4821'] };
    for (const side of [0, 0]) t = addPoint(t, 'w1-2', side, derive(t).matches[0].points.length);
    return t;
  })();
  const old = (() => {
    let t = plainTournament({ players: ['이도윤', '홍길동', '김하나'], pointsToWin: 1, winBy: 1 });
    for (const side of [1, 1]) t = addPoint(t, 'w1-2', side, derive(t).matches[0].points.length);
    return { ...t, createdAt: undefined };
  })();
  const shots = [{ side: 'near', t: 0, stroke: '포핸드', kind: '서브', speedKmh: 30, arc: 0, inferred: false, land: null }];
  const rally = (index) => ({ v: 1, index, source: 'live', startedAt: Date.UTC(2026, 10, 2, 3), durationMs: 900, winner: 'near', nearSlot: 0, why: null, shots, bounces: [] });
  mkdirSync(join(dir, 'archive'));
  mkdirSync(join(dir, 'analysis'));
  writeFileSync(join(dir, 'tournament.json'), JSON.stringify({ rev: 2, pin: PIN, tournament: coded }));
  writeFileSync(join(dir, 'archive', `tournament-${Date.UTC(2026, 9, 1)}.json`), JSON.stringify({ rev: 2, pin: PIN, tournament: old }));
  writeFileSync(join(dir, 'analysis', analysisFileName(coded.createdAt)), JSON.stringify({ v: 1, tournament: coded.createdAt, matches: { 'w1-2': { rallies: { 0: rally(0), 1: rally(1) } } } }));
  writeFileSync(join(dir, 'analysis', 'g-abcdef12.json'), JSON.stringify({ v: 1, source: 'gallery', id: 'abcdef12', playedAt: '2026-10-20', title: '연습', players: { near: '김하나,4821', far: '홍길동,0712' }, rallies: [rally(0)] }));
  const records = () => {
    const files = ['tournament.json', join('archive', readdirSync(join(dir, 'archive'))[0]), ...readdirSync(join(dir, 'analysis')).filter((f) => f !== 'players.json').map((f) => join('analysis', f))];
    return Object.fromEntries(files.map((f) => [f, new Bun.CryptoHasher('sha256').update(readFileSync(join(dir, f))).digest('hex')]));
  };
  let proc;
  let base;
  afterAll(() => proc?.kill());

  test('merge, rename and undo leave every record byte for byte and public reads carry names only', async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'server.js')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir }, stdout: 'pipe', stderr: 'inherit' });
    const reader = proc.stdout.getReader();
    let out = '';
    while (!out.includes('listening')) out += new TextDecoder().decode((await reader.read()).value);
    reader.releaseLock();
    base = `http://127.0.0.1:${port}`;
    const before = records();
    const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'x-pin': PIN }, body: JSON.stringify(body) });
    const person = async (key) => (await fetch(`${base}/api/analysis/person/${encodeURIComponent(key)}?month=2026-11`, { headers: { 'x-pin': PIN } })).text();

    expect(JSON.parse(await person('홍길동,0712')).matches).toHaveLength(2);
    expect((await post('/api/players/merge', { from: '홍길동', to: '홍길동,0712' })).status).toBe(200);
    const merged = await person('홍길동,0712');
    const body = JSON.parse(merged);
    expect(body.person.name).toBe('홍길동');
    expect(body.matches.map((m) => m.kind).toSorted()).toEqual(['gallery', 'tournament', 'tournament']);
    expect(body.calendar.days.map((d) => d.date)).toEqual(['2026-11-02']);
    expect(merged).not.toMatch(/,0712|4821|1111/);

    expect((await post('/api/players/rename', { from: '홍길동,0712', toName: '홍길돈' })).status).toBe(200);
    expect(JSON.parse(await person('홍길동')).person.name).toBe('홍길돈');
    const list = await (await fetch(`${base}/api/analysis/matches`)).text();
    expect(JSON.parse(list).items.map((i) => i.kind).toSorted()).toEqual(['gallery', 'tournament', 'tournament']);
    expect(list).not.toMatch(/0712|4821|1111/);

    const undo = await fetch(`${base}/api/players/aliases/${encodeURIComponent('홍길동,0712')}`, { method: 'DELETE', headers: { 'x-pin': PIN } });
    expect(undo.status).toBe(200);
    expect(JSON.parse(await person('홍길동')).person.name).toBe('홍길동');
    await fetch(`${base}/api/players/aliases/${encodeURIComponent('홍길동')}`, { method: 'DELETE', headers: { 'x-pin': PIN } });
    expect(records()).toEqual(before);
  });

  const people = async () => (await (await fetch(`${base}/api/analysis/people`)).json()).people;
  const byRef = (ref) => fetch(`${base}/api/analysis/person/${ref}?month=2026-11`);
  const send = (method, path, body) => fetch(base + path, { method, headers: { 'x-pin': PIN }, ...(body ? { body: JSON.stringify(body) } : {}) });

  test('the public list labels a shared name by the last two digits and never holds a full code', async () => {
    const list = await people();
    expect(JSON.stringify(list)).not.toMatch(/0712|4821|1111/);
    const named = list.filter((p) => p.name === '홍길동');
    expect(named.map((p) => p.label).toSorted()).toEqual(['·12', undefined]);
    expect(list[0].lastPlayed).toBe('2026-11-02');
    expect(list.find((p) => p.label === '·12')).toEqual({ ref: refOf('홍길동,0712'), name: '홍길동', label: '·12', matches: 2, lastPlayed: '2026-11-02' });
  });

  test('a ref answers without a PIN and holds no digits in the answer', async () => {
    const res = await byRef(refOf('홍길동,0712'));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text).person).toEqual({ ref: refOf('홍길동,0712'), name: '홍길동' });
    expect(text).not.toMatch(/,0712|4821|1111/);
  });

  test('the resolved person keeps its ref through a merge, and the merged key still opens it', async () => {
    const target = refOf('홍길동,0712');
    await send('POST', '/api/players/merge', { from: '홍길동', to: '홍길동,0712' });
    const after = (await people()).filter((p) => p.name === '홍길동');
    expect(after.map((p) => [p.ref, p.matches])).toEqual([[target, 3]]);
    expect((await (await byRef(refOf('홍길동'))).json()).person.ref).toBe(target);
    await send('DELETE', `/api/players/aliases/${encodeURIComponent('홍길동')}`);
  });

  test('a rename gives the new person its ref and the old ref still opens them', async () => {
    await send('POST', '/api/players/rename', { from: '김하나,4821', toName: '김둘' });
    const moved = (await (await byRef(refOf('김하나,4821'))).json()).person;
    expect(moved).toEqual({ ref: refOf('김둘,4821'), name: '김둘' });
    await send('DELETE', `/api/players/aliases/${encodeURIComponent('김하나,4821')}`);
  });

  test('an unknown ref is 404', async () => {
    expect((await byRef('0000000000000000')).status).toBe(404);
  });

  test('the key path needs a PIN', async () => {
    const path = `${base}/api/analysis/person/${encodeURIComponent('홍길동,0712')}`;
    expect((await fetch(path)).status).toBe(403);
    expect((await fetch(path, { headers: { 'x-pin': PIN } })).status).toBe(200);
  });
});
