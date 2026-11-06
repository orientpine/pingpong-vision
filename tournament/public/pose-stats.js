// Pure pose statistics, shared by server, screens and tests: a person's shots with pose, the average
// skeleton per technique and reference time, its numbers, and two periods side by side.
// Rules: docs/analytics.md, 자세 비교. Names only: nothing returned here carries a player's four digits.
import { L } from './i18n.js';
import { onePerPoint, slotOfSide, techniqueOf } from './analysis.js';
import { resolveKey, rosterKeys } from './person.js';
import { galleryDate, tournamentDate } from './trends.js';

// Joint rows in the order the desk stores them: the nose, then MediaPipe's 11..32.
const SHOULDER = [1, 2];
const ELBOW = [3, 4];
const WRIST = [5, 6];
const HIP = [13, 14];
const KNEE = [15, 16];
const ANKLE = [17, 18];

const MIN_VISIBLE = 0.5;
export const MIN_SHOTS = 5;
export const AT = [-0.77, -0.4, 0];
const HIT = AT.indexOf(0);
const METRICS = ['elbowDeg', 'kneeBendDeg', 'trunkRotationDeg', 'handHeight'];
const PERIOD = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DEGREES = 180 / Math.PI;

const coords = (row) => row.slice(0, -1);
const visible = (row) => row.at(-1) >= MIN_VISIBLE;
const middle = (a, b) => a.map((v, i) => (v + b[i]) / 2);
const minus = (a, b) => a.map((v, i) => v - b[i]);
const length = (a) => Math.hypot(...a);

// Turns a 3D frame about the vertical (y) so the hip line runs along +x: a body seen from either end
// of the table, or from another camera, then faces the same way.
function squareHips(frame) {
  const [x, , z] = minus(coords(frame[HIP[1]]), coords(frame[HIP[0]]));
  const turn = Math.atan2(z, x);
  const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
  return frame.map(([px, py, pz, v]) => [px * cos + pz * sin, py, pz * cos - px * sin, v]);
}

// Hips at the origin and a torso of 1, whatever the frame's scale and place; 3D also with square hips.
// null when the torso is not seen, since nothing in the frame can then be measured.
function normalized(frame) {
  const torso = [...SHOULDER, ...HIP].map((i) => frame[i]);
  if (!torso.every(visible)) return null;
  const hip = middle(coords(frame[HIP[0]]), coords(frame[HIP[1]]));
  const shoulder = middle(coords(frame[SHOULDER[0]]), coords(frame[SHOULDER[1]]));
  const unit = length(minus(shoulder, hip));
  if (unit === 0) return null;
  const rows = frame.map((row) => [...minus(coords(row), hip).map((v) => v / unit), row.at(-1)]);
  return hip.length === 3 ? squareHips(rows) : rows;
}

// frames: rows [x,y,v] or [x,y,z,v] x 23, or null. Each joint averages only the frames that saw it.
// n: frames that counted. joints[i]: its average, null if never seen. counts[i]: frames behind it.
export function averageSkeleton(frames) {
  const kept = frames.filter(Boolean).map(normalized).filter(Boolean);
  const rows = kept[0]?.map((_, i) => kept.map((frame) => frame[i]).filter(visible)) ?? [];
  const mean = (seen) => coords(seen[0]).map((_, axis) => seen.reduce((sum, row) => sum + row[axis], 0) / seen.length);
  return { n: kept.length, joints: rows.map((seen) => (seen.length ? mean(seen) : null)), counts: rows.map((seen) => seen.length) };
}

function angleDeg(u, v) {
  const lengths = length(u) * length(v);
  if (lengths === 0) return null;
  const cosine = u.reduce((sum, value, i) => sum + value * v[i], 0) / lengths;
  return Math.acos(Math.max(-1, Math.min(1, cosine))) * DEGREES;
}

const angleAt = (a, joint, b) => (a && joint && b ? angleDeg(minus(a, joint), minus(b, joint)) : null);

function kneeBendDeg(joints) {
  const bends = [0, 1]
    .map((leg) => angleAt(joints[HIP[leg]], joints[KNEE[leg]], joints[ANKLE[leg]]))
    .filter((angle) => angle !== null)
    .map((angle) => 180 - angle);
  return bends.length ? bends.reduce((sum, v) => sum + v, 0) / bends.length : null;
}

