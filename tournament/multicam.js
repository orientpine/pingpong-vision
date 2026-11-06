// In-memory camera membership; callers supply time so expiry is deterministic.
export class Multicam {
  entries = new Map();
  now = 0;

  attach(conn, { id, matchId }, nowMs) {
    this.now = nowMs;
    for (const [key, camera] of this.entries) {
      if (camera.id === id && key !== conn) this.entries.delete(key);
    }
    const previous = this.entries.get(conn);
    if (previous?.id === id && previous.matchId === matchId) {
      previous.touched = nowMs;
      return;
    }
    this.entries.delete(conn);
    this.entries.set(conn, { id, matchId, touched: nowMs, attachedAt: nowMs, statusAt: null, ball: 'lost', active: false, rttMs: null, clockMs: null, near: null, nearAuto: false, hold: false, ask: null });
  }

  detach(conn) {
    return this.entries.delete(conn);
  }

  onCameraHello(conn, { matchId, linked }) {
    const camera = this.entries.get(conn);
    if (camera && (!linked || camera.matchId !== matchId)) this.detach(conn);
  }

  touch(conn, nowMs) {
    this.now = nowMs;
    const camera = this.entries.get(conn);
    if (camera) camera.touched = nowMs;
  }

  status(conn, status, nowMs) {
    this.touch(conn, nowMs);
    const camera = this.entries.get(conn);
    if (camera) Object.assign(camera, status, { statusAt: nowMs });
  }

  sweep(nowMs) {
    this.now = nowMs;
    for (const [conn, camera] of this.entries) {
      if (nowMs - camera.touched > 15000) this.detach(conn);
    }
  }

  // A camera is judging once it has reported running (calibrated and analysing); before its first
  // status it is only loading.
  static running(camera) {
    return camera.statusAt != null && camera.running !== false;
  }

  // The primary is the first attached camera that is judging; while none is, the first attached.
  primaryOf(matchId) {
    let first = null;
    for (const [conn, camera] of this.entries) {
      if (camera.matchId !== matchId) continue;
      if (Multicam.running(camera)) return conn;
      first ??= conn;
    }
    return first;
  }

  isAttached(conn, matchId) {
    return this.entries.get(conn)?.matchId === matchId;
  }

  canWritePoint(cameraId, matchId) {
    const primary = this.primaryOf(matchId);
    return primary === null || this.entries.get(primary).id === cameraId;
  }

  roster() {
    const matches = {};
    for (const [conn, camera] of this.entries) {
      (matches[camera.matchId] ??= []).push({
        id: camera.id.slice(0, 8),
        primary: this.primaryOf(camera.matchId) === conn,
        ball: camera.ball,
        active: camera.active,
        rttMs: camera.rttMs,
        running: Multicam.running(camera),
        near: camera.near,
        nearAuto: camera.nearAuto,
        // 점수 보류: the camera's end check says the two phones' end colours look opposite, so no point of this
        // match is entered by itself (each is asked on the camera) until a person changes a pick
        hold: !!camera.hold,
        // 확인 후 입력: the point waiting on this camera's 누가 땄나요 ({ seq, pre, hold }), or null
        ask: camera.ask ?? null,
        // a camera counts as live once it judges and while its last status is within 15 s, the same time
        // after which its row is dropped: a phone still loading its model or being calibrated is listed but
        // not counted, so 카메라 2대 / 1대 does not flip on every screen; a closed socket removes the row at once
        fresh: Multicam.running(camera) && this.now - camera.statusAt <= 15000,
      });
    }
    return matches;
  }
}
