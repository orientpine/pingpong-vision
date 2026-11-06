// 카메라 판정 비교: the camera's call for each rally next to what the referee entered, read from the lines of
// data/judge-log.jsonl (judge-log.js). Pure: the same lines always give the same table, so the server's
// summary, the CSV on the screen and the tests read one rule. See docs/judge-log.md.
//
// Lines, oldest first (each also has at = server ms and tour = the tournament's createdAt):
//   { t: 'call', id, matchId, index, call: { end, slot, sure, weak, why, reason, shots, bounces }, pre, guess, hold, disagree, rally: { startMs, endMs }, camera, mode }
//   { t: 'drop', id, why }          the camera took its question away unanswered (replaced, let, rally, timeout, fix)
//   { t: 'point', matchId, index, side, end, by }    by: 'camera' | 'camera-fix' | 'referee'; end: its end colour
//   { t: 'undo', matchId, index, side, by }
//   { t: 'flip', matchId, index, side, by }     side: the side after the flip
//   { t: 'clip', matchId, index, clip }
// A call is joined to the point entered at its match and index while it waits. A 'camera-fix' undo and the
// point that puts that index back (the camera phone's hand fix, or 폴트) keep the call that point had.

// The camera's cancel window is 3 s (6 s with a 폴트?/렛? question); an undo from the camera within this
// of entering is that cancel: the camera's call was a fake point.
export const CANCEL_MS = 7000;
// The camera's call can reach the server a moment after a referee screen tapped [확정] on what the camera
// showed: a call this soon after a point at its index with no call is that point's call.
export const LATE_CALL_MS = 10000;

// outcome of one camera call (or of a point with no call):
//   same / different  entered, and the final side (after any later fix) is / is not the camera's call
//   cancelled         a fake point: cancelled right after entry, or the referee said 렛
//   undone            entered, then taken back later (점수 되돌리기)
//   ignored           never entered: replaced by the next call, dropped when the next rally started, or timed out
//   open              still waiting on 누가 땄나요
//   no_call           a point entered with no camera call (카메라 판정 없음): the camera missed it
export const OUTCOMES = ['same', 'different', 'cancelled', 'undone', 'ignored', 'open', 'no_call'];

const keyOf = (matchId, index) => `${matchId}|${index}`;

function blankRow(matchId, no) {
  return { matchId, no, calls: 0, same: 0, different: 0, cancelled: 0, undone: 0, ignored: 0, open: 0, missed: 0, sure: 0, sureSame: 0, sureDifferent: 0, weak: 0, weakGuess: 0, weakOther: 0, weakOut: 0, fixed: 0, msSum: 0, msN: 0 };
}

function addTo(row, p) {
  if (p.outcome === 'no_call') {
    row.missed++;
    return;
  }
  row.calls++;
  row[p.outcome]++;
  if (p.fixes.length && p.outcome !== 'cancelled') row.fixed++;
  if (p.ms != null) { row.msSum += p.ms; row.msN++; }
  if (p.call.sure) {
    row.sure++;
    if (p.outcome === 'same') row.sureSame++;
    if (p.outcome === 'different') row.sureDifferent++;
  }
  if (p.call.weak) {
    row.weak++;
    if (p.outcome === 'same') row.weakGuess++;
    else if (p.outcome === 'different') row.weakOther++;
    else row.weakOut++;
  }
}

// Finished numbers of a row: ratios are null when nothing was decided.
function finish(row) {
  const { msSum, msN, ...rest } = row;
  const decided = row.same + row.different;
  const sureDecided = row.sureSame + row.sureDifferent;
  return {
    ...rest,
    fake: row.cancelled + row.undone,
    agreePct: decided ? Math.round((row.same / decided) * 100) : null,
    surePct: sureDecided ? Math.round((row.sureSame / sureDecided) * 100) : null,
    avgMs: msN ? Math.round(msSum / msN) : null,
  };
}

