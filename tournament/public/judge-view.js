// 카메라 판정 비교: after a match, how often the camera's call matched what the referee entered, and where it
// did not. The numbers come from GET /api/judge/summary (public/judge-compare.js on the server); this file
// draws them and builds the CSV on the device, in the screen's language. app.js hands over render, go, esc
// and openReplay once through bindJudge. See docs/judge-log.md.
import { L, LOCALE, errorText } from './i18n.js';
import { labelText } from './engine.js';

let app = null;
// The open page: the match whose points are listed (null = none picked yet), and what it fetched.
let page = null;

export function bindJudge(deps) { app = deps; }
export const judgeKey = () => page?.key ?? null;
export function openJudge(matchId = null) {
  page = { key: `j/${matchId ?? ''}`, matchId: matchId || null, data: null, error: null, loading: false, loadedFor: null };
}
export function closeJudge() { page = null; }
export function syncJudge(key) {
  if ((key ?? null) === judgeKey()) return;
  if (!key) { page = null; return; }
  openJudge(key.slice(2));
}

const OUTCOME = {
  same: L('같음', 'Same'),
  different: L('다름', 'Different'),
  cancelled: L('가짜 · 취소', 'Fake · cancelled'),
  undone: L('가짜 · 되돌림', 'Fake · undone'),
  ignored: L('안 넣음', 'Not entered'),
  open: L('확인 대기', 'Waiting'),
  no_call: L('카메라 판정 없음', 'No camera call'),
};
const DROP = { replaced: L('다음 판정에 밀림', 'replaced by the next call'), let: L('렛', 'let'), rally: L('다음 랠리 시작', 'next rally started'), timeout: L('시간 지남', 'timed out'), fix: L('점수 고침', 'score fixed'), cancel: L('바로 취소', 'cancelled at once') };
const WHY = { ball_lost: L('공 놓침', 'ball lost'), no_shot: L('샷 끊김', 'no next shot'), no_bounce: L('바운드 없음', 'no bounce') };
const REASON = { double_bounce: L('두 번 튐', 'double bounce'), no_return: L('못 받음', 'missed') };
const END = [L('블루', 'Blue'), L('레드', 'Red')];
const BY = (by) => (by === 'referee' ? L('심판 화면', 'Referee screen') : by ? L('카메라 폰', 'Camera phone') : '');

const esc = (s) => app.esc(s);
const pct = (v) => (v === null ? '–' : `${v}%`);
const secs = (ms) => (ms === null || ms === undefined ? '–' : L(`${(ms / 1000).toLocaleString(LOCALE, { maximumFractionDigits: 1 })}초`, `${(ms / 1000).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} s`));
const matchName = (no) => (no === null ? '–' : L(`${no}경기`, `Match ${no}`));
const nameAt = (d, matchId, slot) => (slot === null || slot === undefined ? '–' : d.names?.[matchId]?.[slot] ?? END[slot]);
const callText = (d, p) => {
  if (!p.call) return L('판정 없음', 'none');
  const c = p.call;
  const how = [c.sure ? L('확실', 'sure') : L('약함', 'weak'), REASON[c.reason] ?? null, WHY[c.why] ?? null].filter(Boolean).join(' · ');
  return `${END[c.end]} ${nameAt(d, p.matchId, c.slot)} (${how})`;
};
const withEnd = (end, name) => (end === null || end === undefined ? name : `${END[end]} ${name}`);
const pickText = (d, p) => (p.finalSide === null ? '–' : withEnd(p.finalEnd, nameAt(d, p.matchId, p.finalSide)));
// the point's number on the score sheet; none for a call that never became a point or was taken back
const pointNo = (p) => (p.finalSide === null || p.finalSide === undefined ? null : p.index + 1);
const fixText = (p) => p.fixes.map((f) => (f.kind === 'flip' ? L('반대로 고침', 'flipped') : L('되돌림', 'undone'))).join(', ');

