import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHeavyLine, queuePosition } from "../desk/heavy.js";
import { DeskWorker, HEARTBEAT_MS, RENEW_MS } from "../desk/worker.js";

const FIX = join(import.meta.dir, "fixtures", "desk");
const HEAVY = [join(FIX, "fake-heavy.sh")];
const ANALYZER = [process.execPath, join(FIX, "fake-analyzer.js")];
const FIRST_PASS = [process.execPath, join(FIX, "fake-first-pass.js")];
const TOKEN = "worker-token-for-tests";
const PLAYED_AT = 1_761_868_800_000;
const CORNERS = [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }, { x: 7, y: 8 }];
const JOB = { id: "j1", kind: "gallery", state: "waiting", corners: CORNERS, players: { near: "A,0712", far: "B,1234" }, playedAt: new Date(PLAYED_AT).toISOString(), createdAt: 5, waitPos: null };

const cleanups = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "desk-worker-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The tournament server's worker API: one job, a 90 s lease on the server's own clock (now).
function fakeServer(job = JOB) {
  const s = { now: 0, leaseUntil: -1, claims: 0, heartbeats: 0, records: [], watchers: [] };
  s.http = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.headers.get("x-desk-worker") !== TOKEN) return new Response(null, { status: 403 });
      const { pathname } = new URL(req.url);
      if (pathname === "/api/desk/worker/heartbeat") {
        s.heartbeats++;
        return new Response(null, { status: 204 });
      }
      if (pathname === "/api/desk/worker/claim") {
        if (s.records.some((r) => r.kind === "result") || s.leaseUntil > s.now) return new Response(null, { status: 204 });
        s.leaseUntil = s.now + 90_000;
        s.claims++;
        return Response.json({ job });
      }
      const [, , , , , , kind] = pathname.split("/");
      if (kind === "video") return new Response("fake video bytes");
      if (kind === "track") return job.track ? new Response(Bun.gzipSync(JSON.stringify({ v: 1, frames: [] }))) : new Response(null, { status: 404 });
      const rec = { kind, claim: s.claims, ...(await req.json()) };
      if (kind === "progress") s.leaseUntil = s.now + 90_000;
      s.records.push(rec);
      for (const w of [...s.watchers]) if (w.pred(rec)) w.resolve(rec);
      return new Response(null, { status: 204 });
    },
  });
  s.url = `http://127.0.0.1:${s.http.port}`;
  s.progress = () => s.records.filter((r) => r.kind === "progress");
  // the first record (already in or still to come) that matches, within 10 s
  s.next = (pred) => {
    const seen = s.records.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      s.watchers.push(w);
      setTimeout(() => reject(new Error("no matching post within 10 s")), 10_000).unref();
    });
  };
  cleanups.push(() => s.http.stop(true));
  return s;
}

function fakeClock() {
  let t = 0;
  const timers = new Set();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      const h = { at: t + ms, fn };
      timers.add(h);
      return h;
    },
    clearTimeout: (h) => timers.delete(h),
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers].filter((h) => h.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due);
        t = due.at;
        due.fn();
      }
      t = end;
    },
  };
}

function makeWorker(server, extra = {}) {
  const stateDir = tempDir();
  const worker = new DeskWorker({ server: server.url, token: TOKEN, stateDir, heavy: HEAVY, analyzer: ANALYZER, heavyQueueDir: null, clock: fakeClock(), log: () => {}, progressMinMs: 0, ...extra });
  cleanups.push(() => worker.stop());
  return worker;
}

async function makeFifo() {
  const path = join(tempDir(), "gate");
  expect(await Bun.spawn(["mkfifo", path]).exited).toBe(0);
  return path;
}

