// The analyzer's checkpoint: the frames done, where a restart may begin, and the rallies so far.
// Written atomically (tmp + rename) at most every everyMs (30 s), so a killed run loses at most
// that much work. A restart begins at resumeFrame, the first frame after the last moment no rally
// was open, so a rally is never cut in two by a restart.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const CHECKPOINT_EVERY_MS = 30_000;
const EMPTY = { lastFrame: 0, lastT: 0, resumeFrame: 0, resumeT: 0, rallies: [] };

export class Checkpoint {
  // key ties the file to one video (its size and fps): a checkpoint of another video is ignored
  constructor({ path, key, now = Date.now, everyMs = CHECKPOINT_EVERY_MS }) {
    this.path = path;
    this.key = key;
    this.now = now;
    this.everyMs = everyMs;
    this.savedAt = now();
  }

  load() {
    if (!existsSync(this.path)) return { ...EMPTY, rallies: [] };
    const saved = JSON.parse(readFileSync(this.path, "utf8"));
    return saved.v === 1 && saved.key === this.key ? saved : { ...EMPTY, rallies: [] };
  }

  // state: { lastFrame, lastT, resumeFrame, resumeT, rallies }
  update(state) {
    if (this.now() - this.savedAt >= this.everyMs) this.save(state);
  }

  save(state) {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, key: this.key, savedAt: new Date(this.now()).toISOString(), ...state }));
    renameSync(tmp, this.path);
    this.savedAt = this.now();
  }
}

// One analyzer per job: a run left behind by a killed worker (the GPU queue starts the analyzer in
// its own scope, so stopping the worker's unit does not reach it) is stopped before a new one starts.
export function takeLock(lockPath) {
  stopLockOwner(lockPath);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, String(process.pid));
  return () => rmSync(lockPath, { force: true });
}

// the owner's command line names its checkpoint (the lock path without ".pid")
export function stopLockOwner(lockPath) {
  if (!existsSync(lockPath)) return null;
  const pid = Number(readFileSync(lockPath, "utf8"));
  return pid !== process.pid && stopPid(pid, lockPath.replace(/\.pid$/, "")) ? pid : null;
}

// SIGKILL: the run is abandoned anyway and its checkpoint is already on disk. Only a process whose
// command line holds marker is stopped, so a pid reused by something else is left alone.
export function stopPid(pid, marker) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  let cmdline;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
  if (!cmdline.includes(marker)) return false;
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false;
    throw err;
  }
}