function trunkRotationDeg(joints) {
  const [ls, rs, lh, rh] = [...SHOULDER, ...HIP].map((i) => joints[i]);
  return ls && rs && lh && rh ? angleDeg(minus(rs, ls), minus(rh, lh)) : null;
}

// y grows downward in both the image and the world landmarks, so above the hips is positive.
function handHeight(joints, side) {
  const [lh, rh, wrist] = [joints[HIP[0]], joints[HIP[1]], joints[WRIST[side]]];
  return lh && rh && wrist ? middle(lh, rh)[1] - wrist[1] : null;
}

// Numbers of one skeleton. Any number whose joints are missing is null. hand: 'R', 'L', or null when
// the racket hand is unknown, which leaves the racket-arm numbers (elbowDeg, handHeight) null.
// elbowDeg: 180 is a straight arm. kneeBendDeg: 0 is a straight leg, the mean of the legs seen.
// handHeight: torso lengths above the hips.
export function metrics({ joints }, hand = 'R') {
  const side = { L: 0, R: 1 }[hand] ?? null;
  return {
    elbowDeg: side === null ? null : angleAt(joints[SHOULDER[side]], joints[ELBOW[side]], joints[WRIST[side]]),
    kneeBendDeg: kneeBendDeg(joints),
    trunkRotationDeg: trunkRotationDeg(joints),
    handHeight: side === null ? null : handHeight(joints, side),
  };
}

// 'YYYY-MM' or 'YYYY-MM-DD..YYYY-MM-DD' -> { from, to } as inclusive KST dates; null when malformed.
export function parsePeriod(text) {
  if (MONTH.test(text ?? '')) return { from: `${text}-01`, to: `${text}-31` };
  const m = text?.match(PERIOD);
  return m && m[1] <= m[2] ? { from: m[1], to: m[2] } : null;
}

// File name stems under data/analysis/pose/. The match id comes from a request, so it cannot leave the folder.
export const galleryPoseKey = (id) => `g-${id}`;

export function tournamentPoseKey(createdAt, matchId) {
  const digits = String(createdAt ?? '').replace(/\D/g, '');
  return digits ? `t-${digits}-${encodeURIComponent(matchId).replaceAll('.', '%2E')}` : null;
}

function shotSamples({ rallies, slot, date, pose }) {
  if (pose === null) return [];
  return rallies.filter((r) => r.source === 'desk').flatMap((rally) => rally.shots.flatMap((shot, i) => {
    const posed = pose[rally.index]?.[i];
    const { key } = techniqueOf(shot);
    if (!posed || key === null || slotOfSide(rally, shot.side) !== slot) return [];
    return [{ date, tech: key, side: shot.side, hand: posed.pose2d.hand, vote: posed.pose2d.vote ?? null, frames2d: posed.pose2d.frames, frames3d: posed.pose3d.frames }];
  }));
}

function tournamentRows(entry, target, { aliases, ralliesOf }) {
  const key = tournamentPoseKey(entry.tournament.createdAt, '');
  if (key === null) return [];
  const keys = rosterKeys(entry.tournament).map((k) => resolveKey(k, aliases));
  return entry.derived.matches.flatMap((m) => {
    const slot = m.players.findIndex((p) => keys[p] === target);
    if (slot < 0 || m.score === null || m.points.length === 0) return [];
    const rallies = ralliesOf(entry.tournament, m.id);
    return [{ rallies: onePerPoint(rallies, Infinity), slot, date: tournamentDate(entry, rallies), key: tournamentPoseKey(entry.tournament.createdAt, m.id) }];
  });
}

function galleryRows(doc, target, aliases) {
  const keys = [doc.players.near, doc.players.far].map((k) => (k ? resolveKey(k, aliases) : null));
  const slot = keys.indexOf(target);
  return slot < 0 ? [] : [{ rallies: onePerPoint(doc.rallies, Infinity), slot, date: galleryDate(doc.playedAt), key: galleryPoseKey(doc.id) }];
}

