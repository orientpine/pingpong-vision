// One rally's shot summary for the tournament's analysis sheet (docs/tournament-link.md, 분석 기록).
// rallyEnd's shotList keeps only side, t and inferred, so the full shots (stroke, kind, speed, arc)
// are gathered here from the pipeline's shot / shotUpdate events. Nothing is computed beyond what
// rally.js already made: the phone sends no body pose (the analysis desk makes that later).

// The shot's landing: the first bounce on the receiver's side after the hit and before the next
// hit (a bounce after the return belongs to the return). Null when it was not seen or not placed.
function landOf(shot, next, bounces) {
  const receiver = shot.side === "near" ? "far" : "near";
  const until = next ? next.t : Infinity;
  const b = bounces.find((x) => x.side === receiver && x.t > shot.t && x.t < until);
  return b && Number.isFinite(b.tx) && Number.isFinite(b.ty) ? { tx: b.tx, ty: b.ty } : null;
}

export class RallyShots {
  constructor() {
    // live references to rally.js's shot objects: a shotUpdate fills the same object in later
    this.shots = [];
  }

  onEvent(e) {
    if (e.type === "rallyStart") this.shots = [];
    else if ((e.type === "shot" || e.type === "shotUpdate") && !this.shots.includes(e.shot)) this.shots.push(e.shot);
  }

  // Taken at rallyEnd, before the next rallyStart clears the list. nearSlot is the tournament player
  // standing at the near end during this rally (tour.slotOf("near") read before the point is written,
  // since the point may change ends).
  draft(e, nearSlot) {
    const shots = [...this.shots].sort((a, b) => a.t - b.t);
    const durationMs = Math.round(e.durationS * 1000);
    return {
      startedAt: Date.now() - durationMs,
      durationMs,
      nearSlot,
      why: e.why,
      shots: shots.map((s, i) => ({
        side: s.side,
        t: s.t,
        stroke: s.stroke ?? null,
        kind: s.kind ?? null,
        speedKmh: s.speedKmh ?? null,
        arc: s.arc ?? null,
        inferred: !!s.inferred,
        land: landOf(s, shots[i + 1], e.bounces),
      })),
      bounces: e.bounces.map((b) => ({ tx: b.tx, ty: b.ty, side: b.side, t: b.t })),
    };
  }
}

// The record for the point the tournament entered ({ matchId, index, side: player slot }). The
// winner comes from the entered point, so a side tapped by hand on an unsure call counts too.
export function rallyRecord(draft, point) {
  return { v: 1, index: point.index, source: "live", ...draft, winner: point.side === draft.nearSlot ? "near" : "far" };
}
