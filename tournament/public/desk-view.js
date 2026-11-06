// 분석 데스크: the 경기 tab of the desk mode (app.js, role 'desk'). The queue lives on the server
// (data/desk/queue.json, docs/analysis-desk.md); this file draws it, uploads videos in resumable
// chunks, takes the four table corners on a picked video's first frame and shows the shooting guide.
// app.js hands over render, go, esc, api, ask, icon, pinForm and pin once through bindDesk.
import { openAnalysis } from '/analysis-view.js';
import { nameOf, normalizeKey, peopleEntries } from '/people-pick.js';
import { L, EN, LOCALE } from './i18n.js';
import { kindText } from './analysis.js';

const POLL_MS = 3000;
const CHUNK = 4 * 1024 * 1024;
const MAX_TITLE = 80;
const FRAME_W = 960;
const KEY_RE = /^([^,]{1,20}),(\d{4})$/u;
const STATE_WORDS = { uploading: L('올리는 중', 'Uploading'), queued: L('대기열', 'Queued'), waiting: L('대기 중', 'Waiting'), running: L('분석 중', 'Analysing'), done: L('끝', 'Done'), failed: L('실패', 'Failed') };
// The same four taps, in the same order, as the camera screen's court calibration.
const CORNER_PROMPTS = [L('내 쪽 끝선 왼쪽 모서리를 누르세요', 'Tap the near-left corner'), L('내 쪽 끝선 오른쪽 모서리를 누르세요', 'Tap the near-right corner'), L('건너편 끝선 오른쪽 모서리를 누르세요', 'Tap the far-right corner'), L('건너편 끝선 왼쪽 모서리를 누르세요', 'Tap the far-left corner')];
const GUIDE = [
  L('폰을 삼각대나 선반에 고정해요. 손에 들고 찍으면 안 돼요.', 'Fix the phone to a tripod or shelf; do not hand-hold it.'),
  L('탁구대 네 모서리가 모두 화면 안에 들어오게 해요.', 'Keep all four table corners in frame.'),
  L('카메라 높이는 탁구대 면과 같거나 더 높게, 끝선 뒤나 옆에서 찍어요.', 'Film from behind or beside an end line, at table height or higher.'),
  L('조명은 고르게, 깜빡이는 등이나 역광은 피해요.', 'Use even lighting; avoid flickering lights and backlight.'),
  L('탁구대 뒤 배경을 비워요. 지나다니는 사람과 다른 공이 없어야 해요.', 'Keep the area behind the table clear of people and other balls.'),
];

let app = null;
let pid = 0;
// jobs/worker: the last queue answer. pending: picked files not yet sent. uploads: jobId -> the upload
// this page is running (the File stays in memory across renders; a reload loses it and the job's row
// offers 이어 올리기). people: nothing here, see people-pick.js.
const desk = { jobs: null, worker: null, error: null, loading: false, snapshot: '', timer: null, pending: [], uploads: new Map(), resumeErrors: {}, sending: false };

export function bindDesk(deps) { app = deps; }

const esc = (s) => app.esc(s);
const kst = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const fmtBytes = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtDay = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? '')); return m ? L(`${Number(m[2])}월 ${Number(m[3])}일`, new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(LOCALE, { month: 'short', day: 'numeric', year: 'numeric' })) : String(iso ?? ''); };
const fmtAgo = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 90 ? L(`${s}초 전`, `${s} sec ago`) : s < 5400 ? L(`${Math.round(s / 60)}분 전`, `${Math.round(s / 60)} min ago`) : L(`${Math.round(s / 3600)}시간 전`, `${Math.round(s / 3600)} hr ago`); };
const card = (title, body, cls = '') => `<section class="card ${cls}"><h2>${title}</h2>${body}</section>`;
const bar = (done, total, label) => `<div class="dk-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}" aria-label="${esc(label)}"><i style="--p: ${total ? ((done / total) * 100).toFixed(1) : 0}%"></i></div>`;
const playerLine = (p) => `${esc(nameOf(p?.near) ?? L('이름 없음', 'Unknown'))} vs ${esc(nameOf(p?.far) ?? L('이름 없음', 'Unknown'))}`;

