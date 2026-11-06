import { Multicam } from './multicam.js';
import { ID_RE } from './vision-link.js';
import { fail } from './public/i18n.js';

// 확인 후 입력: the camera's open 누가 땄나요 (the point number it is for, the camera's call as an end colour or
// none, held or not), shown on the referee screen so it can be entered there too.
const validAsk = (a) => typeof a === 'object' && Number.isInteger(a.seq) && a.seq >= 0
  && (a.pre === undefined || a.pre === null || a.pre === 0 || a.pre === 1) && (a.hold === undefined || typeof a.hold === 'boolean');

// Transport adapter: the tournament owns PIN policy and state, not camera membership.
export class MulticamServer {
  roster = new Multicam();
  sockets = new Map();
  published = '';
  timer = null;

  constructor({ checkPin, matches, publish }) {
    this.checkPin = checkPin;
    this.matches = matches;
    this.publish = publish;
    this.sweeper = setInterval(() => {
      this.roster.sweep(Date.now());
      this.changed();
    }, 2000);
    this.sweeper.unref();
  }

  packet() {
    return JSON.stringify({ type: 'cameras', matches: this.roster.roster() });
  }

  changed() {
    // Only membership, primary and live changes go out: ball, rally and RTT change several times a second
    // while a camera judges, and each list redraws every referee and spectator screen (the phones get
    // those through the camera-to-camera status instead).
    const signature = JSON.stringify(this.roster.roster(), (key, value) => ['rttMs', 'ball', 'active'].includes(key) ? undefined : value);
    if (signature === this.published) return;
    this.published = signature;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.publish(this.packet());
    }, 250);
  }

  open(ws) {
    this.sockets.set(ws.data.conn, ws);
    ws.send(this.packet());
  }

  close(ws) {
    this.sockets.delete(ws.data.conn);
    this.roster.detach(ws.data.conn);
    this.changed();
  }

  hello(ws, hello) {
    const attached = this.roster.entries.get(ws.data.conn);
    if (attached && attached.id !== hello.id) this.roster.detach(ws.data.conn);
    // one row per device: a reload or reconnect of the same phone drops the row of its old socket
    for (const [conn, camera] of this.roster.entries) if (conn !== ws.data.conn && camera.id === hello.id) this.roster.detach(conn);
    this.roster.onCameraHello(ws.data.conn, hello);
    this.roster.touch(ws.data.conn, Date.now());
    this.changed();
  }

  message(ws, message) {
    this.roster.touch(ws.data.conn, Date.now());
    if (message.type === 'clock') {
      ws.send(JSON.stringify({ type: 'clock', c: message.c, s: Date.now() }));
      return;
    }
    if (message.type !== 'mc' || !this.roster.isAttached(ws.data.conn, message.matchId)) return;
    const camera = this.roster.entries.get(ws.data.conn);
    const primary = this.roster.primaryOf(message.matchId);
    const from = camera.id.slice(0, 8);
    switch (message.kind) {
      case 'status': {
        if (!['seen', 'lost'].includes(message.ball) || typeof message.active !== 'boolean'
          || (message.startMs !== null && !Number.isFinite(message.startMs))
          || (message.rttMs !== null && !Number.isFinite(message.rttMs))
          || (message.clockMs !== null && !Number.isFinite(message.clockMs))
          || (message.running !== undefined && typeof message.running !== 'boolean')
          || (message.near !== undefined && message.near !== 0 && message.near !== 1)
          || (message.nearAuto !== undefined && typeof message.nearAuto !== 'boolean')
          || (message.hold !== undefined && typeof message.hold !== 'boolean')
          || (message.ask !== undefined && message.ask !== null && !validAsk(message.ask))) return;
        // running: the camera is calibrated and judging (a phone without this field is an older app: running)
        const status = { ball: message.ball, active: message.active, running: message.running !== false, startMs: message.startMs, rttMs: message.rttMs, clockMs: message.clockMs, near: message.near ?? null, nearAuto: message.nearAuto ?? false, hold: message.hold ?? false, ask: message.ask ? { seq: message.ask.seq, pre: message.ask.pre ?? null, hold: !!message.ask.hold } : null };
        this.roster.status(ws.data.conn, status, Date.now());
        const packet = JSON.stringify({ type: 'mc', kind: 'status', from, primary: primary === ws.data.conn, ...status });
        for (const [conn, socket] of this.sockets) {
          if (conn !== ws.data.conn && this.roster.isAttached(conn, message.matchId)) socket.send(packet);
        }
        this.changed();
        break;
      }
      case 'end':
        if (primary !== ws.data.conn || typeof message.to !== 'string' || (message.near !== 0 && message.near !== 1)) return;
        for (const [conn, socket] of this.sockets) {
          if (conn !== ws.data.conn && this.roster.isAttached(conn, message.matchId)
            && this.roster.entries.get(conn).id.slice(0, 8) === message.to) {
            socket.send(JSON.stringify({ type: 'mc', kind: 'end', from, near: message.near }));
          }
        }
        break;
      case 'rally':
        if (primary !== ws.data.conn) this.sockets.get(primary)?.send(JSON.stringify({ type: 'mc', kind: 'rally', from, seg: message.seg }));
        break;
    }
  }

  async api(req, path) {
    const auth = this.checkPin(req, req.headers.get('x-pin'));
    if (!auth.ok) return Response.json({ error: auth.error, en: auth.en }, { status: auth.status });
    const input = await req.json().catch(() => ({}));
    if (path === '/api/vision/detach') {
      this.roster.detach(input.conn);
      this.changed();
      return Response.json({ ok: true });
    }
    const socket = this.sockets.get(input.conn);
    if (!socket || socket.data.camera !== input.id || !ID_RE.test(String(input.id))) {
      return Response.json(fail('연결된 카메라를 찾을 수 없습니다.', 'Connected camera not found.'), { status: 404 });
    }
    const match = this.matches().find((m) => m.id === input.matchId);
    if (!match || !['live', 'ready'].includes(match.status)) {
      return Response.json(fail('진행할 경기를 찾을 수 없습니다.', 'Match not found or not ready to play.'), { status: 400 });
    }
    this.roster.attach(input.conn, { id: input.id, matchId: input.matchId }, Date.now());
    this.changed();
    return Response.json({ ok: true, cameras: this.roster.roster()[input.matchId] });
  }
}