// lines: parsed judge-log lines of one tournament, oldest first. matches: that tournament's derived matches
// (for the match number). Returns { points, matches, total }: points is one row per camera call or uncalled
// point, oldest first; matches is one row per match with any, in match order.
export function compareJudge(lines, matches = []) {
  const points = [];
  const byId = new Map();
  const open = new Map();
  const played = new Map();
  const stash = new Map();
  const list = (matchId) => {
    if (!played.has(matchId)) played.set(matchId, []);
    return played.get(matchId);
  };
  const undo = (p, by, at) => {
    p.fixes.push({ kind: 'undo', by, at });
    p.finalSide = null;
    p.removed = true;
  };
  const flush = (key) => {
    const s = stash.get(key);
    if (!s) return;
    stash.delete(key);
    undo(s.p, 'camera', s.undoAt);
  };

  for (const line of lines) {
    if (line.t === 'call') {
      const key = keyOf(line.matchId, line.index);
      const p = {
        id: line.id, at: line.at, matchId: line.matchId, index: line.index, call: line.call, pre: line.pre ?? null, guess: line.guess ?? null,
        hold: !!line.hold, disagree: !!line.disagree, rally: line.rally ?? null, camera: line.camera ?? null, mode: line.mode ?? null,
        outcome: 'open', enteredSide: null, finalSide: null, by: null, ms: null, fixes: [], clip: null, dropWhy: null,
      };
      const prev = open.get(key);
      if (prev) {
        prev.outcome = 'ignored';
        prev.dropWhy = 'replaced';
      }
      byId.set(p.id, p);
      points.push(p);
      // a referee screen beat the call to the server: that uncalled point is this call's
      const e = list(line.matchId)[line.index];
      if (e && e.p.outcome === 'no_call' && line.at - e.at <= LATE_CALL_MS) {
        points.splice(points.indexOf(e.p), 1);
        Object.assign(p, { outcome: 'entered', enteredSide: e.side, enteredEnd: e.p.enteredEnd, by: e.by, ms: 0, fixes: e.p.fixes, clip: e.p.clip });
        e.p = p;
        open.delete(key);
      } else open.set(key, p);
    } else if (line.t === 'drop') {
      const p = byId.get(line.id);
      if (!p || p.outcome !== 'open') continue;
      p.outcome = line.why === 'let' ? 'cancelled' : 'ignored';
      p.dropWhy = line.why ?? null;
      if (open.get(keyOf(p.matchId, p.index)) === p) open.delete(keyOf(p.matchId, p.index));
    } else if (line.t === 'point') {
      const key = keyOf(line.matchId, line.index);
      const arr = list(line.matchId);
      const s = stash.get(key);
      if (line.by === 'camera-fix' && s) {
        stash.delete(key);
        if (s.side !== line.side) s.p.fixes.push({ kind: 'flip', by: 'camera', at: line.at });
        arr[line.index] = { p: s.p, side: line.side, end: line.end ?? null, by: s.by, at: s.at };
        continue;
      }
      flush(key);
      const waiting = open.get(key);
      let p;
      if (waiting) {
        open.delete(key);
        p = waiting;
        Object.assign(p, { outcome: 'entered', enteredSide: line.side, enteredEnd: line.end ?? null, by: line.by, ms: Math.max(0, line.at - p.at) });
      } else {
        p = { id: null, at: line.at, matchId: line.matchId, index: line.index, call: null, outcome: 'no_call', enteredSide: line.side, enteredEnd: line.end ?? null, finalSide: null, finalEnd: null, by: line.by, ms: null, fixes: [], clip: null };
        points.push(p);
      }
      arr[line.index] = { p, side: line.side, end: line.end ?? null, by: line.by, at: line.at };
    } else if (line.t === 'undo') {
      const arr = list(line.matchId);
      const e = arr[line.index];
      if (!e) continue;
      arr.length = line.index;
      if (line.by === 'camera-fix') stash.set(keyOf(line.matchId, line.index), { ...e, undoAt: line.at });
      else if (e.p.call && line.by === 'camera' && line.at - e.at <= CANCEL_MS) {
        e.p.outcome = 'cancelled';
        e.p.dropWhy = 'cancel';
        e.p.removed = true;
      } else undo(e.p, line.by, line.at);
    } else if (line.t === 'flip') {
      const e = list(line.matchId)[line.index];
      if (!e || e.side === line.side) continue;
      e.side = line.side;
      // the same rally, played at the same ends: the point moves to the other end colour
      if (e.end !== null && e.end !== undefined) e.end = 1 - e.end;
      e.p.fixes.push({ kind: 'flip', by: line.by, at: line.at });
    } else if (line.t === 'clip') {
      const e = list(line.matchId)[line.index];
      if (e) e.p.clip = line.clip;
    }
  }
  for (const key of [...stash.keys()]) flush(key);
  for (const arr of played.values()) arr.forEach((e, i) => { if (e) { e.p.finalSide = e.side; e.p.finalEnd = e.end ?? null; e.p.index = i; } });
  for (const p of points) {
    if (p.outcome !== 'entered') continue;
    p.outcome = p.removed ? 'undone' : p.finalSide === p.call.slot ? 'same' : 'different';
  }

  const noOf = new Map(matches.map((m) => [m.id, m.no]));
  const rows = new Map();
  const total = blankRow(null, null);
  for (const p of points) {
    // an uncalled point that was taken back again is not a point the camera missed
    if (p.outcome === 'no_call' && p.removed) continue;
    if (!rows.has(p.matchId)) rows.set(p.matchId, blankRow(p.matchId, noOf.get(p.matchId) ?? null));
    addTo(rows.get(p.matchId), p);
    addTo(total, p);
  }
  const order = (a, b) => (a.no ?? Infinity) - (b.no ?? Infinity) || String(a.matchId).localeCompare(String(b.matchId));
  return {
    points: points.map(({ removed, ...p }) => ({ ...p, no: noOf.get(p.matchId) ?? null, undone: !!removed })),
    matches: [...rows.values()].sort(order).map(finish),
    total: finish(total),
  };
}