// ---------- the queue ----------

async function loadJobs() {
  if (!app.pin()) return;
  desk.loading = true;
  try {
    const data = await app.api('/api/desk/jobs', undefined, { method: 'GET' });
    const snapshot = JSON.stringify([data.jobs, data.worker.alive]);
    desk.error = null;
    if (snapshot !== desk.snapshot) {
      desk.snapshot = snapshot;
      desk.jobs = data.jobs;
      desk.worker = data.worker;
      app.render();
    }
  } catch (e) {
    const error = e instanceof TypeError ? L('서버에 연결하지 못했어요.', 'Could not connect to the server.') : e.message;
    if (error !== desk.error) { desk.error = error; app.render(); }
  }
  desk.loading = false;
}

// Polls only while the desk is on screen and the page is visible; the tick stops itself otherwise and
// deskView starts it again.
function ensurePoll() {
  if (desk.timer) return;
  const tick = () => {
    if (!document.querySelector('.desk') || document.visibilityState !== 'visible') { clearInterval(desk.timer); desk.timer = null; return; }
    loadJobs();
  };
  desk.timer = setInterval(tick, POLL_MS);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && document.querySelector('.desk')) { loadJobs(); ensurePoll(); } });

function workerLine() {
  const w = desk.worker;
  if (!w) return '';
  if (w.alive) return `<p class="dk-worker on" role="status"><span class="dk-dot" aria-hidden="true"></span>${L('분석기가 켜져 있어요', 'Analyzer is online')}</p>`;
  return `<p class="dk-worker off" role="status"><span class="dk-dot" aria-hidden="true"></span>${L('분석 PC가 아직 켜지지 않았어요', 'Analysis PC is offline')}${w.lastSeen ? ` · ${L('마지막 신호', 'Last seen')} ${fmtAgo(w.lastSeen)}` : ''}. ${L('올린 영상은 남아 있다가 분석 PC가 켜지면 차례로 돌아가요.', 'Uploaded videos are saved and will be processed when it comes online.')}</p>`;
}

// A gallery job whose first pass is saved: its shots can be opened while forehand/backhand is analysed.
const shotsFirst = (j) => j.kind === 'gallery' && !!j.note?.handPending && j.state !== 'failed' && j.state !== 'done';
const PENDING_NOTE = () => `<span class="dk-state"><i class="dk-mark done" aria-hidden="true"></i>${L('샷 결과 나옴 · 포·백 분석 중', 'Shots ready · forehand/backhand in progress')}</span>`;

