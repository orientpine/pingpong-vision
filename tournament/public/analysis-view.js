// 경기 분석: the sheet a player reads after a match (screen 'analysis' in app.js). The numbers come from
// public/analysis.js; this file only draws them. app.js hands over render, go, openReplay and esc once
// through bindAnalysis, so it keeps one import and a few one-line hooks. See docs/analytics.md, 화면.
import { REPORT_MIN_N, TECH_KEYS, accuracyStatus, analyzeMatch, mapPoint } from '/analysis.js';
import { L, LOCALE } from './i18n.js';
import { labelText } from './engine.js';

// Which player this device calls 나: a match slot, remembered on the device (default slot 0).
const ME_KEY = 'pp-analysis-me';
export const TECH_LABELS = {
  'fore-attack': L('포핸드 공격', 'Forehand attack'), 'fore-defence': L('포핸드 수비', 'Forehand defence'), 'fore-serve': L('포핸드 서브', 'Forehand serve'),
  'back-attack': L('백핸드 공격', 'Backhand attack'), 'back-defence': L('백핸드 수비', 'Backhand defence'), 'back-serve': L('백핸드 서브', 'Backhand serve'),
};
const ZONE_COLS = [L('왼쪽', 'Left'), L('가운데', 'Middle'), L('오른쪽', 'Right')];
const ZONE_ROWS = [L('짧음', 'Short'), L('중간', 'Mid'), L('깊음', 'Deep')];
// The table from above in centimetres: the camera's near end on the left, its left side on top.
const TABLE_CM = { w: 274, h: 152.5 };
const PLAY = '<svg class="an-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>';
const KEY_ME = '<svg viewBox="0 0 14 14" aria-hidden="true"><circle class="an-dot-me" cx="7" cy="7" r="5"/></svg>';
const KEY_OP = '<svg viewBox="0 0 14 14" aria-hidden="true"><rect class="an-dot-op" x="2" y="2" width="10" height="10"/></svg>';

let app = null;
// The open sheet: which match, from which record (null = the current tournament), and what it fetched.
let sheet = null;

export function bindAnalysis(deps) { app = deps; }
export const analysisKey = () => sheet?.key ?? null;
// When the sheet was opened: the player page (player-view.js) can sit over it or under it.
export const analysisOpenedAt = () => sheet?.at ?? 0;
export function closeAnalysis() { sheet = null; }

// histId: null for the current tournament, a record id for a past one, 'g' for a desk video (gallery match).
export function openAnalysis(matchId, histId = null) {
  sheet = { matchId, histId, key: `${histId ?? '-'}/${matchId}`, at: performance.now(), data: null, error: null, loading: false, loadedFor: null };
}

// Back or forward landed on a history entry: show the sheet it names, or none.
export function syncAnalysis(key) {
  if ((key ?? null) === analysisKey()) return;
  if (!key) { sheet = null; return; }
  const cut = key.indexOf('/');
  const hist = key.slice(0, cut);
  openAnalysis(key.slice(cut + 1), hist === '-' ? null : hist);
}

const esc = (s) => app.esc(s);
// A parenthetical such as (5번 중 1번)로 stays on one line, and the particle after the closing paren
// stays glued to it: no-break spaces inside the parens, a word joiner after them.
const glue = (s) => esc(s).replace(/\(([^()]*)\)(?=[가-힣])/g, (_, inner) => `(${inner.replace(/ /g, '\u00a0')})\u2060`); // i18n-data: Korean particle rule
const me = () => (localStorage.getItem(ME_KEY) === '1' ? 1 : 0);
const pct = (won, n) => `${Math.round((won / n) * 100)}%`;
const role = (slot, my) => (slot === my ? L('나', 'Me') : L('상대', 'Opp.'));
const card = (title, body, cls = '') => `<section class="card ${cls}"><h2>${title}</h2>${body}</section>`;

const urlOf = ({ matchId, histId }) => (histId === null
  ? `/api/analysis/match/${encodeURIComponent(matchId)}`
  : histId === 'g' ? `/api/analysis/gallery/${encodeURIComponent(matchId)}`
    : `/api/analysis/history/${encodeURIComponent(histId)}/${encodeURIComponent(matchId)}`);
