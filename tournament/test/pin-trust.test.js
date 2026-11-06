import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

// Who the PIN lockout believes. On the live host only tailscale serve/Funnel (and the vision app) reach
// the server, from 127.0.0.1, and tailscale writes the real device into X-Forwarded-For. A request that
// does not come from this machine is its own address, whatever headers it carries.
const running = [];

async function startServer(host = '127.0.0.1') {
  const dataDir = mkdtempSync(join(tmpdir(), 'pp-pintrust-'));
  const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'server.js')], {
    env: { ...process.env, PORT: '0', HOST: host, DATA_DIR: dataDir },
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
  const base = `http://${host}:${out.match(/:(\d+) \(data:/)[1]}`;
  const post = (path, body, headers = {}) => fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const { pin } = await (await post('/api/tournament', { name: 't', players: ['A,1001', 'B,1002', 'C,1003', 'D,1004'] })).json();
  const wrong = pin === '0000' ? '1111' : '0000';
  return { post, pin, wrong };
}

afterEach(() => {
  for (const { proc, dataDir } of running.splice(0)) {
    proc.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  throw new Error('this test needs one non-loopback IPv4 address on the machine');
}

test('a request not from this machine cannot pick its lockout address with forged headers', async () => {
  const { post, pin, wrong } = await startServer(lanAddress());
  for (let i = 1; i <= 5; i++) {
    const forged = { 'x-forwarded-for': `203.0.113.${i}`, 'cf-connecting-ip': `198.51.100.${i}` };
    expect((await post('/api/pin/verify', { pin: wrong }, forged)).status).toBe(403);
  }
  const fresh = { 'x-forwarded-for': '203.0.113.99', 'cf-connecting-ip': '198.51.100.99' };
  expect((await post('/api/pin/verify', { pin: wrong }, fresh)).status).toBe(429);
  expect((await post('/api/pin/verify', { pin }, fresh)).status).toBe(429);
});

test('cf-connecting-ip passes through tailscale untouched, so it never picks the lockout address', async () => {
  const { post, wrong } = await startServer();
  for (let i = 1; i <= 5; i++) expect((await post('/api/pin/verify', { pin: wrong }, { 'cf-connecting-ip': `198.51.100.${i}` })).status).toBe(403);
  expect((await post('/api/pin/verify', { pin: wrong }, { 'cf-connecting-ip': '198.51.100.77' })).status).toBe(429);
});

test('rotating addresses (an IPv6 /64 holds billions) hits one cap for everyone; a device that passed keeps scoring', async () => {
  const { post, pin, wrong } = await startServer();
  const owner = { 'x-forwarded-for': '198.51.100.10' };
  expect((await post('/api/pin/verify', { pin }, owner)).status).toBe(200);
  for (let i = 1; i <= 20; i++) {
    expect((await post('/api/pin/verify', { pin: wrong }, { 'x-forwarded-for': `2001:db8::${i.toString(16)}` })).status).toBe(403);
  }
  const next = await post('/api/pin/verify', { pin }, { 'x-forwarded-for': '2001:db8::ffff' });
  expect(next.status).toBe(429);
  expect((await next.json()).error).toContain('1분');
  expect((await post('/api/pin/verify', { pin }, owner)).status).toBe(200);
  expect((await post('/api/action', { type: 'point', matchId: 'm1', side: 0, seq: 0 }, { ...owner, 'x-pin': pin })).status).toBe(200);
});