function load(p, stamp) {
  p.loading = true;
  fetch('/api/judge/summary', { cache: 'no-store' })
    .then(async (res) => {
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(body, L(`대회 응답 ${res.status}`, `Tournament replied ${res.status}`)));
      return body;
    })
    .then((data) => { p.data = data; p.error = null; })
    .catch((err) => { p.error = String(err.message || err); })
    .finally(() => {
      p.loading = false;
      p.loadedFor = stamp;
      if (page === p) app.render();
    });
}

const stat = (value, label, cls = '') => `<div class="jg-stat ${cls}"><b>${value}</b><span>${label}</span></div>`;

function totalCard(t) {
  return `<section class="card jg-total"><h2>${L('전체', 'All matches')}</h2>
    <div class="jg-stats">
      ${stat(t.calls, L('카메라 판정', 'Camera calls'))}
      ${stat(`${t.same}/${t.same + t.different}<small> · ${pct(t.agreePct)}</small>`, `${L('심판과 같음', 'Same as referee')}<small class="jg-note">${L('놓침·가짜·안 넣음 제외', 'missed, fake and not entered left out')}</small>`, 'ok')}
      ${stat(t.different, L('심판과 다름', 'Different'), t.different ? 'bad' : '')}
      ${stat(`${pct(t.surePct)}<small> · ${t.sureSame}/${t.sureSame + t.sureDifferent}</small>`, L('확실 판정 맞음', 'Sure calls right'))}
      ${stat(t.missed, L('카메라가 놓친 점수', 'Points the camera missed'), t.missed ? 'bad' : '')}
      ${stat(t.fake, L('가짜 판정 (심판이 취소)', 'Fake calls (cancelled)'), t.fake ? 'bad' : '')}
    </div>
    <p class="jg-line">${L(`약한 판정 ${t.weak}번: 카메라 추정 쪽 ${t.weakGuess} · 반대쪽 ${t.weakOther} · 안 넣음 ${t.weakOut}`, `Weak calls ${t.weak}: camera's guess ${t.weakGuess} · other side ${t.weakOther} · not entered ${t.weakOut}`)}</p>
    <p class="jg-line">${L(`안 넣은 판정 ${t.ignored} · 확인 대기 ${t.open} · 나중에 고친 점수 ${t.fixed} · 확인까지 평균 ${secs(t.avgMs)}`, `Calls not entered ${t.ignored} · waiting ${t.open} · fixed later ${t.fixed} · average time to confirm ${secs(t.avgMs)}`)}</p>
  </section>`;
}

function matchTable(rows, sel) {
  const head = [L('경기', 'Match'), L('판정', 'Calls'), L('같음', 'Same'), L('다름', 'Diff.'), L('확실<br>맞음', 'Sure<br>right'), L('약함<br>추정/반대', 'Weak<br>guess/<br>other'), L('놓침', 'Missed'), L('가짜', 'Fake')];
  const body = rows.map((r) => `<tr class="${r.matchId === sel ? 'on' : ''}"><th scope="row"><button type="button" class="jg-pick" data-act="jg-match" data-id="${esc(r.matchId)}" aria-pressed="${r.matchId === sel}">${r.no === null ? '–' : L(`${r.no}경기`, `M${r.no}`)}</button></th><td>${r.calls}</td><td>${r.same}</td><td class="${r.different ? 'bad' : ''}">${r.different}</td><td>${pct(r.surePct)}</td><td>${r.weakGuess}/${r.weakOther}</td><td class="${r.missed ? 'bad' : ''}">${r.missed}</td><td class="${r.fake ? 'bad' : ''}">${r.fake}</td></tr>`).join('');
  return `<section class="card"><h2>${L('경기별', 'By match')}</h2>
    <table class="jg-table"><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>
    <p class="hint">${L('경기를 누르면 포인트마다 카메라 판정과 심판 입력이 아래에 나와요.', 'Tap a match to list each point\'s camera call and referee entry below.')}</p>
  </section>`;
}

function pointList(d, matchId) {
  const pts = d.points.filter((p) => p.matchId === matchId);
  const row = d.matches.find((r) => r.matchId === matchId);
  const items = pts.map((p) => {
    const no = pointNo(p) ?? '–';
    const extra = [p.by ? BY(p.by) : null, p.ms !== null && p.ms !== undefined ? L(`확인 ${secs(p.ms)}`, `confirmed in ${secs(p.ms)}`) : null, p.dropWhy ? DROP[p.dropWhy] : null, p.hold ? L('끝 색 반대 보류', 'end colour hold') : null, p.disagree ? L('카메라 2대 엇갈림', 'cameras disagreed') : null, p.fixes.length ? fixText(p) : null].filter(Boolean).join(' · ');
    const clip = p.clip ? `<button class="chip jg-clip" data-act="an-play" data-src="${esc(p.clip)}/video" aria-label="${L(`${no}번째 포인트 다시 보기`, `Replay point ${no}`)}">${L('다시 보기', 'Replay')}</button>` : '';
    return `<li class="jg-pt ${p.outcome}"><div class="jg-pt-top"><b class="jg-no">${no}</b><span class="tag jg-tag ${p.outcome}">${OUTCOME[p.outcome]}</span>${clip}</div>
      <div class="kv jg-kv"><span>${L('카메라', 'Camera')}</span><span>${esc(callText(d, p))}</span><span>${L('심판', 'Referee')}</span><span>${esc(pickText(d, p))}</span>${extra ? `<span>${L('기타', 'More')}</span><span>${esc(extra)}</span>` : ''}</div></li>`;
  }).join('');
  return `<section class="card"><h2>${L(`${row ? matchName(row.no) : ''} 포인트별`, `${row ? matchName(row.no) : ''} point by point`)}</h2>${items ? `<ol class="jg-pts">${items}</ol>` : `<p class="hint">${L('이 경기에는 기록이 없어요.', 'Nothing recorded for this match.')}</p>`}</section>`;
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvOf = (rows) => `\ufeff${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

export function judgeCsv(d, kind) {
  if (kind === 'matches') {
    const head = [L('경기', 'Match'), L('카메라 판정', 'Camera calls'), L('같음', 'Same'), L('다름', 'Different'), L('같음 비율 (놓침·가짜·안 넣음 제외)', 'Same % (missed, fake and not entered left out)'), L('확실 판정', 'Sure calls'), L('확실 맞음', 'Sure right'), L('확실 틀림', 'Sure wrong'), L('확실 맞음 비율', 'Sure right %'), L('약한 판정', 'Weak calls'), L('약함 추정 쪽', 'Weak: guess side'), L('약함 반대쪽', 'Weak: other side'), L('약함 안 넣음', 'Weak: not entered'), L('놓친 점수', 'Missed points'), L('가짜 (취소)', 'Fake (cancelled)'), L('가짜 (되돌림)', 'Fake (undone)'), L('안 넣음', 'Not entered'), L('확인 대기', 'Waiting'), L('나중에 고침', 'Fixed later'), L('평균 확인 초', 'Average seconds to confirm')];
    const line = (r, name) => [name, r.calls, r.same, r.different, r.agreePct, r.sure, r.sureSame, r.sureDifferent, r.surePct, r.weak, r.weakGuess, r.weakOther, r.weakOut, r.missed, r.cancelled, r.undone, r.ignored, r.open, r.fixed, r.avgMs === null ? null : (r.avgMs / 1000).toFixed(1)];
    return csvOf([head, ...d.matches.map((r) => line(r, matchName(r.no))), line(d.total, L('전체', 'All'))]);
  }
  const head = [L('경기', 'Match'), L('포인트', 'Point'), L('결과', 'Result'), L('카메라 판정 시각', 'Call time'), L('랠리 시작', 'Rally start'), L('랠리 끝', 'Rally end'), L('카메라 끝 색', 'Camera end colour'), L('카메라 선수', 'Camera player'), L('확실/약함', 'Sure/weak'), L('판정 이유', 'Reason'), L('끝난 이유', 'Why it ended'), L('샷', 'Shots'), L('바운드', 'Bounces'), L('미리 고른 쪽', 'Pre-chosen'), L('추정 쪽', 'Guess'), L('끝 색 반대 보류', 'End colour hold'), L('카메라 2대 엇갈림', 'Cameras disagreed'), L('처음 넣은 선수', 'Entered for'), L('최종 선수', 'Final player'), L('누가 넣음', 'Entered by'), L('확인 초', 'Seconds to confirm'), L('나중에 고침', 'Fixed later'), L('안 넣은 이유', 'Why not entered'), L('클립', 'Clip')];
  const time = (ms) => (ms ? new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }) : null);
  const yes = (v) => (v ? L('예', 'yes') : '');
  const rows = d.points.map((p) => {
    const c = p.call;
    return [matchName(p.no), pointNo(p), OUTCOME[p.outcome], time(c ? p.at : null), time(p.rally?.startMs), time(p.rally?.endMs), c ? END[c.end] : null, c ? nameAt(d, p.matchId, c.slot) : null, c ? (c.sure ? L('확실', 'sure') : L('약함', 'weak')) : null, c ? REASON[c.reason] ?? c.reason : null, c ? WHY[c.why] ?? c.why : null, c ? c.shots : null, c ? c.bounces : null, p.pre === null || p.pre === undefined ? null : END[p.pre], p.guess === null || p.guess === undefined ? null : END[p.guess], yes(p.hold), yes(p.disagree), p.enteredSide === null ? null : withEnd(p.enteredEnd, nameAt(d, p.matchId, p.enteredSide)), p.finalSide === null ? null : withEnd(p.finalEnd, nameAt(d, p.matchId, p.finalSide)), BY(p.by), p.ms === null || p.ms === undefined ? null : (p.ms / 1000).toFixed(1), fixText(p), p.dropWhy ? DROP[p.dropWhy] : null, p.clip];
  });
  return csvOf([head, ...rows]);
}

