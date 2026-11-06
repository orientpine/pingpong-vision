import { EN, L, LANG, LANGS, LOCALE, errorText, setLang } from '/i18n.js';
import { FORMAT_LIVES, FORMAT_NAMES, LEAGUE_RULE, MAX_PLAYERS, MIN_PLAYERS, NAME_MAX, PLAYER_CODE_EXAMPLE, TRIPLE_RULE, labelText, parsePlayerEntry } from '/engine.js';
import { matchPlayers } from '/player-search.js';
import { UNDO_HOLD_MS, acceptTap, detectTransition, endOf, endOrder, endsChanged, isHoldRelease } from '/referee.js';
import { drawStartWord, drawTitle, drawVersion, playRally } from '/start.js';
import { HOLD_TEXT, ROLES, ROLE_NAMES, ROLE_SHORT, cameraEnds, cameraHold, cameraMode, cameraStatus, initialRole, soundState, viewerLayout } from '/role.js';
import { analysisHandlers, analysisKey, analysisView, bindAnalysis, closeAnalysis, syncAnalysis } from '/analysis-view.js';
import { bindJudge, closeJudge, judgeHandlers, judgeKey, judgeView, syncJudge } from '/judge-view.js';
import { bindPlayer, closePlayer, peopleSection, playerHandlers, playerKey, playerView, syncPlayer, topOverlay } from '/player-view.js';
import { bindDesk, deskHandlers, deskView } from '/desk-view.js';
import { bindPeoplePick } from '/people-pick.js';

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');
const $modal = document.getElementById('modal');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PATHS = {
  undo: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  swap: '<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  shuffle: '<path d="m18 14 4 4-4 4"/><path d="m18 2 4 4-4 4"/><path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22"/><path d="M2 6h1.972a4 4 0 0 1 3.6 2.2"/><path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  settings: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  bracket: '<rect x="2" y="3" width="7" height="5" rx="1"/><rect x="2" y="16" width="7" height="5" rx="1"/><rect x="15" y="9.5" width="7" height="5" rx="1"/><path d="M9 5.5h3v13H9"/><path d="M12 12h3"/>',
  chart: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  paddle: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/><circle cx="19.5" cy="4.5" r="2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  minus: '<path d="M5 12h14"/>',
  expand: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
  star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  sound: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  mute: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
  desk: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
};
const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;

const S = {
  state: null,
  tab: localStorage.getItem('pp-tab') || 'match',
  selected: null,
  pin: localStorage.getItem('pp-pin'),
  conn: 'connecting',
  busy: false,
  flip: localStorage.getItem('pp-flip') === '1',
  setup: null,
  setupMode: null,
  people: [],
  pendingRender: false,
  ref: false,
  refNotice: null,
  endNotice: null,
  lastTap: null,
  pressedAt: 0,
  holdFiredAt: null,
  history: null,
  histFav: false,
  histOpen: null,
  clip: null,
  role: initialRole(localStorage.getItem('pp-role')),
  // A reload on 모드 고르기 (a language choice reloads the page) stays there: the history entry says so.
  pickRole: new URLSearchParams(location.search).has('role') || history.state?.pick === true,
  start: false,
  connId: null,
  cameras: [],
  cameraMatches: null,
  speaker: null,
  sound: localStorage.getItem('pp-sound') === '1',
  soundUnlocked: false,
};

// The camera role is the vision app on this same origin: a device that chose it opens there, and
// a one-time setup link (#setup=…) on the one address goes to the camera screen that trades it.
// Coming back here with the browser's back button from the camera is leaving the camera: show the
// mode choice instead of sending the device straight back to it.
const cameFromBack = performance.getEntriesByType?.('navigation')[0]?.type === 'back_forward';
// A new visit opens on the start screen. A reload in the same visit resumes the remembered mode, so a
// camera or a scoreboard that restarts mid-match needs no taps; back onto the root is the way out.
const query = new URLSearchParams(location.search);
S.start = !location.hash.startsWith('#setup=') && !S.pickRole && (query.has('start') || cameFromBack || sessionStorage.getItem('pp-started') !== '1');
if (location.hash.startsWith('#setup=')) location.replace('/vision/' + location.hash);
else if (S.role === 'camera' && !S.pickRole && !S.start) location.replace('/vision/');

const T = () => S.state?.tournament ?? null;
const D = () => S.state?.derived ?? null;
const isAdmin = () => Boolean(S.role === 'referee' && S.pin && T());
const nameOf = (p) => (p === null ? null : T().players[p]);
const started = (t) => Object.values(t.log).some((e) => e.points.length > 0);
// Screens stack like any app: each screen is a browser history entry holding what it shows, so the
// back button at the top left and the browser's own back do the same thing.
const viewOf = () => ({ base: history.state?.base ?? 0, start: S.start, tab: S.tab, ref: S.ref, pick: S.pickRole, setup: S.setupMode, hist: S.histOpen?.summary.id ?? null, an: analysisKey(), pl: playerKey(), jg: judgeKey(), depth: history.state?.depth ?? 0 });
history.replaceState(viewOf(), '');
let rootGuard = false;
// On click, not pointerdown: a history push inside pointerdown cancels the click in WebKit.
addEventListener('click', () => {
  if (rootGuard || S.pickRole || S.start) return;
  rootGuard = true;
  const view = viewOf();
  history.replaceState({ ppRoot: true }, '');
  history.pushState(view, '');
}, { capture: true });

function go(change) {
  change();
  history.pushState({ ...viewOf(), depth: (history.state?.depth ?? 0) + 1 }, '');
  render();
  window.scrollTo(0, 0);
}

function stay(change, url) {
  change();
  history.replaceState(viewOf(), '', url);
  render();
  window.scrollTo(0, 0);
}

function leaveRef() {
  S.ref = false;
  S.refNotice = null;
  screen.orientation?.unlock?.();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// The screen above this one, for a screen opened straight from a link or a reload.
function goUp() {
  if (S.ref) return stay(leaveRef);
  if (topOverlay() === 'player') return stay(closePlayer);
  if (analysisKey()) return stay(closeAnalysis);
  if (judgeKey()) return stay(closeJudge);
  if (S.histOpen) return stay(() => { S.histOpen = null; });
  if (S.setupMode && T()) return stay(() => { S.setup = null; S.setupMode = null; });
  if (S.pickRole) {
    if (S.role === 'camera') { location.assign('/vision/'); return; }
    return stay(() => { S.pickRole = false; }, location.pathname);
  }
  if (T() && S.tab !== 'match') return stay(() => { S.tab = 'match'; localStorage.setItem('pp-tab', S.tab); });
  toPicker();
}

// The mode choice is the top of the app: whatever led here, it sits on the app's first history
// entry, so the browser's back from it leaves the app instead of reopening an earlier screen.
let pickAfterPop = false;
const baseDepth = () => history.state?.base ?? 0;
function toPicker() {
  const depth = (history.state?.depth ?? 0) - baseDepth();
  if (depth > 0) { pickAfterPop = true; history.go(-depth); return; }
  stay(() => { S.pickRole = true; });
}

// 다시 보기 plays over the whole screen (the clip is the camera screen, so its text needs the room):
// a big close, the app's back and the browser's back all close it; it stops on the last frame with
// 다시 보기 to play again. It lives outside $app so re-renders leave it alone.
// A clip saved with its overlay track (the camera's picture plus the HUD as data) plays in the camera
// app's replay page, which draws that HUD over the picture with the camera screen's own code, folds
// 선수·코트 and turns the overlay off. An older clip (HUD already in the picture, no track) plays as before.
// That page gets the whole screen (embed=1) and draws its own ‹, ✕ 닫기 and 다시 보기 where its layout keeps
// room for them; it says "close" when one is pressed. It starts a second before the serve (처음부터 plays the
// 3 s before it). The plain video keeps this page's buttons.
let replayEl = null;
const replayPage = (clip) => `${clip.replace(/\/s\/[^/]+$/, '')}/replay.html?clip=${encodeURIComponent(clip)}&embed=1`;
function openReplay(src) {
  closeReplay(false);
  const clip = src.replace(/\/video$/, '');
  const el = document.createElement('div');
  replayEl = el;
  el.className = 'replay-full';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', L('랠리 다시 보기', 'Rally replay'));
  el.innerHTML = `<div class="replay-full__media"></div>
    <button class="replay-full__back" data-replay="close" aria-label="${L('뒤로, 다시 보기 닫기', 'Back, close replay')}">${icon('back')}</button>
    <button class="replay-full__close" data-replay="close" aria-label="${L('다시 보기 닫기', 'Close replay')}">✕ ${L('닫기', 'Close')}</button>
    <button class="btn replay-full__again" data-replay="again" hidden>${L('다시 보기', 'Replay')}</button>`;
  const slot = el.querySelector('.replay-full__media');
  const again = el.querySelector('.replay-full__again');
  let media = null;
  const show = (withTrack) => {
    if (replayEl !== el) return;
    if (withTrack) {
      media = document.createElement('iframe');
      media.className = 'replay-full__frame';
      media.title = L('랠리 다시 보기', 'Rally replay');
      media.allow = 'autoplay; fullscreen';
      media.src = replayPage(clip);
      el.dataset.media = 'frame';
    } else {
      media = document.createElement('video');
      Object.assign(media, { src, playsInline: true, muted: true, autoplay: true, preload: 'auto' });
      media.addEventListener('ended', () => { again.hidden = false; });
    }
    slot.replaceChildren(media);
    if (media.play) media.play().catch(() => {});
    else media.focus();
  };
  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-replay]')?.dataset.replay;
    if (act === 'close') closeReplay(true);
    if (act !== 'again' || !media) return;
    again.hidden = true;
    if (media.tagName === 'VIDEO') { media.currentTime = 0; media.play().catch(() => {}); }
    else media.contentWindow?.postMessage({ type: 'ppv-replay', cmd: 'again' }, location.origin);
  });
  el.replayEnded = () => { again.hidden = false; };
  document.body.append(el);
  history.pushState({ ...history.state, replayFull: 1 }, '');
  el.querySelector('.replay-full__close').focus();
  fetch(`${clip}/overlay`, { method: 'HEAD', cache: 'no-store' }).then((r) => show(r.ok), () => show(false));
}
function closeReplay(stepBack) {
  if (!replayEl) return;
  replayEl.querySelector('video')?.pause();
  replayEl.remove();
  replayEl = null;
  if (stepBack && history.state?.replayFull) history.back();
}
addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.type !== 'ppv-replay' || !replayEl) return;
  if (replayEl.querySelector('iframe')?.contentWindow !== e.source) return;
  if (e.data.event === 'ended') replayEl.replayEnded();
  if (e.data.event === 'close') closeReplay(true);
});
addEventListener('popstate', (e) => {
  if (!replayEl) return;
  closeReplay(false);
  e.stopImmediatePropagation();
}, { capture: true });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && replayEl) closeReplay(true); });

addEventListener('popstate', (e) => {
  if (e.state?.ppRoot) {
    if (S.pickRole) history.back();
    else {
      goUp();
      if (!S.pickRole) { history.pushState(viewOf(), ''); }
    }
    return;
  }
  const v = pickAfterPop && e.state ? { ...e.state, pick: true } : e.state;
  if (!v || !('tab' in v)) return;
  if ($modal.open) $modal.close();
  if (document.activeElement && $app.contains(document.activeElement)) document.activeElement.blur();
  if (S.ref && !v.ref) leaveRef();
  S.ref = Boolean(v.ref && T());
  S.tab = v.tab;
  localStorage.setItem('pp-tab', S.tab);
  S.pickRole = v.pick;
  S.start = Boolean(v.start);
  if (v.setup !== S.setupMode) {
    S.setup = null;
    S.setupMode = v.setup && T() ? v.setup : null;
  }
  if (!v.hist) S.histOpen = null;
  else if (S.histOpen?.summary.id !== v.hist) openHistory(v.hist).then(render).catch((err) => toast(err.message, 'err'));
  syncAnalysis(v.an ?? null);
  syncJudge(v.jg ?? null);
  syncPlayer(v.pl ?? null);
  if (S.tab === 'history') loadHistory().catch((err) => toast(err.message, 'err'));
  if (pickAfterPop) { pickAfterPop = false; history.replaceState(viewOf(), ''); }
  if (S.role === 'camera' && !S.pickRole && !S.start) { location.replace('/vision/'); return; }
  render();
  window.scrollTo(0, 0);
});

// A page kept by the browser and shown again with back, after the camera was chosen here.
addEventListener('pageshow', (e) => {
  if (e.persisted && S.role === 'camera' && !S.pickRole && !S.start) stay(() => { S.pickRole = true; });
});

function ask(text, yes, danger = false) {
  return new Promise((resolve) => {
    $modal.innerHTML = `<div class="card" role="alertdialog" aria-label="${esc(text)}"><p class="ask-text">${esc(text)}</p>
      <div class="row"><button type="button" class="btn ghost grow" data-ask="0">${L('취소', 'Cancel')}</button><button type="button" class="btn ${danger ? 'danger' : 'primary'} grow" data-ask="1">${esc(yes)}</button></div></div>`;
    let answer = false;
    $modal.addEventListener('close', () => resolve(answer), { once: true });
    for (const b of $modal.querySelectorAll('[data-ask]')) {
      b.addEventListener('click', () => { answer = b.dataset.ask === '1'; $modal.close(); });
    }
    $modal.showModal();
  });
}
const endName = (m, slot) => (endOf(m, slot) === 0 ? L('블루', 'Blue') : L('레드', 'Red'));
const hcTag = (m, side) => (m.handicap?.[side] > 0 ? `<span class="hc" title="${L('핸디캡 시작 점수', 'Handicap start score')}">+${m.handicap[side]}</span>` : '');

// at: a box to sit on instead of the default spot above the bottom tabs (the camera-count toast takes the
// top row's title so it covers no score digit or button)
function toast(msg, kind = '', at = null) {
  $toast.textContent = msg;
  $toast.className = `show ${kind}`;
  $toast.style.cssText = at ? `left:${at.left}px;top:${at.top}px;width:${at.width}px;height:${at.height}px;bottom:auto;max-width:none;transform:none;display:flex;align-items:center;justify-content:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis` : '';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $toast.className = ''; }, 2600);
}

function applyState(state) {
  if (!state) return;
  if (S.state && state.rev < S.state.rev) return;
  if (S.ref && S.state?.derived && state.derived) trackRefNotice(S.state.derived, state.derived);
  if (S.state?.derived && state.derived) noticeEndChange(S.state, state);
  S.state = state;
  render();
}

// Every screen says when the players change ends (automatically by the rules, or a hand fix).
function noticeEndChange(prevState, nextState) {
  const prev = pickMatch(prevState.derived);
  const next = prev && nextState.derived.matches.find((x) => x.id === prev.id);
  if (!endsChanged(prev, next)) return;
  const who = (end) => esc(nextState.tournament.players[next.players[next.ends[end]]] ?? '');
  // in the page flow (above the cards, the TV scores, the referee title), so it covers nothing
  const notice = { matchId: next.id, text: L(`엔드 교체 · 블루 ${who(0)} · 레드 ${who(1)}`, `Change ends · Blue ${who(0)} · Red ${who(1)}`) };
  S.endNotice = notice;
  setTimeout(() => {
    if (S.endNotice !== notice) return;
    S.endNotice = null;
    render();
  }, END_NOTICE_MS);
}

const END_NOTICE_MS = 4000;
const endNoticeText = (m) => (S.endNotice && m && S.endNotice.matchId === m.id ? S.endNotice.text : '');
const endNoticeHtml = (m, cls) => (endNoticeText(m) ? `<div class="${cls}" role="status" data-end-notice>${icon('swap')}<span>${endNoticeText(m)}</span></div>` : '');

function trackRefNotice(prevDerived, nextDerived) {
  const prev = pickMatch(prevDerived);
  const next = prev && nextDerived.matches.find((x) => x.id === prev.id);
  const tr = detectTransition(prev, next);
  if (tr) { S.refNotice = tr; return; }
  const n = S.refNotice;
  const cur = n && nextDerived.matches.find((x) => x.id === n.matchId);
  if (cur?.score && (n.type === 'match' ? cur.status !== 'done' : cur.score.games.length < n.gameNo)) S.refNotice = null;
}

function setPin(pin) {
  S.pin = pin;
  if (pin) localStorage.setItem('pp-pin', pin);
  else localStorage.removeItem('pp-pin');
}

