// One command for a PC without systemd (macOS, WSL, or just a terminal): starts the camera app and
// the tournament app as two processes and serves both on one local address, the way Tailscale's
// path split does on Linux (start.sh): /vision and /vision/* go to the camera app, everything else
// to the tournament app.
//   bun run.mjs
// Then, once: tailscale serve --bg --https=443 http://127.0.0.1:<APP_PORT>
// Settings come from the environment, else ${PPV_DEPLOY_ENV:-~/.config/pingpong-vision/deploy.env}:
//   APP_PORT (8780, the one address), PORT (8791, camera app), TOURNAMENT_PORT (8792),
//   PPV_TOURNAMENT_URL (off runs the camera app alone). All listen on 127.0.0.1 only.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = import.meta.dir;
const envFile = process.env.PPV_DEPLOY_ENV || join(homedir(), ".config/pingpong-vision/deploy.env");
const fileVars = {};
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=([^#]*)/);
    if (m) fileVars[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
}
const setting = (name, fallback) => process.env[name] ?? fileVars[name] ?? fallback;
const APP_PORT = Number(setting("APP_PORT", "8780"));
const VISION_PORT = Number(setting("PORT", "8791"));
const TOURNAMENT_PORT = Number(setting("TOURNAMENT_PORT", "8792"));
const tournamentOn = setting("PPV_TOURNAMENT_URL", "off") !== "off" && existsSync(join(ROOT, "tournament/server.js"));
// Rally uploads go up to 200 MB (save-server.js); the camera app accepts 210 MB, so the proxy does too.
const MAX_BODY = 210 * 1024 * 1024;

const children = new Map();
let stopping = false;
function run(name, cwd, port, extra) {
  const child = spawn(process.execPath, ["server.js"], { cwd, env: { ...process.env, ...extra, PORT: String(port) }, stdio: ["ignore", "inherit", "inherit"] });
  children.set(name, child);
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`${name} stopped (${signal || code}); starting it again in 2 s`);
    setTimeout(() => !stopping && run(name, cwd, port, extra), 2000);
  });
}
const tournamentUrl = `http://127.0.0.1:${TOURNAMENT_PORT}`;
run("camera app", ROOT, VISION_PORT, tournamentOn
  ? { PPV_TOURNAMENT_URL: tournamentUrl, PPV_TOURNAMENT_DATA: setting("PPV_TOURNAMENT_DATA", join(ROOT, "tournament/data/tournament.json")) }
  : { PPV_TOURNAMENT_URL: "" });
if (tournamentOn) run("tournament app", join(ROOT, "tournament"), TOURNAMENT_PORT, {});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    for (const c of children.values()) c.kill("SIGTERM");
    process.exit(0);
  });
}

const backendOf = (path) => (path === "/vision" || path.startsWith("/vision/") || !tournamentOn ? VISION_PORT : TOURNAMENT_PORT);
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
// The apps take the device address from X-Forwarded-For only when the peer is this machine. Tailscale
// serve connects from 127.0.0.1 and writes the real device there, so keep that; anyone else is the
// device itself. Without this every phone would share one PIN lockout.
function deviceOf(req, server) {
  const peer = server.requestIP(req)?.address || "";
  const fwd = req.headers.get("x-forwarded-for")?.split(",").at(-1).trim();
  return LOOPBACK.has(peer) && fwd ? fwd : peer;
}

const server = Bun.serve({
  port: APP_PORT,
  hostname: "127.0.0.1",
  maxRequestBodySize: MAX_BODY,
  idleTimeout: 120,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (!tournamentOn && url.pathname === "/") return Response.redirect("/vision/", 302);
    const device = deviceOf(req, server);
    const to = `127.0.0.1:${backendOf(url.pathname)}${url.pathname}${url.search}`;
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return server.upgrade(req, { data: { to: `ws://${to}`, device, queue: [] } }) ? undefined : new Response("websocket upgrade failed", { status: 400 });
    }
    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.set("x-forwarded-for", device);
    try {
      // The body is streamed, never read into memory here, so a 150 MB upload does not hold up scores.
      return await fetch(`http://${to}`, { method: req.method, headers, body: req.body, duplex: "half", redirect: "manual", decompress: false });
    } catch {
      return new Response("app is starting, try again in a moment", { status: 502 });
    }
  },
  websocket: {
    open(ws) {
      const back = new WebSocket(ws.data.to, { headers: { "x-forwarded-for": ws.data.device } });
      ws.data.back = back;
      back.onopen = () => ws.data.queue.splice(0).forEach((m) => back.send(m));
      back.onmessage = (e) => ws.send(e.data);
      back.onclose = () => ws.close();
      back.onerror = () => ws.close();
    },
    message(ws, m) {
      if (ws.data.back.readyState === 1) ws.data.back.send(m);
      else ws.data.queue.push(m);
    },
    close(ws) {
      ws.data.back?.close();
    },
  },
});

console.log(`one address: http://127.0.0.1:${server.port}/  (camera: /vision/${tournamentOn ? "" : ", tournament app off"})`);
console.log(`share it once: tailscale serve --bg --https=443 http://127.0.0.1:${server.port}`);
