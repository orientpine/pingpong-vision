// The analysis desk worker: takes analysis jobs from the tournament server one at a time and runs
// each through the PC's GPU job queue, so the queue decides when the GPU is free for it.
//   claim -> download the video -> heavy desk-<jobId> --mem <estimate> -- analyzer -> result
// While queued it reports state "waiting" with its place in line (waitPos, see desk/heavy.js);
// once admitted, "running" with the frames done. Every report renews the job's 90 s lease and one
// goes out at least every RENEW_MS. A killed worker leaves the job to lease expiry; the analyzer's
// checkpoint stays on disk, so the next claim of the job goes on from it. docs/analysis-desk.md.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { stopLockOwner, stopPid } from "./checkpoint.js";
import { parseHeavyLine, queuePosition } from "./heavy.js";

export const RENEW_MS = 20_000;
export const PROGRESS_MIN_MS = 5_000;
// an empty claim is one small local request; at 5 s a job waited 2.5 s on average before it started
export const IDLE_POLL_MS = 1_000;
// the server shows the worker as alive while it heard from it in the last 30 s
export const HEARTBEAT_MS = 10_000;
const LEASE_GONE = new Set([404, 409, 410]);

export const realClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };

// Chromium with the full pose model needs about 3 GB; the video element buffers part of the file.
export const memEstimate = (videoBytes) => `${4 + Math.ceil(videoBytes / 1e9)}G`;

async function eachLine(stream, onLine) {
  let rest = "";
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    const parts = (rest + chunk).split("\n");
    rest = parts.pop();
    for (const line of parts) onLine(line);
  }
  if (rest) onLine(rest);
}

// The job's lease: the state the server shows, posted on every change of state, at most every
// PROGRESS_MIN_MS for frame counts, and again RENEW_MS after the last post whatever happens.
class Lease {
  constructor(worker, jobId) {
    this.worker = worker;
    this.jobId = jobId;
    this.label = `desk-${jobId}`;
    this.state = { state: "waiting", progress: null, waitPos: null };
    this.lastPost = -Infinity;
    this.timer = null;
    this.gone = false;
    this.onGone = () => {};
  }

  set(patch, force) {
    const changed = patch.state !== undefined && patch.state !== this.state.state;
    this.state = { ...this.state, ...patch };
    if (force || changed || this.worker.clock.now() - this.lastPost >= this.worker.progressMinMs) this.post();
  }

  // posts go out one after another, so the server sees the states in the order they happened
  post() {
    const { clock } = this.worker;
    clock.clearTimeout(this.timer);
    this.lastPost = clock.now();
    this.timer = clock.setTimeout(() => this.renew(), RENEW_MS);
    const state = this.state;
    this.worker.sent.push({ at: this.lastPost, ...state });
    this.worker.posts = this.worker.posts.then(() =>
      this.worker.api(`/jobs/${this.jobId}/progress`, state).then((res) => {
        if (LEASE_GONE.has(res.status)) {
          this.gone = true;
          this.onGone();
        }
      }, (err) => this.worker.log(`progress post failed: ${err.message}`)),
    );
  }

  // the line moves without a new HEAVY_WAIT line, so a waiting job reads its place from the queue
  renew() {
    const dir = this.worker.config.heavyQueueDir;
    if (this.state.state === "waiting" && dir && existsSync(dir)) {
      const pos = queuePosition(readdirSync(dir), this.label);
      if (pos !== null) this.state = { ...this.state, waitPos: pos };
    }
    this.post();
  }

  stop() {
    this.worker.clock.clearTimeout(this.timer);
  }
}

// the desk stores playedAt as the date string the uploader gave; createdAt (ms) if it does not parse
function playedAtOf(job) {
  const parsed = typeof job.playedAt === "string" ? Date.parse(job.playedAt) : job.playedAt;
  return Number.isFinite(parsed) ? parsed : (job.createdAt ?? 0);
}

export class DeskWorker {
  // config: { server, token, stateDir, heavy: string[], analyzer: string[], firstPass: string[], heavyQueueDir, clock?, log?, progressMinMs? }
  constructor(config) {
    this.config = config;
    this.clock = config.clock ?? realClock;
    this.log = config.log ?? ((m) => console.log(m));
    this.progressMinMs = config.progressMinMs ?? PROGRESS_MIN_MS;
    this.stopped = false;
    this.child = null;
    this.wake = () => {};
    // the progress posts in flight, and every state posted (with the clock's time)
    this.posts = Promise.resolve();
    this.sent = [];
    this.beats = 0;
    this.beatTimer = null;
    this.name = `${hostname()}:${process.pid}`;
    mkdirSync(config.stateDir, { recursive: true });
  }

