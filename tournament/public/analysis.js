// Pure match analysis, shared by server, screens and tests. Criteria are fixed in docs/analytics.md.
// Table coordinates: tx 0..2.74 along the table (near end at 0), ty 0..1.525 left to right as seen
// from the near end (the calibration taps the near left corner first, vision geom.js).

import { L, EN } from './i18n.js';

const TABLE_LENGTH = 2.74;
const TABLE_WIDTH = 1.525;
const NET_TX = TABLE_LENGTH / 2;
const SIDE_DEPTH = TABLE_LENGTH / 2;
const ESTIMATE_BELOW = 0.7;
// success rates and the one-line report need this many points with a decided winner (and of shots per metric)
export const REPORT_MIN_N = 5;

// A stored shot kind or stroke (Korean, as the camera records it) in this screen's language.
const KIND_EN = { 포핸드: 'forehand', 백핸드: 'backhand', 서브: 'serve', 스매시: 'smash', 드라이브: 'drive', 푸시: 'push', 로빙: 'lob', 공격: 'attack', 수비: 'defence' }; // i18n-data: stored Korean kinds
export function kindText(k) {
  if (!EN || typeof k !== 'string') return k;
  return k.replace(/[가-힣]+/g, (w) => KIND_EN[w] ?? w); // i18n-data: matches stored Korean kinds
}

const HANDS = { 포핸드: 'fore', 백핸드: 'back' }; // i18n-data: stored Korean strokes
const TYPES = { 서브: 'serve', 스매시: 'attack', 드라이브: 'attack', 푸시: 'defence', 로빙: 'defence' }; // i18n-data: stored Korean kinds

export const TECH_KEYS = ['fore-attack', 'fore-defence', 'fore-serve', 'back-attack', 'back-defence', 'back-serve'];

const TECH_REPORT = {
  'fore-attack': { label: L('포핸드 공격', 'Forehand attack'), focus: L('포핸드 드라이브를 코스별로 나눠 치는', 'placing forehand drives to different spots') },
  'fore-defence': { label: L('포핸드 수비', 'Forehand defence'), focus: L('포핸드 쪽 공을 낮게 밀어 넘기는', 'pushing balls to your forehand back low') },
  'fore-serve': { label: L('포핸드 서브', 'Forehand serve'), focus: L('포핸드 서브를 원하는 칸에 넣는', 'landing forehand serves in the zone you aim for') },
  'back-attack': { label: L('백핸드 공격', 'Backhand attack'), focus: L('백핸드 드라이브를 몸 앞에서 치는', 'hitting backhand drives in front of your body') },
  'back-defence': { label: L('백핸드 수비', 'Backhand defence'), focus: L('백핸드 쪽 공을 낮게 밀어 넘기는', 'pushing balls to your backhand back low') },
  'back-serve': { label: L('백핸드 서브', 'Backhand serve'), focus: L('백핸드 서브를 원하는 칸에 넣는', 'landing backhand serves in the zone you aim for') },
};

const LENGTH_BUCKETS = [
  { label: L('1~2구', 'Shots 1-2'), upTo: 2, focus: L('서브와 리시브를 짧게 주고받는', 'keeping serve and receive short') },
  { label: L('3~4구', 'Shots 3-4'), upTo: 4, focus: L('서브 다음 공을 바로 공격하는', 'attacking the ball right after the serve') },
  { label: L('5~6구', 'Shots 5-6'), upTo: 6, focus: L('공격 뒤 다음 공까지 이어 가는', 'following an attack through to the next ball') },
  { label: L('7구 이상', 'Shots 7+'), upTo: Infinity, focus: L('긴 랠리에서 자세를 지키며 넘기는', 'holding your form in long rallies') },
];

export function estimateFrom(table) {
  return Object.fromEntries(TECH_KEYS.map((key) => {
    const row = table?.[key];
    return [key, !row || row.precision < ESTIMATE_BELOW || row.recall < ESTIMATE_BELOW];
  }));
}

export const TECH_ESTIMATE = Object.freeze(estimateFrom(null));

const SAMPLE_MIN = 5;

// 'sample' when the measured truth set is too small to quote a number, 'estimate' when precision
// or recall is under the bar, 'measured' otherwise; screens print 표본 부족 for 'sample'.
export function accuracyStatus(table, key) {
  const row = table?.[key];
  if (!row || !(row.n >= SAMPLE_MIN)) return 'sample';
  return row.precision === null || row.precision < ESTIMATE_BELOW || row.recall < ESTIMATE_BELOW ? 'estimate' : 'measured';
}

