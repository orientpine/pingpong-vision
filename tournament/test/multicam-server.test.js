import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MulticamServer } from '../multicam-server.js';

function camera(base) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws');
  const received = [];
  const pending = new Set();
  ws.addEventListener('message', ({ data }) => {
    if (data === 'pong') return;
    const message = JSON.parse(data);
    received.push(message);
    for (const waiter of pending) {
      if (waiter.predicate(message)) {
        pending.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  return {
    ws,
    received,
    send: (message) => ws.send(JSON.stringify(message)),
    wait(predicate) {
      const existing = received.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          pending.delete(waiter);
          reject(new Error('websocket message deadline'));
        }, 3000);
        pending.add(waiter);
      });
    },
  };
}

test('PIN attachment relays cameras, protects points, and promotes on close', async () => {
  // Given: a real server with an ephemeral port and an isolated tournament.
  const dataDir = mkdtempSync(join(tmpdir(), 'pp-multicam-'));
  const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'server.js')], {
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const clients = [];
  try {
    const reader = proc.stdout.getReader();
    let output = '';
    while (!output.includes('listening')) {
      const { value, done } = await reader.read();
      if (done) throw new Error('server exited before listening');
      output += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const base = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
    const post = (path, body, headers = {}) => fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const { pin, state } = await (await post('/api/tournament', { players: ['A,1001', 'B,1002', 'C,1003', 'D,1004'] })).json();
    const auth = { 'x-pin': pin };
    const primary = camera(base);
    const secondary = camera(base);
    const observer = camera(base);
    const third = camera(base);
    clients.push(primary, secondary, observer, third);
    const hello = await Promise.all(clients.map((c) => c.wait((m) => m.type === 'hello')));
    const ids = ['a', 'b', 'c'].map((x) => x.repeat(64));
    const attached = [primary, secondary, third];
    const conns = [hello[0].conn, hello[1].conn, hello[3].conn];
    for (let i = 0; i < attached.length; i++) {
      attached[i].send({ type: 'camera', id: ids[i], mode: 'running', matchId: 'm1', linked: true });
      // A clock round trip fences the hello before the HTTP attachment.
      attached[i].send({ type: 'clock', c: i });
      await attached[i].wait((m) => m.type === 'clock' && m.c === i);
    }
    const request = { conn: conns[0], id: ids[0], matchId: 'm1' };
    const logBefore = readFileSync(join(dataDir, 'action.log'), 'utf8');

    // When / Then: PIN-only admission, existing lockout policy, current match checks.
    expect((await post('/api/vision/attach', request)).status).toBe(403);
    expect((await post('/api/vision/attach', request, { 'x-vision-token': 'token' })).status).toBe(403);
    expect((await post('/api/vision/attach', request, { 'x-pin': pin === '0000' ? '1111' : '0000' })).status).toBe(403);
    expect((await post('/api/vision/attach', { ...request, conn: 'missing' }, auth)).status).toBe(404);
    expect((await post('/api/vision/attach', { ...request, matchId: 'missing' }, auth)).status).toBe(400);
    for (let i = 0; i < attached.length; i++) {
      const response = await post('/api/vision/attach', { conn: conns[i], id: ids[i], matchId: 'm1' }, auth);
      expect(response.status).toBe(200);
      expect((await response.json()).cameras).toHaveLength(i + 1);
    }
    const roster = await observer.wait((m) => m.type === 'cameras' && m.matches.m1?.length === 3);
    expect(roster.matches.m1.map((c) => c.primary)).toEqual([true, false, false]);
    expect((await (await fetch(base + '/api/state')).json()).rev).toBe(state.rev);
    expect(readFileSync(join(dataDir, 'action.log'), 'utf8')).toBe(logBefore);

    // When: the primary reports it runs, then the secondary sends status and a rally.
    primary.send({ type: 'mc', matchId: 'm1', kind: 'status', ball: 'lost', active: false, running: true, startMs: null, rttMs: 10, clockMs: 5 });
    await secondary.wait((m) => m.type === 'mc' && m.kind === 'status' && m.from === 'aaaaaaaa');
    const status = { type: 'mc', matchId: 'm1', kind: 'status', ball: 'seen', active: true, startMs: 100, rttMs: 12, clockMs: 6 };
    secondary.send(status);
    const relayed = await primary.wait((m) => m.type === 'mc' && m.kind === 'status');
    expect(relayed).toEqual({ type: 'mc', kind: 'status', from: 'bbbbbbbb', primary: false, ball: 'seen', active: true, running: true, startMs: 100, rttMs: 12, clockMs: 6, near: null, nearAuto: false, hold: false, ask: null });
    await third.wait((m) => m.type === 'mc' && m.kind === 'status' && m.from === 'bbbbbbbb');
    const seg = { start: 100, end: 200, shots: [] };
    secondary.send({ type: 'mc', kind: 'rally', matchId: 'm1', seg });
    expect(await primary.wait((m) => m.type === 'mc' && m.kind === 'rally')).toEqual({ type: 'mc', kind: 'rally', from: 'bbbbbbbb', seg });
    third.send({ type: 'clock', c: 99 });
    const clock = await third.wait((m) => m.type === 'clock' && m.c === 99);
    expect(clock).toEqual({ type: 'clock', c: 99, s: expect.any(Number) });
    expect(third.received.some((m) => m.kind === 'rally')).toBe(false);
    expect(observer.received.some((m) => m.type === 'mc')).toBe(false);

    // When / Then: only the full primary ID may write automatic points.
    const point = { type: 'point', matchId: 'm1', side: 0, seq: 0 };
    // the camera header is not a credential: the primary's id without the PIN, or with a wrong one, is refused
    expect((await post('/api/action', point, { 'x-ppv-camera': ids[0] })).status).toBe(403);
    expect((await post('/api/action', point, { 'x-ppv-camera': ids[0], 'x-pin': pin === '0000' ? '1111' : '0000' })).status).toBe(403);
    expect((await post('/api/action', point, { 'x-ppv-camera': ids[1], 'x-vision-token': 'token' })).status).toBe(403);
    const denied = await post('/api/action', point, { ...auth, 'x-ppv-camera': ids[1] });
    expect(denied.status).toBe(409);
    expect((await denied.json()).error).toBe('보조 카메라는 점수를 넣지 않아요');
    expect((await post('/api/action', point, { ...auth, 'x-ppv-camera': ids[0] })).status).toBe(200);

    // When: primary disconnects, the oldest remaining camera takes over.
    primary.ws.close();
    const promoted = await observer.wait((m) => m.type === 'cameras' && m.matches.m1?.length === 2);
    expect(promoted.matches.m1[0]).toMatchObject({ id: 'bbbbbbbb', primary: true });

    // When: the third phone reloads (a new socket says hello with the same camera id), its old row goes
    const reloaded = camera(base);
    clients.push(reloaded);
    await reloaded.wait((m) => m.type === 'hello');
    reloaded.send({ type: 'camera', id: ids[2], mode: 'running', matchId: 'm1', linked: true });
    const oneRow = await observer.wait((m) => m.type === 'cameras' && m.matches.m1?.length === 1);
    expect(oneRow.matches.m1.map((c) => c.id)).toEqual(['bbbbbbbb']);
    expect((await post('/api/action', { ...point, seq: 1 }, { ...auth, 'x-ppv-camera': ids[0] })).status).toBe(409);
    expect((await post('/api/action', { ...point, seq: 1 }, { ...auth, 'x-ppv-camera': ids[1] })).status).toBe(200);

    // When / Then: no-header referee writes stay unchanged, and empty rosters allow a camera.
    expect((await post('/api/action', { ...point, seq: 2 }, auth)).status).toBe(200);
    expect((await post('/api/vision/detach', { conn: conns[1] })).status).toBe(403);
    expect((await post('/api/vision/detach', { conn: conns[1] }, auth)).status).toBe(200);
    expect((await post('/api/vision/detach', { conn: conns[2] }, auth)).status).toBe(200);
    expect((await post('/api/action', { ...point, seq: 3 }, { ...auth, 'x-ppv-camera': ids[0] })).status).toBe(200);
  } finally {
    for (const client of clients) client.ws.close();
    proc.kill();
    await proc.exited;
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 15000);

test('ball and rally changes of a judging camera do not resend the camera list to every screen', () => {
  // Given
  const server = new MulticamServer({ checkPin: () => true, matches: () => [], publish: () => {} });
  clearInterval(server.sweeper);
  server.roster.attach('a', { id: 'a'.repeat(64), matchId: 'm1' }, 0);
  server.roster.status('a', { ball: 'lost', active: false, running: true, rttMs: 20, clockMs: 5 }, 100);
  server.roster.now = 100;
  server.changed();
  const listed = server.published;
  clearTimeout(server.timer);
  server.timer = null;
  // When: the ball and the rally change, and the RTT moves
  server.roster.status('a', { ball: 'seen', active: true, running: true, rttMs: 35, clockMs: 5 }, 200);
  server.changed();
  // Then: nothing new to publish
  expect(server.published).toBe(listed);
  expect(server.timer).toBe(null);
  // When: the camera stops judging, the list does change
  server.roster.status('a', { ball: 'lost', active: false, running: false, rttMs: 35, clockMs: 5 }, 300);
  server.changed();
  expect(server.published).not.toBe(listed);
  clearTimeout(server.timer);
});

function endCameras() {
  const server = new MulticamServer({ checkPin: () => true, matches: () => [], publish: () => {} });
  clearInterval(server.sweeper);
  const sockets = ['a', 'b', 'c', 'd'].map((conn) => {
    const received = [];
    const ws = { data: { conn }, send: (data) => received.push(JSON.parse(data)), received };
    server.sockets.set(conn, ws);
    server.roster.attach(conn, { id: conn.repeat(64), matchId: conn === 'd' ? 'm2' : 'm1' }, 0);
    return ws;
  });
  return { server, sockets };
}

const endStatus = { type: 'mc', matchId: 'm1', kind: 'status', ball: 'seen', active: true, startMs: null, rttMs: 10, clockMs: 5 };

test.each([{ near: 0, nearAuto: true }, { near: 1, nearAuto: false }, {}, { hold: true }, { ask: { seq: 3, pre: 1, hold: false } }, { ask: { seq: 0, pre: null, hold: true } }])('status stores and relays end fields when valid: %j', (fields) => {
  // Given
  const { server, sockets } = endCameras();
  try {
    // When
    server.message(sockets[0], { ...endStatus, ...fields });
    // Then
    const expected = { near: fields.near ?? null, nearAuto: fields.nearAuto ?? false, hold: fields.hold ?? false, ask: fields.ask ?? null };
    expect(server.roster.entries.get('a')).toMatchObject(expected);
    expect(server.roster.roster().m1[0]).toMatchObject(expected);
    expect(sockets[1].received).toEqual([{ type: 'mc', kind: 'status', from: 'aaaaaaaa', primary: true, ball: 'seen', active: true, running: true, startMs: null, rttMs: 10, clockMs: 5, ...expected }]);
    expect(sockets[2].received).toEqual(sockets[1].received);
    expect(sockets[0].received.concat(sockets[3].received)).toEqual([]);
  } finally { clearTimeout(server.timer); }
});

test.each([{ near: 2 }, { near: '1' }, { near: null }, { nearAuto: 1 }, { nearAuto: null }, { hold: 1 }, { hold: null }, { ask: { seq: -1 } }, { ask: { seq: 1, pre: 2 } }, { ask: 'x' }, { ask: { seq: 1.5 } }])('status drops the whole message when an end field is invalid: %j', (fields) => {
  // Given
  const { server, sockets } = endCameras();
  // When
  server.message(sockets[0], { ...endStatus, ...fields });
  // Then
  expect(server.roster.entries.get('a')).toMatchObject({ ball: 'lost', statusAt: null, near: null, nearAuto: false });
  expect(sockets.flatMap((s) => s.received)).toEqual([]);
  clearTimeout(server.timer);
});

test('end reaches only the camera addressed by the primary', () => {
  // Given
  const { server, sockets } = endCameras();
  // When
  server.message(sockets[0], { type: 'mc', matchId: 'm1', kind: 'end', to: 'bbbbbbbb', near: 1 });
  // Then
  expect(sockets.map((s) => s.received)).toEqual([[], [{ type: 'mc', kind: 'end', from: 'aaaaaaaa', near: 1 }], [], []]);
});

test.each([
  { sender: 1, to: 'cccccccc', near: 0 },
  { sender: 0, to: 'unknown1', near: 0 },
  { sender: 0, to: 'dddddddd', near: 0 },
  { sender: 0, to: 'aaaaaaaa', near: 0 },
  { sender: 0, to: 'bbbbbbbb', near: 2 },
  { sender: 0, to: 'bbbbbbbb', near: '1' },
  { sender: 0, to: 'bbbbbbbb', near: null },
  { sender: 0, to: 123, near: 0 },
  { sender: 3, to: 'bbbbbbbb', near: 0 },
])('end is dropped when sender, target or colour is invalid: %j', ({ sender, to, near }) => {
  // Given
  const { server, sockets } = endCameras();
  // When
  server.message(sockets[sender], { type: 'mc', matchId: 'm1', kind: 'end', to, near });
  // Then
  expect(sockets.flatMap((s) => s.received)).toEqual([]);
});
