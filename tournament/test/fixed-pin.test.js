import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fixed PIN in DATA_DIR/settings.json: the stored tournament takes it at boot (rev unchanged) and
// every new tournament keeps it. The value here is a test value, not the live one.
const FIXED = '0815';
const OLD = '1111';
const dataDir = mkdtempSync(join(tmpdir(), 'pp-fixedpin-'));
let base;
let proc;

beforeAll(async () => {
  writeFileSync(join(dataDir, 'tournament.json'), JSON.stringify({ rev: 7, pin: OLD, tournament: null }));
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ pin: FIXED }));
  proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'server.js')], {
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = proc.stdout.getReader();
  let out = '';
  while (!out.includes('listening')) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`server exited before listening: ${out}`);
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  base = `http://127.0.0.1:${out.match(/:(\d+) \(data:/)[1]}`;
});

afterAll(() => {
  proc?.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

const post = (path, body, headers = {}) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const stored = () => JSON.parse(readFileSync(join(dataDir, 'tournament.json'), 'utf8'));

test('the stored tournament takes the fixed PIN at boot without a new rev', async () => {
  expect(stored()).toEqual({ rev: 7, pin: FIXED, tournament: null });
  const state = await (await fetch(`${base}/api/state`)).json();
  expect(state.rev).toBe(7);
  expect(state.pinFixed).toBe(true);
  expect((await post('/api/pin/verify', { pin: FIXED }, { 'x-forwarded-for': '192.0.2.10' })).status).toBe(200);
  expect((await post('/api/pin/verify', { pin: OLD }, { 'x-forwarded-for': '192.0.2.10' })).status).toBe(403);
});

test('every new tournament keeps the fixed PIN', async () => {
  const first = await (await post('/api/tournament', { players: ['A,1001', 'B,1002', 'C,1003', 'D,1004'] })).json();
  expect(first.pin).toBe(FIXED);
  const second = await post('/api/tournament', { players: ['E,1005', 'F,1006', 'G,1007', 'H,1008'] }, { 'x-pin': FIXED });
  expect(second.status).toBe(200);
  expect((await second.json()).pin).toBe(FIXED);
  expect(stored().pin).toBe(FIXED);
  expect(stored().rev).toBe(9);
});

test('five wrong PINs still lock that address for a minute, the fixed PIN included', async () => {
  const verify = (pin) => post('/api/pin/verify', { pin }, { 'x-forwarded-for': '192.0.2.20' });
  for (let i = 0; i < 4; i++) expect((await verify('0000')).status).toBe(403);
  expect((await verify('0000')).status).toBe(403);
  expect((await verify(FIXED)).status).toBe(429);
  expect((await post('/api/pin/verify', { pin: FIXED }, { 'x-forwarded-for': '192.0.2.21' })).status).toBe(200);
});
