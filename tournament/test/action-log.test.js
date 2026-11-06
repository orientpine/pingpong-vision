import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'pp-actionlog-'));
let base;
let proc;

beforeAll(async () => {
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

const logLines = () => readFileSync(join(dataDir, 'action.log'), 'utf8').trim().split('\n');
const withoutTime = (line) => line.replace(/^\S+ \S+ KST /, '');

test('every state-changing request writes one line with time, action, outcome, rev and client address, never the PIN', async () => {
  const created = await (await post('/api/tournament', { name: 't', players: ['A,1001', 'B,1002', 'C,1003', 'D,1004'] })).json();
  const pin = created.pin;
  const wrong = pin === '1234' ? '4321' : '1234';
  const viaFunnel = { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' };

  expect((await post('/api/action', { type: 'point', matchId: 'm1', side: 0, seq: 0 }, { ...viaFunnel, 'x-pin': pin })).status).toBe(200);
  expect((await post('/api/action', { type: 'point', matchId: 'm1', side: 1, seq: 1 }, { ...viaFunnel, 'x-pin': wrong })).status).toBe(403);
  expect((await post('/api/action', { type: 'point', matchId: 'm1', side: 0, seq: 0 }, { 'cf-connecting-ip': '198.51.100.9', 'x-pin': pin })).status).toBe(409);
  expect((await post('/api/pin/verify', { pin: wrong })).status).toBe(403);
  await fetch(`${base}/api/state`);

  const lines = logLines();
  expect(lines.length).toBe(5);
  expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} KST \| POST \/api\/tournament \| ok 200 \| rev 0->1 \| ip 127\.0\.0\.1$/);
  expect(lines[1]).toMatch(/\| action:point m1 side=0 \| ok 200 \| rev 1->2 \| ip 203\.0\.113\.7$/);
  expect(lines[2]).toMatch(/\| action:point m1 side=1 \| fail 403 PIN이 맞지 않습니다\. \| rev 2->2 \| ip 203\.0\.113\.7$/);
  expect(lines[3]).toMatch(/\| action:point m1 side=0 \| fail 409 .+ \| rev 2->2 \| ip 127\.0\.0\.1$/);
  expect(lines[4]).toMatch(/\| POST \/api\/pin\/verify \| fail 403 PIN이 맞지 않습니다\. \| rev 2->2 \| ip 127\.0\.0\.1$/);
  for (const line of lines) {
    expect(withoutTime(line)).not.toContain(pin);
    expect(withoutTime(line)).not.toContain(wrong);
  }
});

test('PIN lockout is per real client address: five misses lock only that address', async () => {
  const verify = (ip, pin) => post('/api/pin/verify', { pin }, { 'x-forwarded-for': ip });
  for (let i = 0; i < 5; i++) expect((await verify('192.0.2.1', 'bad')).status).toBe(403);
  expect((await verify('192.0.2.1', 'bad')).status).toBe(429);
  expect((await verify('192.0.2.2', 'bad')).status).toBe(403);
  const pin = JSON.parse(readFileSync(join(dataDir, 'tournament.json'), 'utf8')).pin;
  expect((await verify('192.0.2.2', pin)).status).toBe(200);
  expect((await verify('192.0.2.1', pin)).status).toBe(429);
});

test('clip requires PIN and broadcasts persisted state when authorized', async () => {
  // Given
  const file = join(dataDir, 'tournament.json');
  const oldPin = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).pin : '';
  const { pin } = await (await post('/api/tournament', { players: ['A,1001', 'B,1002', 'C,1003', 'D,1004'] }, { 'x-pin': oldPin })).json();
  await post('/api/action', { type: 'point', matchId: 'm1', side: 0, seq: 0 }, { 'x-pin': pin });
  const url = `/vision/s/${'Z'.repeat(43)}`;
  const action = { type: 'clip', matchId: 'm1', index: 0, url };
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws');
  try {
    await once(ws, 'message', { signal: AbortSignal.timeout(2000) });
    expect((await post('/api/action', action)).status).toBe(403);
    const changed = once(ws, 'message', { signal: AbortSignal.timeout(2000) });
    // When
    const response = await post('/api/action', action, { 'x-pin': pin });
    const [event] = await changed;
    const broadcast = JSON.parse(event.data).state;
    // Then
    expect(response.status).toBe(200);
    const saved = JSON.parse(readFileSync(join(dataDir, 'tournament.json'), 'utf8'));
    expect(saved.tournament.log.m1.clips).toEqual({ 0: url });
    expect(broadcast.tournament.log.m1.clips).toEqual({ 0: url });
    expect(logLines().at(-1)).toContain('action:clip m1 index=0 | ok 200');
    expect(logLines().join('\n')).not.toContain(url);
  } finally {
    ws.close();
  }
});

test('an empty desk worker claim (204) is not written; a refused claim (401) is', async () => {
  const token = readFileSync(join(dataDir, 'desk', 'worker-token'), 'utf8').trim();
  const lines = () => (existsSync(join(dataDir, 'action.log')) ? logLines().length : 0);
  const before = lines();
  for (let i = 0; i < 3; i++) expect((await post('/api/desk/worker/claim', {}, { 'x-desk-worker': token })).status).toBe(204);
  expect(lines()).toBe(before);
  expect((await post('/api/desk/worker/claim', {}, { 'x-desk-worker': 'x'.repeat(token.length) })).status).toBe(401);
  expect(lines()).toBe(before + 1);
  expect(withoutTime(logLines().at(-1))).toStartWith('| POST /api/desk/worker/claim | fail 401');
});