// null for a rally whose near player is unknown (a desk rally job without a known camera end).
export function slotOfSide(rally, side) {
  if (rally.nearSlot === null) return null;
  return side === 'near' ? rally.nearSlot : 1 - rally.nearSlot;
}

export function techniqueOf(shot) {
  const hand = HANDS[shot.stroke] ?? null;
  const type = TYPES[shot.kind] ?? null;
  return { hand, type, key: hand && type ? `${hand}-${type}` : null };
}

// Null when the shot has no landing on the opponent's half of the table. A landing on the net line
// counts as short for both shooters; a landing exactly on a cell line belongs to the deeper or
// further-right cell.
// A bounce's spot on the sheet's table map (cm): tx along the table, camera side on the left; ty runs from
// the near long edge (0, by the camera) to the far one, so the far edge is drawn on top, as the camera sees it.
export const mapPoint = (b) => ({ x: b.tx * 100, y: (TABLE_WIDTH - b.ty) * 100 });

export function zoneOf(land, shooterSide) {
  if (!land || land.ty < 0 || land.ty > TABLE_WIDTH) return null;
  const near = shooterSide === 'near';
  const depth = near ? land.tx - NET_TX : NET_TX - land.tx;
  if (depth < 0 || depth > SIDE_DEPTH) return null;
  const across = near ? land.ty : TABLE_WIDTH - land.ty;
  return {
    col: Math.min(2, Math.floor(across / (TABLE_WIDTH / 3))),
    row: Math.min(2, Math.floor(depth / (SIDE_DEPTH / 3))),
  };
}

