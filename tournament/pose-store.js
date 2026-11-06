// Shot poses from the analysis desk, kept outside the match files because they are large:
// data/analysis/pose/<matchKey>.json = { v:1, rallies:{ [rally]:{ [shot]:{ pose2d, pose3d } } } }.
// Rules: docs/analytics.md, 자세 비교.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord, need } from './desk-results.js';

const JOINT_COUNT = 23;
const FRAME_COUNT = 3;
const MAX_MODEL = 40;

function parseFrames(frames, rowLength) {
  need(Array.isArray(frames) && frames.length === FRAME_COUNT, 'pose frames');
  return frames.map((frame) => {
    if (frame === null) return null;
    need(Array.isArray(frame) && frame.length === JOINT_COUNT, 'pose frame');
    return frame.map((row) => {
      need(Array.isArray(row) && row.length === rowLength && row.every(Number.isFinite), 'pose joint');
      return [...row];
    });
  });
}

function parseShotPose(p) {
  need(isRecord(p) && isRecord(p.pose2d) && isRecord(p.pose3d), 'pose');
  const { model, at, hand, vote, frames } = p.pose2d;
  need(typeof model === 'string' && model.length <= MAX_MODEL, 'pose model');
  need(Array.isArray(at) && at.length === FRAME_COUNT && at.every(Number.isFinite), 'pose at');
  // null: the desk saw too few shots at that end to tell the racket hand (it never guesses one)
  need(hand === 'R' || hand === 'L' || hand === null, 'pose hand');
  // the shot's own racket-hand vote (desks before it send none): counted over the player's shots
  need(vote === undefined || vote === 'R' || vote === 'L' || vote === null, 'pose vote');
  const pose2d = { model, at: [...at], hand, ...(vote === undefined ? {} : { vote }), frames: parseFrames(frames, 3) };
  return { pose2d, pose3d: { frames: parseFrames(p.pose3d.frames, 4) } };
}

// { [rally]: { [shot]: pose } } of a worker result, for rallies and shots that result holds; null without pose.
export function parsePose(input, rallies) {
  if (input === null || input === undefined) return null;
  need(isRecord(input), 'pose');
  return Object.fromEntries(Object.entries(input).map(([rallyIndex, shots]) => {
    const rally = rallies.find((r) => String(r.index) === rallyIndex);
    need(rally !== undefined && isRecord(shots), 'pose rally');
    return [rallyIndex, Object.fromEntries(Object.entries(shots).map(([shotIndex, pose]) => {
      need(/^\d+$/.test(shotIndex) && Number(shotIndex) < rally.shots.length, 'pose shot');
      return [shotIndex, parseShotPose(pose)];
    }))];
  }));
}

export function createPoseStore({ dataDir, now = Date.now, log = console.error }) {
  const dir = join(dataDir, 'analysis', 'pose');
  const pathOf = (key) => join(dir, `${key}.json`);

  function parseFile(path) {
    try {
      const doc = JSON.parse(readFileSync(path, 'utf8'));
      if (doc?.v === 1 && isRecord(doc.rallies)) return doc.rallies;
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
    log(`pose: ignoring ${path}: not a v1 pose file`);
    return null;
  }

  // The rallies of a match, or null when the file is missing or broken.
  function read(key) {
    const path = pathOf(key);
    return existsSync(path) ? parseFile(path) : null;
  }

  // Merges by rally, since a match can get its points from several desk jobs. A broken file is kept
  // aside for a look, never overwritten.
  function save(key, rallies) {
    const path = pathOf(key);
    mkdirSync(dir, { recursive: true });
    const old = read(key);
    if (old === null && existsSync(path)) renameSync(path, `${path}.bad-${now()}`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, rallies: { ...old, ...rallies } }));
    renameSync(tmp, path);
  }

  return { read, save };
}