// A name opens the person's page (names only; the public people list finds the ref).
const nameButton = (name) => (name === null ? L('이름 없음', 'No name') : `<button type="button" class="an-name" data-act="pl-name" data-name="${esc(name)}">${esc(name)}</button>`);
const fmtDay = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? '')); return m ? L(`${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일`, new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString(LOCALE, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })) : esc(iso); };

// Fetches the rallies for the match as it is now; a later render with more points fetches again.
async function load(s, pointsLen) {
  s.loading = true;
  s.error = null;
  s.loadedFor = pointsLen;
  try {
    const res = await fetch(urlOf(s));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || L('분석을 불러오지 못했어요.', 'Could not load the analysis.'));
    s.data = data;
  } catch (e) {
    s.error = e instanceof TypeError ? L('서버에 연결하지 못했어요.', 'Could not reach the server.') : e.message;
  }
  s.loading = false;
  if (sheet === s) app.render();
}

// current = { tournament, derived } of the running tournament; record = the open history record
// ({ summary, tournament, derived }) or null while it still loads. The sheet picks by its histId.
export function analysisView({ current, record }) {
  const s = sheet;
  if (s.histId === 'g') return galleryView(s);
  const ctx = s.histId === null ? current : record?.summary.id === s.histId ? record : null;
  if (!ctx) return `<div class="analysis"><p class="loading an-span">${L('기록을 불러오는 중…', 'Loading history…')}</p></div>`;
  const m = ctx.derived.matches.find((x) => x.id === s.matchId);
  if (!m) return `<div class="analysis"><p class="hint empty an-span">${L('이 경기를 찾을 수 없어요.', 'Match not found.')}</p></div>`;
  const pointsLen = m.points.length;
  if (!s.loading && s.loadedFor !== pointsLen) load(s, pointsLen);
  const names = m.players.map((p, i) => (p === null ? m.slotLabels?.[i] ?? L('선수', 'Player') : ctx.tournament.players[p]));
  const head = `<p class="an-match an-span"><b>${L(`${m.no}경기`, `Match ${m.no}`)}</b> · ${esc(labelText(m.label))} · ${nameButton(names[0])} vs ${nameButton(names[1])}</p>`;
  if (!s.data) return `<div class="analysis">${head}${s.error ? errorView(s.error) : `<p class="loading an-span">${L('분석을 불러오는 중…', 'Loading analysis…')}</p>`}</div>`;
  const a = analyzeMatch(s.data.rallies, { pointsLen, clips: m.clips });
  if (!a.n) return `<div class="analysis">${head}${emptyView(m, s)}</div>`;
  const my = me();
  // Reading order from the brief (docs/analytics.md): report, technique success, then the course.
  return `<div class="analysis">${head}${picker(names, my, a, pointsLen)}${reportCard(a, names, my)}
    ${card(L('기술 성공률', 'Technique success'), techTable(a, names, my, s.data.accuracy ?? null))}
    ${card(L('바운드 자리', 'Bounce spots'), bounceMap(a, names, my))}
    ${card(L('코스 9칸', 'Placement (9 zones)'), zoneGrids(a, names, my))}
    ${card(L('랠리 길이별 승률', 'Win rate by rally length'), lengthTable(a, names, my))}
    ${card(L('가장 긴 랠리 5개', 'Top 5 longest rallies'), top5(a, names))}
    ${card(L('득점 흐름', 'Scoring flow'), timelines(a, names, my, m))}
  </div>`;
}