const emptyTech = () => Object.fromEntries(TECH_KEYS.map((key) => [key, { n: 0, ok: 0 }]));
const emptyZones = () => [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

function compareLongest(a, b) {
  return b.shots.length - a.shots.length || b.durationMs - a.durationMs || a.index - b.index;
}

// A bounce belongs to whoever hit the ball last. Before any shot was seen it can only be a serve
// touching the server's own half, so it goes to that half's player.
function bouncesOf(rally) {
  return rally.bounces.filter((b) => b.tx !== null && b.ty !== null).map((b) => {
    const shooter = rally.shots.findLast((s) => s.t <= b.t);
    return { tx: b.tx, ty: b.ty, slot: slotOfSide(rally, shooter ? shooter.side : b.side) };
  });
}

function countSuccess(rally, result) {
  const loser = rally.winner === 'near' ? 'far' : 'near';
  const last = rally.shots.at(-1);
  const failed = last && last.side === loser ? last : null;
  for (const shot of rally.shots) {
    const { key } = techniqueOf(shot);
    if (key === null) continue;
    const cell = result.tech[slotOfSide(rally, shot.side)][key];
    cell.n += 1;
    if (shot !== failed) cell.ok += 1;
  }
}

function countOutcome(rally, result) {
  const won = slotOfSide(rally, rally.winner);
  if (rally.shots.length === 0) return;
  const bucket = result.length[LENGTH_BUCKETS.findIndex((l) => rally.shots.length <= l.upTo)];
  bucket.n += 1;
  bucket.won[won] += 1;
  const serverSlot = slotOfSide(rally, rally.shots[0].side);
  result.serve[serverSlot].n += 1;
  if (serverSlot === won) result.serve[serverSlot].won += 1;
}

function addRally(rally, result) {
  result.bounces.push(...bouncesOf(rally));
  for (const shot of rally.shots) {
    const slot = slotOfSide(rally, shot.side);
    const zone = zoneOf(shot.land, shot.side);
    if (zone) result.zones[slot][zone.row][zone.col] += 1;
    if (techniqueOf(shot).key === null) result.unclassified[slot] += 1;
  }
  if (rally.winner === null) return;
  result.timeline[slotOfSide(rally, rally.winner)].push(rally.index);
  countSuccess(rally, result);
  countOutcome(rally, result);
}

// One rally per point: the desk re-analysis wins over the live camera summary of the same point.
// A rally without source is live.
// Knowing who stood at which end matters most, then the desk's finer analysis over the live one.
const preference = (r) => (r.nearSlot != null ? 2 : 0) + (r.source === 'desk' ? 1 : 0);

export function onePerPoint(rallies, pointsLen) {
  const byIndex = new Map();
  for (const r of rallies) {
    if (r.index >= pointsLen) continue;
    const kept = byIndex.get(r.index);
    // A desk rally that could not tell who stood at which end does not push out a live rally that can.
    if (!kept || preference(r) > preference(kept)) byIndex.set(r.index, r);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

export function analyzeMatch(rallies, { pointsLen = Infinity, clips = {} } = {}) {
  const kept = onePerPoint(rallies, pointsLen);
  const result = {
    n: kept.length,
    bounces: [],
    zones: [emptyZones(), emptyZones()],
    tech: [emptyTech(), emptyTech()],
    unclassified: [0, 0],
    length: LENGTH_BUCKETS.map(({ label }) => ({ label, n: 0, won: [0, 0] })),
    serve: [{ n: 0, won: 0 }, { n: 0, won: 0 }],
    timeline: [[], []],
    // points whose near player is unknown: counted here, in no player's numbers
    unattributed: 0,
  };
  for (const rally of kept) {
    if (rally.nearSlot === null) result.unattributed += 1;
    else addRally(rally, result);
  }
  // points whose winner is known: a success rate counts only shots of these points
  result.decided = result.timeline[0].length + result.timeline[1].length;
  const top5 = kept.toSorted(compareLongest).slice(0, 5).map((r) => ({
    index: r.index,
    shots: r.shots.length,
    durationMs: r.durationMs,
    winner: r.winner === null ? null : slotOfSide(r, r.winner),
    clip: clips[r.index] ?? null,
  }));
  const reportBy = [0, 1].map((slot) => {
    const text = reportLine(result, slot);
    return text === null ? null : { slot, text };
  });
  return { ...result, top5, report: reportBy[0] ?? reportBy[1], reportBy };
}

function metricsOf(analysis, slot) {
  const received = analysis.serve[1 - slot];
  return [
    { ...analysis.serve[slot], name: L('서브 득점률', 'Serve point rate'), focus: L('서브 길이와 코스를 섞는', 'mixing up serve length and placement') },
    { n: received.n, won: received.n - received.won, name: L('리시브 득점률', 'Receive point rate'), focus: L('상대 서브를 낮고 짧게 받아 넘기는', 'returning the opponent\'s serve low and short') },
    ...TECH_KEYS.map((key) => ({
      n: analysis.tech[slot][key].n,
      won: analysis.tech[slot][key].ok,
      name: L(`${TECH_REPORT[key].label} 성공률`, `${TECH_REPORT[key].label} success rate`),
      focus: TECH_REPORT[key].focus,
    })),
    ...analysis.length.map((bucket, i) => ({
      n: bucket.n,
      won: bucket.won[slot],
      name: L(`${bucket.label} 랠리 승률`, `${bucket.label} rally win rate`),
      focus: LENGTH_BUCKETS[i].focus,
    })),
  ];
}

// The weakest rate among metrics with enough shots; on a tie the earlier metric in metricsOf stays.
// It is called the lowest only when another metric is higher; when all are equal there is no weakest.
export function reportLine(analysis, slot) {
  // a shot count can look large while only a few points have a winner: too few of those, say so instead
  if (analysis.n === 0) return null;
  if ((analysis.decided ?? Infinity) < REPORT_MIN_N) {
    return L(`아직 득점이 정해진 포인트가 적어요(${analysis.decided}개).`, `Few points have a decided winner yet (${analysis.decided}).`);
  }
  const enough = metricsOf(analysis, slot).filter((m) => m.n >= REPORT_MIN_N);
  const rate = (m) => m.won / m.n;
  const weakest = enough.reduce((low, m) => (low === null || rate(m) < rate(low) ? m : low), null);
  if (weakest === null) return null;
  const percent = Math.round((weakest.won / weakest.n) * 100);
  if (!enough.some((m) => rate(m) > rate(weakest))) {
    if (rate(weakest) === 1) {
      const most = enough.reduce((top, m) => (m.n > top.n ? m : top));
      return L(`${most.name}이 ${most.n}번 중 ${most.won}번 모두 성공했어요. 아직 약점이 안 보여요.`, `${most.name}: all ${most.won} of ${most.n}. No weak spot shows yet.`);
    }
    return L(`${weakest.name}이 ${percent}%(${weakest.n}번 중 ${weakest.won}번)예요. 다음에는 ${weakest.focus} 연습을 해 보세요.`, `${weakest.name} is ${percent}% (${weakest.won} of ${weakest.n}); next time practise ${weakest.focus}.`);
  }
  return L(
    `${weakest.name}이 ${percent}%(${weakest.n}번 중 ${weakest.won}번)로 가장 낮으니 다음에는 ${weakest.focus} 연습을 해 보세요.`,
    `${weakest.name} is lowest at ${percent}% (${weakest.won} of ${weakest.n}), so next time practise ${weakest.focus}.`,
  );
}
