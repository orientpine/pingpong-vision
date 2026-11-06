// The analysis desk's page: the production Pipeline run over every frame of one video with the
// full pose model, the same way qa/eval.js runs it, and each rally's shots gathered by RallyShots
// (public/js/analysis-record.js) exactly as the camera does before it sends a rally. Each shot's
// joints come from ShotPoses (pose-buffer.js). Results go to the analyzer (desk/analyze.js) through
// window.__desk; see desk/run-state.js for the messages.
import { RallyShots } from "../js/analysis-record.js";
import { Pipeline } from "../js/pipeline.js";
import { createPose } from "../js/pose.js";
import { ShotPoses } from "./pose-buffer.js";
import { DeskRallies } from "./collect.js";
import { trackShots } from "./track-shots.js";
import { strokeSide } from "../js/rally.js";
import { farBox, farFrames, hiddenLegsFar, toFrame } from "./far-crop.js";
import { MAX_JOINT_AGE_S, jointAge } from "./fresh-joints.js";

const q = new URLSearchParams(location.search);
const FPS = Number(q.get("fps"));
const FROM = Number(q.get("from") || 0);
const corners = JSON.parse(q.get("corners"));
const KIND = q.get("kind") || "gallery";
const TRACK = KIND === "rally" && q.get("track") === "1";
// a gallery job's first-pass shots (desk/pass1.js): this run only fills their forehand/backhand and joints
const SHOTS = KIND === "gallery" && q.get("shots") === "1";
// A first-pass shot takes the forehand/backhand of this run's own shot at the same end when one is this close
// (the two passes put the same hit tens to hundreds of ms apart; on the labelled public videos 150 ms matched
// those that were the same hit), else reads it from the players at its own time. It is read FILL_AFTER_S
// after its time, when this run's shot for the same hit has been seen.
const SAME_HIT_S = 0.15;
const FILL_AFTER_S = 0.3;
const own = [];
const [BEFORE_S, AFTER_S] = [0.85, 0.05];
const PROGRESS_EVERY = 15;

const log = (m) => (document.getElementById("log").textContent = m);