// A desk video: the gallery file holds the title, the day, the two names (or null) and the desk rallies.
// There is no accuracy table for desk results yet, so every technique shows as 추정.
function galleryView(s) {
  if (!s.loading && s.loadedFor !== 'g') load(s, 'g');
  const doc = s.data;
  if (!doc) return `<div class="analysis">${s.error ? errorView(s.error) : `<p class="loading an-span">${L('분석을 불러오는 중…', 'Loading analysis…')}</p>`}</div>`;
  // The public read carries names only; two players with one name are told apart by their table end.
  const same = doc.players.near !== null && doc.players.near === doc.players.far;
  const names = [doc.players.near ?? L('이름 없음', 'No name'), doc.players.far ?? L('이름 없음', 'No name')].map((n, i) => (same ? `${n} (${i ? L('건너편', 'far side') : L('카메라 쪽', 'camera side')})` : n));
  // A first pass (desk shots before the pose model): forehand/backhand is filled in later, so look again
  // every 10 s while this sheet is open.
  if (doc.handPending && !s.recheck) s.recheck = setTimeout(() => { s.recheck = null; if (sheet === s && !s.loading) load(s, 'g'); }, 10000);
  const pending = doc.handPending ? `<p class="an-pending an-span">${L('포·백 분석 중 · 샷·바운드는 먼저 나왔어요. 포핸드·백핸드는 분석이 끝나면 채워져요.', 'Forehand/backhand in progress · shots and bounces are ready; forehand/backhand fills in when the analysis finishes.')}</p>` : '';
  const head = `<p class="an-match an-span"><b>${esc(doc.title)}</b> · ${fmtDay(doc.playedAt)} · ${nameButton(doc.players.near)} vs ${nameButton(doc.players.far)}</p>${pending}`;
  const a = analyzeMatch(doc.rallies, { pointsLen: Infinity, clips: {} });
  if (!a.n) {
    return `<div class="analysis">${head}<section class="card an-empty an-span"><p class="h1">${L('분석 기록이 없어요', 'No analysis yet')}</p><p class="an-why">${L('이 영상의 분석 결과에 랠리가 없어요. 탁구대 네 모서리가 다 보이게 다시 찍어 올려요.', 'This video\'s analysis has no rallies. Film again with all four table corners in view and upload it.')}</p><button class="btn primary" data-act="an-reload" ${s.loading ? 'disabled' : ''}>${s.loading ? L('불러오는 중…', 'Loading…') : L('다시 불러오기', 'Reload')}</button></section></div>`;
  }
  const my = me();
  const nearName = doc.players.near ?? L('이름 없음', 'No name');
  return `<div class="analysis">${head}${picker(names, my, a, L(`영상 1개, 카메라 쪽이 ${nearName}`, `1 video, camera side is ${nearName}`))}${reportCard(a, names, my)}
    ${card(doc.handPending ? L('기술 성공률 · 포·백 분석 중', 'Technique success · forehand/backhand in progress') : L('기술 성공률', 'Technique success'), techTable(a, names, my, null))}
    ${card(L('바운드 자리', 'Bounce spots'), bounceMap(a, names, my))}
    ${card(L('코스 9칸', 'Placement (9 zones)'), zoneGrids(a, names, my))}
    ${card(L('랠리 길이별 승률', 'Win rate by rally length'), lengthTable(a, names, my))}
    ${card(L('가장 긴 랠리 5개', 'Top 5 longest rallies'), top5(a, names))}
    ${card(L('득점 흐름', 'Scoring flow'), timelines(a, names, my, { clips: {} }))}
  </div>`;
}

function errorView(error) {
  return `<section class="card an-empty an-span"><p class="warn">${esc(error)}</p><button class="btn primary" data-act="an-reload">${L('다시 시도', 'Try again')}</button></section>`;
}

function emptyView(m, s) {
  const why = m.status === 'done' ? L('이 경기는 카메라 없이 기록되어 랠리 기록이 없어요.', 'This match was recorded without a camera, so there are no rallies.') : L('이 경기는 아직 카메라가 보낸 랠리가 없어요.', 'The camera has not sent any rallies for this match yet.');
  return `<section class="card an-empty an-span"><p class="h1">${L('분석 기록이 없어요', 'No analysis yet')}</p>
    <p class="an-why">${L('카메라 모드로 찍은 포인트만 분석할 수 있어요.', 'Only points filmed in Camera mode can be analysed.')} ${why}</p>
    <button class="btn primary" data-act="an-reload" ${s.loading ? 'disabled' : ''}>${s.loading ? L('불러오는 중…', 'Loading…') : L('다시 불러오기', 'Reload')}</button></section>`;
}