function stateLine(j) {
  const up = desk.uploads.get(j.id);
  const word = STATE_WORDS[j.state] ?? j.state;
  const pending = shotsFirst(j) ? PENDING_NOTE() : '';
  if (j.state === 'uploading') {
    if (up?.state === 'sending') return `<span class="dk-state"><i class="dk-mark run" aria-hidden="true"></i>${word} · ${Math.floor((up.sent / up.total) * 100)}%</span>${bar(up.sent, up.total, L(`${j.title} 올리기`, `Uploading ${j.title}`))}`;
    if (up?.state === 'error') return `<span class="dk-state err"><i class="dk-mark fail" aria-hidden="true"></i>${L('올리기 멈춤', 'Upload paused')} · ${esc(up.error)}</span>`;
    const wrong = desk.resumeErrors[j.id] ? `<span class="dk-state err">${esc(desk.resumeErrors[j.id])}</span>` : '';
    return `<span class="dk-state"><i class="dk-mark wait" aria-hidden="true"></i>${L('이어 올리기 필요', 'Resume upload needed')} · ${fmtBytes(j.video.received)} / ${fmtBytes(j.video.bytes)}</span>${wrong}`;
  }
  if (j.state === 'queued') return `${pending}<span class="dk-state"><i class="dk-mark wait" aria-hidden="true"></i>${word} · ${desk.worker && !desk.worker.alive ? L('분석 PC가 아직 켜지지 않았어요. 켜지면 차례로 돌아가요', 'Analysis PC is offline; jobs will run when it comes online.') : L('분석기 차례를 기다려요', 'Waiting for the analyzer')}${j.attempts ? ` · ${esc(EN && j.errorEn ? j.errorEn : j.error ?? '')} (${L(`${j.attempts + 1}번째 시도`, `attempt ${j.attempts + 1}`)})` : ''}</span>`;
  if (j.state === 'waiting') return `${pending}<span class="dk-state"><i class="dk-mark wait" aria-hidden="true"></i>${j.waitPos === null ? L('분석기가 GPU 차례를 기다려요', 'Waiting for a GPU slot') : L(`대기 중 ${j.waitPos}번째`, `Queue position ${j.waitPos}`)}</span>`;
  if (j.state === 'running') {
    const p = j.progress;
    return `${pending}<span class="dk-state"><i class="dk-mark run" aria-hidden="true"></i>${word}${p ? ` · ${p.done.toLocaleString(LOCALE)}/${p.total.toLocaleString(LOCALE)} ${L('프레임', 'frames')}` : ''}</span>${p ? bar(p.done, p.total, L(`${j.title} 분석 진행`, `Analysis progress for ${j.title}`)) : ''}`;
  }
  if (j.state === 'failed') return `<span class="dk-state err"><i class="dk-mark fail" aria-hidden="true"></i>${word} · ${esc(EN && j.errorEn ? j.errorEn : j.error ?? L('분석 실패', 'Analysis failed'))}</span>`;
  return `<span class="dk-state ok"><i class="dk-mark done" aria-hidden="true"></i>${word}${j.note?.dropped ? L(` · 랠리 ${j.note.dropped}개는 버렸어요`, ` · ${j.note.dropped} rallies dropped`) : ''}${j.note?.timing === 'estimated' ? L(' · 샷 시각은 추정(옛 원본)', ' · Shot times estimated (legacy source)') : j.note?.timing === 'track' ? L(' · 카메라 샷 시각', ' · Camera shot times') : ''}${j.error ? ` · ${esc(EN && j.errorEn ? j.errorEn : j.error)}` : ''}</span>`;
}

// The wide actions (결과 보기, 같은 파일 고르기, 다시 시도) sit under the state line on their own row, so
// the title and state keep the full width on a phone; only the delete glyph shares the title row.
function jobActs(j) {
  const up = desk.uploads.get(j.id);
  const acts = [];
  if (j.state === 'done' || shotsFirst(j)) acts.push(`<button class="btn dk-result" data-act="dk-result" data-id="${j.id}" data-kind="${j.kind}" data-match="${esc(j.matchRef?.matchId ?? '')}" data-tour="${esc(j.matchRef?.tournament ?? '')}">${L('결과 보기', 'View results')}</button>`);
  if (j.state === 'uploading' && up?.state === 'error') acts.push(`<button class="btn" data-act="dk-retry" data-id="${j.id}">${L('다시 시도', 'Retry')}</button>`);
  if (j.state === 'uploading' && !up) acts.push(`<label class="btn dk-pick"><input type="file" accept="video/*" data-dk-resume="${j.id}" class="dk-input">${L('같은 파일 고르기', 'Choose same file')}</label>`);
  return acts.length ? `<div class="dk-acts">${acts.join('')}</div>` : '';
}

function jobRow(j) {
  const where = j.kind === 'rally' ? `${L('대회 경기', 'Match')} ${esc(j.matchRef?.matchId ?? '')} · ${j.matchRef ? L(`${j.matchRef.index + 1}번째 포인트`, `Point ${j.matchRef.index + 1}`) : ''}` : playerLine(j.players);
  const del = j.state !== 'running' && j.state !== 'waiting' ? `<button class="icon-btn del" data-act="dk-delete" data-id="${j.id}" data-title="${esc(j.title)}" aria-label="${L(`'${esc(j.title)}' 일감 지우기`, `Delete job '${esc(j.title)}'`)}">${app.icon('trash')}</button>` : '';
  return `<div class="dk-job" data-state="${j.state}">
    <div class="dk-head"><b class="dk-title">${esc(j.title)}</b>${del}</div>
    <small class="dk-sub">${where} · ${fmtDay(j.playedAt)} · ${fmtBytes(j.video.bytes)}</small>
    ${stateLine(j)}${jobActs(j)}</div>`;
}

