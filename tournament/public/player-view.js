// 선수: one person's record across tournaments and desk videos (screen 'player' in app.js), opened
// from the 기록 tab's 선수 list or a name on the analysis sheet. Reads GET /api/analysis/person/:ref
// (calendar, trend, won vs lost) and /pose (two periods of one technique); names only, never the four
// digits. The PIN-only tool at the end writes aliases through /api/players and can undo each one.
// app.js hands over render, go, esc, api, icon, pin, foldHead, foldRows and openHistory once.
import { TECH_LABELS, analysisKey, analysisOpenedAt, openAnalysis } from '/analysis-view.js';
import { TECH_KEYS } from '/analysis.js';
import { codeOf, resolveKey } from '/person.js';
import { forgetPeople, nameOf, normalizeKey, peopleEntries } from '/people-pick.js';
import { L, LOCALE, errorText } from './i18n.js';
import { labelText } from './engine.js';
import { MIN_SHOTS } from './pose-stats.js';

const METRICS = [
  ['elbowDeg', L('팔꿈치 각', 'Elbow angle'), '°', L('180이 쭉 편 팔', '180 = straight arm')],
  ['kneeBendDeg', L('무릎 굽힘', 'Knee bend'), '°', L('0이 쭉 편 다리', '0 = straight leg')],
  ['trunkRotationDeg', L('몸통 회전', 'Trunk rotation'), '°', L('어깨 선과 엉덩이 선 사이', 'between shoulder and hip lines')],
  ['handHeight', L('라켓 손 높이', 'Racket hand height'), '', L('몸통 길이 단위, 엉덩이 위가 +', 'in torso lengths, above the hips is +')],
];
const AT_LABELS = [L('0.77초 전', '0.77 s before'), L('0.4초 전', '0.4 s before'), L('공 맞는 순간', 'At impact')];
// the segment has three narrow buttons on a phone; the captions keep the long name
const AT_SHORT = [L('0.77초 전', '-0.77 s'), L('0.4초 전', '-0.4 s'), L('맞는 순간', 'Impact')];
const DOW = [L('월', 'Mon'), L('화', 'Tue'), L('수', 'Wed'), L('목', 'Thu'), L('금', 'Fri'), L('토', 'Sat'), L('일', 'Sun')];
// Bones over the desk's 23 joints (the nose, then MediaPipe 11..32): torso, arms with hands, legs with feet.
const BONES = [[1, 2], [1, 13], [2, 14], [13, 14], [1, 3], [3, 5], [2, 4], [4, 6], [5, 7], [5, 9], [5, 11], [7, 9], [6, 8], [6, 10], [6, 12], [8, 10], [13, 15], [15, 17], [14, 16], [16, 18], [17, 19], [19, 21], [17, 21], [18, 20], [20, 22], [18, 22]];
const SWATCH_A = '<svg viewBox="0 0 28 14" aria-hidden="true"><line class="pl-sw-a" x1="2" y1="7" x2="26" y2="7"/><circle class="pl-sw-a-dot" cx="14" cy="7" r="3.5"/></svg>';
const SWATCH_B = '<svg viewBox="0 0 28 14" aria-hidden="true"><line class="pl-sw-b" x1="2" y1="7" x2="26" y2="7"/><rect class="pl-sw-b-dot" x="10.5" y="3.5" width="7" height="7"/></svg>';
const PLAY = '<svg class="an-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>';

let app = null;
// The open page: which person (by public ref), what it asked for and what came back.
let page = null;
// The public people list for the 기록 tab and for labels: { list, at }.
let people = null;
let peopleLoading = null;

export function bindPlayer(deps) { app = deps; }
export const playerKey = () => page?.ref ?? null;
export function closePlayer() { page = null; }

// Which stacked screen is on top when both are open: the one opened later.
export function topOverlay() {
  if (page && (!analysisKey() || page.at > analysisOpenedAt())) return 'player';
  return analysisKey() ? 'analysis' : null;
}

