// Camera devices (the vision app at /vision/ on this same origin), as every screen sees them.
//
// A camera says hello over the WebSocket with a public id (sha256 of a secret it keeps on the phone)
// and whether it is linked to the tournament. It writes scores only with the tournament PIN, like
// 심판; the old referee approval
// (approve, claim, camera token) is gone.
export const ID_RE = /^[0-9a-f]{64}$/;
export const STALE_MS = 12_000;

export function presenceOf(cameras, now = Date.now()) {
  return [...cameras.entries()].map(([id, c]) => ({
    id,
    online: c.online && now - c.lastSeen < STALE_MS,
    mode: c.mode,
    matchId: c.matchId,
    linked: !!c.linked,
    lastSeen: c.lastSeen,
  }));
}
