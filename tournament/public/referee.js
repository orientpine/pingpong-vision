export const MIN_TAP_GAP_MS = 400;
export const UNDO_HOLD_MS = 600;

export function acceptTap(lastAcceptedAt, now, gap = MIN_TAP_GAP_MS) {
  return lastAcceptedAt === null || now - lastAcceptedAt >= gap;
}

// After a hold fires undo the screen re-renders under the finger, so the release click can land
// on a new control (e.g. the handicap +/- row). Swallow the click of the press that fired the hold.
export function isHoldRelease(pressedAt, holdFiredAt) {
  return holdFiredAt !== null && pressedAt <= holdFiredAt;
}

export function sideOrder(flip) {
  return flip ? [1, 0] : [0, 1];
}

// Card colour is the table end the player stands at now (0 = blue end, 1 = red end), not the player:
// the ends stay put and the players move (match.ends = [slot at blue end, slot at red end]).
export function endOf(m, slot) {
  return m.ends ? (m.ends[0] === slot ? 0 : 1) : slot;
}

// Player slots in screen order: the blue end first, swapped by the viewer's own left/right flip.
export function endOrder(m, flip) {
  const ends = m.ends ?? [0, 1];
  return flip ? [ends[1], ends[0]] : [ends[0], ends[1]];
}

export function endsChanged(prev, next) {
  return !!(prev?.ends && next?.ends && prev.id === next.id && prev.ends[0] !== next.ends[0]);
}

export function detectTransition(prev, next) {
  if (!prev?.score || !next?.score || prev.id !== next.id) return null;
  const { games, won, winner } = next.score;
  if (next.status === 'done' && prev.status !== 'done') {
    return { type: 'match', matchId: next.id, winner, won, game: games[games.length - 1] };
  }
  if (games.length > prev.score.games.length) {
    return { type: 'game', matchId: next.id, gameNo: games.length, won, game: games[games.length - 1] };
  }
  return null;
}
