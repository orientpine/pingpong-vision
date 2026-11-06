import { L } from './i18n.js';

export const ROLES = ['camera', 'referee', 'viewer', 'desk'];
export const ROLE_NAMES = { camera: L('카메라', 'Camera'), referee: L('심판', 'Referee'), viewer: L('관전', 'Viewer'), desk: L('분석 데스크', 'Analysis desk') };
// The mode bar on a 360 px phone has room for three characters a button.
export const ROLE_SHORT = { camera: L('카메라', 'Camera'), referee: L('심판', 'Referee'), viewer: L('관전', 'Viewer'), desk: L('데스크', 'Desk') };

// Only cameras still reporting count: a row whose status went quiet is not a second camera.
export function cameraMode(list) {
  const count = list.filter((c) => c.fresh !== false).length;
  return count ? { count, merged: count >= 2, label: count >= 2 ? L('카메라 2대 합치기', 'Merge 2 cameras') : L('카메라 1대', '1 camera') } : null;
}

// 점수 보류: the match's judging camera says the two phones' end colours look opposite, so it enters no point
// by itself (each is asked on the camera) until a person fixes a pick on either phone.
export const HOLD_TEXT = L('점수 보류 · 끝 색 확인', 'Scoring paused · check end colours');
export function cameraHold(list) {
  return list.some((c) => c.primary && c.hold);
}

// Number all live cameras before grouping by fixed table end; unknown ends still keep their number.
export function cameraEnds(list) {
  const cameras = list.filter((c) => c.fresh).sort((a, b) => Number(b.primary) - Number(a.primary));
  return [0, 1].map((end) => cameras.flatMap((c, i) => c.near === end ? [i + 1] : []));
}

// Every device picks its role once, a PIN device too: a phone can hold the PIN and still be the camera.
export function initialRole(stored) {
  return ROLES.includes(stored) ? stored : null;
}

// The camera this screen should talk about: one filming now beats one waiting for its PIN, which
// beats one that was linked and has gone quiet. A camera that never linked and left is forgotten.
export function cameraStatus(cameras) {
  const list = cameras ?? [];
  const live = list.find((c) => c.online && c.linked);
  if (live) return { kind: 'linked', camera: live };
  const waiting = list.find((c) => c.online);
  if (waiting) return { kind: 'waiting', camera: waiting };
  const lost = list.find((c) => c.linked);
  if (lost) return { kind: 'offline', camera: lost };
  return { kind: 'none', camera: null };
}

// Sound on a viewer screen: browsers speak only after a tap on the page, and only one screen
// (the last one to turn sound on) reads the score so two never talk over each other.
export function soundState({ on, unlocked, conn, speaker }) {
  if (!on) return 'off';
  if (!unlocked) return 'needTap';
  return speaker && speaker === conn ? 'on' : speaker ? 'elsewhere' : 'claiming';
}

// A viewer on a big screen (TV, pad) gets the scoreboard layout; phones keep the normal screen.
export function viewerLayout(role, width, height) {
  if (role !== 'viewer') return null;
  if (width >= 1000 && width >= height) return 'wide';
  // a phone turned sideways (393 high) keeps the phone screen; the tall scoreboard needs a pad's height
  return width >= 700 && height >= 600 ? 'tall' : null;
}