async function main() {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = "/video";
  document.body.append(video);
  await new Promise((res, rej) => {
    video.onloadeddata = res;
    video.onerror = () => rej(new Error("video load failed"));
  });
  const total = Math.floor(video.duration * FPS);
  const model = q.get("model") || "full";
  const pose = await createPose({ delegate: q.get("delegate") || "GPU", model, numPoses: 2, world: true });
  const rallies = new DeskRallies(KIND, RallyShots);
  const shotPoses = new ShotPoses(`mediapipe-${model}`);
  const pipe = new Pipeline({
    pose,
    procWidth: 640,
    poseEvery: 1,
    onEvent: (e) => {
      // with a track or first-pass shots the shots are given; the pipeline here only finds the players (and,
      // with first-pass shots, keeps its own shots' forehand/backhand to lend them)
      if (SHOTS && (e.type === "shot" || e.type === "shotUpdate") && !own.includes(e.shot)) own.push(e.shot);
      if (TRACK || SHOTS) return;
      rallies.onEvent(e);
      shotPoses.onEvent(e);
    },
  });
  pipe.setVideoSize(video.videoWidth, video.videoHeight);
  pipe.setCalibration(corners);
  const seek = (time) =>
    new Promise((res) => {
      video.onseeked = () => res();
      video.currentTime = time;
    });
  const send = async (list) => {
    for (const { startT, draft, shots: rallied } of list) await window.__desk({ rally: { startT, draft, pose: shotPoses.rallyPose(rallied) } });
  };
  const flush = () => send(rallies.take());
  // the far end enlarged, read when the whole frame did not see the far player at this frame; null when
  // no frame needs it (the second pose model is only made then). legsHidden (rally originals only): a
  // person the crop sees whose legs the table hides still counts as the far player (see hiddenLegsFar).
  const farReader = async (needed, { legsHidden = false } = {}) => {
    if (!needed) return null;
    const box = farBox(corners, video.videoWidth, video.videoHeight);
    const cropPose = await createPose({ delegate: q.get("delegate") || "GPU", model, numPoses: 2, world: true });
    const crop = new OffscreenCanvas(box.w, box.h);
    return (t) => {
      const players = pipe.players;
      if (players.far.seenT === t) return;
      crop.getContext("2d").drawImage(video, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
      const seen = toFrame(cropPose.detect(crop, t * 1000, box.w, box.h), box);
      const [, far] = players.assign(seen, players.cal);
      const lm = far ?? (legsHidden ? hiddenLegsFar(seen, players.cal, box) : null);
      if (lm) players.updateOne(players.far, lm, t, players.cal);
    };
  };
  if (TRACK) return trackRun({ video, total, pipe, seek, rallies, shotPoses, send, pose, farReader });
  const given = SHOTS ? await (await fetch("/shots")).json() : [];
  const cropAt = farFrames(given, FPS);
  const readFarEnd = await farReader(cropAt.size > 0);
  let next = 0;
  // one first-pass shot read from the players as they are now: rally.js's own forehand/backhand rule at
  // the shot's time, and the joints ShotPoses keeps for it
  const fill = async (g) => {
    const shot = { t: g.t, side: g.side };
    shotPoses.onEvent({ type: "shot", shot });
    shotPoses.settle();
    let same = null;
    for (const o of own) if (o.side === g.side && Math.abs(o.t - g.t) <= SAME_HIT_S && (!same || Math.abs(o.t - g.t) < Math.abs(same.t - g.t))) same = o;
    const fresh = jointAge(pipe.players[g.side].lmHist, g.t) <= MAX_JOINT_AGE_S;
    const stroke = fresh ? same?.stroke ?? strokeSide(pipe.players.landmarksAt(g.side, g.t), pipe.players[g.side].hand) : null;
    await window.__desk({ fill: { rally: g.rally, shot: g.shot, stroke, pose: shotPoses.poses.get(shot) ?? null } });
    shotPoses.poses.delete(shot);
  };
  let resumeFrame = FROM;
  for (let f = FROM; f < total; f++) {
    await seek((f + 0.5) / FPS);
    pipe.process(video, f / FPS);
    if (cropAt.has(f)) readFarEnd(f / FPS);
    shotPoses.frame(f / FPS, pipe.players);
    if (SHOTS) {
      while (next < given.length && given[next].t + FILL_AFTER_S <= f / FPS) await fill(given[next++]);
      // a resumed run needs the joints from before the next shot again
      resumeFrame = next < given.length ? Math.max(resumeFrame, Math.min(f + 1, Math.floor((given[next].t - 1.2) * FPS))) : f + 1;
    } else {
      await flush();
      if (rallies.resumable()) resumeFrame = f + 1;
    }
    if ((f + 1 - FROM) % PROGRESS_EVERY === 0 || f === total - 1) {
      await window.__desk({ progress: { done: f + 1, total }, t: f / FPS, resumeFrame, resumeT: resumeFrame / FPS });
      log(`frame ${f + 1}/${total}`);
    }
  }
  pipe.reset();
  if (SHOTS) while (next < given.length) await fill(given[next++]);
  else await send(rallies.finish(FROM / FPS, Math.max(FROM, total - 1) / FPS));
  await window.__desk({ done: true, delegate: pose.delegate });
}

// A 다시 보기 original with its overlay track: the frames from BEFORE_S before each track shot to AFTER_S
// after it go through the pipeline for the players' joints, and the shot is posed from them. Around a far
// shot the far end is also read enlarged, as for a gallery video, and a far player whose legs the table hides
// still counts: on a real landscape phone clip the whole frame had no far player at the hit or 0.4 s before it.
async function trackRun({ video, total, pipe, seek, rallies, shotPoses, send, pose, farReader }) {
  const { timing, shots, bounces } = trackShots(await (await fetch("/track")).json());
  for (const bounce of bounces) rallies.onEvent({ type: "bounce", bounce });
  const frames = new Set();
  const farAt = new Set();
  for (const s of shots) {
    for (let f = Math.max(0, Math.floor((s.t - BEFORE_S) * FPS)); f <= Math.min(total - 1, Math.ceil((s.t + AFTER_S) * FPS)); f++) {
      frames.add(f);
      if (s.side === "far") farAt.add(f);
    }
  }
  const readFarEnd = await farReader(farAt.size > 0, { legsHidden: true });
  const order = [...frames].sort((a, b) => a - b);
  let next = 0;
  let done = 0;
  for (const shot of shots) {
    while (next < order.length && order[next] / FPS <= shot.t + AFTER_S) {
      const f = order[next++];
      await seek((f + 0.5) / FPS);
      pipe.process(video, f / FPS);
      if (farAt.has(f)) readFarEnd(f / FPS);
      shotPoses.frame(f / FPS, pipe.players);
      done++;
      await window.__desk({ progress: { done, total: order.length }, t: f / FPS, resumeFrame: 0, resumeT: 0 });
    }
    rallies.onEvent({ type: "shot", shot });
    shotPoses.onEvent({ type: "shot", shot });
    shotPoses.settle();
  }
  log(`track ${timing}: ${shots.length} shots, ${order.length} frames`);
  await send(rallies.finish(0, Math.max(0, total - 1) / FPS));
  await window.__desk({ done: true, delegate: pose.delegate, timing });
}

main().catch((e) => window.__desk({ error: String(e && e.stack ? e.stack : e) }));