describe("HEAVY lines", () => {
  test("a wait behind n jobs is place n+1; a wait for the GPU itself is place 1", () => {
    expect(parseHeavyLine("2026-10-21T20:34:26.010Z HEAVY_WAIT desk-j1: 2 job(s) ahead in the queue")).toEqual({ type: "wait", label: "desk-j1", waitPos: 3, why: "2 job(s) ahead in the queue" });
    expect(parseHeavyLine("HEAVY_WAIT desk-j1: slot.1 was taken 5s ago; its load shows after 120s").waitPos).toBe(1);
    expect(parseHeavyLine("HEAVY_WAIT desk-j1: 1 running; gpu 83%+83% -> -66% free, cpu 14%+6% -> 80% free").waitPos).toBe(1);
  });

  test("admit and unrelated lines", () => {
    expect(parseHeavyLine("HEAVY_ADMIT desk-j1 slot.1: 0 heavy job(s) running, load 5 < 80")).toEqual({ type: "admit", label: "desk-j1" });
    expect(parseHeavyLine("HEAVY_SCOPE desk-j1 heavy-desk-j1-1.scope MemoryMax=6.0G")).toBeNull();
    expect(parseHeavyLine("[page] some console line")).toBeNull();
  });

  test("the place in line comes from the queue directory's sorted tickets", () => {
    const names = ["001761900000200-77-desk-j1", "001761900000100-12-lift3d", "001761900000300-90-desk-j10"];
    expect(queuePosition(names, "desk-j1")).toBe(2);
    expect(queuePosition(names, "desk-j10")).toBe(3);
    expect(queuePosition(names, "desk-j2")).toBeNull();
  });
});