function picker(names, my, a, pointsLen) {
  const btn = (slot) => `<button type="button" role="radio" aria-checked="${slot === my}" class="seg-btn ${slot === my ? 'on' : ''}" data-act="an-me" data-slot="${slot}"><b>${esc(names[slot])}</b><small>${role(slot, my)}</small></button>`;
  const of = typeof pointsLen === 'number' ? L(`포인트 ${pointsLen}개`, `${pointsLen} ${pointsLen === 1 ? 'point' : 'points'}`) : pointsLen;
  return `<div class="an-head an-span">
    <div class="seg" role="radiogroup" aria-label="${L('나로 볼 선수', 'Player to view as me')}">${btn(0)}${btn(1)}</div>
    <p class="hint">${L('누구 기준으로 볼지 골라요. 이 기기에 기억해요. ', 'Pick whose side to view from. Remembered on this device. ')}${glue(L(`랠리 ${a.n}개를 분석했어요(${of}).`, `Analysed ${a.n} ${a.n === 1 ? 'rally' : 'rallies'} (${of}).`))}</p>
  </div>`;
}

function reportCard(a, names, my) {
  const line = (slot) => `<p class="an-report ${slot === my ? '' : 'op'}"><b>${esc(names[slot])} · ${role(slot, my)}</b>${glue(a.reportBy[slot]?.text ?? L('표본이 5개 이상인 항목이 아직 없어서 리포트를 쓸 수 없어요.', 'No item has 5 or more samples yet, so there is no report.'))}</p>`;
  return card(L('한 줄 리포트', 'One-line report'), line(my) + line(1 - my), 'an-span');
}

function bounceMap(a, names, my) {
  const counts = [0, 0];
  const dots = a.bounces.map((b) => {
    counts[b.slot] += 1;
    const { x, y } = mapPoint(b);
    return b.slot === my
      ? `<circle class="an-dot-me" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4"/>`
      : `<rect class="an-dot-op" x="${(x - 3.5).toFixed(1)}" y="${(y - 3.5).toFixed(1)}" width="7" height="7"/>`;
  }).join('');
  const { w, h } = TABLE_CM;
  const label = L(`${names[my]} ${counts[my]}개, ${names[1 - my]} ${counts[1 - my]}개`, `${names[my]} ${counts[my]}, ${names[1 - my]} ${counts[1 - my]}`);
  return `<p class="an-legend"><span>${KEY_ME}${esc(names[my])} ${L(`${counts[my]}개`, counts[my])}</span><span>${KEY_OP}${esc(names[1 - my])} ${L(`${counts[1 - my]}개`, counts[1 - my])}</span></p>
    <div class="an-ends" aria-hidden="true"><span>${L('카메라 쪽', 'Camera side')}</span><span>${L('네트', 'Net')}</span><span>${L('먼 쪽', 'Far side')}</span></div>
    <svg class="an-map" viewBox="-1 -1 ${w + 2} ${h + 2}" role="img" aria-label="${L('바운드 자리 지도', 'Bounce map')}: ${esc(label)}">
      <rect class="line" x="0" y="0" width="${w}" height="${h}"/>
      <line class="line" x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}"/>
      <line class="line net" x1="${w / 2}" y1="-1" x2="${w / 2}" y2="${h + 1}"/>
      ${dots}
    </svg>
    <p class="hint">${L(`공이 탁구대에 튄 자리예요(탁구대 2.74 × 1.525 m). ${esc(names[my])}의 공은 동그라미, ${esc(names[1 - my])}의 공은 네모예요. 왼쪽이 카메라에 가까운 쪽이라 엔드를 바꾸면 같은 선수의 공이 양쪽에 찍혀요.`, `Where the ball bounced on the table (2.74 × 1.525 m). ${esc(names[my])}'s balls are circles, ${esc(names[1 - my])}'s are squares. Left is the camera side, so after changing ends the same player's balls show on both halves.`)}</p>`;
}

