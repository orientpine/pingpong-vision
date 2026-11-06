import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Player codes ('이름,네자리') are stored with the tournament but leave the server only through
// GET /api/players with the PIN. The digits here are made up.
const running = [];

async function startServer(saved) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pp-playercode-'));
  if (saved) writeFileSync(join(dataDir, 'tournament.json'), JSON.stringify(saved));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  running.push({ proc, dataDir });
  const reader = proc.stdout.getReader();
  let out = '';
  while (!out.includes('listening')) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`server exited before listening: ${out}`);
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body, headers = {}) => fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const get = (path, headers = {}) => fetch(base + path, { headers });
  const stored = () => JSON.parse(readFileSync(join(dataDir, 'tournament.json'), 'utf8'));
  return { post, get, stored };
}

afterEach(() => {
  for (const { proc, dataDir } of running.splice(0)) {
    proc.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

const ENTRIES = ['홍길동,0712', '홍길동,1234', '김민수,5555', '이영희,6666'];
const CODES = ['0712', '1234', '5555', '6666'];

test('codes are stored by slot and absent from /api/state, the history list and history detail', async () => {
  const { post, get, stored } = await startServer();
  const res = await post('/api/tournament', { name: 't', players: ENTRIES });
  expect(res.status).toBe(200);
  expect(stored().tournament.codes).toEqual(CODES);
  for (const path of ['/api/state', '/api/history', '/api/history/current']) {
    const text = await (await get(path)).text();
    for (const code of CODES) expect(text).not.toContain(code);
    expect(text).not.toContain('"codes"');
  }
  const state = await (await get('/api/state')).json();
  expect(state.tournament.players).toEqual(['홍길동·12', '홍길동·34', '김민수', '이영희']);
  expect(state.playerCodes).toBe(true);
});

test('malformed and duplicate entries are refused with 409 and nothing is stored', async () => {
  const { post, get } = await startServer();
  const malformed = await post('/api/tournament', { players: ['홍길동', '김민수,5555', '이영희,6666'] });
  expect(malformed.status).toBe(409);
  const duplicate = await post('/api/tournament', { players: ['홍길동,0712', '홍길동,0712', '이영희,6666'] });
  expect(duplicate.status).toBe(409);
  expect((await (await get('/api/state')).json()).tournament).toBeNull();
});

test('GET /api/players needs the PIN and lists registered people; a setup edit keeps codes with each person', async () => {
  const { post, get, stored } = await startServer();
  const { pin } = await (await post('/api/tournament', { players: ENTRIES })).json();
  expect((await get('/api/players')).status).toBe(403);
  const edit = await post('/api/action', { type: 'setup', players: ['이영희', '김민수', '홍길동·34', '홍길동·12'] }, { 'x-pin': pin });
  expect(edit.status).toBe(200);
  expect(stored().tournament.codes).toEqual(['6666', '5555', '1234', '0712']);
  const { players } = await (await get('/api/players', { 'x-pin': pin })).json();
  expect(players.map((p) => `${p.name},${p.code}`).sort()).toEqual([...ENTRIES].sort());
});

test('a tournament saved before codes still loads, renames and edits without codes', async () => {
  const old = { name: '옛 대회', format: 'double', bestOf: 3, pointsToWin: 11, winBy: 2, players: ['A', 'B', 'C', 'D'], log: {}, createdAt: '2026-10-01T00:00:00.000Z' };
  const { post, get, stored } = await startServer({ rev: 3, pin: '4321', tournament: old });
  const state = await (await get('/api/state')).json();
  expect(state.tournament.players).toEqual(['A', 'B', 'C', 'D']);
  expect(state.playerCodes).toBe(false);
  expect((await post('/api/action', { type: 'rename', index: 0, name: '에이' }, { 'x-pin': '4321' })).status).toBe(200);
  expect((await post('/api/action', { type: 'setup', players: ['D', 'C', 'B', '에이'] }, { 'x-pin': '4321' })).status).toBe(200);
  expect(stored().tournament.players).toEqual(['D', 'C', 'B', '에이']);
  expect('codes' in stored().tournament).toBe(false);
  expect((await (await get('/api/players', { 'x-pin': '4321' })).json()).players).toEqual([]);
});