describe("desk worker", () => {
  test("a job goes waiting (with its place) -> running -> result, and its files are removed", async () => {
    const server = fakeServer();
    const worker = makeWorker(server);
    const run = worker.run();
    const result = await server.next((r) => r.kind === "result");
    worker.stop();
    await run;

    const states = server.progress().map((r) => r.state);
    expect(states.indexOf("running")).toBeGreaterThan(states.lastIndexOf("waiting"));
    expect(server.progress().filter((r) => r.state === "waiting").map((r) => r.waitPos)).toEqual([null, 3, 1]);
    expect(server.progress().filter((r) => r.state === "running").at(-1)).toMatchObject({ progress: { done: 6, total: 6 }, waitPos: null });
    expect(result.rallies.map((r) => r.index)).toEqual([0, 1]);
    expect(result.rallies[0]).toMatchObject({ v: 1, source: "desk", nearSlot: 0, winner: "near", startedAt: PLAYED_AT + Math.round((1 / 60 - 0.5) * 1000) });
    expect(result.rallies[0].shots[0]).toMatchObject({ stroke: "forehand", kind: "drive" });
    expect(Object.keys(result.pose)).toEqual(["0", "1"]);
    expect(result.pose[0][0].pose2d.model).toBe("fake");
    expect(existsSync(worker.paths(JOB.id).checkpoint) || existsSync(worker.paths(JOB.id).video)).toBe(false);
  });

  test("the lease is renewed RENEW_MS after the last post while queued, with the place read from the queue", async () => {
    const server = fakeServer();
    const gate = await makeFifo();
    const queueDir = tempDir();
    for (const n of ["001761900000100-12-other", "001761900000200-77-desk-j1", "001761900000300-90-later"]) writeFileSync(join(queueDir, n), "local");
    const worker = makeWorker(server, { heavyQueueDir: queueDir, heavy: ["env", `FAKE_HEAVY_GATE=${gate}`, ...HEAVY] });
    const run = worker.run();
    const gateWriter = open(gate, "w");
    await server.next((r) => r.waitPos === 3);
    const sentBefore = worker.sent.length;

    worker.clock.advance(RENEW_MS - 1);
    expect(worker.sent.length).toBe(sentBefore);
    worker.clock.advance(1);
    expect(worker.sent.length).toBe(sentBefore + 1);
    expect(worker.sent.at(-1)).toMatchObject({ state: "waiting", waitPos: 2, at: worker.sent[sentBefore - 1].at + RENEW_MS });
    worker.clock.advance(RENEW_MS);
    expect(worker.sent.length).toBe(sentBefore + 2);

    const writer = await gateWriter;
    cleanups.push(() => writer.close());
    await writer.write("go\n");
    await writer.write("go\n");
    await server.next((r) => r.kind === "result");
    worker.stop();
    await run;
    const gaps = worker.sent.slice(1).map((s, i) => s.at - worker.sent[i].at);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(30_000);
  });

  test("the worker will not start without its server and GPU queue settings (no host defaults)", async () => {
    const tokenFile = join(tempDir(), "worker-token");
    writeFileSync(tokenFile, `${TOKEN}\n`);
    for (const drop of ["DESK_SERVER", "DESK_HEAVY", "DESK_HEAVY_QUEUE_DIR"]) {
      const env = { ...process.env, DESK_TOKEN_FILE: tokenFile, DESK_SERVER: "http://127.0.0.1:9", DESK_HEAVY: "true", DESK_HEAVY_QUEUE_DIR: tempDir(), DESK_STATE_DIR: tempDir() };
      delete env[drop];
      const p = Bun.spawn([process.execPath, join(import.meta.dir, "..", "desk", "worker.js")], { env, stdout: "ignore", stderr: "ignore" });
      expect(await p.exited).toBe(2);
    }
  });

  test("a killed worker leaves the run to lease expiry; the next worker stops it and resumes the checkpoint", async () => {
    const server = fakeServer();
    const stateDir = tempDir();
    const tokenFile = join(tempDir(), "worker-token");
    writeFileSync(tokenFile, `${TOKEN}\n`);
    const first = Bun.spawn([process.execPath, join(import.meta.dir, "..", "desk", "worker.js")], {
      env: { ...process.env, DESK_SERVER: server.url, DESK_TOKEN_FILE: tokenFile, DESK_STATE_DIR: stateDir, DESK_HEAVY: HEAVY.join(" "), DESK_ANALYZER: `${ANALYZER.join(" ")} --fake-hang-at 3`, DESK_HEAVY_QUEUE_DIR: join(stateDir, "none"), DESK_PROGRESS_MIN_MS: "0" },
      stdout: "ignore",
      stderr: "ignore",
    });
    cleanups.push(() => first.kill(9));
    await server.next((r) => r.kind === "progress" && r.progress?.done === 3);
    first.kill(9);
    await first.exited;
    const checkpoint = join(stateDir, "checkpoints", `${JOB.id}.json`);
    const orphan = Number(readFileSync(`${checkpoint}.pid`, "utf8"));
    expect(JSON.parse(readFileSync(checkpoint, "utf8"))).toMatchObject({ resumeFrame: 3, rallies: [{ index: 0 }] });
    expect(server.records.some((r) => r.kind === "result")).toBe(false);
    expect(await Bun.spawn(["kill", "-0", String(orphan)]).exited).toBe(0);

    server.now += 90_001;
    const second = makeWorker(server, { stateDir });
    expect(second.recover()).toContain(orphan);
    const run = second.run();
    const result = await server.next((r) => r.kind === "result");
    second.stop();
    await run;

    expect(server.claims).toBe(2);
    expect(server.progress().filter((r) => r.claim === 2 && r.progress).map((r) => r.progress.done)).toEqual([4, 5, 6]);
    expect(Object.keys(result.pose)).toEqual(["0", "1"]);
    expect(result.rallies.map((r) => [r.index, r.startedAt])).toEqual([
      [0, PLAYED_AT + Math.round((1 / 60 - 0.5) * 1000)],
      [1, PLAYED_AT + Math.round((4 / 60 - 0.5) * 1000)],
    ]);
  }, 20_000);

  test("a heartbeat goes out at start and every HEARTBEAT_MS, idle or busy", async () => {
    const server = fakeServer();
    server.leaseUntil = Infinity;
    const worker = makeWorker(server);
    const run = worker.run();
    expect(worker.beats).toBe(1);
    worker.clock.advance(HEARTBEAT_MS - 1);
    expect(worker.beats).toBe(1);
    worker.clock.advance(1);
    expect(worker.beats).toBe(2);
    worker.clock.advance(3 * HEARTBEAT_MS);
    expect(worker.beats).toBe(5);
    worker.stop();
    await run;
  });

  test("a rally job with a track downloads it, hands it to the analyzer, and its result carries the timing", async () => {
    const server = fakeServer({ ...JOB, kind: "rally", track: { bytes: 30, frames: 0 } });
    const worker = makeWorker(server);
    const run = worker.run();
    const result = await server.next((r) => r.kind === "result");
    worker.stop();
    await run;
    expect(result.timing).toBe("track");
  });

  test("a job without table corners gets an error result and no analyzer run", async () => {
    const server = fakeServer();
    const worker = makeWorker(server);
    JOB.corners = null;
    cleanups.push(() => (JOB.corners = CORNERS));
    const run = worker.run();
    const result = await server.next((r) => r.kind === "result");
    worker.stop();
    await run;
    expect(result.error).toContain("no table corners");
    expect(server.progress().every((r) => r.state === "waiting")).toBe(true);
  });

  test("an analyzer that fails gives an error result with its exit code and last lines", async () => {
    const server = fakeServer();
    const worker = makeWorker(server, { analyzer: [...ANALYZER, "--fake-fail"] });
    const run = worker.run();
    const result = await server.next((r) => r.kind === "result");
    worker.stop();
    await run;
    expect(result.rallies).toBeUndefined();
    expect(result.error).toContain("analyzer exited 3");
    expect(result.error).toContain("pose model failed to load");
    expect(existsSync(worker.paths(JOB.id).video)).toBe(false);
  });
});