  paths(jobId) {
    const dir = this.config.stateDir;
    return { video: join(dir, "videos", `${jobId}.video`), track: join(dir, "videos", `${jobId}.track.json.gz`), checkpoint: join(dir, "checkpoints", `${jobId}.json`), shots: join(dir, "checkpoints", `${jobId}.shots.json`) };
  }

  get activeFile() {
    return join(this.config.stateDir, "active.json");
  }

  api(path, body) {
    return fetch(`${this.config.server}/api/desk/worker${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-desk-worker": this.config.token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  // a run left by a killed worker: its queue process and analyzer are stopped; the checkpoint stays
  recover() {
    if (!existsSync(this.activeFile)) return [];
    const active = JSON.parse(readFileSync(this.activeFile, "utf8"));
    const stopped = [stopPid(active.pid, active.label) ? active.pid : null, stopLockOwner(`${active.checkpoint}.pid`)].filter((p) => p !== null);
    rmSync(this.activeFile, { force: true });
    if (stopped.length) this.log(`recovered job ${active.jobId}: stopped pid ${stopped.join(", ")}`);
    return stopped;
  }

  async run() {
    this.recover();
    this.beat();
    while (!this.stopped) {
      const job = await this.claim();
      if (job) await this.runJob(job);
      else if (!this.stopped) await this.sleep(IDLE_POLL_MS);
    }
  }

  beat() {
    this.beats++;
    this.api("/heartbeat", {}).catch((err) => this.log(`heartbeat failed: ${err.message}`));
    this.beatTimer = this.clock.setTimeout(() => this.beat(), HEARTBEAT_MS);
  }

  stop() {
    this.stopped = true;
    this.clock.clearTimeout(this.beatTimer);
    this.wake();
    this.kill();
  }

  kill() {
    if (!this.child) return;
    stopPid(this.child.pid, this.child.label);
    stopLockOwner(`${this.child.checkpoint}.pid`);
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const h = this.clock.setTimeout(resolve, ms);
      this.wake = () => {
        this.clock.clearTimeout(h);
        resolve();
      };
    });
  }

  async claim() {
    try {
      const res = await this.api("/claim", { worker: this.name });
      if (res.status === 204) return null;
      if (!res.ok) throw new Error(`claim answered ${res.status}`);
      return (await res.json()).job;
    } catch (err) {
      this.log(`claim failed: ${err.message}`);
      return null;
    }
  }

  async runJob(job) {
    const lease = new Lease(this, job.id);
    lease.onGone = () => this.kill();
    lease.post();
    const paths = this.paths(job.id);
    let outcome;
    try {
      if (!job.corners) throw new Error("the job has no table corners");
      await this.download(job.id, paths.video);
      // a rally job from a 다시 보기 original brings its overlay track: the analyzer takes shot times from it
      if (job.kind === "rally" && job.track) await this.download(job.id, paths.track, "track");
      // a gallery job's shots go out first; the analyzer then fills their forehand/backhand
      if (job.kind === "gallery" && this.config.firstPass) await this.firstPass(job, paths);
      outcome = await this.analyze(job, paths, lease);
    } catch (err) {
      outcome = { error: `analysis desk worker: ${err.message}` };
    } finally {
      lease.stop();
    }
    await this.posts;
    if (lease.gone || this.stopped) return;
    const res = await this.api(`/jobs/${job.id}/result`, outcome).catch((err) => ({ ok: false, status: err.message }));
    // 409: the lease ran out and the job went back to the queue, so the checkpoint is kept for the
    // next claim; 404: the job was deleted, so its files go too
    if (!res.ok && res.status !== 404) {
      this.log(`result for job ${job.id} not taken (${res.status}); the job comes back after its lease`);
      return;
    }
    for (const p of [paths.video, paths.track, paths.shots, paths.checkpoint, `${paths.checkpoint}.pid`, this.activeFile]) rmSync(p, { force: true });
  }

  async download(jobId, path, what = "video") {
    if (existsSync(path)) return;
    const res = await this.api(`/jobs/${jobId}/${what}`);
    if (!res.ok) throw new Error(`${what} download answered ${res.status}`);
    mkdirSync(join(path, ".."), { recursive: true });
    await Bun.write(`${path}.part`, res);
    renameSync(`${path}.part`, path);
  }

  // The first pass (desk/pass1.js, outside the GPU queue: one CPU, seconds per video) and its shots sent at
  // once to /early. One job runs at a time, so one first pass does too. A worker that comes back to the job
  // reuses the shots it kept. A failed first pass only costs the early view: the analysis goes on as before.
  async firstPass(job, paths) {
    if (!existsSync(paths.shots)) {
      const proc = Bun.spawn([...this.config.firstPass, "--video", paths.video, "--corners", JSON.stringify(job.corners), "--played-at", String(playedAtOf(job))], { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      const line = out.trim().split("\n").pop() ?? "";
      if (code !== 0 || !line.startsWith("{")) {
        this.log(`first pass for job ${job.id} failed (exit ${code}): ${err.trim().split("\n").pop() ?? ""}`);
        return;
      }
      mkdirSync(join(paths.shots, ".."), { recursive: true });
      writeFileSync(`${paths.shots}.part`, line);
      renameSync(`${paths.shots}.part`, paths.shots);
    }
    const { rallies } = JSON.parse(readFileSync(paths.shots, "utf8"));
    const res = await this.api(`/jobs/${job.id}/early`, { rallies }).catch((err) => ({ ok: false, status: err.message }));
    if (!res.ok) this.log(`first pass for job ${job.id} not taken (${res.status})`);
  }

  async analyze(job, paths, lease) {
    const { heavy, analyzer } = this.config;
    const playedAt = playedAtOf(job);
    const cmd = [...heavy, lease.label, "--mem", memEstimate(statSync(paths.video).size), "--",
      ...analyzer, "--video", paths.video, "--corners", JSON.stringify(job.corners), "--checkpoint", paths.checkpoint, "--played-at", String(playedAt), "--kind", job.kind === "rally" ? "rally" : "gallery",
      ...(job.kind === "rally" && existsSync(paths.track) ? ["--track", paths.track] : []),
      ...(job.kind === "gallery" && existsSync(paths.shots) ? ["--shots", paths.shots] : [])];
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    this.child = { pid: proc.pid, label: lease.label, checkpoint: paths.checkpoint };
    writeFileSync(this.activeFile, JSON.stringify({ jobId: job.id, ...this.child }));
    const tail = [];
    let rallies = null;
    let pose = null;
    let timing = null;
    await Promise.all([
      eachLine(proc.stderr, (line) => {
        tail.push(line);
        if (tail.length > 20) tail.shift();
        const h = parseHeavyLine(line);
        if (h?.label !== lease.label) return;
        if (h.type === "wait") lease.set({ state: "waiting", waitPos: h.waitPos, progress: null }, true);
        else lease.set({ state: "running", waitPos: null }, true);
      }),
      eachLine(proc.stdout, (line) => {
        if (!line.startsWith("{")) return;
        const m = JSON.parse(line);
        if (m.progress) lease.set({ state: "running", waitPos: null, progress: m.progress }, false);
        if (m.rallies) ({ rallies, pose, timing = null } = m);
      }),
    ]);
    const code = await proc.exited;
    this.child = null;
    if (code === 0 && rallies) return { rallies, pose, ...(timing ? { timing } : {}) };
    return { error: `analyzer exited ${code}${rallies ? "" : " without rallies"}: ${tail.slice(-5).join(" | ")}` };
  }
}

if (import.meta.main) {
  const env = process.env;
  const tokenFile = env.DESK_TOKEN_FILE ?? (env.TOURNAMENT_DATA_DIR && join(env.TOURNAMENT_DATA_DIR, "desk", "worker-token"));
  // no host defaults: the server address and the GPU queue are this PC's own settings, written into the
  // unit by deploy/install-desk-worker.sh
  const missing = ["DESK_SERVER", "DESK_HEAVY", "DESK_HEAVY_QUEUE_DIR"].filter((k) => !env[k]);
  if (!tokenFile || missing.length) {
    console.error("set TOURNAMENT_DATA_DIR (the tournament server's DATA_DIR) or DESK_TOKEN_FILE, and DESK_SERVER, DESK_HEAVY and DESK_HEAVY_QUEUE_DIR");
    process.exit(2);
  }
  const worker = new DeskWorker({
    server: env.DESK_SERVER,
    token: readFileSync(tokenFile, "utf8").trim(),
    stateDir: env.DESK_STATE_DIR ?? join(homedir(), ".local", "state", "pingpong-desk"),
    heavy: env.DESK_HEAVY.split(" "),
    analyzer: env.DESK_ANALYZER ? env.DESK_ANALYZER.split(" ") : [process.execPath, join(import.meta.dir, "analyze.js")],
    firstPass: env.DESK_FIRST_PASS ? env.DESK_FIRST_PASS.split(" ") : [process.execPath, join(import.meta.dir, "pass1.js")],
    heavyQueueDir: env.DESK_HEAVY_QUEUE_DIR,
    progressMinMs: env.DESK_PROGRESS_MIN_MS ? Number(env.DESK_PROGRESS_MIN_MS) : PROGRESS_MIN_MS,
  });
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => worker.stop());
  worker.log(`analysis desk worker: ${worker.config.server}, state in ${worker.config.stateDir}`);
  await worker.run();
}