async function api(path, body, { pin = true, method = 'POST' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (pin && S.pin) headers['x-pin'] = S.pin;
  const res = await fetch(path, { method, headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (data.state) applyState(data.state);
  if (res.status === 403 && pin) {
    setPin(null);
    render();
    openPinSettings(L('PIN이 바뀌었거나 맞지 않습니다. 다시 입력해 주세요.', 'The PIN changed or is wrong. Please enter it again.'));
  }
  if (!res.ok) throw new Error(errorText(data, L('요청을 처리하지 못했습니다.', 'Could not process the request.')));
  return data;
}

// Every long list folds: a head with its name and count, remembered per device. Over 10 rows a list
// shows 5 (the latest, or the ones the list says) until 전체 n개 보기. Value: 'closed', 'all' or absent.
function foldStore() {
  try { return JSON.parse(localStorage.getItem('pp-fold')) || {}; } catch { return {}; }
}
function foldSet(key, value) {
  const all = foldStore();
  if (value) all[key] = value;
  else delete all[key];
  localStorage.setItem('pp-fold', JSON.stringify(all));
}
function foldHead(key, label, count) {
  const open = foldStore()[key] !== 'closed';
  return `<button type="button" class="fold-head" data-act="fold" data-key="${key}" aria-expanded="${open}"><span class="fold-name">${label}</span><span class="fold-count">${count}</span>${icon(open ? 'up' : 'down')}</button>`;
}
// rows: one HTML string per row. start: first row of the short window. few: its name in the button.
function foldRows(key, rows, { start = 0, few = L('최근', 'latest'), limit = true } = {}) {
  const state = foldStore()[key];
  if (state === 'closed') return '';
  const long = limit && rows.length > 10;
  const from = Math.max(0, Math.min(start, rows.length - 5));
  const shown = long && state !== 'all' ? rows.slice(from, from + 5) : rows;
  const more = long ? `<button type="button" class="btn ghost fold-more" data-act="fold-all" data-key="${key}">${state === 'all' ? L(`${few} 5개만 보기`, `Show ${few} 5 only`) : L(`전체 ${rows.length}개 보기`, `Show all ${rows.length}`)}</button>` : '';
  return shown.join('') + more;
}
// A match list opens on the latest match that has started, not on the first of the tournament.
function matchWindow(ms) {
  const last = ms.findLastIndex((m) => m.status !== 'pending');
  return last < 0 ? 0 : last - 4;
}

// Redraws the page and puts focus back on the list's head, for a keyboard or TV remote.
function refold(key) {
  document.activeElement?.blur();
  render();
  document.querySelector(`[data-act="fold"][data-key="${key}"]`)?.focus({ preventScroll: true });
}

function isTyping() {
  const el = document.activeElement;
  return el && $app.contains(el) && el.tagName === 'INPUT';
}

function playClip(video) {
  video.play().catch((e) => {
    if (!(e instanceof DOMException) || !['NotAllowedError', 'NotSupportedError', 'AbortError'].includes(e.name)) throw e;
  });
}

function render() {
  if (isTyping()) { S.pendingRender = true; return; }
  S.pendingRender = false;
  if (S.start) {
    delete document.body.dataset.role;
    if (!$app.querySelector('.start')) { $app.innerHTML = startView(S.titleShown); S.titleShown = true; drawTitle($app.querySelector('.start-logo')); drawStartWord($app.querySelector('.start-word')); playRally($app.querySelector('.start-rally')); }
    const ver = $app.querySelector('.start-ver'), v = S.state?.version ? `V ${S.state.version}` : '';
    if (ver.dataset.v !== v) { ver.dataset.v = v; ver.setAttribute('aria-label', v); drawVersion(ver.querySelector('canvas'), v, getComputedStyle(ver).color); }
    return;
  }
  if (!S.state) return;
  const t = T();
  const inSetup = S.role === 'referee' && (!t || S.setupMode);
  if (S.role) document.body.dataset.role = S.role;
  else delete document.body.dataset.role;
  if (S.pickRole) {
    $app.innerHTML = roleView();
    return;
  }
  if (S.ref && !inSetup) {
    $app.innerHTML = refView();
    document.body.dataset.busy = S.busy ? '1' : '';
    syncWakeLock();
    return;
  }
  const views = { match: S.role === 'desk' ? deskView : matchView, bracket: bracketView, standings: standingsView, history: historyView, settings: settingsView };
  const tv = t && !inSetup && S.tab === 'match' && !topOverlay() && !judgeKey() ? viewerLayout(S.role, innerWidth, innerHeight) : null;
  S.tvLayout = tv;
  if (tv) document.body.dataset.tv = tv;
  else delete document.body.dataset.tv;
  const body = tv ? '' : inSetup ? setupView() : !t ? roleAsk() + `<p class="hint empty">${L('대회가 시작되기를 기다려요. 첫 대회는 심판 모드에서 만들 수 있어요.', 'Waiting for a tournament to start. The first one is created in Referee mode.')}</p>` : topOverlay() === 'player' ? playerView() : analysisKey() ? analysisView({ current: { tournament: t, derived: D() }, record: S.histOpen }) : judgeKey() ? judgeView({ rev: S.state.rev, tournament: t }) : roleAsk() + (views[S.tab] ?? matchView)();
  const video = $app.querySelector('[data-clip-video]');
  const hud = $app.querySelector('[data-clip-hud]');
  const previous = [...$app.children];
  const template = document.createElement('template');
  template.innerHTML = tv ? tvView(tv) : header() + `<main class="main">${body}</main>` + (inSetup ? '' : nav());
  const nextVideo = template.content.querySelector('[data-clip-video]');
  const nextHud = template.content.querySelector('[data-clip-hud]');
  $app.append(template.content);
  if (video && nextVideo && video.getAttribute('src') === nextVideo.getAttribute('src')) {
    const playing = !video.paused;
    // the overlay canvas over that clip stays too (keyed by the clip, like the video)
    if (hud && nextHud) nextHud.replaceWith(hud);
    if (nextVideo.parentNode.moveBefore) {
      // Preserve playback on browsers supporting state-preserving DOM moves.
      nextVideo.parentNode.moveBefore(video, nextVideo);
      nextVideo.remove();
    } else {
      // Reuse the media element on browsers without moveBefore.
      nextVideo.replaceWith(video);
      if (playing) playClip(video);
    }
  } else if (nextVideo) {
    playClip(nextVideo);
  }
  previous.forEach((node) => node.remove());
  syncClipOverlay();
  document.body.dataset.busy = S.busy ? '1' : '';
  syncWakeLock();
}

// The small clip boxes (TV 방금 포인트, the phone's clip card) draw the clip's overlay track on a canvas
// over the video in this page: name tags, joints, trail, LOCK and the record strip, with the camera app's
// own drawing code (/vision/js/clip-overlay.js). One drawer per clip, kept while that video stays.
// (function declarations and var: render() runs while this module is still loading)
function clipHud() { return '<canvas class="clip-hud" data-clip-hud aria-hidden="true" hidden></canvas>'; }
var clipOverlay = null;
var clipOverlayModule = null;
function syncClipOverlay() {
  const video = $app.querySelector('[data-clip-video]');
  const canvas = video && $app.querySelector('[data-clip-hud]');
  if (clipOverlay && clipOverlay.video === video && clipOverlay.canvas === canvas) return;
  clipOverlay?.stop();
  clipOverlay = null;
  if (!video || !canvas) return;
  const clip = video.getAttribute('src').replace(/\/video$/, '');
  clipOverlayModule ??= import(`${clip.replace(/\/s\/[^/]+$/, '')}/js/clip-overlay.js`).catch((err) => { console.warn('clip overlay', err); clipOverlayModule = null; return null; });
  const holder = { video, canvas, stopped: false, drawer: null, stop() { this.stopped = true; this.drawer?.stop(); } };
  clipOverlay = holder;
  clipOverlayModule.then((mod) => {
    if (!mod || holder.stopped) return;
    holder.drawer = new mod.ClipOverlay(video, canvas, clip);
  });
}

const SCREEN_NAMES = { match: L('경기', 'Match'), bracket: L('대진', 'Bracket'), standings: L('순위', 'Standings'), history: L('기록', 'History'), settings: L('설정', 'Settings') };

function screenName() {
  if (!T()) return S.role === 'referee' ? L('새 대회', 'Setup') : L('대회 대기', 'Waiting');
  if (S.setupMode === 'new') return L('새 대회', 'Setup');
  if (S.setupMode === 'edit') return L('대진·방식 변경', 'Edit bracket');
  if (topOverlay() === 'player') return L('선수', 'Player');
  if (analysisKey()) return L('경기 분석', 'Match analysis');
  if (judgeKey()) return L('판정 비교', 'Camera calls');
  if (S.role === 'desk' && S.tab === 'match') return L('분석 데스크', 'Analysis desk');
  if (S.tab === 'history' && S.histOpen) return L('대회 기록', 'Tournament');
  return SCREEN_NAMES[S.tab] ?? L('경기', 'Match');
}

const backButton = (cls = 'back') => `<button class="${cls}" data-act="back" data-back data-back-destination="${(history.state?.depth ?? 0) > 0 ? 'previous' : S.ref ? 'match' : topOverlay() === 'player' ? (analysisKey() ? 'analysis' : S.tab) : analysisKey() ? (S.histOpen ? 'history' : 'match') : judgeKey() ? 'match' : S.histOpen ? 'history' : S.setupMode && T() ? 'settings' : T() && S.tab !== 'match' ? 'match' : 'picker'}" aria-label="${L('뒤로', 'Back')}">${icon('back')}</button>`;

function header() {
  const t = T();
  const admin = isAdmin();
  const connText = { online: L('실시간 연결됨', 'Live'), offline: L('연결 끊김 - 재연결 중', 'Offline - reconnecting'), connecting: L('연결 중', 'Connecting') }[S.conn];
  return `<header class="top">
    ${backButton()}
    <div class="top-title"><b data-screen-name>${screenName()}</b><small><span class="dot ${S.conn}" title="${connText}" aria-label="${connText}"></span>${esc(labelText(t?.name) || 'PINGPONG VISION')}</small></div>
    ${t ? `<span class="chip ${admin || (S.role === 'desk' && S.pin) ? 'on' : ''}">${icon(S.role === 'viewer' ? 'eye' : admin || (S.role === 'desk' && S.pin) ? 'unlock' : 'lock')}${S.role === 'viewer' ? L('관전 · 보기 전용', 'Viewer · view only') : S.role === 'desk' ? (S.pin ? L('올리기 가능', 'Can upload') : L('PIN 필요', 'PIN needed')) : admin ? L('기록 가능', 'Can score') : L('보기 전용', 'View only')}</span>` : ''}
    ${roleBar()}
  </header>`;
}

const ROLE_ICONS = { camera: 'camera', referee: 'paddle', viewer: 'eye', desk: 'desk' };
const ROLE_HINTS = {
  get camera() { return S.pin ? L('탁구대를 찍어 점수를 자동으로 넣어요', 'Films the table and scores automatically') : L('탁구대를 찍어 점수를 자동으로 넣어요 (PIN 필요)', 'Films the table and scores automatically (PIN needed)'); },
  get referee() { return S.pin ? L('점수를 넣고 고쳐요', 'Enter and fix scores') : L('점수를 넣고 고쳐요 (PIN 필요)', 'Enter and fix scores (PIN needed)'); },
  viewer: L('점수를 보고 랠리를 다시 봐요 (보기만)', 'Watch scores and rally replays (view only)'),
  get desk() { return S.pin ? L('영상을 올려 기술과 자세를 분석해요', 'Upload video to analyse strokes and form') : L('영상을 올려 기술과 자세를 분석해요 (PIN 필요)', 'Upload video to analyse strokes and form (PIN needed)'); },
};

// Always on top: which job this device does, one tap to switch.
function roleBar() {
  return `<nav class="roles ${S.role ? '' : 'ask'}" aria-label="${L('이 기기 역할', 'This device\'s role')}">${ROLES.map((r) => `<button class="${S.role === r ? 'on' : ''}" data-act="role" data-role="${r}" aria-pressed="${S.role === r}">${icon(ROLE_ICONS[r])}${ROLE_SHORT[r]}</button>`).join('')}</nav>`;
}

// A device that has not chosen yet still sees the match (old links keep working), with the choice on top.
function roleAsk() {
  if (S.role) return '';
  return `<p class="role-ask" role="status">${icon('up')}<span>${L('이 기기는 무엇을 할까요? 위에서 <b>카메라</b> · <b>심판</b> · <b>관전</b> · <b>데스크</b> 중 하나를 눌러 주세요.', 'What will this device do? Tap <b>Camera</b> · <b>Referee</b> · <b>Viewer</b> · <b>Desk</b> above.')}</span></p>`;
}

// The title slams in on the first start screen of a page load; coming back to it later in the visit is calm.
function startView(calm) {
  return `<main class="start${calm ? ' calm' : ''}"><h1 class="start-logo" data-screen-name aria-label="PINGPONG VISION"><b hidden>PINGPONG VISION</b><canvas class="start-halo"></canvas><canvas class="start-ribbon"></canvas><span class="ln"><canvas></canvas><i></i></span><span class="ln"><canvas></canvas><i></i></span></h1>
    <canvas class="start-rally" aria-hidden="true"></canvas>
    <div class="start-stage" aria-hidden="true"></div>
    <p class="start-press" aria-hidden="true">PRESS START</p>
    <button class="start-go" data-act="start" aria-label="${L('시작하기(START)', 'Start')}"><span class="start-face"><canvas class="start-word" aria-hidden="true"></canvas></span></button>
    <p class="start-ver" role="img"><canvas></canvas></p></main>`;
}

function roleView() {
  return `<header class="top"><img class="top-logo" src="/icon.svg" alt="" width="44" height="44"><div class="top-title"><b data-screen-name>${L('모드 고르기', 'Choose mode')}</b><small>${esc(labelText(T()?.name) || 'PINGPONG VISION')}</small></div></header>
    <main class="main role-pick"><div class="lang-row">${icon('globe')}${langSeg()}</div><h1 class="h1">${L('이 기기는 무엇을 할까요?', 'What will this device do?')}</h1>
    <p class="hint">${L('기기에 기억해요. 왼쪽 위 ←로 돌아와 언제든 바꿀 수 있어요.', 'This device remembers it. Come back with ← at the top left to change it any time.')}</p>
    ${ROLES.map((r) => `<button class="role-card" data-act="role" data-role="${r}">${icon(ROLE_ICONS[r])}<b>${ROLE_NAMES[r]}</b><span>${ROLE_HINTS[r]}</span></button>`).join('')}
  </main>`;
}

// The language choice, on 모드 고르기 and in 설정: each name in its own language, so a visitor finds theirs
// whichever language is on. lang="ko" marks the one Korean word an English screen keeps on purpose.
function langSeg() {
  const name = { ko: '한국어', en: 'English' }; // i18n-data: each language's own name
  return `<div class="seg lang-seg" role="radiogroup" aria-label="${L('언어', 'Language')}">${LANGS.map((l) => `<button type="button" role="radio" aria-checked="${l === LANG}" class="seg-btn ${l === LANG ? 'on' : ''}" data-act="lang" data-lang="${l}" lang="${l}"><b>${name[l]}</b></button>`).join('')}</div>`;
}

function speak(text) {
  const synth = globalThis.speechSynthesis;
  if (!synth || !text || typeof SpeechSynthesisUtterance === 'undefined') return false;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = EN ? 'en-US' : 'ko-KR';
  const voice = synth.getVoices().find((v) => (v.lang || '').toLowerCase().startsWith(LANG));
  if (voice) u.voice = voice;
  u.rate = 1.05;
  synth.speak(u);
  return true;
}

function sendWs(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Called inside a tap: browsers allow speech only after one.
function unlockSound() {
  if (!S.soundUnlocked) S.soundUnlocked = speak(' ');
  syncSpeaker();
}

function syncSpeaker() {
  const want = S.role === 'viewer' && S.sound && S.soundUnlocked;
  const mine = S.speaker && S.speaker === S.connId;
  if (want && !mine) sendWs({ type: 'speaker', on: true });
  if (!want && mine) sendWs({ type: 'speaker', on: false });
}

function soundCard() {
  if (S.role !== 'viewer') return '';
  const st = soundState({ on: S.sound, unlocked: S.soundUnlocked, conn: S.connId, speaker: S.speaker });
  const text = {
    off: L('소리 꺼짐', 'Sound off'),
    needTap: L('소리를 켜려면 화면을 한 번 눌러 주세요', 'Tap the screen once to turn sound on'),
    claiming: L('소리 켜는 중', 'Turning sound on'),
    on: L('이 화면이 점수를 읽어요', 'This screen calls the score'),
    elsewhere: L('다른 화면에서 소리가 나요', 'Sound plays on another screen'),
  }[st];
  const btn = st === 'off' || st === 'needTap' ? ['sound-on', 'sound', L('소리 켜기', 'Sound on')] : st === 'elsewhere' ? ['sound-on', 'sound', L('여기서 듣기', 'Play here')] : ['sound-off', 'mute', L('소리 끄기', 'Sound off')];
  return `<div class="vcard sound ${st}" data-sound="${st}" role="status">${icon(st === 'on' ? 'sound' : 'mute')}<span>${text}</span><button class="btn" data-act="${btn[0]}">${icon(btn[1])}${btn[2]}</button></div>`;
}

// Viewer on a TV or pad: both scores big enough to read from across the hall, the latest point's
// clip beside (wide) or under (tall) them, and almost no controls (a viewer rarely touches it).
function tvView(layout) {
  const t = T();
  const d = D();
  const m = pickMatch(d);
  const top = `<header class="tv-top">${backButton()}<span class="dot ${S.conn}" aria-label="${S.conn === 'online' ? L('실시간 연결됨', 'Live') : L('연결 끊김 - 재연결 중', 'Offline - reconnecting')}"></span>
    <b class="tv-title">${esc(labelText(t.name))}</b><span class="tv-match"><span data-screen-name>${L('점수판', 'Scoreboard')}</span>${m ? ` · ${L(`${m.no}경기`, `Match ${m.no}`)} · ${esc(labelText(m.label))}` : ''}</span>
    <span class="tv-role">${icon('eye')}${L(`${ROLE_NAMES.viewer} 모드`, `${ROLE_NAMES.viewer} mode`)}</span></header>`;
  if (!m) return `<div class="tv tv-${layout}">${top}<main class="tv-main tv-done">${championCard(d)}</main></div>`;
  const s = m.score;
  const [first, second] = endOrder(m, S.flip);
  const side = (i) => {
    const value = m.status === 'done' ? s.won[i] : i === 0 ? s.current.a : s.current.b;
    const serving = s.server === i && m.status !== 'done';
    let tag = '';
    if (s.matchPoint === i) tag = `<span class="tag mp">${L('매치 포인트', 'Match point')}</span>`;
    else if (s.gamePoint === i) tag = `<span class="tag">${L('게임 포인트', 'Game point')}</span>`;
    const result = m.status === 'done' ? (s.winner === i ? 'won' : 'lost') : '';
    return `<section class="tv-side side${endOf(m, i)} ${result}" aria-label="${endName(m, i)} ${esc(nameOf(m.players[i]))} ${L(`${value}점`, `${value} ${value === 1 ? 'point' : 'points'}`)}">
      <div class="tv-name"><span class="player-name">${esc(nameOf(m.players[i]))}${hcTag(m, i)}</span>${endTag(m, i)}</div>
      <div class="tv-score">${value}</div>
      <div class="tv-foot"><span class="tv-games">${L('게임', 'Games')} <b>${s.won[i]}</b></span>${serving ? `<span class="serve tv-serve"><i class="ball"></i>${L('서브', 'Serve')}</span>` : ''}${result === 'won' ? `<span class="serve tv-serve">${icon('trophy')}${L('승리', 'Wins')}</span>` : ''}${tag}</div>
    </section>`;
  };
  const games = s.games.map((g, i) => `<span class="g">${L(`${i + 1}게임`, `G${i + 1}`)} ${g.a}:${g.b}</span>`).join('');
  const live = m.status === 'ready' || m.status === 'live';
  const strip = `<div class="tv-strip">${games}${live ? `<span class="g">${L(`${s.gameNo}게임 진행`, `Game ${s.gameNo} live`)}</span>` : ''}${live && s.deuce ? `<span class="g deuce">${L('듀스', 'Deuce')}</span>` : ''}<span class="g">${L(`${t.bestOf}판 ${s.need}선승`, `Best of ${t.bestOf}`)}</span></div>`;
  const banner = m.status === 'done'
    ? `<div class="tv-banner">${icon('trophy')}${L(`${esc(nameOf(m.winnerPlayer))} 승리`, `${esc(nameOf(m.winnerPlayer))} wins`)} · ${Math.max(...s.won)}:${Math.min(...s.won)}</div>`
    : s.lastGame ? `<div class="tv-banner">${L(`${s.lastGame.no}게임 ${esc(nameOf(m.players[s.lastGame.winner]))} 승리`, `Game ${s.lastGame.no}: ${esc(nameOf(m.players[s.lastGame.winner]))} wins`)} · ${s.lastGame.a}:${s.lastGame.b}</div>` : '';
  const clips = clipState(m);
  const clip = clips
    ? `<section class="tv-clip"><h2>${clipTitle(m)}</h2>
        <video data-clip-video src="${esc(m.clips[S.clip.index])}/video" muted playsinline loop preload="metadata"></video>${clipHud()}${latestButton()}</section>`
    : `<section class="tv-clip tv-clip-empty"><h2>${L('방금 포인트', 'Last point')}</h2><div class="tv-clip-wait">${L('포인트가 끝나면 그 장면이 여기 떠요', 'When a point ends, its replay shows here')}</div></section>`;
  const next = d.matches.find((x) => x.status !== 'done' && x.id !== m.id);
  const nextLine = next ? `<p class="tv-next">${L(`다음 · ${next.no}경기`, `Next · Match ${next.no}`)} <b>${vsText(next)}</b></p>` : '';
  return `<div class="tv tv-${layout} ${S.clip?.pinned && S.clip.matchId === m.id ? 'tv-replay' : ''}">${top}
    <main class="tv-main"><div class="tv-scores">${endNoticeHtml(m, 'tv-end')}${side(first)}${side(second)}</div>
      <aside class="tv-panel">${banner}${strip}${clip}${rallyList(m)}${layout === 'wide' ? nextLine : ''}<div class="tv-cards">${cameraCard(m)}${soundCard()}</div></aside></main></div>`;
}

function cameraCard(m) {
  const { kind, camera } = cameraStatus(S.cameras);
  return kind === 'none' ? '' : cameraLine(m, kind, camera);
}

function endTag(m, side) {
  const end = endOf(m, side);
  const camera = cameraEnds(S.cameraMatches?.[m.id] ?? [])[end][0];
  return `<span class="end-tag end-${end}">${L(`${endName(m, side)} 끝`, `${endName(m, side)} end`)}${camera ? ` · ${L(`카메라${camera} 쪽`, `Camera ${camera} side`)}` : ''}</span>`;
}

function cameraLine(m, kind, camera) {
  const where = (id) => {
    const x = D().matches.find((y) => y.id === id);
    return x ? L(`${x.no}경기`, `Match ${x.no}`) : L('경기 고르는 중', 'choosing a match');
  };
  if (kind === 'waiting') {
    return `<div class="vcard cam waiting" data-camera="waiting" role="status">${icon('camera')}<span>${L('카메라가 켜져 있어요 · 카메라에서 대회 PIN을 넣어야 점수가 기록돼요', 'A camera is on · enter the tournament PIN on it to record scores')}</span></div>`;
  }
  if (kind === 'offline') {
    return `<div class="vcard cam offline" data-camera="offline" role="status">${icon('camera')}<span>${L('카메라 연결 끊김 · 다시 연결되면 저절로 이어져요', 'Camera disconnected · it resumes by itself when it reconnects')}</span></div>`;
  }
  const other = m && camera.matchId && camera.matchId !== m.id;
  const live = camera.mode === 'running' ? L('촬영 중', 'recording') : L('켜짐', 'on');
  // 카메라 여러 대: how many PIN cameras film this match ("카메라 1대" / "카메라 2대 합치기")
  const mode = cameraMode(S.cameraMatches?.[m?.id] ?? []);
  const ends = cameraEnds(S.cameraMatches?.[m?.id] ?? []);
  const labels = ends.map((numbers, end) => numbers.length ? numbers.map((n) => L(`카메라${n}`, `Camera ${n}`)).join(' · ') : end === 0 ? L('블루', 'Blue') : L('레드', 'Red'));
  const map = ends.some((numbers) => numbers.length)
    ? `<div class="camera-map" role="img" aria-label="${L(`탁구대 · 블루 끝 ${labels[0]} · 레드 끝 ${labels[1]}`, `Table · Blue end ${labels[0]} · Red end ${labels[1]}`)}"><span class="end-0">${labels[0]}</span><span class="end-1">${labels[1]}</span></div>` : '';
  const hold = cameraHold(S.cameraMatches?.[m?.id] ?? []);
  return `<div class="vcard cam linked ${other ? 'other' : ''} ${map ? 'has-map' : ''} ${hold ? 'hold' : ''}" data-camera="linked" ${hold ? 'data-hold' : ''} role="status">${icon('camera')}<span>${hold ? `<b>${HOLD_TEXT}</b> · ` : ''}${mode ? mode.label : L('카메라 연결됨', 'Camera linked')} · ${where(camera.matchId)} ${live}${other ? L(' (다른 경기)', ' (other match)') : ''}</span>${isAdmin() && camera.approved ? `<button class="btn ghost" data-act="camera-revoke" data-id="${camera.id}">${L('승인 취소', 'Revoke')}</button>` : ''}${map}</div>`;
}

function nav() {
  const tabs = [S.role === 'desk' ? ['match', L('데스크', 'Desk'), 'desk'] : ['match', L('경기', 'Match'), 'paddle'], ['bracket', L('대진', 'Bracket'), 'bracket'], ['standings', L('순위', 'Standings'), 'chart'], ['history', L('기록', 'History'), 'history'], ['settings', L('설정', 'Settings'), 'settings']];
  return `<nav class="nav">${tabs.map(([id, label, ic]) => `<button class="${S.tab === id ? 'on' : ''}" data-act="tab" data-tab="${id}" aria-current="${S.tab === id ? 'page' : 'false'}">${icon(ic)}${label}</button>`).join('')}</nav>`;
}

function seg(key, options, value) {
  return `<div class="seg" role="radiogroup" style="grid-template-columns: repeat(${options.length}, minmax(0, 1fr))">${options.map(([v, label, sub, disabled]) => {
    const on = String(v) === String(value);
    return `<button type="button" role="radio" aria-checked="${on}" class="seg-btn ${on ? 'on' : ''}" data-act="draft-set" data-key="${key}" data-val="${v}" ${disabled ? 'disabled' : ''}><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</button>`;
  }).join('')}</div>`;
}

function formatHint(format, n) {
  if (format === 'league') return L(`모든 참가자가 한 번씩 붙습니다. ${n}명이면 ${(n * (n - 1)) / 2}경기입니다. 순위: ${LEAGUE_RULE}.`, `Every player meets every other once. ${n} players play ${(n * (n - 1)) / 2} matches. Standings: ${LEAGUE_RULE}.`);
  if (n === 2 && format !== 'league') {
    const lives = FORMAT_LIVES[format];
    return L(`두 사람이 계속 맞붙어 먼저 ${lives}패 한 쪽이 탈락합니다(최대 ${2 * lives - 1}경기).`, `The two players meet again and again; the first to ${lives} losses is out (up to ${2 * lives - 1} matches).`);
  }
  if (format === 'triple') return TRIPLE_RULE.join(' ');
  if (n === 4) return L('첫 경기는 1번 vs 4번, 2번 vs 3번 시드입니다.', 'First matches: seed 1 vs 4 and seed 2 vs 3.');
  const byes = 2 ** Math.ceil(Math.log2(n)) - n;
  return `${byes ? L(`상위 ${byes}명(1~${byes}번 시드)은 1라운드 부전승입니다. `, `The top ${byes} (seeds 1-${byes}) get a round 1 bye. `) : ''}${L('두 번 지면 탈락하고, 결승에서 패자조 쪽이 이기면 리셋 경기를 합니다.', 'Two losses and you are out; if the losers bracket side wins the final, a reset match is played.')}`;
}

function ensureDraft() {
  if (!S.setup) {
    const t = T();
    S.setup = t && S.setupMode === 'edit'
      ? { name: t.name, players: [...t.players], format: t.format, bestOf: t.bestOf }
      : { name: '', players: ['', '', '', ''], format: 'double', bestOf: 3 };
    loadPeople();
  }
  return S.setup;
}

// Registered '이름,네자리' people for the name dropdown, only on a device holding the PIN.
function loadPeople() {
  S.people = [];
  if (!S.pin || !T()) return;
  api('/api/players', undefined, { method: 'GET' }).then((r) => { S.people = r.players; }).catch((err) => toast(err.message, 'err'));
}

// A setup edit of a tournament made before player codes keeps plain names.
const codesWanted = () => !(S.setupMode === 'edit' && T() && !S.state.playerCodes);

// The message under a seed field as it is typed: empty until something is typed, and for a name
// already on the roster being edited (it keeps its code).
function seedError(text) {
  if (!String(text).trim() || !codesWanted()) return '';
  if (S.setupMode === 'edit' && T()?.players.includes(String(text).normalize('NFKC').trim())) return '';
  const p = parsePlayerEntry(text);
  return 'error' in p ? errorText(p, p.error) : '';
}

// While the dropdown offers people the message waits; it comes back once the list closes.
function checkSeed(input) {
  const i = input.dataset.draft.slice(1);
  const err = document.getElementById(`seed-list-${i}`).hidden ? seedError(input.value) : '';
  document.getElementById(`seed-err-${i}`).textContent = err;
  if (err) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

function showPeople(input) {
  const i = input.dataset.draft.slice(1);
  const list = document.getElementById(`seed-list-${i}`);
  const rows = document.activeElement === input ? matchPlayers(S.people, input.value) : [];
  list.innerHTML = rows.map((p, k) => `<li role="option" id="seed-opt-${i}-${k}" class="seed-opt" data-act="person-pick" data-i="${i}" data-entry="${esc(p.entry)}" aria-selected="false"><span>${esc(p.name)}</span><span class="seed-code">${esc(p.code)}</span></li>`).join('');
  list.hidden = !rows.length;
  input.setAttribute('aria-expanded', String(rows.length > 0));
  input.removeAttribute('aria-activedescendant');
}

function setupView() {
  const d = ensureDraft();
  const editing = S.setupMode === 'edit';
  const replacing = S.setupMode === 'new' && T();
  const coded = codesWanted();
  return `<section class="card">
    <h1 class="h1">${editing ? L('대진·방식 변경', 'Edit bracket') : L('새 대회 만들기', 'New tournament')}</h1>
    ${replacing ? `<p class="warn">${L('새 대회를 만들면 지금 대회 기록은 서버에 보관되고 화면에서 사라집니다.', 'A new tournament archives the current one on the server and clears it from the screen.')} ${S.state?.pinFixed ? L('PIN은 지금과 같습니다.', 'The PIN stays the same.') : L('PIN도 새로 발급됩니다.', 'A new PIN is issued too.')}</p>` : ''}
    ${editing ? '' : `<label class="field"><span>${L('대회 이름', 'Tournament name')}</span><input data-draft="name" value="${esc(d.name)}" placeholder="${L('예: 10월 탁구 대회', 'e.g. October Ping Pong Cup')}" maxlength="40" autocomplete="off"></label>`}
    <div class="field">${foldHead('seeds', L('참가자 · 위에서부터 시드 순서', 'Players · seed order from the top'), L(`${d.players.length}명`, `${d.players.length} players`))}
      ${foldStore().seeds === 'closed' ? '' : `<ol class="seeds">${d.players.map((p, i) => `<li class="seed">
        <span class="seed-no">${i + 1}</span>
        <input data-draft="p${i}" value="${esc(p)}" placeholder="${coded ? L('이름,네자리', 'name,4 digits') : L(`참가자 ${i + 1} 이름`, `Player ${i + 1} name`)}" maxlength="${NAME_MAX + 6}" autocomplete="off" aria-label="${L(`${i + 1}번 시드`, `Seed ${i + 1}`)} ${coded ? L('이름,네자리', 'name,4 digits') : L('이름', 'name')}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="seed-list-${i}" aria-describedby="seed-err-${i}"${seedError(p) ? ' aria-invalid="true"' : ''}>
        <button type="button" class="icon-btn" data-act="seed-move" data-i="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="${L(`${i + 1}번 시드를 위로`, `Move seed ${i + 1} up`)}">${icon('up')}</button>
        <button type="button" class="icon-btn" data-act="seed-move" data-i="${i}" data-dir="1" ${i === d.players.length - 1 ? 'disabled' : ''} aria-label="${L(`${i + 1}번 시드를 아래로`, `Move seed ${i + 1} down`)}">${icon('down')}</button>
        <button type="button" class="icon-btn" data-act="seed-remove" data-i="${i}" ${d.players.length <= MIN_PLAYERS ? 'disabled' : ''} aria-label="${L(`${i + 1}번 참가자 빼기`, `Remove player ${i + 1}`)}">${icon('x')}</button>
        <ul class="seed-list" id="seed-list-${i}" role="listbox" aria-label="${L('등록된 선수', 'Registered players')}" hidden></ul>
        <p class="err-text seed-err" id="seed-err-${i}" aria-live="polite">${esc(seedError(p))}</p>
      </li>`).join('')}</ol>`}
      <div class="row">
        <button type="button" class="btn ghost grow" data-act="seed-add" ${d.players.length >= MAX_PLAYERS ? 'disabled' : ''}>${icon('plus')} ${L('참가자 추가', 'Add player')}</button>
        <button type="button" class="btn ghost grow" data-act="shuffle">${icon('shuffle')} ${L('무작위 추첨', 'Shuffle')}</button>
      </div>
      ${coded ? `<p class="hint">${L(`이름 뒤에 쉼표와 아무 네 자리 숫자를 붙여요. 예: ${PLAYER_CODE_EXAMPLE}. 같은 이름이어도 네 자리로 구분해요.`, `Add a comma and any four digits after the name, e.g. ${PLAYER_CODE_EXAMPLE}. The digits tell apart players with the same name.`)}</p>` : ''}
      <p class="hint">${L(`${MIN_PLAYERS}~${MAX_PLAYERS}명까지 등록할 수 있습니다.`, `You can enter ${MIN_PLAYERS}-${MAX_PLAYERS} players.`)}</p>
    </div>
    <div class="field"><span>${L('방식', 'Format')}</span>${seg('format', [['double', L('더블 · 기본', 'Double · default'), L('2패 탈락', 'Out after 2 losses')], ['triple', L('트리플', 'Triple'), L('3패 탈락', 'Out after 3 losses')], ['league', L('리그전', 'Round robin'), L('모두 한 번씩', 'Everyone once')]], d.format)}
      <p class="hint">${formatHint(d.format, d.players.length)}</p></div>
    <div class="field"><span>${L('경기 길이', 'Match length')}</span>${seg('bestOf', [[3, L('3판 2선승', 'Best of 3'), L('기본', 'Default')], [5, L('5판 3선승', 'Best of 5'), '']], d.bestOf)}</div>
    <p class="hint">${L('게임당 11점 · 10:10부터 2점 차 듀스 · 서브는 2점마다 교대(듀스에서는 1점마다)', '11 points a game · deuce from 10:10, win by 2 · serve changes every 2 points (every point at deuce)')}</p>
    <div class="row">
      <button type="button" class="btn primary grow" data-act="setup-submit">${editing ? L('변경 저장', 'Save changes') : L('대회 만들기', 'Create tournament')}</button>
    </div>
  </section>`;
}

function statusInfo(m, d) {
  if (m.status === 'done') return ['done', L('완료', 'Done')];
  if (m.status === 'live') return ['live', L('진행 중', 'Live')];
  if (m.status === 'ready') return d.current?.id === m.id ? ['next', L('다음 경기', 'Up next')] : ['ready', L('준비됨', 'Ready')];
  return ['pending', L('대기', 'Waiting')];
}

function pickMatch(d) {
  const sel = S.selected && d.matches.find((x) => x.id === S.selected);
  if (sel && sel.status !== 'pending') return sel;
  return d.current;
}

function pips(won, need) {
  return Array.from({ length: need }, (_, i) => `<i class="pip ${i < won ? 'on' : ''}"></i>`).join('');
}

function vsText(m) {
  return `${esc(nameOf(m.players[0]) ?? labelText(m.slotLabels[0]))} vs ${esc(nameOf(m.players[1]) ?? labelText(m.slotLabels[1]))}`;
}

function championCard(d, hint = true) {
  return `<section class="champ">${icon('trophy')}<small>${L('우승', 'Champion')}</small><div class="who">${esc(nameOf(d.champion))}</div><small>${hint ? L('대회가 끝났습니다. 순위 탭에서 최종 순위를 확인하세요.', 'The tournament is over. See the final standings in the Standings tab.') : L('대회가 끝났습니다.', 'The tournament is over.')}</small></section>`;
}

function matchView() {
  const t = T();
  const d = D();
  const m = pickMatch(d);
  const chips = `<nav class="chips" aria-label="${L('경기 선택', 'Choose match')}">${d.matches.map((x) => `<button class="mchip ${x.status} ${x.id === m?.id ? 'sel' : ''}" data-act="select" data-id="${x.id}" aria-pressed="${x.id === m?.id}" ${x.status === 'pending' ? 'disabled' : ''}><i class="sdot"></i>${L(`${x.no}경기`, `M${x.no}`)}</button>`).join('')}</nav>`;
  if (!m) return chips + championCard(d) + upNext(d, null);

  const s = m.score;
  const admin = isAdmin();
  const playable = m.status === 'ready' || m.status === 'live';
  const watching = S.role === 'viewer';
  const canScore = S.role === 'referee' && playable && !S.busy;
  const [cls, label] = statusInfo(m, d);
  const order = endOrder(m, S.flip);

  const pane = (side) => {
    const nm = nameOf(m.players[side]);
    const serving = s.server === side;
    const value = m.status === 'done' ? s.won[side] : side === 0 ? s.current.a : s.current.b;
    let tag = '';
    if (s.matchPoint === side) tag = `<span class="tag mp">${L('매치 포인트', 'Match point')}</span>`;
    else if (s.gamePoint === side) tag = `<span class="tag">${L('게임 포인트', 'Game point')}</span>`;
    const result = m.status === 'done' ? (s.winner === side ? 'won' : 'lost') : '';
    return `<button class="pane side${endOf(m, side)} ${result} ${serving ? 'serving' : ''}" data-act="point" data-side="${side}" ${canScore ? '' : 'disabled'} aria-label="${L(`${endName(m, side)} ${esc(nm)} 득점 (현재 ${value})`, `Point ${endName(m, side)} ${esc(nm)} (now ${value})`)}">
      <div class="pane-head"><span class="pname"><span class="player-name">${esc(nm)}${hcTag(m, side)}</span>${endTag(m, side)}</span>${serving ? `<span class="serve"><i class="ball"></i>${L('서브', 'Serve')}</span>` : ''}${result === 'won' ? `<span class="serve">${icon('trophy')}${L('승리', 'Wins')}</span>` : ''}</div>
      <div class="pscore">${value}</div>
      <div class="pane-foot"><span class="pips">${pips(s.won[side], s.need)}<span>${m.status === 'done' ? L('게임', 'Games') : L(`게임 ${s.won[side]}`, `Games ${s.won[side]}`)}</span></span>${tag}</div>
    </button>`;
  };

  const games = s.games.map((g, i) => `<span class="g">${L(`${i + 1}게임`, `G${i + 1}`)} ${g.a}:${g.b}</span>`).join('');
  const strip = `<div class="strip">${games}${playable ? `<span class="g">${L(`${s.gameNo}게임 진행`, `Game ${s.gameNo} live`)}</span>` : ''}${playable && s.deuce ? `<span class="g deuce">${L('듀스', 'Deuce')}</span>` : ''}</div>`;

  const controls = `<div class="controls">
    <button class="btn primary full" data-act="ref-enter">${icon('expand')} ${L('가로 점수 입력', 'Landscape scoring')}</button>
    <button class="btn full" data-act="undo" ${admin && m.points.length && !S.busy ? '' : 'disabled'}>${icon('undo')} ${L('점수 취소', 'Undo point')}</button>
    ${admin && playable ? `<button class="btn full" data-act="first-server" ${S.busy ? 'disabled' : ''}>${m.points.length ? L('서브 바꾸기', 'Change server') : L('첫 서브 바꾸기', 'Change first server')} · ${L('지금', 'now')} ${esc(nameOf(m.players[s.server]))}</button>` : ''}
  </div>`;
  // 관전 writes nothing: no referee mode, no undo or serve buttons, no PIN prompt. The card order
  // for this device alone is in the settings tab (내 자리에서 보기).
  const watchControls = '';

  const banner = m.status === 'done'
    ? `<div class="banner">${icon('trophy')}${L(`${esc(nameOf(m.winnerPlayer))} 승리`, `${esc(nameOf(m.winnerPlayer))} wins`)} · ${Math.max(...s.won)}:${Math.min(...s.won)}</div>
       ${d.current ? `<button class="btn primary" data-act="select" data-id="${d.current.id}">${L(`다음 경기로 · ${d.current.no}경기`, `Next match · Match ${d.current.no}`)} ${vsText(d.current)}</button>` : ''}`
    : s.lastGame
    ? `<div class="banner game" role="status">${icon('trophy')}<span>${L(`${s.lastGame.no}게임 ${esc(nameOf(m.players[s.lastGame.winner]))} 승리`, `Game ${s.lastGame.no}: ${esc(nameOf(m.players[s.lastGame.winner]))} wins`)} · ${s.lastGame.a}:${s.lastGame.b}<small>${L('게임 스코어', 'Games')} ${esc(nameOf(m.players[0]))} ${s.won[0]} : ${s.won[1]} ${esc(nameOf(m.players[1]))} · ${L(`${s.gameNo}게임은 ${s.current.a}:${s.current.b}부터`, `game ${s.gameNo} starts at ${s.current.a}:${s.current.b}`)}</small></span></div>`
    : '';

  return `${chips}
    ${d.finished && m.status === 'done' ? championCard(d) : ''}
    <div class="mhead"><div class="title"><span class="mno">${L(`${m.no}경기`, `Match ${m.no}`)}</span>${esc(labelText(m.label))}</div><span class="row"><span class="badge ${cls}">${label}</span></span></div>
    <div class="msub">${FORMAT_NAMES[t.format]} · ${L(`${t.bestOf}판 ${s.need}선승`, `Best of ${t.bestOf}`)} · ${L(`${t.pointsToWin}점`, `${t.pointsToWin} points`)}</div>
    ${cameraCard(m)}${soundCard()}
    ${banner}
    ${endNoticeHtml(m, 'end-notice')}
    <div class="board ${Object.keys(m.clips).length ? 'has-clip' : ''}">${pane(order[0])}${pane(order[1])}</div>
    ${latestClip(m)}
    ${strip}
    ${admin || watching ? '' : `<button class="note" data-act="pin" aria-label="${L('설정에서 PIN 입력', 'Enter PIN in settings')}">${icon('lock')}${L('보기 전용 화면입니다. 점수를 기록하려면 대회 PIN을 입력하세요.', 'View-only screen. Enter the tournament PIN to record scores.')}</button>`}
    ${watching ? watchControls : controls}
    ${m.points.length ? `<button class="btn full" data-act="an-open" data-id="${m.id}">${icon('chart')} ${L('분석', 'Analysis')}</button>` : ''}
    ${m.points.length ? `<button class="btn full" data-act="jg-open" data-id="${m.id}">${icon('chart')} ${L('카메라 판정 비교', 'Camera calls vs referee')}</button>` : ''}
    ${watching ? rallyList(m) : clipList(m)}
    ${admin && !watching && m.status === 'ready' ? handicapCard(t, m) : ''}
    ${upNext(d, m)}`;
}

// The latest clip sits right under the score cards so a viewer sees it without scrolling
// (phone portrait and a TV); the replay list stays further down.
function clipState(m) {
  const clips = Object.entries(m.clips).sort(([a], [b]) => Number(b) - Number(a));
  if (!clips.length) { S.clip = null; return null; }
  const [latestIndex, latestUrl] = clips[0];
  const latest = `${latestIndex}:${latestUrl}`;
  // A rally picked to watch again stays on screen when the next point comes in.
  if (S.clip?.matchId !== m.id || !m.clips[S.clip.index] || (S.clip.latest !== latest && !S.clip.pinned)) {
    S.clip = { matchId: m.id, latest, index: latestIndex };
  } else {
    S.clip.latest = latest;
  }
  return clips;
}

const isLatest = () => String(S.clip.index) === S.clip.latest.split(':')[0];

function clipTitle(m) {
  const i = S.clip.index;
  return `${isLatest() ? L('방금 포인트', 'Last point') : L('다시 보기', 'Replay')} · ${L(`${Number(i) + 1}번째`, `#${Number(i) + 1}`)} · ${L(`${esc(nameOf(m.players[m.points[i]]))} 득점`, `${esc(nameOf(m.players[m.points[i]]))} scores`)}`;
}

const latestButton = () => (isLatest() ? '' : `<button class="btn" data-act="clip-latest">${L('방금 포인트로', 'To last point')}</button>`);

function latestClip(m) {
  if (!clipState(m)) return '';
  return `<section class="card clips clip-now"><h2>${clipTitle(m)}</h2>
    <video data-clip-video src="${esc(m.clips[S.clip.index])}/video" controls muted playsinline preload="metadata"></video>${clipHud()}${latestButton()}
  </section>`;
}

// Every rally of this match, newest first: the ones with a saved clip play here, the rest are listed.
function rallyList(m) {
  const n = m.points.length;
  if (!n) return '';
  clipState(m);
  const items = [];
  for (let i = n - 1; i >= 0; i--) {
    const who = esc(nameOf(m.players[m.points[i]]));
    const play = m.clips[i]
      ? `<button class="btn" data-act="clip-play" data-index="${i}" aria-pressed="${String(S.clip?.index) === String(i)}">${L('다시 보기', 'Replay')}</button>`
      : `<span class="noclip">${L('영상 없음', 'No video')}</span>`;
    items.push(`<li><span>${L(`${i + 1}번째 · ${who} 득점`, `#${i + 1} · ${who} scores`)}</span>${play}</li>`);
  }
  return `<section class="card clips rallies"><h2 class="fold-title">${foldHead('rallies', L('랠리 다시 보기', 'Rally replays'), L(`영상 ${Object.keys(m.clips).length}/${n}`, `Videos ${Object.keys(m.clips).length}/${n}`))}</h2>${foldList('rallies', items)}</section>`;
}

// Rows of an <ol>, with 전체 n개 보기 under the list, not inside it.
function foldList(key, items) {
  const body = foldRows(key, items);
  if (!body) return '';
  const cut = body.indexOf('<button type="button" class="btn ghost fold-more"');
  return cut < 0 ? `<ol class="clip-list">${body}</ol>` : `<ol class="clip-list">${body.slice(0, cut)}</ol>${body.slice(cut)}`;
}

function clipList(m) {
  const clips = clipState(m);
  if (!clips) return '';
  return `<section class="card clips"><h2 class="fold-title">${foldHead('clips', L('포인트 영상', 'Point videos'), String(clips.length))}</h2>
    ${foldList('clips', clips.map(([index]) => `<li><span>${L(`${Number(index) + 1}번째 포인트 · ${esc(nameOf(m.players[m.points[index]]))} 득점`, `Point ${Number(index) + 1} · ${esc(nameOf(m.players[m.points[index]]))} scores`)}</span>
      <button class="btn" data-act="clip-play" data-index="${index}" aria-pressed="${S.clip.index === index}">${L('다시 보기', 'Replay')}</button></li>`))}
  </section>`;
}

function handicapCard(t, m) {
  const max = t.pointsToWin - 1;
  const row = (side) => {
    const h = m.handicap[side];
    return `<div class="hc-row"><span class="hc-name">${esc(nameOf(m.players[side]))}</span>
      <button class="icon-btn" data-act="hc" data-side="${side}" data-d="-1" ${h <= 0 || S.busy ? 'disabled' : ''} aria-label="${L(`${esc(nameOf(m.players[side]))} 시작 점수 1 빼기`, `${esc(nameOf(m.players[side]))} start score minus 1`)}">${icon('minus')}</button>
      <b class="hc-val">${h}</b>
      <button class="icon-btn" data-act="hc" data-side="${side}" data-d="1" ${h >= max || S.busy ? 'disabled' : ''} aria-label="${L(`${esc(nameOf(m.players[side]))} 시작 점수 1 더하기`, `${esc(nameOf(m.players[side]))} start score plus 1`)}">${icon('plus')}</button></div>`;
  };
  return `<section class="card"><h2>${L('핸디캡 · 시작 점수', 'Handicap · start score')}</h2>${row(0)}${row(1)}
    <p class="hint">${L('이 경기의 모든 게임이 이 점수에서 시작합니다(11점·듀스 규칙 그대로). 첫 점수 전에만 바꿀 수 있습니다.', 'Every game of this match starts from this score (11 points and deuce rules unchanged). It can be changed only before the first point.')}</p></section>`;
}

function refNoticeView(d) {
  const n = S.refNotice;
  const m = n && d.matches.find((x) => x.id === n.matchId);
  if (!m) return '';
  const winnerName = esc(nameOf(m.players[n.game.winner]));
  if (n.type === 'game') {
    const [l, r] = endOrder(m, S.flip);
    return `<div class="ref-notice" role="alertdialog" aria-label="${L(`${n.gameNo}게임 종료`, `Game ${n.gameNo} over`)}"><div class="ref-card">
      <small>${L(`${n.gameNo}게임 종료`, `Game ${n.gameNo} over`)}</small>
      <b>${L(`${winnerName} 승리`, `${winnerName} wins`)} · ${n.game.a}:${n.game.b}</b>
      <span>${L('게임 스코어', 'Games')} ${esc(nameOf(m.players[l]))} ${n.won[l]} : ${n.won[r]} ${esc(nameOf(m.players[r]))}</span>
      <span>${icon('swap')} ${L(`엔드 교체 · 블루 ${esc(nameOf(m.players[m.ends[0]]))} · 레드 ${esc(nameOf(m.players[m.ends[1]]))}`, `Change ends · Blue ${esc(nameOf(m.players[m.ends[0]]))} · Red ${esc(nameOf(m.players[m.ends[1]]))}`)}</span>
      <div class="row"><button class="btn primary grow" data-act="notice-close">${L('계속', 'Continue')}</button></div>
    </div></div>`;
  }
  const next = d.current;
  return `<div class="ref-notice" role="alertdialog" aria-label="${L('경기 종료', 'Match over')}"><div class="ref-card">
    <small>${L(`${m.no}경기 종료`, `Match ${m.no} over`)}</small>
    <b>${icon('trophy')} ${L(`${winnerName} 승리`, `${winnerName} wins`)} · ${Math.max(...n.won)}:${Math.min(...n.won)}</b>
    <div class="row">${next ? `<button class="btn primary grow" data-act="ref-next">${L(`다음 경기 · ${next.no}경기`, `Next match · Match ${next.no}`)} ${vsText(next)}</button>` : ''}<button class="btn grow" data-act="ref-exit">${L('심판 모드 나가기', 'Leave Referee mode')}</button></div>
  </div></div>`;
}

function refView() {
  const d = D();
  const m = pickMatch(d);
  const fs = document.fullscreenEnabled
    ? `<button class="ref-btn" data-act="ref-fs" aria-label="${L('전체 화면 전환', 'Toggle full screen')}">${icon('expand')}<span class="lbl">${document.fullscreenElement ? L('전체 화면 해제', 'Exit full screen') : L('전체 화면', 'Full screen')}</span></button>`
    : '';
  const exit = `<button class="ref-btn" data-act="ref-exit" data-back data-back-destination="match" aria-label="${L('뒤로, 심판 모드 나가기', 'Back, leave Referee mode')}">${icon('back')}</button><span class="mode" data-screen-name>${icon('paddle')}${L('심판 모드', 'Referee mode')}</span>`;
  if (!m) return `<div class="ref"><div class="ref-bar">${exit}<span class="ref-title">${L('대회 종료', 'Tournament over')}</span></div><div class="ref-empty">${championCard(d)}</div></div>`;

  const s = m.score;
  const admin = isAdmin();
  const playable = m.status === 'ready' || m.status === 'live';
  const canScore = S.role === 'referee' && playable && !S.busy && !S.refNotice;
  const ask = cameraAsk(m);
  const valueOf = (side) => (m.status === 'done' ? s.won[side] : side === 0 ? s.current.a : s.current.b);
  // both cards draw their digits at the size the longer score fits (10 and up takes two digits' width)
  const digits = Math.max(String(valueOf(0)).length, String(valueOf(1)).length);
  const half = (side) => {
    const nm = nameOf(m.players[side]);
    const serving = s.server === side;
    const value = valueOf(side);
    let tag = '';
    if (s.matchPoint === side) tag = `<span class="tag mp">${L('매치 포인트', 'Match point')}</span>`;
    else if (s.gamePoint === side) tag = `<span class="tag">${L('게임 포인트', 'Game point')}</span>`;
    const result = m.status === 'done' ? (s.winner === side ? 'won' : 'lost') : '';
    // 확인 후 입력: the camera's call for the point waiting to go in
    const asked = ask && ask.pre === endOf(m, side);
    if (asked) tag = `<span class="tag ask">${L('카메라 판정', "Camera's call")}</span>${tag}`;
    return `<button class="ref-half side${endOf(m, side)} ${serving ? 'serving' : ''} ${result} ${asked ? 'asked' : ''}" data-act="point" data-side="${side}" ${canScore ? '' : 'disabled'} aria-label="${L(`${endName(m, side)} ${esc(nm)} 득점 (현재 ${value})`, `Point ${endName(m, side)} ${esc(nm)} (now ${value})`)}${asked ? L(' · 카메라 판정', " · camera's call") : ''}">
      <span class="ref-top"><span class="ref-name">${esc(nm)}${hcTag(m, side)}</span>${serving ? `<span class="serve"><i class="ball"></i>${L('서브', 'Serve')}</span>` : ''}</span>
      <span class="ref-mid"><span class="ref-score" style="--n: ${digits}">${value}</span></span>
      <span class="ref-foot"><span class="pips">${pips(s.won[side], s.need)}<span>${L(`게임 ${s.won[side]}`, `Games ${s.won[side]}`)}</span></span>${tag}</span>
    </button>`;
  };
  const [left, right] = endOrder(m, S.flip);
  const title = m.status === 'done' ? L(`${m.no}경기 종료`, `Match ${m.no} over`) : `${L(`${m.no}경기 · ${s.gameNo}게임`, `Match ${m.no} · Game ${s.gameNo}`)}${s.deuce ? L(' · 듀스', ' · Deuce') : ''}`;
  const hcStep = (side) => {
    const h = m.handicap[side];
    const who = esc(nameOf(m.players[side]));
    return `<span class="ref-hc"><button class="ref-btn" data-act="hc" data-side="${side}" data-d="-1" ${h <= 0 || S.busy ? 'disabled' : ''} aria-label="${L(`${who} 시작 점수 1 빼기`, `${who} start score minus 1`)}">${icon('minus')}</button><b>${who} ${h}</b><button class="ref-btn" data-act="hc" data-side="${side}" data-d="1" ${h >= T().pointsToWin - 1 || S.busy ? 'disabled' : ''} aria-label="${L(`${who} 시작 점수 1 더하기`, `${who} start score plus 1`)}">${icon('plus')}</button></span>`;
  };
  const bottom = admin && m.status === 'ready'
    ? `<div class="ref-hc-row">${hcStep(left)}<small>${L('시작 점수(핸디캡)', 'Start score (handicap)')}</small>${hcStep(right)}</div>`
    : admin
    ? `<button class="ref-undo" data-hold="undo" data-act="undo-hint" ${m.points.length && !S.busy ? '' : 'disabled'}>${icon('undo')}<span>${L('길게 눌러 점수 취소', 'Hold to undo point')}</span></button>`
    : `<button class="note" data-act="pin" aria-label="${L('설정에서 PIN 입력', 'Enter PIN in settings')}">${icon('lock')}${L('보기 전용입니다. 점수를 기록하려면 PIN을 입력하세요.', 'View only. Enter the PIN to record scores.')}</button>`;
  // the hold, the camera's question and the 끝 색 확인 row take height from the cards: their score digits shrink
  const rows = `${S.refDone ? `<p class="ref-done" role="status" data-ref-done>${esc(S.refDone)}</p>` : ''}${cameraHold(S.cameraMatches?.[m.id] ?? []) ? `<p class="ref-hold" data-hold-text>${L(`${HOLD_TEXT} · 어느 폰이든 끝 색을 고치면 풀려요`, `${HOLD_TEXT} · fixing the end colour on either phone ends it`)}</p>` : ''}${admin ? askRow(m, ask, canScore) + checkRow(m) : ''}`;
  return `<div class="ref${rows ? ' ref-rows' : ''}">
    <div class="ref-bar">${exit}<span class="ref-line"><span class="ref-title${endNoticeText(m) ? ' ref-end' : ''}" ${endNoticeText(m) ? 'role="status" data-end-notice' : ''}>${endNoticeText(m) || title}</span>${refCamera()}</span><span class="ref-tools">${admin && playable ? `<button class="ref-btn" data-act="first-server" data-ref-serve ${S.busy ? 'disabled' : ''} aria-label="${L('서브 바꾸기', 'Change server')}">${icon('paddle')}<span class="lbl">${L('서브 바꾸기', 'Server')}</span></button>` : ''}${admin && playable ? `<button class="ref-btn" data-act="ends-swap" ${S.busy ? 'disabled' : ''} aria-label="${L('엔드 바꾸기: 두 선수 자리 교체, 레드·블루 자리는 그대로', 'Change ends: the players swap places, Red and Blue sides stay')}">${icon('swap')}<span class="lbl">${L('엔드 바꾸기', 'Ends')}</span></button>` : `<button class="ref-btn" data-act="flip" aria-label="${L('좌우 바꾸기', 'Flip left and right')}">${icon('swap')}<span class="lbl">${L('좌우 바꾸기', 'Flip')}</span></button>`}${fs}</span></div>
    <div class="ref-halves">${half(left)}${half(right)}</div>
    <div class="ref-bottom">${rows}${bottom}</div>
    ${refNoticeView(d)}
  </div>`;
}

// 확인 후 입력 (owner decision, 2026-11-01): the camera's 누가 땄나요 for the next point of this match, as its status says;
// gone once that point is in (here, on the camera, or by a hand tap).
function cameraAsk(m) {
  const a = (S.cameraMatches?.[m.id] ?? []).find((c) => c.primary)?.ask;
  return a && a.seq === m.points.length && m.status !== 'done' ? a : null;
}

// The point waiting on the camera, on the referee screen: [확정] enters the camera's call (one tap); the other
// player's card enters the other. Held (끝 색 확인) or two cameras apart: no call, tap the card that won.
function askRow(m, ask, canScore) {
  if (!ask) return '';
  if (ask.pre == null) {
    const why = ask.hold ? HOLD_TEXT : L('카메라 판정이 엇갈려요', 'the cameras disagree');
    return `<div class="ref-ask" role="status" data-ref-ask><span class="ref-ask-text">${L(`<b>누가 땄나요?</b> ${why} · 득점한 쪽 점수판을 눌러 주세요`, `<b>Who won it?</b> ${why} · tap the winner's card`)}</span></div>`;
  }
  const slot = (m.ends ?? [0, 1])[ask.pre];
  const who = esc(nameOf(m.players[slot]));
  const end = ask.pre === 0 ? L('블루', 'Blue') : L('레드', 'Red');
  return `<div class="ref-ask" role="status" data-ref-ask><span class="ref-ask-text">${L(`<b>카메라 판정 확인</b> ${end} ${who} 득점?`, `<b>Camera's call</b> ${end} ${who} scored?`)}</span><button class="ref-btn ok" data-act="point" data-side="${slot}" data-ask-confirm ${canScore ? '' : 'disabled'}>${L('확정', 'Confirm')}</button></div>`;
}

// 끝 색 확인: the points the camera entered by itself before it warned that the end colours look opposite,
// one at a time from the earliest: [반대로] gives it to the other player (later points stay), [맞음] clears it.
function checkRow(m) {
  const marked = Object.keys(m.marks ?? {}).map(Number).filter((i) => i < m.points.length).sort((a, b) => a - b);
  if (!marked.length) return '';
  const i = marked[0];
  const who = esc(nameOf(m.players[m.points[i]]));
  const of = marked.length > 1 ? ` 1/${marked.length}` : '';
  return `<div class="ref-check" role="group" aria-label="${L('끝 색 확인', 'Check end colours')}" data-ref-check><span class="ref-check-text">${L(`<b>끝 색 확인${of}</b> ${i + 1}번째 포인트 · ${who} 득점`, `<b>Check end colours${of}</b> point ${i + 1} · ${who} scored`)}</span><button class="ref-btn warn" data-act="mark-flip" data-index="${i}" ${S.busy ? 'disabled' : ''}>${L('반대로', 'Swap')}</button><button class="ref-btn" data-act="mark-ok" data-index="${i}" ${S.busy ? 'disabled' : ''}>${L('맞음', 'Correct')}</button></div>`;
}

function refCamera() {
  const mode = cameraMode(S.cameraMatches?.[pickMatch(D())?.id] ?? []);
  const { kind, camera } = cameraStatus(S.cameras);
  if (kind === 'none') return '';
  if (kind === 'linked' && cameraHold(S.cameraMatches?.[pickMatch(D())?.id] ?? [])) {
    // a narrow screen has no room for it in the bar (icon only there): the line under the cards says it instead
    return `<span class="ref-cam hold" data-camera="hold" data-hold role="status" aria-label="${HOLD_TEXT}">${icon('camera')}<span class="lbl" data-hold-text>${HOLD_TEXT}</span></span>`;
  }
  const label = kind === 'linked' && mode ? mode.label : { linked: L('카메라 연결됨', 'Camera linked'), offline: L('카메라 끊김', 'Camera offline'), waiting: L('카메라 PIN 대기', 'Camera needs PIN') }[kind];
  return `<span class="ref-cam ${kind}" data-camera="${kind}" role="status">${icon('camera')}<span class="lbl">${label}</span></span>`;
}

function upNext(d, shown) {
  const rest = d.matches.filter((x) => x.status !== 'done' && x.id !== shown?.id).slice(0, 3);
  if (!rest.length) return '';
  return `<section class="card upnext"><h2>${L('다음 순서', 'Up next')}</h2>${rest.map((x) => {
    const [cls, label] = statusInfo(x, d);
    return `<div class="item"><span>${L(`${x.no}경기`, `Match ${x.no}`)} · ${esc(labelText(x.label))}</span><span class="badge ${cls}">${label}</span></div><div class="item"><b>${vsText(x)}</b></div>`;
  }).join('')}</section>`;
}

function bracketView() {
  const t = T();
  const d = D();
  if (t.format === 'league') return leagueView(t, d);
  const two = t.players.length === 2;
  const groups = two ? [['F', L('결승', 'Final')]] : t.format === 'triple'
    ? [['W', L('승자조 (0패)', 'Winners (0 losses)')], ['L', L('패자조 A (1패)', 'Losers A (1 loss)')], ['L2', L('패자조 B (2패)', 'Losers B (2 losses)')], ['F', L('그랜드 파이널', 'Grand final')]]
    : [['W', L('승자조', 'Winners bracket')], ['L', L('패자조', 'Losers bracket')], ['F', L('그랜드 파이널', 'Grand final')]];
  const card = (m) => matchCard(m, d);
  const summary = d.finished
    ? championCard(d)
    : `<section class="card"><div class="kv"><span>${L('진행', 'Progress')}</span><span>${L(`${d.matches.filter((m) => m.status === 'done').length} / ${d.matches.length}경기 완료`, `${d.matches.filter((m) => m.status === 'done').length} / ${d.matches.length} matches done`)}</span><span>${L('다음', 'Next')}</span><span>${d.current ? `${L(`${d.current.no}경기`, `Match ${d.current.no}`)} ${vsText(d.current)}` : '-'}</span></div>${two
      ? `<p class="hint">${FORMAT_NAMES[t.format]}: ${formatHint(t.format, 2)}</p>`
      : t.format === 'triple'
      ? `<ol class="rules">${TRIPLE_RULE.map((r) => `<li>${r}</li>`).join('')}</ol>`
      : `<p class="hint">${FORMAT_NAMES[t.format]}: ${L(`${d.lives}패 하면 탈락합니다. 결승에서 패자조 출신이 이기면 리셋 매치가 자동으로 추가됩니다.`, `${d.lives} losses and you are out. If the losers bracket player wins the final, a reset match is added automatically.`)}</p>`}</section>`;
  return summary + groups.map(([stage, title]) => {
    const ms = d.matches.filter((m) => m.stage === stage);
    const key = `bracket-${stage}`;
    return ms.length ? `<section class="group"><h3 class="fold-title">${foldHead(key, title, L(`${ms.length}경기`, `${ms.length} ${ms.length === 1 ? 'match' : 'matches'}`))}</h3>${foldRows(key, ms.map(card), { start: matchWindow(ms) })}</section>` : '';
  }).join('');
}

function matchCard(m, d) {
  const [cls, label] = statusInfo(m, d);
  const row = (i) => {
    const p = m.players[i];
    if (p === null) return `<div class="prow tbd"><span class="nm"><span>${esc(labelText(m.slotLabels[i]))}</span></span><span class="sc"></span></div>`;
    const res = m.status === 'done' ? (m.score.winner === i ? 'win' : 'lose') : '';
    const live = m.status === 'live' ? `<span class="live-pts">${i === 0 ? m.score.current.a : m.score.current.b}</span>` : '';
    // A pending match can already know one player (the other slot waits on a result): no score yet.
    return `<div class="prow ${res}"><span class="nm">${res === 'win' ? icon('check') : ''}<span>${esc(nameOf(p))}</span>${hcTag(m, i)}</span><span>${live}<span class="sc">${m.score ? m.score.won[i] : ''}</span></span></div>`;
  };
  return `<button class="mcard ${cls}" data-act="open" data-id="${m.id}" ${m.status === 'pending' ? 'disabled' : ''}>
    <div class="mcard-top"><span><b>${L(`${m.no}경기`, `Match ${m.no}`)}</b> · ${esc(labelText(m.label))}</span><span class="badge ${cls}">${label}</span></div>
    ${row(0)}${row(1)}${m.status === 'pending' ? `<p class="hint">${L('앞 경기 결과가 나오면 열립니다.', 'Opens when the earlier results are in.')}</p>` : ''}
  </button>`;
}

function leagueView(t, d) {
  const done = d.matches.filter((m) => m.status === 'done').length;
  const summary = d.finished
    ? championCard(d)
    : `<section class="card"><div class="kv"><span>${L('진행', 'Progress')}</span><span>${L(`${done} / ${d.matches.length}경기 완료`, `${done} / ${d.matches.length} matches done`)}</span><span>${L('다음', 'Next')}</span><span>${d.current ? `${L(`${d.current.no}경기`, `Match ${d.current.no}`)} ${vsText(d.current)}` : '-'}</span></div><p class="hint">${L(`리그전: 모든 참가자가 한 번씩 붙습니다. 순위: ${LEAGUE_RULE}.`, `Round robin: every player meets every other once. Standings: ${LEAGUE_RULE}.`)}</p></section>`;
  const rounds = [...new Set(d.matches.map((m) => m.round))];
  return summary + rounds.map((r) => {
    const ms = d.matches.filter((m) => m.round === r);
    const key = `round-${r}`;
    return `<section class="group"><h3 class="fold-title">${foldHead(key, L(`${r}라운드`, `Round ${r}`), L(`${ms.length}경기`, `${ms.length} ${ms.length === 1 ? 'match' : 'matches'}`))}</h3>${foldRows(key, ms.map((m) => matchCard(m, d)), { start: matchWindow(ms) })}</section>`;
  }).join('');
}

function leagueStandingsView(d) {
  const diff = (a, b) => { const v = a - b; return `${v > 0 ? '+' : ''}${v}`; };
  const rows = d.standings.map((s) => {
    const status = s.status === 'champion'
      ? `<span class="badge next">${icon('trophy')}${L('우승', 'Champion')}</span>`
      : s.status === 'finished' ? `<span class="badge">${L(`${s.place}위 확정`, `#${s.place} final`)}</span>` : `<span class="badge live">${L(`잠정 ${s.rank}위`, `#${s.rank} for now`)}</span>`;
    return `<div class="standing ${s.status === 'champion' ? 'champion' : ''}">
      <div class="rk">${s.rank}</div>
      <div class="nmrow"><b>${esc(s.name)}</b>${status}</div>
      <div class="stats">
        <div class="stat"><small>${L('승패', 'W-L')}</small><b>${L(`${s.wins}승 ${s.losses}패`, `${s.wins}W ${s.losses}L`)}</b>${s.h2h !== null ? `<i>${L(`승자승 ${s.h2h}`, `H2H ${s.h2h}`)}</i>` : ''}</div>
        <div class="stat"><small>${L('게임 득실', 'Games')}</small><b>${s.gamesWon}-${s.gamesLost}</b><i>${diff(s.gamesWon, s.gamesLost)}</i></div>
        <div class="stat"><small>${L('점수 득실', 'Points')}</small><b>${s.pointsWon}-${s.pointsLost}</b><i>${diff(s.pointsWon, s.pointsLost)}</i></div>
      </div>
    </div>`;
  });
  return `${d.finished ? championCard(d, false) : ''}<section class="group"><h3 class="fold-title">${foldHead('standings', L('순위', 'Standings'), L(`${rows.length}명`, `${rows.length} players`))}</h3>${foldRows('standings', rows, { few: L('상위', 'top') })}</section>
    <p class="hint">${L(`리그전 순위: ${LEAGUE_RULE}. 승자승은 승수가 같은 선수끼리 친 경기의 승수입니다. 점수는 실제 랠리만 센니다(핸디캡 제외). 모든 경기가 끝나면 순위가 확정됩니다.`, `Round robin standings: ${LEAGUE_RULE}. Head-to-head counts wins in matches between the tied players. Points count real rallies only (no handicap). Standings are final when every match is done.`)}</p>`;
}

function standingsView() {
  const d = D();
  if (T().format === 'league') return leagueStandingsView(d);
  const diff = (a, b) => { const v = a - b; return `${v > 0 ? '+' : ''}${v}`; };
  const rows = d.standings.map((s) => {
    let status;
    if (s.status === 'champion') status = `<span class="badge next">${icon('trophy')}${L('우승', 'Champion')}</span>`;
    else if (s.status === 'eliminated') status = `<span class="badge">${L(`${s.place}위 확정 · 탈락`, `#${s.place} final · out`)}</span>`;
    else status = `<span class="badge live">${L('생존', 'In')} · <span class="lives">${Array.from({ length: d.lives }, (_, i) => `<i class="life ${i < s.lossCount ? 'gone' : ''}"></i>`).join('')}</span></span>`;
    return `<div class="standing ${s.status}">
      <div class="rk">${s.place ?? s.rank}</div>
      <div class="nmrow"><b>${esc(s.name)}</b>${status}</div>
      <div class="stats">
        <div class="stat"><small>${L('매치', 'Matches')}</small><b>${L(`${s.wins}승 ${s.losses}패`, `${s.wins}W ${s.losses}L`)}</b></div>
        <div class="stat"><small>${L('게임 득실', 'Games')}</small><b>${s.gamesWon}-${s.gamesLost}</b><i>${diff(s.gamesWon, s.gamesLost)}</i></div>
        <div class="stat"><small>${L('점수 득실', 'Points')}</small><b>${s.pointsWon}-${s.pointsLost}</b><i>${diff(s.pointsWon, s.pointsLost)}</i></div>
      </div>
    </div>`;
  });
  return `${d.finished ? championCard(d, false) : ''}<section class="group"><h3 class="fold-title">${foldHead('standings', L('순위', 'Standings'), L(`${rows.length}명`, `${rows.length} players`))}</h3>${foldRows('standings', rows, { few: L('상위', 'top') })}</section>
    <p class="hint">${L('순위는 탈락 순서로 확정됩니다(먼저 탈락할수록 낮은 순위). 생존자는 패 수가 적은 순, 그다음 승수·점수 득실 순으로 표시합니다. 점수 통계는 진행 중인 경기까지 실시간 반영됩니다.', 'Places are fixed in elimination order (out earlier, placed lower). Players still in are listed by fewest losses, then wins and point difference. Score stats include live matches.')}</p>`;
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(LOCALE, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-');

async function loadHistory() {
  const res = await fetch('/api/history');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorText(data, L('기록을 불러오지 못했습니다.', 'Could not load the history.')));
  S.history = data.items;
  const open = S.histOpen?.summary.id;
  if (open && !S.history.some((h) => h.id === open)) S.histOpen = null;
  else if (open) await openHistory(open);
  render();
}

async function openHistory(id) {
  const res = await fetch(`/api/history/${encodeURIComponent(id)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorText(data, L('기록을 불러오지 못했습니다.', 'Could not load the history.')));
  S.histOpen = data;
}

function favButton(h) {
  const label = h.favorite ? L('즐겨찾기 해제', 'Unfavourite') : L('즐겨찾기', 'Favourite');
  if (!isAdmin()) return h.favorite ? `<span class="star on" title="${L('즐겨찾기', 'Favourite')}">${icon('star')}</span>` : '';
  return `<button class="icon-btn star ${h.favorite ? 'on' : ''}" data-act="hist-fav" data-id="${esc(h.id)}" data-fav="${h.favorite ? '0' : '1'}" aria-pressed="${h.favorite}" aria-label="${esc(labelText(h.name))} ${label}">${icon('star')}</button>`;
}

function delButton(h) {
  if (!isAdmin() || h.current) return '';
  return `<button class="icon-btn del" data-act="hist-del" data-id="${esc(h.id)}" data-name="${esc(labelText(h.name))}" aria-label="${L(`${esc(labelText(h.name))} 기록 삭제`, `Delete ${esc(labelText(h.name))} history`)}">${icon('trash')}</button>`;
}

function historyResult(h) {
  if (h.broken) return `<span class="badge">${L('파일을 읽지 못함', 'Unreadable file')}</span>`;
  if (h.champion) return `<span class="badge next">${icon('trophy')}${L('우승', 'Champion')} ${esc(h.champion)}</span>`;
  return `<span class="badge ${h.current ? 'live' : ''}">${h.current ? L('진행 중', 'Live') : L('미완료', 'Unfinished')} · ${L(`${h.played}/${h.total}경기`, `${h.played}/${h.total} matches`)}</span>`;
}

function historyView() {
  if (S.histOpen) return historyDetailView(S.histOpen);
  if (!S.history) return `<p class="loading">${L('기록을 불러오는 중…', 'Loading history…')}</p>`;
  const favCount = S.history.filter((h) => h.favorite).length;
  const items = S.histFav ? S.history.filter((h) => h.favorite) : S.history;
  const filter = `<div class="seg" role="radiogroup" aria-label="${L('기록 필터', 'History filter')}">${[[false, L(`전체 ${S.history.length}`, `All ${S.history.length}`)], [true, L(`즐겨찾기 ${favCount}`, `Favourites ${favCount}`)]].map(([fav, label]) => `<button type="button" role="radio" aria-checked="${S.histFav === fav}" class="seg-btn ${S.histFav === fav ? 'on' : ''}" data-act="hist-filter" data-fav="${fav ? '1' : '0'}"><b>${label}</b></button>`).join('')}</div>`;
  const card = (h) => `<article class="hcard ${h.current ? 'live' : ''}">
      <button class="hcard-main" data-act="hist-open" data-id="${esc(h.id)}" ${h.broken ? 'disabled' : ''}>
        <span class="hcard-title"><b>${esc(labelText(h.name) || L('이름 없는 대회', 'Untitled tournament'))}</b>${h.current ? `<span class="badge live">${L('현재 대회', 'Current')}</span>` : ''}</span>
        <small>${h.broken ? L(`보관 ${fmtDate(h.archivedAt)}`, `Archived ${fmtDate(h.archivedAt)}`) : `${fmtDate(h.createdAt)} · ${FORMAT_NAMES[h.format] ?? h.format} · ${L(`${h.bestOf}판`, `Best of ${h.bestOf}`)}`}</small>
        <span class="hcard-players">${h.players.map(esc).join(' · ')}</span>
        ${historyResult(h)}
      </button>
      <div class="hcard-acts">${favButton(h)}${delButton(h)}</div>
    </article>`;
  const empty = `<p class="hint empty">${S.histFav ? `${L('즐겨찾기한 기록이 없습니다.', 'No favourites yet.')}${isAdmin() ? L(' 별을 눌러 추가하세요.', ' Tap the star to add one.') : ''}` : L('아직 기록이 없습니다.', 'No history yet.')}</p>`;
  return `<h1 class="h1">${L('경기 기록', 'Match history')}</h1>${filter}
    <section class="group">${items.length ? `<h2 class="fold-title">${foldHead('history', S.histFav ? L('즐겨찾기', 'Favourites') : L('지난 대회', 'Past tournaments'), String(items.length))}</h2>${foldRows('history', items.map(card))}` : empty}</section>
    ${peopleSection()}
    <p class="hint">${L('새 대회를 만들면 지금 대회가 여기에 보관됩니다.', 'Creating a new tournament archives the current one here.')} ${isAdmin() ? L('삭제한 기록은 서버 휴지통(data/trash)에 남아 되살릴 수 있습니다.', 'Deleted history stays in the server trash (data/trash) and can be restored.') : L('즐겨찾기와 삭제는 PIN을 입력한 기기에서 할 수 있습니다.', 'Favourites and deleting work on a device with the PIN.')}</p>`;
}

function historyDetailView({ summary: h, tournament: t, derived: d }) {
  const nm = (p) => esc(p === null ? '' : t.players[p]);
  const shown = d.matches.filter((m) => m.status !== 'pending');
  const match = (m) => {
    const [cls, label] = statusInfo(m, d);
    const s = m.score;
    const row = (i) => {
      const res = m.status === 'done' ? (s.winner === i ? 'win' : 'lose') : '';
      return `<div class="prow ${res}"><span class="nm">${res === 'win' ? icon('check') : ''}<span>${nm(m.players[i])}</span>${hcTag(m, i)}</span><span class="sc">${s.won[i]}</span></div>`;
    };
    const games = s.games.map((g, i) => `<span class="g">${L(`${i + 1}게임`, `G${i + 1}`)} ${g.a}:${g.b}</span>`).join('');
    const live = m.status === 'live' ? `<span class="g">${L(`${s.gameNo}게임`, `G${s.gameNo}`)} ${s.current.a}:${s.current.b}</span>` : '';
    return `<div class="mcard ${cls}"><div class="mcard-top"><span><b>${L(`${m.no}경기`, `Match ${m.no}`)}</b> · ${esc(labelText(m.label))}</span><span class="badge ${cls}">${label}</span></div>${row(0)}${row(1)}${games || live ? `<div class="strip">${games}${live}</div>` : ''}${m.points.length ? `<button class="btn" data-act="an-open" data-id="${m.id}" data-hist="${esc(h.id)}">${icon('chart')} ${L('분석', 'Analysis')}</button>` : ''}</div>`;
  };
  const ranks = d.standings.map((s) => `<span>${L(`${s.place ?? s.rank}위`, `#${s.place ?? s.rank}`)}</span><span>${esc(s.name)} · ${L(`${s.wins}승 ${s.losses}패 · 게임 ${s.gamesWon}-${s.gamesLost}`, `${s.wins}W ${s.losses}L · games ${s.gamesWon}-${s.gamesLost}`)}</span>`);
  return `<div class="row hist-bar"><span class="hcard-acts">${favButton(h)}${delButton(h)}</span></div>
    <section class="card"><h1 class="h1">${esc(labelText(h.name) || L('이름 없는 대회', 'Untitled tournament'))}</h1>
      <div class="kv"><span>${L('시작', 'Started')}</span><span>${fmtDate(h.createdAt)}</span>${h.archivedAt ? `<span>${L('보관', 'Archived')}</span><span>${fmtDate(h.archivedAt)}</span>` : ''}<span>${L('방식', 'Format')}</span><span>${FORMAT_NAMES[h.format] ?? h.format} · ${L(`${h.bestOf}판 ${Math.ceil(h.bestOf / 2)}선승`, `Best of ${h.bestOf}`)}</span><span>${L('결과', 'Result')}</span><span>${historyResult(h)}</span></div>
      ${h.current ? `<button class="btn primary" data-act="hist-current">${L('경기 화면으로', 'To match screen')}</button>` : ''}
    </section>
    ${(() => { const body = foldRows('hist-rank', ranks, { few: L('상위', 'top') }); const cut = body.indexOf('<button'); return `<section class="card"><h2 class="fold-title">${foldHead('hist-rank', L('순위', 'Standings'), L(`${ranks.length}명`, `${ranks.length} players`))}</h2>${body ? `<div class="kv">${cut < 0 ? body : body.slice(0, cut)}</div>${cut < 0 ? '' : body.slice(cut)}` : ''}</section>`; })()}
    <section class="group"><h3 class="fold-title">${foldHead('hist-matches', L('경기 결과', 'Results'), L(`${h.played}/${h.total}경기 완료`, `${h.played}/${h.total} done`))}</h3>${shown.length ? foldRows('hist-matches', shown.map(match), { start: shown.length - 5 }) : `<p class="hint">${L('치른 경기가 없습니다.', 'No matches played.')}</p>`}</section>`;
}

// 새 버전 있음: the camera app on this address answers with a newer release only on a public install
// (its update-check.js asks GitHub at most once a day); asked once a page, quiet when it fails
let updateInfo = null;
let updateAsked = false;
function askUpdate() {
  if (updateAsked) return;
  updateAsked = true;
  fetch('/vision/api/update').then((r) => (r.ok ? r.json() : null)).then((u) => {
    if (!u?.latest || !/^https:\/\/github\.com\//.test(u.url || '')) return;
    updateInfo = u;
    render();
  }).catch(() => {});
}

function settingsView() {
  const t = T();
  const admin = isAdmin();
  const url = location.origin + '/';
  askUpdate();
  return `${updateInfo ? `<a class="update-line" href="${esc(updateInfo.url)}" target="_blank" rel="noopener noreferrer">${L(`새 버전 있음 · v${esc(updateInfo.latest)}`, `New version · v${esc(updateInfo.latest)}`)}</a>` : ''}<section class="card"><h2>${L('대회 정보', 'Tournament')}</h2>
      <div class="kv"><span>${L('이름', 'Name')}</span><span>${esc(labelText(t.name))}</span><span>${L('방식', 'Format')}</span><span>${FORMAT_NAMES[t.format]}</span><span>${L('경기', 'Match')}</span><span>${L(`${t.bestOf}판 ${Math.ceil(t.bestOf / 2)}선승 · 게임당 ${t.pointsToWin}점 · ${t.winBy}점 차`, `Best of ${t.bestOf} · ${t.pointsToWin} points a game · win by ${t.winBy}`)}</span><span>${L('시드', 'Seeds')}</span><span>${t.players.map((p, i) => `${i + 1}. ${esc(p)}`).join('  ')}</span></div>
    </section>
    <section class="card"><h2>${L('이 기기 화면', 'This screen')}</h2>
      <button class="btn" data-act="flip" aria-pressed="${S.flip}">${icon('swap')} ${L('내 자리에서 보기', 'View from my side')} · ${S.flip ? L('켜짐', 'On') : L('꺼짐', 'Off')}</button>
      <p class="hint">${L('이 기기 화면에서만 두 선수 카드 순서를 뒤집어요. 점수·엔드엔 영향 없어요.', 'Swaps the two player cards on this screen only. Scores and ends are not affected.')}</p>
    </section>
    <section class="card" data-card="lang"><h2>${L('언어', 'Language')}</h2>
      ${langSeg()}
      <p class="hint">${L('이 기기의 모든 화면(카메라 화면 포함)에 적용돼요.', 'Applies to every screen on this device, the camera screen too.')}</p>
    </section>
    <section class="card"><h2>${L('링크 공유', 'Share link')}</h2>
      <div class="url">${esc(url)}</div>
      <div class="row"><button class="btn grow" data-act="copy-link">${icon('link')} ${L('링크 복사', 'Copy link')}</button>${navigator.share ? `<button class="btn grow" data-act="share-link">${L('공유하기', 'Share')}</button>` : ''}</div>
      <p class="hint">${L('링크만 있으면 누구나 볼 수 있습니다. 점수 입력은 PIN을 입력한 기기에서만 됩니다.', 'Anyone with the link can watch. Scoring works only on a device with the PIN.')}</p>
    </section>
    <section class="card" id="pin-card"><h2>${L('기록 권한', 'Scoring access')}</h2>
      ${S.role === 'viewer' ? `<p class="hint">${L('관전 · 보기 전용', 'Viewer · view only')}${S.pin ? L(' · 이 기기에 PIN 저장됨', ' · PIN saved on this device') : ''}. ${L('점수를 기록하려면 심판 모드로 바꾸세요.', 'Switch to Referee mode to record scores.')}</p>${S.pin ? `<button class="btn" data-act="logout">${L('이 기기에서 PIN 지우기', 'Remove PIN from this device')}</button>` : ''}` : admin
        ? `<p class="hint">${L('이 기기는 점수를 기록할 수 있습니다.', 'This device can record scores.')}</p><div class="pinbig">${esc(S.pin)}</div><p class="hint">${L('점수를 기록할 사람에게만 이 PIN을 알려 주세요.', 'Share this PIN only with people who keep score.')}</p><button class="btn" data-act="logout">${L('이 기기에서 PIN 지우기', 'Remove PIN from this device')}</button>`
        : S.role === 'desk' ? `<p class="hint">${S.pin ? L('이 기기는 분석 데스크에 영상을 올릴 수 있어요.', 'This device can upload video to the Analysis desk.') : L('대회 PIN(4자리)을 입력하면 분석 데스크를 쓸 수 있어요.', 'Enter the tournament PIN (4 digits) to use the Analysis desk.')}</p>${S.pin ? `<button class="btn" data-act="logout">${L('이 기기에서 PIN 지우기', 'Remove PIN from this device')}</button>` : ''}`
          : `<p class="hint">${L('대회 PIN(4자리)을 입력하면 점수를 기록할 수 있습니다.', 'Enter the tournament PIN (4 digits) to record scores.')}</p>`}
      ${pinForm('pin')}
    </section>
    ${admin ? `<section class="card"><h2 class="fold-title">${foldHead('rename', L('참가자 이름 수정', 'Edit player names'), L(`${t.players.length}명`, `${t.players.length} players`))}</h2>
      ${foldRows('rename', t.players.map((p, i) => `<label class="field"><span>${L(`${i + 1}번 시드`, `Seed ${i + 1}`)}</span><input data-rename="${i}" value="${esc(p)}" maxlength="${NAME_MAX + 6}" autocomplete="off"></label>`), { few: L('처음', 'first') })}
      ${foldStore().rename === 'closed' ? '' : `<button class="btn" data-act="rename-save">${L('이름 저장', 'Save names')}</button>`}
    </section>
    <section class="card"><h2>${L('대진 관리', 'Bracket')}</h2>
      ${started(t)
        ? `<p class="hint">${L('경기가 시작되어 시드와 방식은 바꿀 수 없습니다. 잘못 입력한 점수는 경기 화면의 점수 취소로 되돌리세요.', 'Matches have started, so seeds and format are locked. Fix a wrong score with Undo point on the match screen.')}</p>`
        : `<button class="btn" data-act="setup-edit">${L('시드·방식·경기 길이 변경', 'Change seeds, format, length')}</button>`}
      <button class="btn danger" data-act="setup-new">${L('새 대회 만들기', 'New tournament')}</button>
    </section>` : ''}`;
}

// The one PIN form: 설정 (심판) and the camera's PIN dialog use the same field, check and memory.
const pinForm = (id) => `<form data-form="pin" class="keyform"><input id="${id}-input" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="one-time-code" placeholder="${L('4자리 숫자', '4 digits')}" aria-label="${L('대회 PIN', 'Tournament PIN')}"><button type="submit" class="btn primary">${L('PIN 저장', 'Save PIN')}</button><p class="err-text" id="${id}-err"></p></form>`;

// 카메라 goes in with the same tournament PIN as 심판 (owner decision): a device without it gets that
// PIN form in a dialog. The right PIN is remembered on the device as for 심판 and then opens the
// camera; a wrong one stays in the form, 취소 (or Esc, or back) leaves the device where it was.
let pinThen = null;
function askPin(then, who = L('카메라', 'Camera')) {
  pinThen = then;
  $modal.innerHTML = `<div class="card" role="dialog" aria-label="${who} PIN"><h2>${L(`${who} · 대회 PIN`, `${who} · Tournament PIN`)}</h2>
    <p class="hint">${L(`심판과 같은 대회 PIN(4자리)을 넣으면 ${who}로 들어가요. 이 기기에 기억해요.`, `Enter the same tournament PIN (4 digits) as the referee to open ${who}. This device remembers it.`)}</p>
    ${pinForm('cam-pin')}
    <button type="button" class="btn ghost full" data-act="modal-close">${L('취소', 'Cancel')}</button></div>`;
  $modal.addEventListener('close', () => { pinThen = null; }, { once: true });
  $modal.showModal();
  document.getElementById('cam-pin-input').focus();
}

function openPinSettings(message = '') {
  if (S.ref) leaveRef();
  go(() => { S.tab = 'settings'; S.setup = null; S.setupMode = null; S.histOpen = null; });
  const field = document.getElementById('pin-input');
  if (field) {
    document.getElementById('pin-err').textContent = message;
    field.focus();
  }
}

function showNewPin(pin) {
  $modal.innerHTML = `<div class="card">
    <h2>${L('대회가 만들어졌습니다', 'Tournament created')}</h2>
    <p class="hint">${L('점수 기록용 PIN입니다', 'This is the scoring PIN')}${S.state?.pinFixed ? L('(고정 PIN이라 새 대회에서도 같습니다)', ' (fixed, so it stays the same for new tournaments)') : ''}. ${L('이 기기에는 저장되었고, 설정 탭에서 다시 볼 수 있습니다.', 'It is saved on this device and shown again in the Settings tab.')}</p>
    <div class="pinbig">${esc(pin)}</div>
    <p class="hint">${L('점수를 기록할 사람에게만 알려 주세요. 링크만 받은 사람은 보기만 할 수 있습니다.', 'Share it only with people who keep score. People with just the link can only watch.')}</p>
    <button class="btn primary" data-act="modal-close">${L('확인', 'OK')}</button>
  </div>`;
  $modal.showModal();
}

const handlers = {
  back() {
    if ((history.state?.depth ?? 0) > baseDepth()) history.back();
    else goUp();
  },
  // The button stays sunk for a moment, so even a quick tap is seen to press it.
  start(b) {
    if (b.classList.contains('pressed')) return;
    b.classList.add('pressed');
    setTimeout(() => {
      sessionStorage.setItem('pp-started', '1');
      S.start = false;
      S.pickRole = true;
      history.pushState({ ...viewOf(), base: 1, depth: 1 }, '');
      render();
      window.scrollTo(0, 0);
    }, 130);
  },
  fold(b) {
    const key = b.dataset.key;
    foldSet(key, foldStore()[key] === 'closed' ? null : 'closed');
    refold(key);
  },
  'fold-all'(b) {
    const key = b.dataset.key;
    foldSet(key, foldStore()[key] === 'all' ? null : 'all');
    refold(key);
  },
  'role-pick'() {
    toPicker();
  },
  // A mode card keeps its pressed look for a moment, so even a quick tap or Enter is seen to press it.
  role(b) {
    if (b.classList.contains('role-card') && !b.dataset.go) {
      b.dataset.go = '1';
      b.classList.add('pressed');
      setTimeout(() => handlers.role(b), 130);
      return;
    }
    const role = b.dataset.role;
    if ((role === 'camera' || role === 'desk') && T() && !S.pin) {
      b.classList.remove('pressed');
      delete b.dataset.go;
      askPin(() => { b.dataset.go = '1'; handlers.role(b); }, ROLE_NAMES[role]);
      return;
    }
    S.role = role;
    S.pickRole = false;
    if (role !== 'referee') { S.setup = null; S.setupMode = null; if (S.ref) leaveRef(); }
    localStorage.setItem('pp-role', role);
    history.replaceState(viewOf(), '', location.pathname);
    if (role === 'camera') { sessionStorage.removeItem('pp-left-camera'); location.replace('/vision/'); return; }
    if (role === 'viewer') {
      S.sound = true;
      localStorage.setItem('pp-sound', '1');
      unlockSound();
    } else {
      syncSpeaker();
    }
    render();
  },
  'sound-on'() {
    S.sound = true;
    localStorage.setItem('pp-sound', '1');
    unlockSound();
    render();
  },
  'sound-off'() {
    S.sound = false;
    localStorage.setItem('pp-sound', '0');
    syncSpeaker();
    render();
  },
  'clip-latest'() {
    S.clip = null;
    render();
  },
  'clip-play'(b) {
    S.clip = { ...S.clip, index: b.dataset.index, pinned: true };
    render();
    const video = $app.querySelector('[data-clip-video]');
    video.pause();
    video.closest('.clip-now')?.scrollIntoView({ block: 'start' });
    openReplay(video.getAttribute('src'));
  },
  tab(b) {
    if (b.dataset.tab === S.tab && !S.histOpen && !analysisKey() && !judgeKey()) { window.scrollTo(0, 0); return; }
    go(() => {
      closeAnalysis();
      closeJudge();
      closePlayer();
      S.tab = b.dataset.tab;
      localStorage.setItem('pp-tab', S.tab);
      if (S.tab === 'history') {
        S.histOpen = null;
        loadHistory().catch((err) => toast(err.message, 'err'));
      }
    });
  },
  'hist-filter'(b) {
    S.histFav = b.dataset.fav === '1';
    render();
  },
  async 'hist-open'(b) {
    await openHistory(b.dataset.id);
    go(() => {});
  },
  'hist-back'() {
    handlers.back();
  },
  'hist-current'() {
    S.histOpen = null;
    handlers.tab({ dataset: { tab: 'match' } });
  },
  async 'hist-fav'(b) {
    const favorite = b.dataset.fav === '1';
    await api(`/api/history/${b.dataset.id}/favorite`, { favorite });
    await loadHistory();
    toast(favorite ? L('즐겨찾기에 추가했습니다.', 'Added to favourites.') : L('즐겨찾기를 해제했습니다.', 'Removed from favourites.'));
  },
  async 'hist-del'(b) {
    if (!(await ask(L(`'${b.dataset.name}' 기록을 삭제할까요? 목록에서 사라집니다.`, `Delete '${b.dataset.name}' history? It leaves the list.`), L('삭제', 'Delete'), true))) return;
    await api(`/api/history/${b.dataset.id}`, undefined, { method: 'DELETE' });
    await loadHistory();
    toast(L('기록을 삭제했습니다.', 'History deleted.'));
  },
  select(b) {
    S.selected = b.dataset.id;
    render();
  },
  open(b) {
    const m = D().matches.find((x) => x.id === b.dataset.id);
    if (m.status === 'pending') { toast(L('앞 경기 결과가 나오면 열립니다.', 'Opens when the earlier results are in.')); return; }
    go(() => {
      S.selected = m.id;
      S.tab = 'match';
      localStorage.setItem('pp-tab', S.tab);
    });
  },
  pin() {
    openPinSettings();
  },
  'modal-close'() { $modal.close(); },
  logout() {
    setPin(null);
    render();
    toast(L('이 기기는 이제 보기 전용입니다.', 'This device is now view only.'));
  },
  async point(b) {
    if (!isAdmin()) return openPinSettings();
    const now = performance.now();
    if (!acceptTap(S.lastTap, now)) return;
    S.lastTap = now;
    const m = pickMatch(D());
    S.selected = m.id;
    S.busy = true;
    render();
    navigator.vibrate?.(12);
    try {
      await api('/api/action', { type: 'point', matchId: m.id, side: Number(b.dataset.side), seq: m.points.length });
    } finally {
      S.busy = false;
      render();
    }
  },
  async undo() {
    const m = pickMatch(D());
    S.selected = m.id;
    S.busy = true;
    render();
    try {
      await api('/api/action', { type: 'undo', matchId: m.id, seq: m.points.length });
      toast(L('마지막 점수를 취소했습니다.', 'Last point undone.'));
    } finally {
      S.busy = false;
      render();
    }
  },
  async 'mark-flip'(b) {
    const m = pickMatch(D());
    const i = Number(b.dataset.index);
    if (!m || !(i < m.points.length)) return;
    const to = nameOf(m.players[1 - m.points[i]]);
    if (!(await ask(L(`${i + 1}번째 포인트를 ${to} 득점으로 바꿀까요? 뒤의 포인트는 그대로예요.`, `Give point ${i + 1} to ${to}? Later points stay.`), L('바꾸기', 'Swap')))) return;
    S.busy = true;
    render();
    try {
      await api('/api/action', { type: 'flip', matchId: m.id, index: i, seq: m.points.length });
      // said on a line of its own under the cards (a toast there lay over the 끝 색 확인 row and its buttons)
      S.refDone = L(`${i + 1}번째 포인트를 ${to} 득점으로 바꿨어요`, `Point ${i + 1} now goes to ${to}`);
      clearTimeout(S.refDoneTimer);
      S.refDoneTimer = setTimeout(() => { S.refDone = null; render(); }, 3000);
    } finally {
      S.busy = false;
      render();
    }
  },
  async 'mark-ok'(b) {
    const m = pickMatch(D());
    const i = Number(b.dataset.index);
    if (!m) return;
    S.busy = true;
    render();
    try {
      await api('/api/action', { type: 'mark', matchId: m.id, index: i, on: false });
    } finally {
      S.busy = false;
      render();
    }
  },
  lang(b) {
    setLang(b.dataset.lang);
  },
  flip() {
    S.flip = !S.flip;
    localStorage.setItem('pp-flip', S.flip ? '1' : '0');
    render();
  },
  // A hand fix of who stands at which end, for every screen (the rules change ends by themselves).
  async 'ends-swap'() {
    const m = pickMatch(D());
    if (!m) return;
    S.refNotice = null;
    S.busy = true;
    render();
    try {
      await api('/api/action', { type: 'ends', matchId: m.id, blue: m.ends[1] });
    } finally {
      S.busy = false;
      render();
    }
  },
  'notice-close'() {
    S.refNotice = null;
    render();
  },
  async 'ref-enter'() {
    go(() => {
      S.ref = true;
      S.refNotice = null;
    });
    const el = document.documentElement;
    if (el.requestFullscreen && !document.fullscreenElement) await el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    await screen.orientation?.lock?.('landscape').catch(() => {});
    if (!document.fullscreenEnabled) toast(L('주소창까지 숨기려면 공유 → 홈 화면에 추가로 연 뒤 휴대폰을 가로로 돌리세요.', 'To hide the address bar too, open it from Share → Add to Home Screen and turn the phone sideways.'));
  },
  'ref-exit'() {
    handlers.back();
  },
  async 'ref-fs'() {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    else await document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    render();
  },
  'ref-next'() {
    S.selected = D().current?.id ?? null;
    S.refNotice = null;
    render();
  },
  async 'undo-hint'(b, e) {
    if (e.detail === 0) { await handlers.undo(); return; }
    toast(L('점수 취소는 버튼을 길게 눌러 주세요.', 'Hold the button to undo a point.'));
  },
  async hc(b) {
    const m = pickMatch(D());
    const h = [...m.handicap];
    h[Number(b.dataset.side)] += Number(b.dataset.d);
    S.busy = true;
    render();
    try {
      await api('/api/action', { type: 'handicap', matchId: m.id, handicap: h });
    } finally {
      S.busy = false;
      render();
    }
  },
  async 'first-server'() {
    const m = pickMatch(D());
    S.busy = true;
    render();
    try {
      await api('/api/action', { type: 'firstServer', matchId: m.id, side: 1 - m.firstServer });
      const now = D().matches.find((x) => x.id === m.id);
      toast(L(`서브: ${nameOf(now.players[now.score.server])}`, `Serve: ${nameOf(now.players[now.score.server])}`));
    } finally {
      S.busy = false;
      render();
    }
  },
  'draft-set'(b) {
    ensureDraft()[b.dataset.key] = b.dataset.key === 'bestOf' ? Number(b.dataset.val) : b.dataset.val;
    render();
  },
  'seed-add'() {
    const d = ensureDraft();
    if (d.players.length < MAX_PLAYERS) d.players.push('');
    render();
  },
  'seed-remove'(b) {
    const d = ensureDraft();
    if (d.players.length <= MIN_PLAYERS) return;
    d.players.splice(Number(b.dataset.i), 1);
    render();
  },
  'seed-move'(b) {
    const d = ensureDraft();
    const i = Number(b.dataset.i);
    const j = i + Number(b.dataset.dir);
    [d.players[i], d.players[j]] = [d.players[j], d.players[i]];
    render();
  },
  shuffle() {
    const d = ensureDraft();
    const a = d.players;
    for (let i = a.length - 1; i > 0; i--) {
      const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    render();
    toast(L('시드를 무작위로 추첨했습니다.', 'Seeds shuffled.'));
  },
  'person-pick'(b) {
    const input = document.querySelector(`[data-draft="p${b.dataset.i}"]`);
    input.value = b.dataset.entry;
    ensureDraft().players[Number(b.dataset.i)] = b.dataset.entry;
    showPeople(input);
    checkSeed(input);
  },
  'setup-cancel'() {
    handlers.back();
  },
  'setup-edit'() {
    go(() => {
      S.setup = null;
      S.setupMode = 'edit';
    });
  },
  async 'setup-new'() {
    if (!(await ask(L('새 대회를 만들까요? 지금 대회는 보관되고 화면에서 사라집니다.', 'Create a new tournament? The current one is archived and leaves the screen.'), L('새 대회 만들기', 'New tournament'), true))) return;
    go(() => {
      S.setup = null;
      S.setupMode = 'new';
    });
  },
  async 'setup-submit'() {
    if (S.role !== 'referee') return;
    const d = ensureDraft();
    if (S.setupMode === 'edit') {
      await api('/api/action', { type: 'setup', players: d.players, format: d.format, bestOf: d.bestOf });
      toast(L('대진을 변경했습니다.', 'Bracket changed.'));
    } else {
      const res = await api('/api/tournament', d, { pin: Boolean(T()) });
      setPin(res.pin);
      showNewPin(res.pin);
    }
    stay(() => {
      S.setup = null;
      S.setupMode = null;
      S.selected = null;
      S.tab = 'match';
      localStorage.setItem('pp-tab', S.tab);
    });
  },
  async 'rename-save'() {
    const t = T();
    const inputs = [...document.querySelectorAll('[data-rename]')];
    let changed = 0;
    for (const input of inputs) {
      const i = Number(input.dataset.rename);
      const name = input.value.trim();
      if (name !== t.players[i]) {
        await api('/api/action', { type: 'rename', index: i, name });
        changed++;
      }
    }
    document.activeElement?.blur();
    toast(changed ? L('이름을 저장했습니다.', 'Names saved.') : L('바뀐 이름이 없습니다.', 'No names changed.'));
    render();
  },
  async 'copy-link'() {
    const url = location.origin + '/';
    try {
      await navigator.clipboard.writeText(url);
      toast(L('링크를 복사했습니다.', 'Link copied.'));
    } catch {
      prompt(L('이 링크를 복사하세요', 'Copy this link'), url);
    }
  },
  async 'share-link'() {
    await navigator.share({ title: T().name, url: location.origin + '/' }).catch(() => {});
  },
  ...analysisHandlers,
  ...judgeHandlers,
  ...playerHandlers,
  ...deskHandlers,
};
// 경기 분석 (analysis-view.js), 선수 (player-view.js) and 분석 데스크 (desk-view.js) draw through the app's
// own render, navigation, dialogs and PIN memory.
bindAnalysis({ render, go, openReplay, esc });
bindJudge({ render, go, esc });
bindPlayer({ render, go, esc, api, icon, pin: () => S.pin, foldHead, foldRows, openHistory });
bindDesk({ render, go, esc, api, ask, icon, pinForm, pin: () => S.pin, tournament: T, openHistory, foldHead, foldRows });
bindPeoplePick(() => S.pin);

document.addEventListener('click', async (e) => {
  if (isHoldRelease(S.pressedAt, S.holdFiredAt)) {
    S.holdFiredAt = null;
    return;
  }
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const fn = handlers[b.dataset.act];
  if (!fn) return;
  try {
    await fn(b, e);
  } catch (err) {
    toast(err.message, 'err');
  }
});

let holdTimer = null;
document.addEventListener('pointerdown', (e) => {
  S.pressedAt = performance.now();
  if (S.role === 'viewer' && S.sound && !S.soundUnlocked) {
    unlockSound();
    // after the click: a render here replaces the button under the finger and the tap is lost
    document.addEventListener('click', render, { once: true });
  }
  const b = e.target.closest('[data-hold]');
  if (!b || b.disabled) return;
  b.classList.add('holding');
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    holdTimer = null;
    S.holdFiredAt = performance.now();
    handlers.undo().catch((err) => toast(err.message, 'err'));
  }, UNDO_HOLD_MS);
});
for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(type, () => {
    if (!holdTimer) return;
    clearTimeout(holdTimer);
    holdTimer = null;
    document.querySelector('.holding')?.classList.remove('holding');
  });
}
// Mode cards take their colour only while held: off again when the finger slides off, lets go
// without a click, or the page comes back from the back-forward cache.
let pressedCard = null;
const unpress = () => { pressedCard?.classList.remove('pressed'); pressedCard = null; };
document.addEventListener('pointerdown', (e) => {
  const c = e.target.closest?.('.role-card');
  if (!c) return;
  pressedCard = c;
  c.classList.add('pressed');
});
document.addEventListener('pointermove', (e) => {
  if (!pressedCard) return;
  const r = pressedCard.getBoundingClientRect();
  pressedCard.classList.toggle('pressed', e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom);
});
for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, unpress);
document.addEventListener('keydown', (e) => {
  if (e.key === ' ' && e.target.matches?.('.role-card')) { pressedCard = e.target; e.target.classList.add('pressed'); }
});
document.addEventListener('keyup', unpress);
document.addEventListener('focusout', (e) => { if (e.target === pressedCard) unpress(); });
addEventListener('pageshow', () => document.querySelectorAll('.role-card.pressed').forEach((c) => { c.classList.remove('pressed'); delete c.dataset.go; }));
document.addEventListener('fullscreenchange', () => { if (S.ref) render(); });
// A clip deleted on the PC (or one the server cannot read) says so instead of staying black.
document.addEventListener('error', (e) => {
  if (e.target.matches?.('[data-clip-video]')) toast(L('이 랠리 영상을 열 수 없어요. PC에서 지워졌을 수 있어요.', 'Cannot open this rally video. It may have been deleted on the PC.'), 'err');
}, true);
// A portrait clip (a phone filming upright) gets a tall box instead of being shrunk into the 16:9 one.
document.addEventListener('loadedmetadata', (e) => {
  const v = e.target;
  if (v.matches?.('[data-clip-video]')) v.classList.toggle('is-tall', v.videoHeight > v.videoWidth);
}, true);
// Turning the phone draws the referee screen again, as a fresh load at the new size: on the owner's iPhone
// (2026-11-01) the bar came back from landscape one row short and the cards covered 엔드 바꾸기 and the match line.
let upright = innerHeight > innerWidth;
addEventListener('resize', () => {
  const turned = upright !== innerHeight > innerWidth;
  upright = innerHeight > innerWidth;
  if ((S.ref && turned) || viewerLayout(S.role, innerWidth, innerHeight) !== S.tvLayout) render();
});

document.addEventListener('input', (e) => {
  const key = e.target.dataset?.draft;
  if (!key) return;
  const d = ensureDraft();
  if (key === 'name') d.name = e.target.value;
  else {
    d.players[Number(key.slice(1))] = e.target.value;
    showPeople(e.target);
    checkSeed(e.target);
  }
});

// The name dropdown: Up/Down (keyboard or TV remote) move through it, Enter picks, Esc closes.
document.addEventListener('keydown', (e) => {
  const input = e.target.closest?.('input[role="combobox"]');
  const list = input && document.getElementById(input.getAttribute('aria-controls'));
  if (!list || list.hidden) return;
  const opts = [...list.children];
  const cur = opts.findIndex((o) => o.id === input.getAttribute('aria-activedescendant'));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = Math.max(-1, Math.min(opts.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
    opts.forEach((o, k) => o.setAttribute('aria-selected', String(k === next)));
    if (next < 0) input.removeAttribute('aria-activedescendant');
    else input.setAttribute('aria-activedescendant', opts[next].id);
  } else if (e.key === 'Enter' && cur >= 0) {
    e.preventDefault();
    handlers['person-pick'](opts[cur]);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    checkSeed(input);
  }
});
// A touch or click on a row keeps the focus in the field, so the row is still there for its click.
document.addEventListener('pointerdown', (e) => { if (e.target.closest?.('.seed-opt')) e.preventDefault(); });
for (const type of ['focusin', 'focusout']) {
  document.addEventListener(type, (e) => {
    if (!e.target.matches?.('input[role="combobox"]')) return;
    showPeople(e.target);
    checkSeed(e.target);
  });
}

document.addEventListener('focusout', () => {
  setTimeout(() => { if (S.pendingRender && !isTyping()) render(); }, 0);
});

document.addEventListener('submit', async (e) => {
  if (e.target.dataset.form !== 'pin') return;
  e.preventDefault();
  const field = e.target.querySelector('input');
  const pin = field.value.trim();
  const err = e.target.querySelector('.err-text');
  if (!/^\d{4}$/.test(pin)) { err.textContent = L('4자리 숫자를 입력하세요.', 'Enter 4 digits.'); return; }
  try {
    const res = await fetch('/api/pin/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { err.textContent = errorText(data, L('PIN을 확인하지 못했습니다.', 'Could not check the PIN.')); return; }
    setPin(pin);
    field.blur();
    if (pinThen) {
      const then = pinThen;
      $modal.close();
      then();
      return;
    }
    render();
    toast(S.role === 'viewer' ? L('PIN을 저장했습니다. 관전은 보기 전용입니다.', 'PIN saved. Viewer mode is view only.') : L('이 기기에서 점수를 기록할 수 있습니다.', 'This device can now record scores.'));
  } catch {
    err.textContent = L('서버에 연결하지 못했습니다.', 'Could not reach the server.');
  }
});

let ws;
let retry = 0;
let heartbeat;

// The camera count shown (카메라 1대 / 2대 합치기) changes only once a new count has held for
// CAMERA_SETTLE_MS: a phone busy loading its model goes quiet for a few seconds, and the screens
// should not flick 2-1-2 (with a toast each time) meanwhile.
const CAMERA_SETTLE_MS = 4000;
function applyCameras(matches) {
  S.cameraLatest = matches;
  const id = D() && pickMatch(D())?.id;
  const count = (all) => cameraMode(all?.[id] ?? [])?.count ?? 0;
  if (!S.cameraMatches || count(matches) === count(S.cameraMatches)) {
    clearTimeout(S.cameraTimer);
    S.cameraTimer = null;
    S.cameraMatches = matches;
    render();
    return;
  }
  // the list is sent again on every status, so keep a running wait for the same new count
  if (S.cameraTimer && count(matches) === S.cameraPending) return;
  clearTimeout(S.cameraTimer);
  S.cameraPending = count(matches);
  S.cameraTimer = setTimeout(() => {
    S.cameraTimer = null;
    const before = count(S.cameraMatches);
    const after = count(S.cameraLatest);
    if (S.tab === 'match' && (S.role === 'viewer' || S.role === 'referee')) {
      const title = document.querySelector('.top .top-title');
      const at = title?.offsetWidth ? title.getBoundingClientRect() : null;
      if (before === 1 && after === 2) toast(L('카메라 2대로 전환', 'Switched to 2 cameras'), '', at);
      if (before === 2 && after === 1) toast(L('카메라 1대로 전환', 'Switched to 1 camera'), '', at);
    }
    S.cameraMatches = S.cameraLatest;
    render();
  }, CAMERA_SETTLE_MS);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 0;
    S.conn = 'online';
    clearInterval(heartbeat);
    heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, 25_000);
    render();
  };
  ws.onmessage = (ev) => {
    if (ev.data === 'pong') return;
    const msg = JSON.parse(ev.data);
    if (msg.type === 'hello') {
      S.connId = msg.conn;
      S.cameraMatches = null;
      clearTimeout(S.cameraTimer);
      S.speaker = null;
      syncSpeaker();
      return;
    }
    if (msg.type === 'cameras') {
      applyCameras(msg.matches);
      return;
    }
    if (msg.type === 'presence') {
      S.cameras = msg.cameras;
      S.speaker = msg.speaker;
      render();
      return;
    }
    if (msg.type === 'say') {
      if (S.role === 'viewer' && S.sound) speak(EN && msg.en ? msg.en : msg.text);
      return;
    }
    if (msg.type === 'state') applyState(msg.state);
    if (S.tab === 'history' && S.history && !S.ref) loadHistory().catch((err) => toast(err.message, 'err'));
  };
  ws.onclose = () => {
    clearInterval(heartbeat);
    S.conn = 'offline';
    render();
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 500 * retry);
  };
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  connect();
  fetch('/api/state').then((r) => r.json()).then(applyState).catch(() => {});
  syncWakeLock();
});

let wakeLock = null;
async function syncWakeLock() {
  const want = S.tab === 'match' && isAdmin() && document.visibilityState === 'visible';
  try {
    if (want && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}

async function boot() {
  const state = await fetch('/api/state').then((r) => r.json());
  applyState(state);
  connect();
  if (S.tab === 'history') loadHistory().catch((err) => toast(err.message, 'err'));
  if (S.pin && state.tournament) {
    const res = await fetch('/api/pin/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: S.pin }) });
    if (res.status === 403) {
      setPin(null);
      render();
    }
  }
}

render();
boot().catch(() => {
  $app.innerHTML = `<p class="loading">${L('서버에 연결하지 못했습니다. 잠시 뒤 새로고침해 주세요.', 'Could not reach the server. Please reload in a moment.')}</p>`;
  setTimeout(() => location.reload(), 5000);
});
