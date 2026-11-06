// This phone as the camera of the tournament app on the same origin (one app, a role per device).
// It keeps a WebSocket to the tournament server: every 5 s it says it is here (what it films,
// whether it can write scores, under a public id = sha256 of a secret kept on the phone), and it
// hears which screen took the sound. Write access is the tournament PIN only (typed here, or already
// on this device from the tournament app), as on the referee screen (owner decision, 2026-10-31).
import { speak } from "./voice.js";
import { pick } from "./i18n.js";

const HELLO_MS = 5000;
// 카메라 여러 대 (docs/multicam.md): clock pings on connect, then every CLOCK_MS
const CLOCK_FIRST = 4;
const CLOCK_FIRST_MS = 500;
const CLOCK_MS = 10000;

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Venue {
  constructor(store, tour, mode) {
    this.store = store;
    this.tour = tour;
    this.mode = mode;
    this.ws = null;
    this.retry = 0;
    this.id = null;
    this.speaker = null;
    // multicam: this socket's id on the server, the attachment, the match's camera list
    this.conn = null;
    this.attached = null; // { conn, matchId, pin } the server accepted
    this.attaching = false;
    this.cameras = [];
    this.clock = null; // a multicam.js Clock, set by app.js
    this.onCameras = () => {};
    this.onMc = () => {};
  }

  // Only a device that chose the camera role, or holds a tournament PIN, talks to the tournament
  // app; the vision app opened on its own stays quiet.
  wanted() {
    let shared = null;
    try {
      shared = localStorage.getItem("pp-role") === "camera" || !!localStorage.getItem("pp-pin");
    } catch {}
    return shared || this.tour.linked();
  }

  async start() {
    if (this.started || !this.wanted()) return;
    this.started = true;
    this.tour.setWs("connecting");
    let secret = this.store.get("venueSecret", null);
    if (!secret) {
      secret = b64url(crypto.getRandomValues(new Uint8Array(32)));
      this.store.set("venueSecret", secret);
    }
    this.secret = secret;
    this.id = await sha256hex(secret);
    setInterval(() => this.hello(), HELLO_MS);
    await this.whenTournamentApp();
    this.usePinFromTournamentApp();
    this.connect();
  }

  // The vision app can also run on its own (no tournament app on this origin): then do not knock.
  async whenTournamentApp() {
    for (;;) {
      const ok = await fetch("/api/state", { cache: "no-store" }).then((r) => r.ok && (r.headers.get("content-type") || "").includes("json"), () => false);
      if (ok) return;
      this.tour.setWs("none");
      await new Promise((res) => setTimeout(res, 30000));
    }
  }

  // The tournament app keeps its PIN under "pp-pin" on this same origin.
  usePinFromTournamentApp() {
    if (this.tour.linked()) return;
    let pin = null;
    try {
      pin = localStorage.getItem("pp-pin");
    } catch {}
    if (pin) this.tour.connect(pin);
  }

  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.tour.setWs("online");
      this.hello();
      this.pingClock(CLOCK_FIRST);
    };
    ws.onmessage = (ev) => {
      if (ev.data === "pong") return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "hello" && msg.conn) {
        this.conn = msg.conn;
        this.attached = null;
        this.attach();
      }
      if (msg.type === "clock" && this.clock) {
        this.clock.sample(msg.c, msg.s, performance.now());
        this.onCameras(this.cameras);
      }
      if (msg.type === "cameras") this.setCameras(msg.matches || {});
      if (msg.type === "mc") this.onMc(msg);
      if (msg.type === "presence") this.onPresence(msg);
      if (msg.type === "state" && msg.state && msg.state.tournament) {
        try {
          // a point entered elsewhere answers an open 누가 땄나요; the state is skipped only during a 3 s cancel
          this.tour.seen(msg.state);
          if (!this.tour.pending || this.tour.pending.choice) this.tour.apply(msg.state);
          this.tour.onChange();
        } catch {}
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.conn = null;
      this.attached = null;
      this.setCameras({});
      this.tour.setWs("offline");
      this.retry = Math.min(this.retry + 1, 5);
      setTimeout(() => this.connect(), Math.min(10000, 1000 * 2 ** (this.retry - 1)));
    };
  }

  hello() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.id) return;
    this.ws.send(JSON.stringify({ type: "camera", id: this.id, mode: this.mode(), matchId: this.tour.matchId, linked: this.tour.linked() }));
    this.attach();
  }

  send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  // clock pings: n now, 0.5 s apart, then one every CLOCK_MS while the socket is open
  pingClock(n) {
    const ws = this.ws;
    const one = () => this.ws === ws && this.send({ type: "clock", c: performance.now() });
    for (let i = 0; i < n; i++) setTimeout(one, i * CLOCK_FIRST_MS);
    clearInterval(this.clockTimer);
    this.clockTimer = setInterval(() => (this.ws === ws ? one() : clearInterval(this.clockTimer)), CLOCK_MS);
  }

  // Join this match's camera list with the tournament PIN (a camera without it is never attached,
  // owner decision). Done again when the socket, the match or the PIN changes; the server drops it when the
  // socket closes or the hello names another match.
  async attach() {
    const pin = this.tour.pin;
    const matchId = this.tour.matchId;
    const conn = this.conn;
    const a = this.attached;
    if (a && a.conn === conn && a.matchId === matchId && a.pin === pin) return;
    if (!conn || !pin || !matchId || !this.id || this.attaching) {
      if (!pin || !matchId) this.attached = null;
      return;
    }
    this.attaching = true;
    try {
      const res = await fetch("/api/vision/attach", { method: "POST", headers: { "content-type": "application/json", "x-pin": pin }, body: JSON.stringify({ conn, id: this.id, matchId }) });
      this.attached = res.ok ? { conn, matchId, pin, at: Date.now() } : null;
      // the camera hello on the socket can reach the server after this call: try again shortly
      if (res.status === 404) setTimeout(() => this.attach(), 1000);
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        if (Array.isArray(body.cameras)) this.setCameras({ [matchId]: body.cameras });
      }
    } catch (err) {
      this.attached = null;
      console.warn("ppv: camera attach", err);
    } finally {
      this.attaching = false;
    }
  }

  setCameras(matches) {
    const a = this.attached;
    this.cameras = a && Array.isArray(matches[a.matchId]) ? matches[a.matchId] : [];
    // the server forgot this phone (a sweep, a restart): attach again on the next hello. A list sent
    // just before the attach answer can still lack it, so give that 2 s.
    if (a && Date.now() - a.at > 2000 && !this.me()) {
      this.attached = null;
      this.cameras = [];
    }
    this.onCameras(this.cameras);
  }

  // this phone's entry in the match's camera list (ids are the first 8 hex of the camera id)
  me() {
    return this.attached && this.id ? this.cameras.find((c) => c.id === this.id.slice(0, 8)) || null : null;
  }

  async onPresence(msg) {
    this.speaker = msg.speaker || null;
    this.hello();
  }

  // Call-outs go to the screen that took the sound (a viewer TV or pad); with none, or when the
  // tournament app cannot be reached, this phone speaks. Never both.
  async say(pair) {
    if (this.speaker && this.tour.linked() && this.tour.ws === "online") {
      try {
        const res = await fetch("/api/vision/say", { method: "POST", headers: { "content-type": "application/json", ...this.tour.auth() }, body: JSON.stringify({ text: pair.ko, en: pair.en }) });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.delivered) return "screen";
      } catch {}
    }
    speak(pick(pair));
    return "phone";
  }
}