function queueCard() {
  if (desk.error && !desk.jobs) return card(L('대기열', 'Queue'), `<p class="warn">${esc(desk.error)}</p><button class="btn primary" data-act="dk-reload">${L('다시 시도', 'Retry')}</button>`);
  if (!desk.jobs) return card(L('대기열', 'Queue'), `<p class="loading">${L('대기열을 불러오는 중…', 'Loading queue…')}</p>`);
  const jobs = desk.jobs;
  const left = jobs.filter((j) => j.state !== 'done' && j.state !== 'failed').length;
  const counts = Object.entries(STATE_WORDS).map(([s, w]) => [w, jobs.filter((j) => j.state === s).length]).filter(([, n]) => n);
  const summary = jobs.length ? `<p class="hint">${L(`남은 영상 ${left}개`, `${left} videos left`)} · ${counts.map(([w, n]) => `${w} ${n}`).join(' · ')}${desk.error ? ` · ${L('마지막 새로 고침 실패', 'Last refresh failed')}: ${esc(desk.error)}` : ''}</p>` : '';
  // newest first, folded like every long list: over 10 rows show 5 until 전체 n개 보기
  const list = jobs.length
    ? `<div class="dk-jobs">${app.foldRows('desk-jobs', [...jobs].reverse().map(jobRow), { few: L('최근', 'Recent') })}</div>`
    : `<p class="hint empty">${L('아직 올린 영상이 없어요. 아래에서 영상을 골라 올려요.', 'No videos uploaded yet. Choose videos below to upload.')}</p>`;
  return `<section class="card"><h2 class="fold-title">${app.foldHead('desk-jobs', L('대기열', 'Queue'), L(`${jobs.length}개`, `${jobs.length} jobs`))}</h2>${workerLine()}${summary}${list}</section>`;
}

// ---------- new videos ----------

function pendingRow(p) {
  const field = (key, label, extra = '') => `<div class="field"><label for="dk-${p.id}-${key}">${label}</label>${extra}<p class="err-text" id="dk-${p.id}-${key}-err">${esc(p.errors[key] ?? '')}</p></div>`;
  const player = (key, label) => field(key, label, `<input id="dk-${p.id}-${key}" data-dk-field="${key}" data-dk-id="${p.id}" data-people-pick value="${esc(p[key])}" placeholder="${L('이름,네자리', 'Name, four digits')}" autocomplete="off" autocapitalize="off" maxlength="26"><ul class="pp-sugg" role="listbox" aria-label="${L('등록된 선수', 'Registered players')}" hidden></ul>`);
  return `<li class="dk-file">
    <p class="dk-fname"><b>${esc(p.file.name)}</b><small>${fmtBytes(p.file.size)}</small><button class="icon-btn" data-act="dk-drop" data-id="${p.id}" aria-label="${L(`'${esc(p.file.name)}' 목록에서 빼기`, `Remove '${esc(p.file.name)}' from list`)}">${app.icon('x')}</button></p>
    <div class="dk-fields">
      ${player('near', L('가까운 쪽 선수 (카메라 쪽)', 'Near-side player (camera side)'))}
      ${player('far', L('건너편 선수', 'Far-side player'))}
      ${field('playedAt', L('친 날짜', 'Date played'), `<input id="dk-${p.id}-playedAt" type="date" data-dk-field="playedAt" data-dk-id="${p.id}" value="${esc(p.playedAt)}" max="${kst()}">`)}
      ${field('title', L('제목', 'Title'), `<input id="dk-${p.id}-title" data-dk-field="title" data-dk-id="${p.id}" value="${esc(p.title)}" maxlength="${MAX_TITLE}" autocomplete="off">`)}
    </div>
    ${cornersBlock(p)}
  </li>`;
}