const esc = (s) => app.esc(s);
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const thisMonth = () => kstToday().slice(0, 7);
const shiftMonth = (ym, by) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + by, 1)); return d.toISOString().slice(0, 7); };
// no-break spaces: a date never splits across lines
const fmtDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? '')); return m ? L(`${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일`, new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString(LOCALE, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })) : L('날짜 모름', 'Date unknown'); };
const monthShort = (y, m) => new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleDateString(LOCALE, { year: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtMonth = (ym) => { const [y, m] = ym.split('-'); return L(`${y}년 ${Number(m)}월`, monthShort(y, m)); };
const matchesN = (n) => L(`경기 ${n}개`, `${n} ${n === 1 ? 'match' : 'matches'}`);
const clipsN = (n) => L(`클립 ${n}개`, `${n} ${n === 1 ? 'clip' : 'clips'}`);
const shotsN = (n) => L(`샷 ${n}개`, `${n} ${n === 1 ? 'shot' : 'shots'}`);
const pct = (a, n) => `${Math.round((a / n) * 100)}%`;
const card = (title, body, cls = '') => `<section class="card ${cls}"><h2>${title}</h2>${body}</section>`;
const none = `<span class="an-none">${L('없음', 'None')}</span>`;

export function openPlayer(ref) {
  page = {
    ref, at: performance.now(), month: thisMonth(), period: 'month', data: null, error: null, loading: false, loadedFor: null, day: null,
    tech: 'fore-attack', a: shiftMonth(thisMonth(), -1), b: thisMonth(), atIdx: 2, pose: null, poseError: null, poseLoading: false, poseFor: null,
    view: { yaw: -0.7, pitch: 0.3 },
    tool: { key: undefined, resolving: false, aliases: null, name: '', target: '', typedKey: '', keyError: null, busy: false, error: null, done: null },
  };
}

// Back or forward landed on a history entry: show the page it names, or none.
export function syncPlayer(ref) {
  if ((ref ?? null) === playerKey()) return;
  if (!ref) { page = null; return; }
  openPlayer(ref);
}

// ---------- data ----------

async function load(p) {
  p.loading = true;
  p.error = null;
  p.loadedFor = `${p.month}|${p.period}`;
  try {
    const res = await fetch(`/api/analysis/person/${encodeURIComponent(p.ref)}?month=${p.month}&period=${p.period}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorText(data, L('선수 기록을 불러오지 못했어요.', 'Could not load the player record.')));
    p.data = data;
  } catch (e) {
    p.error = e instanceof TypeError ? L('서버에 연결하지 못했어요.', 'Could not reach the server.') : e.message;
  }
  p.loading = false;
  if (page === p) app.render();
}

async function loadPose(p) {
  p.poseLoading = true;
  p.poseError = null;
  p.poseFor = `${p.tech}|${p.a}|${p.b}`;
  try {
    const res = await fetch(`/api/analysis/person/${encodeURIComponent(p.ref)}/pose?tech=${p.tech}&a=${p.a}&b=${p.b}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorText(data, L('자세를 불러오지 못했어요.', 'Could not load the pose.')));
    p.pose = data;
  } catch (e) {
    p.pose = null;
    p.poseError = e instanceof TypeError ? L('서버에 연결하지 못했어요.', 'Could not reach the server.') : e.message;
  }
  p.poseLoading = false;
  if (page === p) app.render();
}

async function loadPeople() {
  peopleLoading = (async () => {
    try {
      const res = await fetch('/api/analysis/people');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(data, L('선수 목록을 불러오지 못했어요.', 'Could not load the player list.')));
      people = { list: data.people, at: Date.now(), error: null };
    } catch (e) {
      people = { list: null, at: Date.now(), error: e instanceof TypeError ? L('서버에 연결하지 못했어요.', 'Could not reach the server.') : e.message };
    }
    peopleLoading = null;
    app.render();
  })();
  return peopleLoading;
}

const labelOf = (ref) => people?.list?.find((x) => x.ref === ref)?.label ?? '';

// ---------- the page ----------

export function playerView() {
  const p = page;
  if (!p.loading && p.loadedFor !== `${p.month}|${p.period}`) load(p);
  if (!people && !peopleLoading) loadPeople();
  if (!p.data) return `<div class="player">${p.error ? `<section class="card an-empty pl-span"><p class="warn">${esc(p.error)}</p><button class="btn primary" data-act="pl-retry">${L('다시 시도', 'Retry')}</button></section>` : `<p class="loading pl-span">${L('선수 기록을 불러오는 중…', 'Loading player record…')}</p>`}</div>`;
  const d = p.data;
  queueMicrotask(paintAll);
  const last = d.matches[0];
  const head = `<p class="pl-headline pl-span"><b>${esc(d.person.name)}${esc(labelOf(d.person.ref))}</b> · ${matchesN(d.matches.length)}${last ? ` · ${L('마지막 경기', 'Last match')} ${fmtDate(last.date)}` : ''}${p.error ? ` · ${L('새로 고침 실패', 'Refresh failed')}: ${esc(p.error)}` : ''}</p>`;
  return `<div class="player">${head}
    ${card(L('달력', 'Calendar'), calendar(p, d))}
    ${card(L('추이', 'Trend'), trend(p, d))}
    ${card(L('이긴 경기와 진 경기', 'Won and lost matches'), winLoss(d))}
    ${card(L('자세 비교', 'Pose comparison'), pose(p))}
    ${tool(p, d)}
  </div>`;
}

function calendar(p, d) {
  const [y, m] = p.month.split('-').map(Number);
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const byDate = new Map(d.calendar.days.map((day) => [day.date, day]));
  const cell = (n) => {
    const date = `${p.month}-${String(n).padStart(2, '0')}`;
    const day = byDate.get(date);
    if (!day) return `<span class="pl-day"><b>${n}</b></span>`;
    const first = day.matches[0];
    const result = first.won === null ? '' : first.won ? L('승', 'W') : L('패', 'L');
    const more = day.matches.length > 1 ? `<small>${L(`+${day.matches.length - 1}경기`, `+${day.matches.length - 1}`)}</small>` : '';
    const clips = day.clips ? `<small class="pl-clips">${PLAY}${day.clips}</small>` : '';
    return `<button type="button" class="pl-day has" data-act="pl-day" data-date="${date}" aria-pressed="${p.day === date}" aria-label="${L(`${n}일`, `Day ${n}`)} · ${matchesN(day.matches.length)}${day.clips ? ` · ${clipsN(day.clips)}` : ''}">
      <b>${n}</b><small class="pl-score">${first.score.me}:${first.score.them}</small>${result ? `<small class="${first.won ? 'pl-win' : 'pl-lose'}">${result}</small>` : ''}${more || clips}</button>`;
  };
  const cells = [...Array.from({ length: lead }, () => '<span class="pl-day blank" aria-hidden="true"></span>'), ...Array.from({ length: count }, (_, i) => cell(i + 1))];
  const picked = p.day?.startsWith(p.month) ? byDate.get(p.day) : null;
  const list = picked
    ? `<ul class="pl-daylist">${picked.matches.map((x) => `<li><span class="pl-dm"><b>${esc(labelText(x.title))}</b><small>${L(`${esc(labelText(x.opponent))} 상대`, `vs ${esc(labelText(x.opponent))}`)} · ${x.score.me}:${x.score.them} ${x.won === null ? L('· 승패 없음', '· No result') : x.won ? L('승', 'Won') : L('패', 'Lost')} · ${clipsN(x.clips)}</small></span><button class="btn pl-sheet" data-act="pl-sheet" data-kind="${x.kind}" data-id="${esc(x.id)}">${L('분석 보기', 'View analysis')}</button></li>`).join('')}</ul>`
    : d.calendar.days.length ? `<p class="hint">${L('경기가 있는 날을 누르면 그날 경기가 여기에 나와요.', 'Tap a day with a match to see that day\'s matches here.')}</p>` : `<p class="hint">${L(`${m}월에는 경기가 없어요.`, `No matches in ${fmtMonth(p.month)}.`)}</p>`;
  return `<div class="pl-monthnav"><button class="icon-btn" data-act="pl-month" data-dir="-1" aria-label="${L('지난달', 'Previous month')}">${app.icon('back')}</button><b>${fmtMonth(p.month)}</b><button class="icon-btn" data-act="pl-month" data-dir="1" aria-label="${L('다음 달', 'Next month')}" ${p.month >= thisMonth() ? 'disabled' : ''}>${app.icon('next')}</button></div>
    <div class="pl-cal" aria-label="${L(`${fmtMonth(p.month)} 달력`, `${fmtMonth(p.month)} calendar`)}">${DOW.map((w) => `<span class="pl-dow">${w}</span>`).join('')}${cells.join('')}</div>
    <p class="hint">${L(`숫자는 나:상대예요. 대회 경기는 이긴 게임 수, 데스크 영상은 득점 수예요. ${PLAY} 뒤의 숫자는 그날 클립 수예요.`, `Scores read me:opponent. Tournament matches show games won, desk videos show points. The number after ${PLAY} is that day's clip count.`)}</p>${list}`;
}

const periodName = (period, unit) => (unit === 'week' ? L(`${Number(period.slice(5, 7))}/${Number(period.slice(8, 10))} 주`, `Wk ${Number(period.slice(5, 7))}/${Number(period.slice(8, 10))}`) : L(`${period.slice(2, 4)}년 ${Number(period.slice(5, 7))}월`, monthShort(period.slice(0, 4), period.slice(5, 7))));

function trend(p, d) {
  const seg = `<div class="seg" role="radiogroup" aria-label="${L('기간 단위', 'Period unit')}">${[['week', L('주별', 'Weekly')], ['month', L('월별', 'Monthly')]].map(([v, label]) => `<button type="button" role="radio" aria-checked="${p.period === v}" class="seg-btn ${p.period === v ? 'on' : ''}" data-act="pl-period" data-period="${v}"><b>${label}</b></button>`).join('')}</div>`;
  if (!d.trend.length) return `${seg}<p class="hint">${L('승패가 난 경기가 아직 없어요.', 'No decided matches yet.')}</p>`;
  const rows = d.trend.map((r) => {
    const tech = TECH_KEYS.reduce((s, k) => ({ n: s.n + r.tech[k].n, ok: s.ok + r.tech[k].ok }), { n: 0, ok: 0 });
    return { label: periodName(r.period, p.period), played: r.played, won: r.won, tech };
  });
  const table = `<table class="an-table pl-trend"><thead><tr><th scope="col">${L('기간', 'Period')}</th><th scope="col">${L('경기', 'Matches')}</th><th scope="col">${L('승률', 'Win rate')}</th><th scope="col">${L('기술 성공률', 'Tech success')}</th></tr></thead><tbody>${rows.map((r) => `<tr><th scope="row">${r.label}</th><td>${r.played}</td><td><b>${pct(r.won, r.played)}</b><small>${r.won}/${r.played}</small></td><td>${r.tech.n ? `<b>${pct(r.tech.ok, r.tech.n)}</b><small>${r.tech.ok}/${r.tech.n}</small>` : none}</td></tr>`).join('')}</tbody></table>`;
  return `${seg}${trendChart(rows)}${table}<p class="hint">${L('승률은 승패가 난 경기만 세요. 기술 성공률은 그 기간 샷 전체의 성공 비율이고, 뒤의 숫자가 표본이에요.', 'Win rate counts decided matches only. Tech success is the share of all shots in the period that succeeded; the small number is the sample.')}</p>`;
}

// Two lines over the periods, oldest left: win rate (circles, solid) and technique success (squares, dashed).
function trendChart(rows) {
  // `left`, not L: L is the i18n text helper used in the aria-label below.
  const W = 320; const H = 132; const left = 34; const R = 10; const T = 10; const B = 26;
  const n = rows.length;
  const x = (i) => (n === 1 ? (left + W - R) / 2 : left + ((W - left - R) * i) / (n - 1));
  const y = (r) => T + (H - T - B) * (1 - r);
  const series = (vals, cls, marker) => {
    const pts = vals.map((v, i) => (v === null ? null : [x(i), y(v)]));
    let path = '';
    pts.forEach((pt, i) => { if (pt) path += `${pts[i - 1] ? 'L' : 'M'}${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`; });
    const marks = pts.map((pt) => (pt ? marker(pt) : '')).join('');
    return `<path class="${cls}" d="${path}"/>${marks}`;
  };
  const win = rows.map((r) => r.won / r.played);
  const tech = rows.map((r) => (r.tech.n ? r.tech.ok / r.tech.n : null));
  const grid = [0, 0.5, 1].map((v) => `<line class="pl-grid" x1="${left}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}"/><text class="pl-axis" x="${left - 4}" y="${y(v) + 4}" text-anchor="end">${v * 100}%</text>`).join('');
  const labels = (n === 1 ? [0] : [0, n - 1]).map((i) => `<text class="pl-axis" x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : 'end'}">${rows[i].label}</text>`).join('');
  return `<svg class="pl-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${L(`승률과 기술 성공률 추이, ${n}개 기간`, `Win rate and tech success trend, ${n} ${n === 1 ? 'period' : 'periods'}`)}">${grid}
    ${series(tech, 'pl-line-b', ([px, py]) => `<rect class="pl-dot-b" x="${(px - 3.5).toFixed(1)}" y="${(py - 3.5).toFixed(1)}" width="7" height="7"/>`)}
    ${series(win, 'pl-line-a', ([px, py]) => `<circle class="pl-dot-a" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4"/>`)}${labels}</svg>
    <p class="an-legend pl-legend"><span>${SWATCH_A}${L('승률', 'Win rate')}</span><span>${SWATCH_B}${L('기술 성공률', 'Tech success')}</span></p>`;
}

function winLoss(d) {
  const { won, lost } = d.winLoss;
  if (!won.matches && !lost.matches) return `<p class="hint">${L('분석이 있는 승패 경기가 아직 없어요. 카메라로 찍은 대회 경기나 데스크 영상이 쌓이면 비교해요.', 'No decided matches with analysis yet. Camera-recorded tournament matches and desk videos will be compared once they pile up.')}</p>`;
  const rate = (v) => (v.n ? `<b>${Math.round(v.rate * 100)}%</b><small>${v.n}</small>` : none);
  const speed = (v) => (v.n ? `<b>${Math.round(v.avgKmh)} km/h</b><small>${v.n}</small>` : none);
  const row = (label, a, b) => `<tr><th scope="row">${label}</th><td>${a}</td><td>${b}</td></tr>`;
  const rows = [
    row(L('경기 수', 'Matches'), `<b>${won.matches}</b>`, `<b>${lost.matches}</b>`),
    row(L('서브 득점률', 'Serve point rate'), rate(won.serve), rate(lost.serve)),
    row(L('리시브 득점률', 'Receive point rate'), rate(won.receive), rate(lost.receive)),
    ...TECH_KEYS.map((k) => row(TECH_LABELS[k], rate(won.tech[k]), rate(lost.tech[k]))),
    ...won.length.map((l, i) => row(L(`${l.label} 승률`, `${l.label} win rate`), rate(l), rate(lost.length[i]))),
    row(L('평균 샷 속도', 'Avg shot speed'), speed(won.speed), speed(lost.speed)),
  ];
  return `<table class="an-table pl-wl"><thead><tr><th scope="col">${L('항목 · 비율과 표본', 'Item · rate and sample')}</th><th scope="col">${L('이긴 경기', 'Won matches')}</th><th scope="col">${L('진 경기', 'Lost matches')}</th></tr></thead><tbody>${rows.join('')}</tbody></table>
    <p class="hint">${L('경기마다 평균하지 않고 포인트와 샷을 모두 더해 냈어요. 작은 숫자가 그 표본이에요. 분석이 없는 경기와 승패가 안 난 경기는 빠져요.', 'Not averaged per match: all points and shots are summed. The small number is the sample. Matches without analysis or without a result are left out.')}</p>`;
}

// ---------- 자세 비교 ----------

function pose(p) {
  const controls = `<div class="field"><label for="pl-tech">${L('기술', 'Technique')}</label><select id="pl-tech" data-pl-tech>${TECH_KEYS.map((k) => `<option value="${k}" ${k === p.tech ? 'selected' : ''}>${TECH_LABELS[k]}</option>`).join('')}</select></div>
  <div class="pl-pose-ctl">
    <div class="field"><label for="pl-a">${L('기간 A', 'Period A')}</label><input id="pl-a" type="month" data-pl-period="a" value="${p.a}" max="${thisMonth()}"></div>
    <div class="field"><label for="pl-b">${L('기간 B', 'Period B')}</label><input id="pl-b" type="month" data-pl-period="b" value="${p.b}" max="${thisMonth()}"></div>
  </div>`;
  if (!p.poseLoading && p.poseFor !== `${p.tech}|${p.a}|${p.b}`) loadPose(p);
  if (!p.pose) return controls + (p.poseError ? `<p class="warn">${esc(p.poseError)}</p><button class="btn primary" data-act="pl-pose-retry">${L('다시 시도', 'Retry')}</button>` : `<p class="loading">${L('자세를 불러오는 중…', 'Loading pose…')}</p>`);
  const r = p.pose;
  const atSeg = `<div class="seg pl-at" role="radiogroup" aria-label="${L('기준 시각', 'Reference time')}">${AT_SHORT.map((label, i) => `<button type="button" role="radio" aria-checked="${p.atIdx === i}" class="seg-btn ${p.atIdx === i ? 'on' : ''}" data-act="pl-at" data-at="${i}" aria-label="${AT_LABELS[i]}"><b>${label}</b></button>`).join('')}</div>`;
  const legend = `<p class="an-legend pl-legend"><span>${SWATCH_A}A ${fmtMonth(r.a.period.from.slice(0, 7))} · ${shotsN(r.a.n)}</span><span>${SWATCH_B}B ${fmtMonth(r.b.period.from.slice(0, 7))} · ${shotsN(r.b.n)}</span></p>`;
  const alt = (dim) => L(`${TECH_LABELS[r.tech]} ${AT_LABELS[p.atIdx]}의 ${dim} 평균 뼈대, A ${r.a.n}개와 B ${r.b.n}개 샷`, `${TECH_LABELS[r.tech]}, ${AT_LABELS[p.atIdx]}: average ${dim} skeleton, ${r.a.n} shots in A and ${r.b.n} in B`);
  const canvases = `<div class="pl-canvases">
    <figure class="pl-fig"><figcaption>${L('2D 겹쳐 보기', '2D overlay')} · ${AT_LABELS[p.atIdx]}</figcaption><canvas data-pl-2d width="600" height="600" role="img" aria-label="${esc(alt('2D'))}"></canvas></figure>
    <figure class="pl-fig"><figcaption>${L('3D 뼈대 · 끌어서 돌려요', '3D skeleton · drag to rotate')}</figcaption><canvas data-pl-3d width="600" height="600" role="img" aria-label="${esc(alt('3D'))}"></canvas>
      <div class="row pl-orbit"><button class="icon-btn" data-act="pl-orbit" data-yaw="-1" aria-label="${L('왼쪽으로 돌리기', 'Rotate left')}">${app.icon('back')}</button><button class="btn ghost grow" data-act="pl-orbit" data-reset="1">${L('정면으로', 'Front')}</button><button class="icon-btn" data-act="pl-orbit" data-yaw="1" aria-label="${L('오른쪽으로 돌리기', 'Rotate right')}">${app.icon('next')}</button></div></figure>
  </div>`;
  const unattributed = r.unattributedRallies ? L(` 가까운 쪽 선수를 모르는 랠리 ${r.unattributedRallies}개의 샷은 누구에게도 넣지 않았어요.`, ` Shots from ${r.unattributedRallies} ${r.unattributedRallies === 1 ? 'rally' : 'rallies'} where the near-side player is unknown were not credited to anyone.`) : '';
  return `${controls}${atSeg}${legend}${canvases}${numbers(r, p.atIdx)}
    <p class="hint">${L('깊이(z)는 카메라 하나로 추정한 값이라 잰 값이 아니에요. 몸 크기와 카메라 거리는 엉덩이를 원점으로, 몸통 길이를 1로 맞춰 뺐어요. 2D는 먼 쪽에서 친 샷을 좌우로 뒤집어 같은 방향으로 맞췄고, 카메라 높이와 각도 차이는 남아요.', 'Depth (z) is estimated from a single camera, not measured. Body size and camera distance are removed by putting the hips at the origin and the torso length at 1. In 2D, shots from the far side are mirrored left to right to face the same way; camera height and angle differences remain.')}${unattributed}</p>`;
}

function numbers(r, atIdx) {
  const dim = r.a.skeletons.d3[atIdx].n || r.b.skeletons.d3[atIdx].n ? 'd3' : 'd2';
  const [a, b] = [r.a.metrics[dim][atIdx], r.b.metrics[dim][atIdx]];
  const diffs = r.diffs?.[dim][atIdx] ?? null;
  const num = (v, unit) => (unit === '°' ? v.toFixed(0) : v.toFixed(2)) + unit;
  const val = (v, unit) => (v === null ? '<span class="an-none">—</span>' : `<b>${num(v, unit)}</b>`);
  const diff = (v, unit) => (v === null ? '<span class="an-none">—</span>' : `<b>${v > 0 ? '+' : ''}${num(v, unit)}</b>`);
  const hand = (h) => (h === 'R' ? L('오른손', 'right') : h === 'L' ? L('왼손', 'left') : L('모름', 'unknown'));
  const rows = METRICS.map(([k, label, unit, note]) => `<tr><th scope="row">${label}<small>${note}</small></th><td>${val(a[k], unit)}</td><td>${val(b[k], unit)}</td><td>${diffs ? diff(diffs[k], unit) : '<span class="an-none">—</span>'}</td></tr>`).join('');
  return `${r.reason ? `<p class="hint pl-reason">${esc(L(r.reason, `Each period needs at least ${MIN_SHOTS} shots to compare (A ${r.a.n}, B ${r.b.n}).`))}</p>` : ''}
    <table class="an-table pl-nums"><thead><tr><th scope="col">${dim === 'd3' ? '3D' : '2D'} ${L('뼈대 수치', 'skeleton values')} · ${AT_LABELS[atIdx]}</th><th scope="col">A<small>n ${r.a.n}</small></th><th scope="col">B<small>n ${r.b.n}</small></th><th scope="col">B − A</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="hint">${L(`라켓 손 A ${hand(r.a.hand)} · B ${hand(r.b.hand)}. 라켓 손을 모르면 팔꿈치 각과 손 높이는 비워 둬요. 수치는 5장면 이상 본 관절로만 재요.`, `Racket hand A ${hand(r.a.hand)} · B ${hand(r.b.hand)}. If the racket hand is unknown, elbow angle and hand height stay blank. Values use only joints seen in 5 or more frames.`)}</p>`;
}

function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return { a: v('--c-speed'), b: v('--c-ink'), grid: v('--c-frame-lo'), muted: v('--c-ink-2') };
}

// One skeleton: bones between seen joints, a mark on each joint (A circles, B squares).
function drawSkeleton(ctx, joints, project, { color, width, dash, square }) {
  if (!joints.length) return false;
  const pt = (i) => (joints[i] ? project(joints[i]) : null);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'square';
  ctx.setLineDash(dash);
  ctx.beginPath();
  for (const [i, j] of BONES) {
    const [p, q] = [pt(i), pt(j)];
    if (p && q) { ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); }
  }
  const [nose, ls, rs] = [pt(0), pt(1), pt(2)];
  if (nose && ls && rs) { ctx.moveTo(nose[0], nose[1]); ctx.lineTo((ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2); }
  ctx.stroke();
  ctx.setLineDash([]);
  for (let i = 0; i < joints.length; i += 1) {
    const p = pt(i);
    if (!p) continue;
    if (square) ctx.fillRect(p[0] - 5, p[1] - 5, 10, 10);
    else { ctx.beginPath(); ctx.arc(p[0], p[1], 5.5, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
  return true;
}

function caption(ctx, c, lines, color, { middle = false } = {}) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = '700 22px Galmuri11, monospace';
  ctx.textAlign = 'center';
  // at the top, clear of the figure that may still be drawn; in the middle when nothing is drawn
  const top = middle ? c.height / 2 - ((lines.length - 1) * 30) / 2 : 44;
  lines.forEach((line, i) => ctx.fillText(line, c.width / 2, top + i * 30));
  ctx.restore();
}
const EMPTY_FIG = [L('아직 그릴 샷이 없어요', 'No shots to draw yet'), L('샷이 모이면 여기 그려져요', 'They will show up here')];

function paint2d(c, r, atIdx) {
  const ctx = c.getContext('2d');
  const tk = tokens();
  ctx.clearRect(0, 0, c.width, c.height);
  const s = c.height / 4.4;
  const project = ([x, y]) => [c.width / 2 + x * s, c.height * 0.42 + y * s];
  const drewA = drawSkeleton(ctx, r.a.skeletons.d2[atIdx].joints, project, { color: tk.a, width: 6, dash: [], square: false });
  const drewB = drawSkeleton(ctx, r.b.skeletons.d2[atIdx].joints, project, { color: tk.b, width: 4, dash: [14, 10], square: true });
  if (!drewA && !drewB) caption(ctx, c, EMPTY_FIG, tk.muted, { middle: true });
  else if (!drewA || !drewB) caption(ctx, c, [L(`${drewA ? 'B' : 'A'} 기간에는 샷이 없어요`, `No shots in period ${drewA ? 'B' : 'A'}`)], tk.muted);
}

function paint3d(c, r, atIdx, { yaw, pitch }) {
  const ctx = c.getContext('2d');
  const tk = tokens();
  ctx.clearRect(0, 0, c.width, c.height);
  const s = c.height / 4.4;
  const rotate = ([x, y, z]) => {
    const [cy, sy, cp, sp] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch)];
    const [x1, z1] = [x * cy + z * sy, z * cy - x * sy];
    return [x1, y * cp - z1 * sp, y * sp + z1 * cp];
  };
  const project = (j) => { const [x, y] = rotate(j); return [c.width / 2 + x * s, c.height * 0.42 + y * s]; };
  // a floor under the feet so a turn can be seen even where the two bodies overlap
  ctx.save();
  ctx.strokeStyle = tk.grid;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = -3; i <= 3; i += 1) {
    const [a, b] = [project([i * 0.4, 2.05, -1.2]), project([i * 0.4, 2.05, 1.2])];
    const [d, e] = [project([-1.2, 2.05, i * 0.4]), project([1.2, 2.05, i * 0.4])];
    ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.moveTo(d[0], d[1]); ctx.lineTo(e[0], e[1]);
  }
  ctx.stroke();
  ctx.restore();
  const drewA = drawSkeleton(ctx, r.a.skeletons.d3[atIdx].joints, project, { color: tk.a, width: 6, dash: [], square: false });
  const drewB = drawSkeleton(ctx, r.b.skeletons.d3[atIdx].joints, project, { color: tk.b, width: 4, dash: [14, 10], square: true });
  if (!drewA && !drewB) caption(ctx, c, EMPTY_FIG, tk.muted, { middle: true });
}

function paintAll() {
  const p = page;
  if (!p?.pose) return;
  const c2 = document.querySelector('canvas[data-pl-2d]');
  const c3 = document.querySelector('canvas[data-pl-3d]');
  if (c2) paint2d(c2, p.pose, p.atIdx);
  if (c3) paint3d(c3, p.pose, p.atIdx, p.view);
}

// Orbit by dragging the 3D canvas; the buttons beside it turn it without a drag.
let drag = null;
document.addEventListener('pointerdown', (e) => {
  const c = e.target.closest?.('canvas[data-pl-3d]');
  if (!c || !page) return;
  drag = { x: e.clientX, y: e.clientY };
  c.setPointerCapture(e.pointerId);
});
document.addEventListener('pointermove', (e) => {
  if (!drag || !page) return;
  page.view.yaw += (e.clientX - drag.x) * 0.012;
  page.view.pitch = Math.max(-1.3, Math.min(1.3, page.view.pitch + (e.clientY - drag.y) * 0.012));
  drag = { x: e.clientX, y: e.clientY };
  paintAll();
});
for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, () => { drag = null; });

document.addEventListener('change', (e) => {
  const el = e.target;
  if (!page) return;
  if (el.matches?.('[data-pl-tech]')) { page.tech = el.value; app.render(); }
  if (el.matches?.('[data-pl-period]') && /^\d{4}-\d{2}$/.test(el.value)) { page[el.dataset.plPeriod] = el.value; app.render(); }
});

// ---------- 이름 바꾸기 · 합치기 (PIN) ----------

function tool(p, d) {
  if (!app.pin()) return '';
  const t = p.tool;
  // the key is looked up against the person as the page has it now, so never while a reload is in flight
  if (t.key === undefined && !t.resolving && !p.loading) findKey(p);
  let body;
  if (t.key === undefined) body = `<p class="loading">${L('이 선수의 열쇠를 찾는 중…', 'Looking for this player\'s key…')}</p>`;
  else if (t.key === null) {
    body = `<p class="hint">${L('이 선수의 열쇠(이름,네자리)를 찾지 못했어요. 영상을 올릴 때 적은 이름,네자리를 적으면 이 선수가 맞는지 확인해요.', 'Could not find this player\'s key (name,4 digits). Enter the name,4 digits you typed when uploading a video and it will be checked against this player.')}</p>
      <div class="field"><label for="pl-key">${L('열쇠', 'Key')}</label><input id="pl-key" data-pl-tool="typedKey" value="${esc(t.typedKey)}" placeholder="${esc(d.person.name)},0000" autocomplete="off"><p class="err-text">${esc(t.keyError ?? '')}</p></div>
      <button class="btn" data-act="pl-key-check" ${t.busy ? 'disabled' : ''}>${L('확인', 'OK')}</button>`;
  } else body = toolBody(p, d);
  return card(L('이름 바꾸기 · 합치기', 'Rename · merge'), `<p class="hint">${L('PIN을 넣은 기기에서만 보여요. 경기 기록은 고치지 않고 연결만 적어서 언제든 되돌릴 수 있어요.', 'Only shown on a device with the PIN entered. Match records are not edited; only a link is written, so it can be undone any time.')}</p>${t.done ? `<p class="pl-done" role="status">${esc(t.done)}</p>` : ''}${t.error ? `<p class="warn">${esc(t.error)}</p>` : ''}${body}`, 'pl-tool pl-span');
}

const currentKey = (t) => resolveKey(t.key, t.aliases ?? {});

function renamePreview(t, d) {
  const key = currentKey(t);
  const name = normalizeKey(t.name).replace(/,\d{4}$/, '');
  if (!name || name === nameOf(key)) return { ok: false, html: '' };
  if (name.length > 20 || name.includes(',')) return { ok: false, html: `<p class="err-text">${L('이름은 쉼표 없이 20자까지예요.', 'Names are up to 20 characters, no commas.')}</p>` };
  const code = codeOf(key);
  return { ok: true, html: `<p class="pl-preview">${esc(key)} → <b>${esc(code ? `${name},${code}` : name)}</b> · ${L(`경기 ${d.matches.length}개가 새 이름으로 보여요.`, `${matchesN(d.matches.length)} will show under the new name.`)}${code ? '' : L(' 옛 기록이라 네자리는 없어요.', ' This is an old record, so there are no 4 digits.')}</p>` };
}

function mergePreview(t, d) {
  const key = currentKey(t);
  const target = normalizeKey(t.target);
  if (!target) return { ok: false, html: '' };
  if (target === key) return { ok: false, html: `<p class="err-text">${L('이미 같은 사람이에요.', 'That is already the same player.')}</p>` };
  if (!/^[^,]{1,20}(,\d{4})?$/u.test(target)) return { ok: false, html: `<p class="err-text">${L('이름,네자리로 적어요.', 'Enter it as name,4 digits.')}</p>` };
  const other = people?.list?.find((x) => `${x.name}${x.label ?? ''}` === target || (x.name === nameOf(target) && !x.label));
  return { ok: true, html: `<p class="pl-preview">${esc(key)} (${matchesN(d.matches.length)}) → <b>${esc(target)}</b>${other ? ` (${matchesN(other.matches)})` : L(' (아직 기록 없음)', ' (no record yet)')}${L('에 붙여요.', ' will be merged into it.')} ${L(`합치면 한 사람으로 경기 ${d.matches.length + (other?.matches ?? 0)}개가 보여요.`, `After merging, one player shows ${matchesN(d.matches.length + (other?.matches ?? 0))}.`)}</p>` };
}

function toolBody(p, d) {
  const t = p.tool;
  const key = currentKey(t);
  const rn = renamePreview(t, d);
  const mg = mergePreview(t, d);
  const mine = Object.entries(t.aliases ?? {}).filter(([from]) => resolveKey(from, t.aliases) === key);
  const links = mine.length
    ? `<ul class="pl-links">${mine.map(([from, to]) => `<li><span class="pl-dm"><b>${esc(from)}</b><small>→ ${esc(to)}</small></span><button class="btn" data-act="pl-undo" data-from="${esc(from)}" ${t.busy ? 'disabled' : ''}>${L('되돌리기', 'Undo')}</button></li>`).join('')}</ul>`
    : `<p class="hint">${L('이 선수에게 적힌 연결이 없어요.', 'No links are written for this player.')}</p>`;
  return `<p class="pl-keyline">${L('지금 열쇠', 'Current key')} <b>${esc(key)}</b></p>
    <div class="pl-tool-grid">
      <div class="pl-tool-part"><div class="field"><label for="pl-rename">${L('새 이름', 'New name')}</label><input id="pl-rename" data-pl-tool="name" value="${esc(t.name)}" maxlength="20" placeholder="${esc(nameOf(key))}" autocomplete="off"></div><div data-pl-preview="name">${rn.html}</div><button class="btn" data-act="pl-rename" ${rn.ok && !t.busy ? '' : 'disabled'}>${L('이름 바꾸기', 'Rename')}</button></div>
      <div class="pl-tool-part"><div class="field"><label for="pl-merge">${L('이 선수를 붙일 선수', 'Player to merge into')}</label><input id="pl-merge" data-pl-tool="target" data-people-pick value="${esc(t.target)}" placeholder="${L('이름,네자리', 'Name,4 digits')}" autocomplete="off" maxlength="26"><ul class="pp-sugg" role="listbox" aria-label="${L('등록된 선수', 'Registered players')}" hidden></ul></div><div data-pl-preview="target">${mg.html}</div><button class="btn" data-act="pl-merge" ${mg.ok && !t.busy ? '' : 'disabled'}>${L('합치기', 'Merge')}</button></div>
    </div>
    <h3 class="pl-h3">${L('적힌 연결', 'Written links')}</h3>${links}`;
}

// The person's key: the candidates that show this name, each asked of the PIN read by key, which
// answers with the resolved ref. No four digits are guessed; a key nobody listed is typed by hand.
async function findKey(p) {
  const t = p.tool;
  t.resolving = true;
  try {
    t.aliases = (await app.api('/api/players/aliases', undefined, { method: 'GET' })).aliases;
    const entries = await peopleEntries(app.pin(), { force: true });
    const name = p.data.person.name;
    const candidates = [...new Set([name, ...entries.filter((e) => e.name === name).map((e) => e.entry), ...Object.entries(t.aliases).flat().filter((k) => nameOf(k) === name)])];
    t.key = null;
    for (const key of candidates) {
      if (await refOfKey(key) === p.data.person.ref) { t.key = key; break; }
    }
  } catch (e) {
    t.key = null;
    t.error = e.message;
  }
  t.resolving = false;
  if (page === p) app.render();
}

async function refOfKey(key) {
  const res = await fetch(`/api/analysis/person/${encodeURIComponent(key)}?month=${thisMonth()}`, { headers: { 'x-pin': app.pin() } });
  const data = await res.json().catch(() => ({}));
  return res.ok ? data.person.ref : null;
}

// After a write everything is read again: the person's matches, aliases, the people list.
function refreshAll(p) {
  p.loadedFor = null;
  p.poseFor = null;
  p.tool.key = undefined;
  p.tool.aliases = null;
  forgetPeople();
  people = null;
  app.render();
}

async function write(p, run) {
  const t = p.tool;
  t.busy = true;
  t.error = null;
  t.done = null;
  app.render();
  try {
    t.done = await run();
    t.name = '';
    t.target = '';
  } catch (e) {
    t.error = e.message;
  }
  t.busy = false;
  refreshAll(p);
}

// The previews follow the typing without a full render (render waits while a field has focus).
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.matches?.('[data-pl-tool]') || !page) return;
  const t = page.tool;
  t[el.dataset.plTool] = el.value;
  const part = el.closest('.pl-tool-part');
  if (!part) return;
  const pv = el.dataset.plTool === 'name' ? renamePreview(t, page.data) : mergePreview(t, page.data);
  part.querySelector('[data-pl-preview]').innerHTML = pv.html;
  part.querySelector('[data-act]').disabled = !pv.ok || t.busy;
});

const splitId = (id) => { const cut = id.indexOf('/'); return [id.slice(0, cut), id.slice(cut + 1)]; };

// data-act handlers, merged into app.js's table.
export const playerHandlers = {
  'pl-open'(b) { app.go(() => openPlayer(b.dataset.ref)); },
  // a name on the analysis sheet: the public person with that shown name (label included)
  async 'pl-name'(b) {
    if (!people?.list) await loadPeople();
    const hits = (people?.list ?? []).filter((x) => `${x.name}${x.label ?? ''}` === b.dataset.name || x.name === b.dataset.name);
    if (hits.length !== 1) throw new Error(hits.length ? L('같은 이름이 여럿이라 기록 탭의 선수 목록에서 골라요.', 'Several players share this name; pick one from the player list in the History tab.') : L('이 선수의 기록 페이지가 아직 없어요.', 'This player has no record page yet.'));
    app.go(() => openPlayer(hits[0].ref));
  },
  'pl-retry'() { page.loadedFor = null; page.error = null; app.render(); },
  'pl-people-retry'() { people = null; app.render(); },
  'pl-day'(b) { page.day = page.day === b.dataset.date ? null : b.dataset.date; app.render(); },
  'pl-month'(b) { page.month = shiftMonth(page.month, Number(b.dataset.dir)); page.day = null; app.render(); },
  'pl-period'(b) { page.period = b.dataset.period; app.render(); },
  'pl-at'(b) { page.atIdx = Number(b.dataset.at); app.render(); },
  'pl-orbit'(b) {
    if (b.dataset.reset) page.view = { yaw: -0.7, pitch: 0.3 };
    else page.view.yaw += Number(b.dataset.yaw) * 0.35;
    paintAll();
  },
  'pl-pose-retry'() { page.poseFor = null; page.poseError = null; app.render(); },
  async 'pl-sheet'(b) {
    if (b.dataset.kind === 'gallery') { app.go(() => openAnalysis(b.dataset.id, 'g')); return; }
    const [hist, matchId] = splitId(b.dataset.id);
    if (hist === 'current') { app.go(() => openAnalysis(matchId, null)); return; }
    await app.openHistory(hist);
    app.go(() => openAnalysis(matchId, hist));
  },
  async 'pl-key-check'() {
    const t = page.tool;
    const key = normalizeKey(t.typedKey);
    t.busy = true;
    app.render();
    const ref = /^[^,]{1,20}(,\d{4})?$/u.test(key) ? await refOfKey(key) : null;
    t.busy = false;
    if (ref !== page.data.person.ref) { t.keyError = ref ? L('그 열쇠는 다른 사람이에요.', 'That key belongs to someone else.') : L('그런 선수가 없어요.', 'No such player.'); app.render(); return; }
    t.keyError = null;
    t.key = key;
    app.render();
  },
  'pl-rename'() {
    const p = page;
    const key = currentKey(p.tool);
    const name = normalizeKey(p.tool.name).replace(/,\d{4}$/, '');
    write(p, async () => {
      await app.api('/api/players/rename', { from: key, toName: name });
      const to = codeOf(key) ? `${name},${codeOf(key)}` : name;
      return L(`'${key}'를 '${to}'로 바꿨어요. 아래 적힌 연결에서 되돌릴 수 있어요.`, `Renamed '${key}' to '${to}'. You can undo it under Written links below.`);
    });
  },
  'pl-merge'() {
    const p = page;
    const key = currentKey(p.tool);
    const target = normalizeKey(p.tool.target);
    write(p, async () => {
      await app.api('/api/players/merge', { from: key, to: target });
      return L(`'${key}'를 '${target}'에 붙였어요. 이제 한 사람으로 보여요. 아래 적힌 연결에서 되돌릴 수 있어요.`, `Merged '${key}' into '${target}'. They now show as one player. You can undo it under Written links below.`);
    });
  },
  'pl-undo'(b) {
    const p = page;
    write(p, async () => {
      await app.api(`/api/players/aliases/${encodeURIComponent(b.dataset.from)}`, undefined, { method: 'DELETE' });
      return L(`'${b.dataset.from}' 연결을 지웠어요. 기록은 원래대로 읽혀요.`, `Removed the link for '${b.dataset.from}'. Records read as before.`);
    });
  },
};

// ---------- the 기록 tab's 선수 list ----------

export function peopleSection() {
  if (!people && !peopleLoading) loadPeople();
  if (!people) return card(L('선수', 'Players'), `<p class="loading">${L('선수 목록을 불러오는 중…', 'Loading player list…')}</p>`);
  if (people.error) return card(L('선수', 'Players'), `<p class="warn">${esc(people.error)}</p><button class="btn primary" data-act="pl-people-retry">${L('다시 시도', 'Retry')}</button>`);
  const list = people.list;
  if (!list.length) return card(L('선수', 'Players'), `<p class="hint">${L('아직 경기를 한 선수가 없어요. 대회 경기와 분석 데스크의 영상이 쌓이면 여기에 모여요.', 'No player has played yet. Tournament matches and analysis desk videos will collect here.')}</p>`);
  const rows = list.map((x) => `<button class="pl-person" data-act="pl-open" data-ref="${x.ref}"><span class="pl-pname"><b>${esc(x.name)}</b>${x.label ? `<small>${esc(x.label)}</small>` : ''}</span><small class="pl-pmeta">${matchesN(x.matches)} · ${L('마지막', 'Last')} ${fmtDate(x.lastPlayed)}</small>${app.icon('next')}</button>`);
  return `<section class="card"><h2 class="fold-title">${app.foldHead('people', L('선수', 'Players'), L(`${list.length}명`, `${list.length}`))}</h2>${app.foldRows('people', rows)}<p class="hint">${L('같은 이름이 둘이면 네자리의 끝 두 자리가 붙어요. 이름을 누르면 그 선수의 달력과 추이, 자세 비교가 열려요.', 'If two players share a name, the last two of their 4 digits are added. Tap a name to open that player\'s calendar, trend and pose comparison.')}</p></section>`;
}