function download(kind) {
  const d = page?.data;
  if (!d) return;
  const blob = new Blob([judgeCsv(d, kind)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  a.download = kind === 'matches' ? L(`카메라판정-경기별-${day}.csv`, `camera-calls-by-match-${day}.csv`) : L(`카메라판정-포인트별-${day}.csv`, `camera-calls-by-point-${day}.csv`);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// rev: the tournament's record number, so a point entered while the page is open shows on the next draw.
export function judgeView({ rev, tournament }) {
  const p = page;
  if (!p.loading && p.loadedFor !== rev) load(p, rev);
  const head = `<p class="an-match jg-head"><b>${esc(labelText(tournament.name))}</b> · ${L('카메라 판정과 심판 입력', 'camera calls and referee entries')}</p>`;
  const d = p.data;
  if (!d) return `<div class="judge">${head}${p.error ? `<section class="card"><p class="warn">${esc(p.error)}</p></section>` : `<p class="loading">${L('불러오는 중…', 'Loading…')}</p>`}</div>`;
  if (!d.points.length) return `<div class="judge">${head}<section class="card"><p class="h1">${L('아직 기록이 없어요', 'Nothing recorded yet')}</p><p class="hint">${L('카메라가 대회에 연결돼 포인트를 판정하면 여기에 쌓여요. 심판이 직접 넣은 점수도 같이 남아요.', 'Each point the linked camera judges is kept here, next to what the referee entered. Points entered by hand are kept too.')}</p></section></div>`;
  const sel = d.matches.some((r) => r.matchId === p.matchId) ? p.matchId : d.matches.at(-1)?.matchId ?? null;
  return `<div class="judge">${head}${totalCard(d.total)}${matchTable(d.matches, sel)}${sel ? pointList(d, sel) : ''}
    <section class="card"><h2>${L('CSV로 받기', 'Download CSV')}</h2><div class="row"><button class="btn grow" data-act="jg-csv" data-kind="matches">${L('경기별 표', 'By match')}</button><button class="btn grow" data-act="jg-csv" data-kind="points">${L('포인트별', 'Point by point')}</button></div>
    <p class="hint">${L('이 PC에만 있는 기록이에요. 이름은 대회 기록의 선수 이름만 써요.', 'The record stays on this PC. Names are the ones already in the tournament record.')}</p></section>
  </div>`;
}

export const judgeHandlers = {
  'jg-open'(b) { app.go(() => openJudge(b.dataset.id || null)); },
  'jg-match'(b) {
    if (!page) return;
    page.matchId = b.dataset.id;
    app.render();
  },
  'jg-csv'(b) { download(b.dataset.kind); },
};