function cornersBlock(p) {
  if (p.frame === null) return `<p class="hint">${L('첫 장면을 읽는 중…', 'Reading first frame…')}</p>`;
  if (p.frame === 'failed') return `<p class="hint">${L('이 영상의 첫 장면을 브라우저가 읽지 못했어요. 모서리는 건너뛰고 분석기가 탁구대를 찾아요.', 'The browser could not read this video’s first frame. Skip corners; the analyzer will find the table.')}</p>`;
  const n = p.corners.length;
  const status = n === 4 ? L('모서리 4개를 표시했어요.', 'All 4 corners marked.') : CORNER_PROMPTS[n];
  return `<div class="dk-frame">
    <p class="dk-corner-hint" role="status"><b>${L('탁구대 모서리', 'Table corners')} ${n}/4</b> ${esc(status)}</p>
    <canvas data-dk-frame="${p.id}" width="${p.frame.canvas.width}" height="${p.frame.canvas.height}" role="img" aria-label="${L(`${esc(p.file.name)}의 첫 장면. 모서리 ${n}개 표시됨`, `${esc(p.file.name)} first frame. ${n} corners marked`)}"></canvas>
    <div class="row dk-corner-acts"><button class="btn" data-act="dk-corner-undo" data-id="${p.id}" ${n ? '' : 'disabled'}>${app.icon('undo')}${L('모서리 취소', 'Undo corner')}</button><button class="btn ghost" data-act="dk-corner-reset" data-id="${p.id}" ${n ? '' : 'disabled'}>${L('다시 찍기', 'Reset corners')}</button></div>
    <p class="hint">${L('카메라 쪽 끝선 왼쪽부터 시계 방향으로 네 번 눌러요. 분석기가 이 네 점으로 탁구대 좌표를 잡아요.', 'Tap four times clockwise, starting at the near-left corner. The analyzer uses these points to map the table.')}</p>
  </div>`;
}

function addCard() {
  const picker = `<label class="btn primary dk-pick dk-pick-main"><input type="file" accept="video/*" multiple data-dk-files class="dk-input">${app.icon('plus')}${L('영상 고르기', 'Choose videos')}</label>`;
  const sending = [...desk.uploads.values()].filter((u) => u.state === 'sending');
  const sendLine = sending.length ? `<p class="hint" role="status">${L(`올리는 중 ${sending.length}개 · 남은 영상 ${sending.length + desk.pending.length}개. 이 화면을 닫지 않으면 차례로 올라가요. 닫혔다면 대기열에서 같은 파일을 다시 골라 이어 올려요.`, `Uploading ${sending.length}; ${sending.length + desk.pending.length} videos left. Keep this screen open. If it closed, choose the same file from the queue to resume.`)}</p>` : '';
  // with the worker off, say so before anything is sent rather than after a wait
  const offLine = desk.worker && !desk.worker.alive ? `<p class="hint dk-off" role="status">${L('분석 PC가 아직 켜지지 않았어요. 지금 올린 영상은 보관되고, 분석 PC가 켜지면 차례로 분석돼요.', 'Analysis PC is offline. Videos are saved and will be analyzed when it comes online.')}</p>` : '';
  if (!desk.pending.length) return card(L('영상 올리기', 'Upload videos'), `${picker}${sendLine}${offLine}<p class="hint">${L('한 번에 여러 개를 골라요. 영상은 이 PC에만 올라가고 밖으로 나가지 않아요.', 'Choose multiple videos at once. Videos are uploaded only to this PC and never leave it.')}</p>`);
  const ready = desk.pending.length;
  return card(L('영상 올리기', 'Upload videos'), `${picker}${sendLine}${offLine}
    <ol class="dk-files">${desk.pending.map(pendingRow).join('')}</ol>
    <button class="btn primary dk-send" data-act="dk-upload" ${desk.sending ? 'disabled' : ''}>${desk.sending ? L('올리는 중…', 'Uploading…') : L(`영상 ${ready}개 올리기`, `Upload ${ready} ${ready === 1 ? 'video' : 'videos'}`)}</button>
    <p class="hint">${L('선수 이름은 등록된 선수 목록에서 고르거나 이름,네자리로 적어요. 비우면 이름 없음으로 두고 선수 페이지에서 나중에 정해요.', 'Choose registered players or enter a name and four digits. Leave blank to assign players later on the player page.')}</p>`);
}