function personRows(person, { tournaments, gallery, aliases, ralliesOf }) {
  const target = resolveKey(person, aliases);
  return [
    ...tournaments.flatMap((entry) => tournamentRows(entry, target, { aliases, ralliesOf })),
    ...gallery.flatMap((doc) => galleryRows(doc, target, aliases)),
  ];
}

// Every shot of a person with pose: [{ date, tech, side, hand, frames2d, frames3d }]. A desk rally
// whose near player is unknown (nearSlot null) gives none: see unattributedRallies.
// sources: as in trends.js, plus poseOf(matchKey) -> { [rally]: { [shot]: pose } } or null.
export function personSamples(person, sources) {
  return personRows(person, sources).flatMap((row) => shotSamples({ ...row, pose: sources.poseOf(row.key) }));
}

// Desk rallies in the person's matches that belong to nobody because the near player is unknown.
export function unattributedRallies(person, sources) {
  return personRows(person, sources).reduce((sum, row) => sum + row.rallies.filter((r) => r.source === 'desk' && r.nearSlot === null).length, 0);
}

// The picture is mirrored between the two ends: a player at the far end looks the other way.
const mirrored = (frame) => frame && frame.map(([x, y, v]) => [-x, y, v]);

const usual = (values) => [...Map.groupBy(values, (v) => v).entries()].toSorted((a, b) => b[1].length - a[1].length)[0]?.[0];

// A joint seen in too few shots says nothing either, so it is left out of the numbers.
const trusted = (skeleton) => ({ ...skeleton, joints: skeleton.joints.map((joint, i) => (skeleton.counts[i] >= MIN_SHOTS ? joint : null)) });

// A point clip's desk job has one or two shots, too few to tell the racket hand (hand null), so the shots'
// own votes are counted over all of the person's shots: the majority with at least MIN_HAND_VOTES votes,
// else null (a tie too). Shots saved before votes count as none.
export const MIN_HAND_VOTES = 5;
export function votedHand(person) {
  const votes = person.map((s) => s.vote).filter((v) => v === 'R' || v === 'L');
  const left = votes.filter((v) => v === 'L').length;
  const right = votes.length - left;
  return votes.length < MIN_HAND_VOTES || left === right ? null : left > right ? 'L' : 'R';
}

function periodView(samples, period, fallbackHand = null) {
  // an unknown hand stays unknown: the racket-arm numbers are left out, never measured on a guess
  const hand = usual(samples.map((s) => s.hand).filter((h) => h !== null)) ?? fallbackHand;
  const d2 = AT.map((_, i) => averageSkeleton(samples.map((s) => (s.side === 'far' ? mirrored(s.frames2d[i]) : s.frames2d[i]))));
  const d3 = AT.map((_, i) => averageSkeleton(samples.map((s) => s.frames3d[i])));
  const numbers = (list) => list.map((skeleton) => metrics(trusted(skeleton), hand));
  return { period, n: d2[HIT].n, hand, skeletons: { d2, d3 }, metrics: { d2: numbers(d2), d3: numbers(d3) } };
}

const difference = (a, b) => Object.fromEntries(METRICS.map((key) => [key, a[key] === null || b[key] === null ? null : b[key] - a[key]]));

// person: personSamples(...). key: a technique key. Periods: { from, to }. diffs are B minus A, per
// reference time, or null with a reason when a period has fewer than MIN_SHOTS shots at the hit.
export function comparePeriods(person, key, periodA, periodB) {
  const voted = votedHand(person);
  const view = (period) => periodView(person.filter((s) => s.tech === key && s.date !== null && s.date >= period.from && s.date <= period.to), period, voted);
  const [a, b] = [view(periodA), view(periodB)];
  const comparable = Math.min(a.n, b.n) >= MIN_SHOTS;
  return {
    tech: key,
    at: AT,
    a,
    b,
    diffs: comparable ? Object.fromEntries(['d2', 'd3'].map((d) => [d, AT.map((_, i) => difference(a.metrics[d][i], b.metrics[d][i]))])) : null,
    reason: comparable ? null : L(`기간마다 샷이 ${MIN_SHOTS}개 이상 있어야 비교해요 (A ${a.n}개, B ${b.n}개).`, `Each period needs at least ${MIN_SHOTS} shots to compare (A ${a.n}, B ${b.n}).`),
  };
}