describe("gallery first pass", () => {
  test("a gallery job's first-pass shots go to /early before the analysis, and the result is those shots filled", async () => {
    const server = fakeServer();
    const worker = makeWorker(server, { firstPass: FIRST_PASS });
    const run = worker.run();
    const result = await server.next((r) => r.kind === "result");
    worker.stop();
    await run;

    const kinds = server.records.map((r) => (r.kind === "progress" ? r.state : r.kind));
    expect(kinds.indexOf("early")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("early")).toBeLessThan(kinds.indexOf("running"));
    const early = server.records.find((r) => r.kind === "early");
    expect(early.rallies.flatMap((r) => r.shots.map((s) => [s.side, s.t, s.stroke]))).toEqual([["near", 0.5, null], ["far", 0.9, null], ["near", 2, null], ["far", 2.4, null]]);
    expect(result.rallies.flatMap((r) => r.shots.map((s) => [s.side, s.t, s.kind, s.stroke]))).toEqual([["near", 0.5, "드라이브", "포핸드"], ["far", 0.9, "푸시", null], ["near", 2, "드라이브", "포핸드"], ["far", 2.4, "푸시", null]]);
    expect(result.rallies.map((r) => [r.index, r.startedAt, r.winner])).toEqual([[0, 1000, "far"], [1, 1001, "far"]]);
    expect(Object.keys(result.pose)).toEqual(["0", "1"]);
    expect(Object.keys(result.pose[0])).toEqual(["0"]);
    expect(result.pose[0][0].pose2d).toMatchObject({ model: "fake", hand: null });
    expect(result.pose[0][0].vote).toBeUndefined();
    const paths = worker.paths(JOB.id);
    expect([paths.shots, paths.checkpoint, paths.video].some((p) => existsSync(p))).toBe(false);
  });

  test("a first pass that fails costs only the early view: the analysis goes on with its own shots", async () => {
    const server = fakeServer();
    const logged = [];
    const worker = makeWorker(server, { firstPass: ["env", "FAKE_FIRST_PASS_FAIL=1", ...FIRST_PASS], log: (m) => logged.push(m) });
    const run = worker.run();
    const result = await server.next((r) => r.kind === "result");
    worker.stop();
    await run;
    expect(server.records.some((r) => r.kind === "early")).toBe(false);
    expect(result.rallies[0].shots[0]).toMatchObject({ stroke: "forehand", kind: "drive" });
    expect(logged.some((m) => m.includes("first pass for job j1 failed (exit 3)"))).toBe(true);
  });

  test("a rally job has no first pass", async () => {
    const server = fakeServer({ ...JOB, kind: "rally" });
    const worker = makeWorker(server, { firstPass: FIRST_PASS });
    const run = worker.run();
    const result = await server.next((r) => r.kind === "result");
    worker.stop();
    await run;
    expect(server.records.some((r) => r.kind === "early")).toBe(false);
    expect(result.rallies[0].shots[0]).toMatchObject({ stroke: "forehand", kind: "drive" });
  });
});