const guideCard = () => card(L('촬영 안내', 'Filming tips'), `<ol class="rules dk-guide">${GUIDE.map((g) => `<li>${g}</li>`).join('')}</ol>`);

export function deskView() {
  if (!app.pin()) {
    return `<div class="desk"><section class="card dk-span"><h2>${L('대회 PIN', 'Tournament PIN')}</h2>
      <p class="hint">${L('분석 데스크는 심판과 같은 대회 PIN으로 열어요. 영상 올리기와 대기열 보기에 써요.', 'The analysis desk uses the same tournament PIN as the referee. Use it to upload videos and view the queue.')}</p>${app.pinForm('desk-pin')}</section>${guideCard()}</div>`;
  }
  if (!desk.jobs && !desk.loading && !desk.error) loadJobs();
  ensurePoll();
  queueMicrotask(paintFrames);
  return `<div class="desk">${queueCard()}<div class="dk-side">${addCard()}${guideCard()}</div></div>`;
}

// ---------- first frame and corners ----------

async function grabFrame(p) {
  const url = URL.createObjectURL(p.file);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  const once = (ev, ms) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    v.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true });
    v.addEventListener('error', () => { clearTimeout(t); rej(new Error('decode')); }, { once: true });
  });
  try {
    v.src = url;
    await once('loadeddata', 15000);
    // the first frame of a phone clip is often black or blurred: half a second in is the table
    if (v.duration > 1) { v.currentTime = 0.5; await once('seeked', 8000); }
    const scale = Math.min(1, FRAME_W / v.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(v.videoWidth * scale);
    canvas.height = Math.round(v.videoHeight * scale);
    canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
    p.frame = { canvas, videoW: v.videoWidth, videoH: v.videoHeight };
  } catch {
    p.frame = 'failed';
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
  if (desk.pending.includes(p)) app.render();
}

function paintFrames() {
  for (const c of document.querySelectorAll('canvas[data-dk-frame]')) {
    const p = desk.pending.find((x) => String(x.id) === c.dataset.dkFrame);
    if (!p || !p.frame || p.frame === 'failed') continue;
    const ctx = c.getContext('2d');
    ctx.drawImage(p.frame.canvas, 0, 0);
    const u = Math.max(3, Math.round(c.width / 150));
    const pts = p.corners;
    if (pts.length > 1) {
      ctx.lineWidth = u;
      ctx.strokeStyle = '#ffd34d';
      ctx.beginPath();
      pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      if (pts.length === 4) ctx.closePath();
      ctx.stroke();
    }
    pts.forEach((q, i) => {
      ctx.fillStyle = '#ff8a1f';
      ctx.fillRect(q.x - u * 4, q.y - u * 4, u * 8, u * 8);
      ctx.fillStyle = '#1a0d00';
      ctx.font = `700 ${u * 6}px Galmuri11, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), q.x, q.y + u * 0.5);
    });
  }
}

document.addEventListener('click', (e) => {
  const c = e.target.closest?.('canvas[data-dk-frame]');
  if (!c) return;
  const p = desk.pending.find((x) => String(x.id) === c.dataset.dkFrame);
  if (!p || !p.frame || p.frame === 'failed' || p.corners.length >= 4) return;
  const r = c.getBoundingClientRect();
  p.corners.push({ x: Math.round(((e.clientX - r.left) * c.width) / r.width), y: Math.round(((e.clientY - r.top) * c.height) / r.height) });
  app.render();
});

// ---------- fields ----------

document.addEventListener('change', (e) => {
  const input = e.target;
  if (input.matches?.('[data-dk-files]')) {
    for (const file of input.files) {
      const p = { id: ++pid, file, title: file.name.replace(/\.[a-z0-9]{1,5}$/i, '').slice(0, MAX_TITLE) || file.name.slice(0, MAX_TITLE), playedAt: kst(), near: '', far: '', frame: null, corners: [], errors: {} };
      desk.pending.push(p);
      grabFrame(p);
    }
    input.value = '';
    app.render();
  } else if (input.matches?.('[data-dk-resume]')) {
    const file = input.files[0];
    const id = input.dataset.dkResume;
    input.value = '';
    if (file) resumeUpload(id, file).catch((err) => { desk.resumeErrors[id] = err.message; app.render(); });
  }
});

document.addEventListener('input', (e) => {
  const input = e.target;
  if (!input.matches?.('[data-dk-field]')) return;
  const p = desk.pending.find((x) => String(x.id) === input.dataset.dkId);
  if (!p) return;
  p[input.dataset.dkField] = input.value;
  if (p.errors[input.dataset.dkField]) {
    delete p.errors[input.dataset.dkField];
    const err = document.getElementById(`${input.id}-err`);
    if (err) err.textContent = '';
  }
});

// '' -> null, '홍길동,0712' (also with a full-width comma or a space) -> the key, anything else -> a reason.
function playerOf(text) {
  const key = normalizeKey(text);
  if (!key) return { key: null };
  const m = KEY_RE.exec(key);
  return m ? { key: `${m[1].trim()},${m[2]}` } : { error: L('이름,네자리로 적어요. 예: 홍길동,0712', 'Enter a name and four digits, e.g. Hong,0712') };
}

function validate(p) {
  const errors = {};
  const near = playerOf(p.near);
  const far = playerOf(p.far);
  if (near.error) errors.near = near.error;
  if (far.error) errors.far = far.error;
  if (near.key && near.key === far.key) errors.far = L('두 선수가 같아요.', 'Players must be different.');
  if (!p.title.trim()) errors.title = L('제목을 적어요.', 'Enter a title.');
  if (Number.isNaN(Date.parse(p.playedAt))) errors.playedAt = L('날짜를 골라요.', 'Choose a date.');
  p.errors = errors;
  return { ok: Object.keys(errors).length === 0, near: near.key ?? null, far: far.key ?? null };
}

// ---------- uploads ----------

async function sendChunks(id) {
  const u = desk.uploads.get(id);
  let offset = u.sent;
  try {
    while (offset < u.total) {
      const end = Math.min(offset + CHUNK, u.total);
      const res = await fetch(`/api/desk/jobs/${id}/video?offset=${offset}`, { method: 'PUT', headers: { 'x-pin': app.pin(), 'content-type': 'application/octet-stream' }, body: u.file.slice(offset, end) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && Number.isInteger(data.received)) {
        if (data.received === offset) throw new Error(data.error || L('이어 올릴 위치가 맞지 않아요.', 'Resume position does not match.'));
        offset = data.received;
      } else if (!res.ok) {
        throw new Error(data.error || L('조각을 올리지 못했어요.', 'Could not upload a video chunk.'));
      } else {
        offset = data.received;
      }
      u.sent = offset;
      app.render();
    }
    u.state = 'done';
  } catch (e) {
    u.state = 'error';
    u.error = e instanceof TypeError ? L('서버에 연결하지 못했어요.', 'Could not connect to the server.') : e.message;
  }
  await loadJobs();
  app.render();
}

async function startUploads() {
  if (desk.sending) return;
  const checked = desk.pending.map((p) => ({ p, v: validate(p) }));
  if (checked.some(({ v }) => !v.ok)) { app.render(); return; }
  desk.sending = true;
  app.render();
  try {
    for (const { p, v } of checked) {
      const { job } = await app.api('/api/desk/jobs', { kind: 'gallery', title: p.title.trim(), playedAt: p.playedAt, players: { near: v.near, far: v.far }, video: { name: p.file.name, bytes: p.file.size, type: p.file.type || 'application/octet-stream' } });
      desk.pending = desk.pending.filter((x) => x !== p);
      desk.uploads.set(job.id, { file: p.file, sent: 0, total: p.file.size, state: 'sending', error: null });
      if (p.corners.length === 4 && p.frame?.canvas) {
        const sx = p.frame.videoW / p.frame.canvas.width;
        const sy = p.frame.videoH / p.frame.canvas.height;
        await app.api(`/api/desk/jobs/${job.id}/corners`, { corners: p.corners.map((c) => ({ x: Math.round(c.x * sx), y: Math.round(c.y * sy) })) });
      }
      await loadJobs();
      app.render();
      await sendChunks(job.id);
    }
  } catch (e) {
    desk.error = e instanceof TypeError ? L('서버에 연결하지 못했어요.', 'Could not connect to the server.') : e.message;
  }
  desk.sending = false;
  app.render();
}

// The page was reopened: the same file (name and size) continues from the bytes the server holds.
async function resumeUpload(id, file) {
  const job = desk.jobs?.find((j) => j.id === id);
  if (!job) throw new Error(L('일감을 찾을 수 없어요.', 'Job not found.'));
  if (file.name !== job.video.name || file.size !== job.video.bytes) throw new Error(L(`같은 파일이 아니에요. ${job.video.name} (${fmtBytes(job.video.bytes)})을 골라요.`, `This is not the same file. Choose ${job.video.name} (${fmtBytes(job.video.bytes)}).`));
  const fresh = (await app.api(`/api/desk/jobs/${id}`, undefined, { method: 'GET' })).job;
  delete desk.resumeErrors[id];
  desk.uploads.set(id, { file, sent: fresh.video.received, total: file.size, state: 'sending', error: null });
  app.render();
  await sendChunks(id);
}

// data-act handlers, merged into app.js's table.
export const deskHandlers = {
  'dk-reload'() { desk.error = null; loadJobs(); app.render(); },
  'dk-drop'(b) { desk.pending = desk.pending.filter((p) => String(p.id) !== b.dataset.id); app.render(); },
  'dk-corner-undo'(b) { desk.pending.find((p) => String(p.id) === b.dataset.id)?.corners.pop(); app.render(); },
  'dk-corner-reset'(b) { const p = desk.pending.find((x) => String(x.id) === b.dataset.id); if (p) p.corners = []; app.render(); },
  'dk-upload'() { startUploads(); },
  'dk-retry'(b) {
    const u = desk.uploads.get(b.dataset.id);
    if (!u) return;
    u.state = 'sending';
    u.error = null;
    app.render();
    sendChunks(b.dataset.id);
  },
  async 'dk-delete'(b) {
    if (!(await app.ask(L(`'${b.dataset.title}' 일감과 영상을 지울까요? 이미 저장된 분석 결과는 남아요.`, `Delete job '${b.dataset.title}' and its video? Saved analysis results will remain.`), L('지우기', 'Delete'), true))) return;
    await app.api(`/api/desk/jobs/${b.dataset.id}`, undefined, { method: 'DELETE' });
    desk.uploads.delete(b.dataset.id);
    await loadJobs();
    app.render();
  },
  async 'dk-result'(b) {
    if (b.dataset.kind === 'gallery') { app.go(() => openAnalysis(b.dataset.id, 'g')); return; }
    // a rally job wrote into a tournament match: the current one, or an archived one by its createdAt
    if (String(app.tournament()?.createdAt) === b.dataset.tour) { app.go(() => openAnalysis(b.dataset.match, null)); return; }
    const res = await fetch('/api/history');
    const data = await res.json().catch(() => ({}));
    const hist = data.items?.find((h) => !h.current && String(h.createdAt) === b.dataset.tour);
    if (!hist) throw new Error(L('이 경기의 기록을 찾을 수 없어요.', 'Match history not found.'));
    await app.openHistory(hist.id);
    app.go(() => openAnalysis(b.dataset.match, hist.id));
  },
};