function zoneGrids(a, names, my) {
  const grid = (slot) => {
    const zones = a.zones[slot];
    const flat = zones.flat();
    const total = flat.reduce((s, n) => s + n, 0);
    const max = Math.max(1, ...flat);
    // Deep row on top and the net at the bottom: the far court as the shooter sees it.
    const rows = [2, 1, 0].map((r) => `<span class="an-zr">${ZONE_ROWS[r]}</span>${zones[r].map((n) => `<span class="an-cell ${slot === my ? 'me' : 'op'}" style="--a: ${(n / max).toFixed(2)}"><b>${n}</b><small>${total ? pct(n, total) : '0%'}</small></span>`).join('')}`).join('');
    const cols = `<span></span>${ZONE_COLS.map((c) => `<span class="an-zc">${c}</span>`).join('')}`;
    return `<figure class="an-zone"><figcaption><b>${esc(names[slot])} · ${role(slot, my)}</b> <small>${L(`상대 코트에 떨어진 공 ${total}개`, `${total} ${total === 1 ? 'ball' : 'balls'} landed on the opponent's half`)}</small></figcaption>
      <div class="an-zgrid" role="img" aria-label="${L(`${esc(names[slot])}의 코스 9칸, 깊이와 좌우별 개수`, `${esc(names[slot])}: 9 placement zones, count by depth and side`)}">${rows}${cols}</div>
      <p class="an-net">${L('네트 쪽 · 친 사람이 보는 방향', 'Net side · as the hitter sees it')}</p></figure>`;
  };
  return `<div class="an-zones">${grid(my)}${grid(1 - my)}</div>`;
}

const colHead = (names, my) => [my, 1 - my].map((slot) => `<th scope="col">${esc(names[slot])}<small>${role(slot, my)}</small></th>`).join('');
const rate = (won, n, detail) => (n ? `<b>${pct(won, n)}</b><small>${detail}</small>` : `<span class="an-none">${L('없음', 'None')}</span>`);

// Without an accuracy table every phone technique is an estimate. With one, accuracyStatus decides per
// technique: 'sample' prints 표본 부족 instead of the numbers, 'estimate' keeps the numbers and the 추정
// badge, 'measured' shows the numbers alone.
function techTable(a, names, my, accuracy) {
  const status = (key) => (accuracy ? accuracyStatus(accuracy, key) : 'estimate');
  // rates count only shots of points with a decided winner; below REPORT_MIN_N of those there is no rate
  const few = (a.decided ?? 0) < REPORT_MIN_N;
  const cells = (key) => (few
    ? `<td colspan="2" class="an-sample"><span class="an-none">${L('알 수 없음', 'Unknown')}</span></td>`
    : status(key) === 'sample'
    ? `<td colspan="2" class="an-sample"><span class="an-none">${L('표본 부족', 'Too few samples')}</span></td>`
    : [my, 1 - my].map((slot) => `<td>${rate(a.tech[slot][key].ok, a.tech[slot][key].n, `${a.tech[slot][key].ok}/${a.tech[slot][key].n}`)}</td>`).join(''));
  const rows = TECH_KEYS.map((key) => `<tr><th scope="row">${TECH_LABELS[key]}${status(key) === 'estimate' ? `<span class="badge an-est">${L('추정', 'est.')}</span>` : ''}</th>${cells(key)}</tr>`).join('');
  // Two plain lines for players; the measured numbers behind them live in the report and the PR.
  const notes = [
    ...(few ? [L(`아직 득점이 정해진 포인트가 적어요(${a.decided ?? 0}개). 성공률은 ${REPORT_MIN_N}개부터 보여요.`, `Few points have a decided winner yet (${a.decided ?? 0}); success rates show from ${REPORT_MIN_N}.`)] : []),
    ...(accuracy
      ? [L('추정은 아직 틀릴 때가 많아요.', 'Est. means it is still often wrong.'), L('표본 부족은 쓸 만큼 쌓이지 않은 기술이에요.', 'Too few samples means not enough data has built up yet.')]
      : [L('추정: 정확도 표가 아직 없어 모든 기술을 추정으로 표시해요.', 'Est.: there is no accuracy table yet, so every technique is marked as an estimate.')]),
    L(`판정 못 한 샷 ${esc(names[my])} ${a.unclassified[my]}개 · ${esc(names[1 - my])} ${a.unclassified[1 - my]}개는 성공률에서 뺐어요.`, `Unclassified shots, left out of the success rates: ${esc(names[my])} ${a.unclassified[my]} · ${esc(names[1 - my])} ${a.unclassified[1 - my]}.`),
  ];
  return `<table class="an-table"><thead><tr><th scope="col">${L('기술 · 성공/시도', 'Technique · hit/tried')}<small class="an-basis">${L(`(포인트 ${a.decided ?? 0}개 기준)`, `(from ${a.decided ?? 0} points)`)}</small></th>${colHead(names, my)}</tr></thead><tbody>${rows}</tbody></table>
    <p class="hint">${notes.join('<br>')}</p>`;
}

function lengthTable(a, names, my) {
  const rows = a.length.map((b) => `<tr><th scope="row">${b.label}</th><td>${L(`${b.n}번`, b.n)}</td>${[my, 1 - my].map((slot) => `<td>${rate(b.won[slot], b.n, L(`${b.won[slot]}승`, `${b.won[slot]} won`))}</td>`).join('')}</tr>`).join('');
  return `<table class="an-table"><thead><tr><th scope="col">${L('길이', 'Length')}</th><th scope="col">${L('랠리', 'Rallies')}</th>${colHead(names, my)}</tr></thead><tbody>${rows}</tbody></table>
    <p class="hint">${L('몇 구째에서 승부가 갈리는지 봐요. 1~2구는 서브와 리시브예요.', 'See on which shot the point is decided. Shots 1-2 are the serve and receive.')}</p>`;
}

const playButton = (index, clip) => (clip
  ? `<button class="btn an-play" data-act="an-play" data-src="${esc(clip)}/video" aria-label="${L(`${index + 1}번째 포인트 다시 보기`, `Replay point ${index + 1}`)}">${L('다시 보기', 'Replay')}</button>`
  : `<button class="btn an-play" disabled aria-label="${L(`${index + 1}번째 포인트 영상 없음`, `Point ${index + 1}: no video`)}">${L('영상 없음', 'No video')}</button>`);

function top5(a, names) {
  const rows = a.top5.map((r, i) => `<li><span class="an-rank">${i + 1}</span><span class="an-top-main"><b>${L(`${r.shots}구 · ${(r.durationMs / 1000).toFixed(1)}초`, `${r.shots} ${r.shots === 1 ? 'shot' : 'shots'} · ${(r.durationMs / 1000).toFixed(1)} s`)}</b><small>${L(`${r.index + 1}번째 포인트`, `Point ${r.index + 1}`)} · ${r.winner === null ? L('득점자 모름', 'Scorer unknown') : L(`${esc(names[r.winner])} 득점`, `${esc(names[r.winner])} scored`)}</small></span>${playButton(r.index, r.clip)}</li>`).join('');
  return `<ol class="an-top">${rows}</ol>`;
}

function timelines(a, names, my, m) {
  const chip = (i) => (m.clips[i]
    ? `<button class="chip an-chip" data-act="an-play" data-src="${esc(m.clips[i])}/video" aria-label="${L(`${i + 1}번째 포인트 다시 보기`, `Replay point ${i + 1}`)}">${i + 1}${PLAY}</button>`
    : `<button class="chip an-chip" disabled aria-label="${L(`${i + 1}번째 포인트 영상 없음`, `Point ${i + 1}: no video`)}">${i + 1}</button>`);
  const row = (slot) => `<div class="an-tl"><p class="an-tl-name"><b>${esc(names[slot])}</b><small>${role(slot, my)} · ${L(`${a.timeline[slot].length}점`, `${a.timeline[slot].length} ${a.timeline[slot].length === 1 ? 'pt' : 'pts'}`)}</small></p>
    <div class="an-chips">${a.timeline[slot].map(chip).join('') || `<span class="an-none">${L('득점 없음', 'No points')}</span>`}</div></div>`;
  return `${row(my)}${row(1 - my)}<p class="hint">${L(`번호는 포인트 순서예요. ${PLAY} 표시가 있는 포인트만 영상을 볼 수 있어요.`, `Numbers are the point order. Only points marked ${PLAY} have video.`)}</p>`;
}

// data-act handlers, merged into app.js's table.
export const analysisHandlers = {
  'an-open'(b) { app.go(() => openAnalysis(b.dataset.id, b.dataset.hist || null)); },
  'an-me'(b) {
    localStorage.setItem(ME_KEY, b.dataset.slot);
    app.render();
  },
  'an-play'(b) { app.openReplay(b.dataset.src); },
  'an-reload'() {
    if (!sheet) return;
    sheet.loadedFor = null;
    app.render();
  },
};
