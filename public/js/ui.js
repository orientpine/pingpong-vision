// ui.js - createUI(root, handlers) for pingpong-vision (contract: docs/contract.md)
// Screens: intro / loading / error / HUD (ready, running, stopped) / calibrating,
// plus the history sheet and the settings popover. render(state) is called every
// frame: DOM text is diffed, the overlay canvas is redrawn through hud.js.
// Layout fit (data-fit on .app): "stack" on a portrait phone (the panels are grid rows floating
// over the full-screen picture; while calibrating the picture sits between them), "overlay" elsewhere.
import { L, EN, LANG, LOCALE } from "./i18n.js";
import { fitBox, insidePolygon } from "./geom.js";
import { END_TAG, PANEL_IDS, drawHud, invalidateHudTheme } from "./hud.js";
import { SIDE_NAMES } from "./tournament.js";
import { SMALL_TABLE, quadFraction } from "./guards.js";
import { HOLD_REASON } from "./multicam.js";
import { createCameraGuide } from "./camera-guide-ui.js";

// End-colour warning and 점수 보류 copy (all strings in docs/copy-end-hold.md)
const HOLD_SHORT = L("점수 보류", "Paused");
const HOLD_STRIP = L("보류", "Paused");
// 확인 후 입력 copy (docs/copy-end-hold.md)
const CAMERA_CALL = L("카메라 판정", "Camera's call");
const WHO_WON = L("누가 땄나요?", "Who won it?");
const CONFIRM_TEXT = (colour, sure) => (sure ? L(`카메라는 ${colour} · 맞으면 눌러 확정`, `Camera says ${colour} · tap to confirm`) : L(`카메라는 ${colour}(확실하지 않음) · 맞으면 눌러 확정`, `Camera says ${colour} (not sure) · tap to confirm`));
const ENTRY_NOTE = L("점수 입력: 확인 후 입력 · 포인트마다 카메라 판정을 한 번 눌러 확정해요 (심판 화면에서도)", "Scoring: confirm first · tap the camera's call once for each point (also on the referee screen)");
const END_WARN = L("두 폰 끝 색이 반대로 보여요 · 이 폰과 다른 폰의 앞쪽 사이드를 확인해 주세요", "The two phones see the ends the other way round · check the near side on this phone and the other");
const END_WARN_HOLD = L("점수 보류 중: 두 폰 끝 색이 반대로 보여요 · 어느 폰이든 앞쪽 사이드를 고치면 풀려요. 그때까지 카메라 판정 없이 누가 땄나요에서 직접 골라요", "Scoring paused: the two phones see the ends the other way round · fixing the near side on either phone ends it. Until then pick the winner in Who won it? yourself, with no camera call");

const TABLE_L = 2.74;        // m, tx axis (from MY end)
const TABLE_W = 1.525;       // m, ty axis
const MOVE_SCALE_M = 6;      // MOVE meters share one scale: 6 m, growing in 6 m steps with the leader
const SHOT_SCALE_KMH = 60;   // SHOT meter is full at 60 km/h
const WRIST_SCALE_DEG = 90;  // 손목 (wrist bend) meter is full at 90 degrees

// status strip chip per state.tracking (docs/contract.md); kind: lock = gold, warn = orange
const TRACKING = {
  "no-calibration": { text: L("코트 보정 필요", "Calibrate court"), kind: "warn" },
  "no-table": { text: L("탁구대 안 보임", "No table"), kind: "warn" },
  unstable: { text: L("폰 흔들림", "Phone shaking"), kind: "warn" },
  searching: { text: L("공 찾는 중", "Finding ball"), kind: "" },
  locked: { text: L("공 추적 중", "Tracking ball"), kind: "lock" },
};
const LOUPE_ZOOM = 3;
const LOUPE_PX = 120;
const DRAG_PX = 8;           // a press that moves less than this is a tap

const CALIB_STEPS = [
  L("내 쪽 끝선 왼쪽 모서리를 누르세요", "Tap the left corner of the near end"),
  L("내 쪽 끝선 오른쪽 모서리를 누르세요", "Tap the right corner of the near end"),
  L("건너편 끝선 오른쪽 모서리를 누르세요", "Tap the right corner of the far end"),
  L("건너편 끝선 왼쪽 모서리를 누르세요", "Tap the left corner of the far end"),
];
const CALIB_SNAPPING = L("1초만 그대로… 테두리에 맞추는 중", "Hold still… fitting to the edge");
// The 정밀하게 button (owner 2026-11-05 00:02 KST: "외곽선을 대충 지정하면, 정밀하게 하는 기능을 버튼으로"): the
// taps stay where they were tapped until it is pressed; a result that cannot be trusted keeps the points
// and says why. Every sentence fits the two guide lines of a 393 px portrait phone. After the fourth tap
// the guide keeps the end-colour sentence and the button itself is lit (.btn--next) until it is used.
const calibSnapDone = (px) => L(`테두리에 맞췄어요 · 최대 ${px}px 옮김`, `Fitted to the edge · moved ≤${px}px`);
const calibSnapShaky = (px) => L(`맞췄지만 흔들려요 ±${px}px`, `Fitted, but shaking ±${px}px`);
const CALIB_SNAP_UNDONE = L("찍은 점으로 되돌렸어요", "Back to your taps");
// every 정밀하게 message at its longest (qa/calib-snap-ui.mjs puts each in the guide and checks it stays
// within two lines on a 393 px portrait phone)
export const CALIB_SNAP_SAMPLES = () => [CALIB_SNAPPING, calibSnapDone(888), calibSnapShaky(88.8), CALIB_SNAP_UNDONE, CALIB_SNAP_FAILED, ...["no-line", "not-edge", "not-table", "too-far", "shake"].map((code) => calibSnapWhy({ code, side: [2, 3], corner: 3, shakePx: 88.8 })), calibSnapWhy({ code: "no-line" })];
// why a refine kept the points (calib-refine.js codes); side = the two corner numbers on screen
function calibSnapWhy(res) {
  const [a, b] = (res && res.side) || [];
  const pair = a != null ? `${a + 1}–${b + 1}` : "";
  switch (res && res.code) {
    case "no-line":
      return pair ? L(`${pair}번 테두리를 못 찾았어요`, `No edge found at ${pair}`) : L("테두리를 못 찾았어요", "No edge found");
    case "not-edge":
      return L(`${pair}번은 탁구대 끝이 아니에요`, `${pair} is not the table edge`);
    case "not-table":
      return L("탁구대 면이 아니라서 그대로 뒀어요", "Not the table top, points kept");
    case "too-far":
      return L(`${res.corner + 1}번 점이 테두리에서 너무 멀어요`, `Point ${res.corner + 1} is too far off`);
    case "shake":
      return L(`너무 흔들려 그대로 뒀어요 ±${res.shakePx}px`, `Too shaky ±${res.shakePx}px, kept`);
    default:
      return CALIB_SNAP_FAILED;
  }
}
// After the four corners a person picks this phone's end colour (owner 2026-11-01: each phone's sides are
// set by a person, at the first outline and in settings): the picture names both ends, ⇄ swaps them.
const CALIB_END_BLUE = L("내 쪽은 블루 끝이에요. 맞으면 확인, 아니면 ⇄", "My end is Blue. OK if right, else ⇄");
const CALIB_END_RED = L("내 쪽은 레드 끝이에요. 맞으면 확인, 아니면 ⇄", "My end is Red. OK if right, else ⇄");
// The guide shows at most two lines on a 393 px portrait phone (qa/calib-guide-lines.mjs): a third line
// grew the bar above the picture and moved it while the corners were tapped.
const CALIB_EDGE = L("탁구대 전체가 보이게 폰을 세워 주세요", "Stand the phone so the whole table is in view");
const CALIB_SNAP_FAILED = L("화면을 못 읽었어요. 다시 눌러요", "Could not read the picture");

// One SVG icon set: 24px grid, 2px round stroke (guideline 18).
// how long a new calibration warning sentence stays over the picture (ms)
const BANNER_MS = 6000;

const ICONS = {
  play: '<path d="M7 5v14l11-7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  calibrate: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><path d="M12 9v6M9 12h6"/>',
  swap: '<path d="M7 16V4m0 0L3 8m4-4 4 4"/><path d="M17 8v12m0 0 4-4m-4 4-4-4"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  history: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  settings: '<path d="M4 7h8M18 7h2M4 17h4M14 17h6"/><circle cx="15" cy="7" r="2.5"/><circle cx="11" cy="17" r="2.5"/>',
  shield: '<path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z"/><path d="m9 12 2 2 4-4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>',
  restart: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  file: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  warn: '<path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18v.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>',
  court: '<rect x="3" y="6" width="18" height="12"/><path d="M12 6v12M3 12h18"/>',
};

function iconSvg(name) {
  return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">${ICONS[name]}</svg>`;
}

export function icon(name) {
  const span = document.createElement("span");
  span.className = "icon";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = iconSvg(name);
  span._n = name;
  return span;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function setText(node, text) {
  const s = text == null ? "" : String(text);
  if (node._t !== s) { node.textContent = s; node._t = s; }
}

function setAttr(node, name, value) {
  const s = value == null ? null : String(value);
  const key = `_a_${name}`;
  if (node[key] === s) return;
  node[key] = s;
  if (s == null) node.removeAttribute(name); else node.setAttribute(name, s);
}

function setStyleVar(node, name, value) {
  const key = `_v_${name}`;
  if (node[key] === value) return;
  node[key] = value;
  node.style.setProperty(name, value);
}

function toggleClass(node, cls, on) {
  const key = `_c_${cls}`;
  if (node[key] === !!on) return;
  node[key] = !!on;
  node.classList.toggle(cls, !!on);
}

function setHidden(node, on) {
  if (node.hidden === !!on) return;
  node.hidden = !!on;
}

function fmtRallyTime(ms) {
  // mm:ss.cc like the reference (00:03.20)
  const total = Math.max(0, Math.floor(ms || 0));
  const m = Math.min(99, Math.floor(total / 60000));
  const s = Math.floor((total % 60000) / 1000);
  const c = Math.floor((total % 1000) / 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtKmh(v) {
  return v == null || Number.isNaN(v) ? "--" : `~${Math.round(v)}`;
}

function fmtMeters(v) {
  return v == null || Number.isNaN(v) ? "--" : (Math.round(v * 10) / 10).toFixed(1);
}

function fmtDeg(v) {
  return v == null || Number.isNaN(v) ? "--" : `${Math.round(v)}\u00b0`;
}

function pct(x) {
  return `${Math.round(Math.max(0, Math.min(1, x || 0)) * 100)}%`;
}

function fmtTimeOfDay(epochMs) {
  const d = new Date(epochMs);
  if (EN) return d.toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit", second: "2-digit" });
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function fmtDuration(ms) {
  const s = (Math.max(0, ms || 0) / 1000).toFixed(1);
  return L(`${s}초`, `${s}s`);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Live court map floor around the table (cm): players stand behind the end lines, so the map
// shows FLOOR_X behind each end and FLOOR_Y beside each long side; a player further away sits
// on the edge as a hollow ring (the footer still reads the real distance).
const FLOOR_X = 120, FLOOR_Y = 30;

// The colour a court map end and its marks take: 0 blue end, 1 red end (state.players[side].end).
export function endColourVar(end) {
  return end === 1 ? "var(--c-red)" : "var(--c-blue)";
}

/**
 * Court map SVG markup: table seen from above, MY end on the left and the far long edge on top, as the camera
 * sees the table (ty runs from the near long edge, 0, to the far one); `stands` adds the floor and the players.
 * The two short edges are the ends, drawn in their end colour (--c-me near, --c-opp far), so the map alone
 * says which end is blue and which is red.
 */
export function courtSvg(bounces, calibrated, small, stands = null) {
  const W = TABLE_L * 100, H = TABLE_W * 100;
  const mapY = (ty) => (TABLE_W - ty) * 100;
  const pad = small ? 10 : 14;
  const fx = stands ? FLOOR_X : pad, fy = stands ? FLOOR_Y : pad;
  const bw = `${bounces.length} ${bounces.length === 1 ? "bounce" : "bounces"}`;
  const label = stands ? L(`바운드 위치 ${bounces.length}개, 선수 위치`, `${bw}, player spots`) : L(`바운드 위치 ${bounces.length}개`, bw);
  const parts = [
    `<svg class="court__svg" viewBox="${-fx} ${-fy} ${W + fx * 2} ${H + fy * 2}" role="img" aria-label="${label}">`,
    stands ? `<rect class="cm-floor" x="${-fx}" y="${-fy}" width="${W + fx * 2}" height="${H + fy * 2}"/>` : "",
    `<rect class="cm-table" x="0" y="0" width="${W}" height="${H}"/>`,
    `<line class="cm-mid" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}"/>`,
    `<line class="cm-net" x1="${W / 2}" y1="${-pad / 2}" x2="${W / 2}" y2="${H + pad / 2}"/>`,
    `<line class="cm-end cm-end--near" x1="0" y1="0" x2="0" y2="${H}"/>`,
    `<line class="cm-end cm-end--far" x1="${W}" y1="0" x2="${W}" y2="${H}"/>`,
  ];
  if (calibrated && bounces.length) {
    const pts = bounces.map((b) => ({ x: Math.max(0, Math.min(W, b.tx * 100)), y: Math.max(0, Math.min(H, mapY(b.ty))), side: b.side }));
    if (pts.length > 1) parts.push(`<polyline class="cm-path" points="${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}"/>`);
    const s = small ? 12 : 10;
    pts.forEach((p, i) => {
      const cls = p.side === "far" ? "far" : "near";
      parts.push(`<rect class="cm-dot cm-dot--${cls}" x="${(p.x - s / 2).toFixed(1)}" y="${(p.y - s / 2).toFixed(1)}" width="${s}" height="${s}"/>`);
      if (i === pts.length - 1) parts.push(`<circle class="cm-ring cm-ring--${cls}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${s * 1.3}"/>`);
    });
  }
  if (calibrated && stands) {
    for (const side of ["far", "near"]) {
      const st = stands[side];
      if (!st) continue;
      const rx = st.x * 100, ry = mapY(st.y), r = 11;
      const x = Math.max(-fx + r, Math.min(W + fx - r, rx)), y = Math.max(-fy + r, Math.min(H + fy - r, ry));
      const out = x !== rx || y !== ry;
      const cls = `cm-stand cm-stand--${side}${st.stale ? " cm-stand--stale" : ""}${out ? " cm-stand--out" : ""}`;
      parts.push(`<circle class="${cls}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}"/>`);
    }
  }
  parts.push("</svg>");
  return parts.join("");
}

// What the screen says about PC save on this device. `kind` picks the chip colour; never the key.
const NEED_PIN = L("PIN을 넣어야 점수가 기록돼요", "Enter the PIN to record scores");

function saveStatus(save = {}, hasPin = false) {
  const off = { chip: L("PC꺼짐", "PC off"), label: L("PC 저장: 꺼짐", "PC save: off") };
  if (save.supported === false) return { kind: "bad", chip: L("PC불가", "No PC"), label: L("PC 저장 불가 · 녹화 미지원", "No PC save · can't record"), hint: L("이 브라우저는 영상 녹화를 지원하지 않아요", "This browser can't record video") };
  if (save.recordOff) return { kind: "bad", chip: L("녹화꺼짐", "Rec off"), label: L("다시 보기 녹화 꺼짐", "Replay recording off"), hint: L("녹화에서 오류가 나 이번에는 녹화를 껐어요. 점수와 분석은 그대로예요. 화면을 다시 열면 다시 켜져요", "Recording hit an error, so it is off for now. Scores and analysis carry on. Reopen the screen to turn it back on") };
  if (!save.keySet) return { ...off, kind: "off", hint: hasPin ? save.keyError || L("PC 저장 권한 발급을 다시 시도해 주세요", "Try getting PC save access again") : L("대회 PIN을 넣으면 켜져요", "Enter the tournament PIN to turn it on") };
  if (save.check === "rejected") return { ...off, kind: "bad", hint: hasPin ? L("이 기기 권한이 끊겼어요. PC 저장 권한 발급을 다시 시도해 주세요", "This device lost access. Try getting PC save access again") : L("이 기기 권한이 끊겼어요. 대회 PIN을 넣으면 켜져요", "This device lost access. Enter the tournament PIN to turn it on") };
  if (save.check === "unknown") return { kind: "bad", chip: "PC?", label: L("PC 저장: 확인 못 함", "PC save: can't check"), hint: L("서버에 닿지 않아요. 연결되면 다시 확인해요", "Can't reach the server. Checks again once connected") };
  if (save.check !== "ok") return { kind: "wait", chip: "PC…", label: L("PC 저장: 확인 중", "PC save: checking"), hint: "" };
  return { kind: "on", chip: "PC✓", label: L("PC 저장: 켜짐 ✓", "PC save: on ✓"), hint: L("끝난 랠리 구간 영상과 기록이 PC로 올라가요", "Finished rally clips and records go to the PC") };
}

/**
 * Build the UI inside `root`.
 * @param {HTMLElement} root
 * @param {object} handlers see docs/contract.md
 */
// "왼쪽 블루 · 오른쪽 레드" (or 아래 / 위): where the two end lines sit in the picture. corners in tap
// order (taps 1-2 = the near end), in any one coordinate space; near = the near end's colour.
export function endsWords(corners, near) {
  if (!corners || corners.length !== 4) return "";
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const n = mid(corners[0], corners[1]), f = mid(corners[2], corners[3]);
  const nearEnd = near === 1 ? 1 : 0;
  const across = Math.abs(n.x - f.x) >= Math.abs(n.y - f.y);
  // English keeps the side-by-side form short (L / R): the chip shares the landscape strip with the others
  const [first, second] = across ? [L("왼쪽", "L"), L("오른쪽", "R")] : [L("아래", "Bottom"), L("위", "Top")];
  const nearFirst = across ? n.x < f.x : n.y > f.y;
  const a = nearFirst ? nearEnd : 1 - nearEnd;
  return `${first} ${SIDE_NAMES[a]} · ${second} ${SIDE_NAMES[1 - a]}`;
}

// replay: the same screen drawn over a recorded clip (replay.js); buttons and chips keep their place
// but are not shown, so the overlay lands where the camera screen had it.
export function createUI(root, handlers = {}, { replay = false } = {}) {
  const H = (name, ...args) => { const fn = handlers[name]; if (typeof fn === "function") return fn(...args); };

  // ---------- stage ----------
  const video = el("video", { class: "stage__video", playsinline: true, muted: true, autoplay: true, "aria-label": L("카메라 영상", "Camera video") });
  video.muted = true; video.playsInline = true; video.autoplay = true;
  const overlay = el("canvas", { class: "stage__overlay", "aria-hidden": "true" });
  const calibPoly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  calibPoly.setAttribute("class", "calib__poly");
  const calibSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  calibSvg.setAttribute("class", "calib__svg");
  let calibNear = 0; // this phone's near end colour (0 blue, 1 red), from the tournament link
  // which end is blue / red while the corners go in: thin see-through dotted end lines (owner, 2026-10-31)
  // over a faint dark dot, and the end name on the floor below each end
  const svgEl = (tag, attrs) => {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const calibEnds = [0, 1].map(() => ({
    halo: svgEl("line", { class: "calib__end-halo" }),
    line: svgEl("line", { class: "calib__end" }),
    label: svgEl("text", { class: "calib__end-label" }),
  }));
  // the taps before 정밀하게, kept faint under the fitted outline so the two can be compared
  const calibGhost = svgEl("polygon", { class: "calib__ghost" });
  const calibGhostPts = [0, 1, 2, 3].map(() => svgEl("circle", { class: "calib__ghost-pt", r: "4" }));
  calibSvg.append(calibGhost, ...calibGhostPts, calibPoly, ...calibEnds.flatMap((e) => [e.halo, e.line, e.label]));
  const loupe = el("canvas", { class: "calib__loupe", hidden: true, "aria-hidden": "true" });
  const calibLayer = el("div", { class: "calib", "aria-label": L("코트 보정: 탁구대 모서리를 누르세요", "Calibrate court: tap the table corners") }, calibSvg, loupe);
  const stageChips = el("div", { class: "stage__chips" });
  const fitToggleLabel = el("span", {}, L("채움", "Fill"));
  const btnFit = el("button", { class: "chip stage__fit", type: "button", hidden: true, onclick: () => toggleVideoFit() }, fitToggleLabel);
  let videoFill = localStorage.getItem("ppv-video-fill");
  const stage = el("div", { class: "stage" }, video, overlay, calibLayer);
  // the live chips and the fit switch: on the picture, just under the top panels (portrait phone)
  const peek = el("div", { class: "peek" }, stageChips, btnFit);

  // ---------- HUD ----------
  const timeNum = el("span", { class: "num" }, "00:00.00");
  const shotsNum = el("span", { class: "num" }, "0");
  const speedNum = el("span", { class: "num" }, "--");
  const glance = el("header", { class: "glance", "aria-label": L("랠리 요약", "Rally summary") },
    el("div", { class: "panel panel--glance" }, el("div", { class: "panel__label" }, "RALLY TIME"), el("div", { class: "panel__value" }, timeNum)),
    el("div", { class: "panel panel--glance" }, el("div", { class: "panel__label" }, "SHOT COUNT"), el("div", { class: "panel__value" }, shotsNum, el("span", { class: "unit" }, "SHOT"))),
    el("div", { class: "panel panel--glance" },
      el("div", { class: "panel__label" }, "SHOT SPEED"),
      el("div", { class: "panel__value" }, speedNum,
        el("span", { class: "unit unit--stack" }, el("span", {}, "km/h"), el("span", { class: "panel__note", title: L("속도·거리는 화면 기반 추정치", "Speed and distance are estimates from the picture") }, L("추정", "est."))))),
  );

  // status strip (guideline 23/25): recording chip, tracking chip, perf readout
  const recDot = el("i", { class: "chip__dot", "aria-hidden": "true" });
  const recText = el("span", {}, L("준비됨", "Ready"));
  const chipRec = el("span", { class: "chip chip--rec" }, recDot, recText);
  const chipTrack = el("span", { class: "chip chip--track", hidden: true }, "");
  // which end is blue / red in this picture, and with two cameras whether their colours agree
  // one camera: where blue and red are; while a 점수 보류 stands (the other phone went off after the end check
  // warned) the hold, and a tap opens settings at the warning, as the other camera's chip does
  const chipEnds = el("span", { class: "chip chip--ends", hidden: true, onclick: (e) => openEndWarning(e), onkeydown: (e) => (e.key === "Enter" || e.key === " ") && openEndWarning(e) }, "");
  const chipPerf = el("span", { class: "chip chip--perf" }, "");
  const chipSave = el("span", { class: "chip chip--save" }, "");
  const chipSlow = el("span", { class: "chip chip--warn", hidden: true }, L("폰이 느려졌어요(열?)", "Phone slowed (heat?)"));
  // tap: back to the full-screen overlay now, and no switch again for this camera run
  const chipStable = el("button", { class: "chip chip--warn chip--stable", type: "button", hidden: true, "aria-label": L("판정 안정 모드 끄고 전체 화면으로", "Steady-call mode off, full screen"), onclick: () => H("onDismissStable") }, L("판정 안정 모드 · 영상 작게", "Steady-call · small video"));
  // orange chosen but a white ball keeps showing (state.colorHint from the engine)
  const chipColor = el("span", { class: "chip chip--warn", hidden: true }, "");
  // one app, a role per device: the tournament app link and the way back to the role choice
  // one chip: the camera role (tap to change it) and the tournament link state
  const roleLink = (label) => el("span", { class: "chip chip--role" }, el("span", {}, label));
  const chipLink = roleLink("");
  const chipLinkText = chipLink.lastChild;
  // 카메라 여러 대: with two cameras on the match, the other camera's ball state and this phone's clock error
  // with the end-colour warning on, a tap opens settings, where the same warning sits by 카메라 앞쪽
  const openEndWarning = (e) => {
    if (!e.currentTarget.classList.contains("chip--warn")) return;
    openSettings();
    endWarnNote.scrollIntoView({ block: "center" });
  };
  const chipCams = el("span", { class: "chip chip--cams", hidden: true, onclick: openEndWarning, onkeydown: (e) => (e.key === "Enter" || e.key === " ") && openEndWarning(e) }, "");
  // a PIN phone fixes the score here, without leaving the camera screen (the 점수 고치기 panel)
  const chipFix = el("button", { class: "chip chip--fix", type: "button", hidden: true, "aria-label": L("점수 고치기", "Fix score"), "aria-expanded": "false", onclick: () => toggleFix() }, icon("edit"), el("span", {}, L("점수", "Score")));
  // the way out, top left on every camera screen; the browser's back does the same (app.js)
  const backButton = () => el("button", { class: "chip chip--back", type: "button", "data-back": "", "aria-label": L("뒤로: 카메라 끄고 모드 고르기", "Back: camera off, choose mode"), onclick: () => back() }, icon("back"));
  chipRec.setAttribute("data-screen-name", "");
  const strip = el("div", { class: "strip", role: "status", "aria-live": "off" }, backButton(), chipLink, chipCams, chipSave, chipFix, chipRec, chipTrack, chipEnds, chipSlow, chipStable, chipColor, chipPerf);
  // calibration issue banner: the engine's sentence (state.calibrationIssue), shown only while set
  const bannerText = el("span", {}, "");
  const banner = el("div", { class: "banner", role: "status", hidden: true }, icon("warn"), bannerText);

  const playerRows = {};
  function playerBlock(side) {
    const cls = side === "near" ? "me" : "opp";
    const name = el("span", { class: `plate plate--${cls}` }, side === "near" ? L("블루 사이드", "Blue side") : L("레드 사이드", "Red side"));
    const off = el("span", { class: "prow__off", hidden: true }, L("화면 밖", "Off screen"));
    const row = (key, fill, num, unit) => el("div", { class: "prow" }, el("span", { class: "prow__k" }, key),
      el("span", { class: `meter meter--${cls}`, "aria-hidden": "true" }, el("i", { class: "meter__track" }), fill),
      el("span", { class: "prow__v" }, num, unit ? el("span", { class: "unit" }, ` ${unit}`) : null));
    const moveFill = el("i", { class: "meter__fill" }), moveNum = el("span", {}, "--");
    const wristFill = el("i", { class: "meter__fill" }), wristNum = el("span", {}, "--");
    const shotFill = el("i", { class: "meter__fill" }), shotNum = el("span", {}, "--");
    const block = el("div", { class: "pblock" },
      el("div", { class: "prow prow--name" }, name, off),
      row("MOVE", moveFill, moveNum, "m"),
      row(L("손목", "WRIST"), wristFill, wristNum, null),
      row("SHOT", shotFill, shotNum, "km/h"));
    playerRows[side] = { name, off, wristFill, wristNum, moveFill, moveNum, shotFill, shotNum };
    return block;
  }
  const vs = el("div", { class: "vs", "aria-hidden": "true" }, el("span", { class: "vs__t" }, "VS"));
  const players = el("section", { class: "panel players", "aria-label": L("선수 기록", "Player stats") }, playerBlock("near"), vs, playerBlock("far"));

  const courtSvgWrap = el("div", { class: "court__svgwrap" });
  const courtHint = el("p", { class: "court__hint", hidden: true }, L("코트 보정을 하면 바운드 위치가 보여요", "Calibrate the court to see bounce spots"));
  const courtBox = el("div", { class: "court__box" }, courtSvgWrap, courtHint);
  const courtCount = el("span", { class: "court__count" }, L("바운드 0회", "0 bounces"));
  // metres behind the end line of each player's standing point ("1.2m", "옆" beside the table)
  const standDist = { near: el("span", { class: "court__dist" }, ""), far: el("span", { class: "court__dist" }, "") };
  // the end colour of each map end (the near end is at the bottom of the map)
  const courtKey = { near: el("span", {}, L("블루", "Blue")), far: el("span", {}, L("레드", "Red")) };
  const court = el("section", { class: "panel court", "aria-label": L("바운드와 선수 위치", "Bounces and player spots") },
    el("div", { class: "court__head" }, el("span", { class: "court__title" }, "COURT MAP"), el("span", { class: "court__sub" }, L("바운드·선수", "bounces·players"))),
    courtBox,
    el("div", { class: "court__foot" },
      el("span", { class: "court__key c-me" }, el("i", { class: "swatch swatch--me", "aria-hidden": "true" }), courtKey.near, standDist.near),
      courtCount,
      el("span", { class: "court__key c-opp" }, standDist.far, courtKey.far, el("i", { class: "swatch swatch--opp", "aria-hidden": "true" }))),
  );
  const bottom = el("div", { class: "bottom" }, players, court);
  // players + court map sit behind one chip. They start open on every visit, portrait and landscape,
  // and stay open through rallies (owner, 2026-10-31: "기본이 펼친걸로 해"); the chip folds them by hand.
  let panelsOpen = true;
  const dockArrow = el("span", { class: "dock__arrow", "aria-hidden": "true" }, "");
  const dock = el("button", { class: "chip dock", type: "button", "aria-expanded": "true", onclick: () => pressDock() }, icon("court"), el("span", {}, L("선수·코트", "Players·court")), dockArrow);
  // A replay: 선수·코트 pressed while a panel folded itself for want of a free spot shows both anyway, over
  // the picture if need be (the viewer asked for them), still off the buttons and off each other; pressed
  // again it folds them. The camera keeps folding a panel that has no free spot.
  let panelsAsked = false;
  function pressDock() {
    const folded = [players, court].some((p) => panelSpot.get(p)?.size === "off");
    if (replay && panelsOpen && folded && !panelsAsked) {
      panelsAsked = true;
      panelSpot.clear();
    } else {
      panelsAsked = false;
      setPanels(!panelsOpen);
    }
    H("onPanels");
  }
  function setPanels(on) {
    panelsOpen = !!on;
    syncPanels();
  }
  function syncPanels() {
    setHidden(bottom, !panelsOpen);
    setAttr(app, "data-panels", panelsOpen ? "open" : "closed");
    setAttr(dock, "aria-expanded", String(panelsOpen));
    setAttr(dock, "aria-label", panelsOpen ? L("선수·코트맵 접기", "Fold players and court map") : L("선수·코트맵 펼치기", "Show players and court map"));
    setText(dockArrow, panelsOpen ? "▾" : "▴");
  }
  const live = el("div", { class: "visually-hidden", "aria-live": "polite" });
  const hud = el("div", { class: "hud" }, glance, banner, dock, bottom, live);

  // ---------- control bar ----------
  const toggleIcon = icon("play");
  const toggleLabel = el("span", {}, L("시작", "Start"));
  const btnToggle = el("button", { class: "btn btn--bar btn--primary", type: "button", onclick: () => (currentMode === "running" ? H("onStop") : H("onStartCamera")) }, toggleIcon, toggleLabel);
  const btnCalib = el("button", { class: "btn btn--bar", type: "button", onclick: () => { closeSettings(); H("onBeginCalibration"); } }, icon("calibrate"), el("span", {}, L("코트 보정", "Calibrate")));
  const btnSwap = el("button", { class: "btn btn--bar", type: "button", "aria-label": L("자리 교체: 두 선수의 엔드 바꾸기, 레드·블루 사이드는 그대로", "Swap places: players change ends, red and blue sides stay"), onclick: () => H("onSwapPlayers") }, icon("swap"), el("span", {}, L("자리 교체", "Swap")));
  const btnHistory = el("button", { class: "btn btn--bar", type: "button", onclick: () => { closeSettings(); H("onOpenHistory"); } }, icon("history"), el("span", {}, L("기록", "History")));
  const btnSettings = el("button", { class: "btn btn--bar", type: "button", "aria-haspopup": "dialog", "aria-expanded": "false", onclick: () => toggleSettings() }, icon("settings"), el("span", {}, L("설정", "Settings")));
  const bar = el("nav", { class: "bar", "aria-label": L("조작", "Controls") }, btnToggle, btnCalib, btnSwap, btnHistory, btnSettings);

  // ---------- point entered in the tournament app: 3 s to cancel ----------
  const pointText = el("span", { class: "pointbar__text" }, "");
  // The bar opens after every point (확인 후 입력), so it must not sit on the panels or the control rail: where
  // something it would cover starts beside it (landscape: the court map column and the right rail reach up
  // to the top rows), it narrows to the room left of them; if that room is too small it stays as it was.
  const fitPointbar = () => {
    for (const k of ["left", "width", "transform"]) pointbar.style[k] = "";
    const keepOff = () => [bar, ...app.querySelectorAll(".court, .players")].filter((n) => n.offsetParent !== null && !n.closest("[hidden]"));
    for (let pass = 0; pass < 2; pass++) {
      const r = pointbar.getBoundingClientRect();
      const hit = keepOff().map((n) => n.getBoundingClientRect()).filter((q) => q.width && q.top < r.bottom && q.bottom > r.top && q.left < r.right && q.right > r.left);
      if (!hit.length) return;
      const gap = 8;
      const right = Math.min(...hit.map((q) => q.left)) - gap;
      const left = Math.max(gap, ...hit.filter((q) => q.right <= r.left + 1).map((q) => q.right + gap));
      if (right - left < 300) { for (const k of ["left", "width", "transform"]) pointbar.style[k] = ""; return; }
      pointbar.style.transform = "none";
      pointbar.style.left = `${Math.round(left)}px`;
      pointbar.style.width = `${Math.round(right - left)}px`;
    }
  };
  const pointCancel = el("button", { class: "btn btn--danger pointbar__cancel", type: "button", onclick: () => H("onTourCancel") }, L("취소", "Cancel"));
  const pickBlue = el("button", { class: "btn btn--big pointbar__pick pointbar__pick--blue", type: "button", onclick: () => H("onTourPick", 0) }, L("블루 득점", "Point Blue"));
  const pickRed = el("button", { class: "btn btn--big pointbar__pick pointbar__pick--red", type: "button", onclick: () => H("onTourPick", 1) }, L("레드 득점", "Point Red"));
  const pointPicks = el("div", { class: "pointbar__picks", hidden: true }, pickBlue, pickRed);
  const askLet = el("button", { class: "btn btn--big pointbar__ask", type: "button", onclick: () => H("onTourLet") }, L("렛?", "Let?"));
  const askFault = el("button", { class: "btn btn--big pointbar__ask", type: "button", onclick: () => H("onTourFault") }, L("폴트?", "Fault?"));
  const pointAsks = el("div", { class: "pointbar__picks pointbar__asks", hidden: true }, askLet, askFault);
  // two cameras, colour not decided in time (phone 2): one tap says which end is blue in this picture
  const pointbar = el("div", { class: "pointbar", role: "status", "aria-live": "polite", hidden: true }, pointText, pointCancel, pointPicks, pointAsks);

  // ---------- 점수 고치기: +1, 되돌리기, and a recent point to the other side (PIN phone only) ----------
  let fixOpen = false;
  let fixSig = "";
  const fixScore = el("span", { class: "fix__score" }, "");
  const fixClose = el("button", { class: "btn btn--quiet fix__close", type: "button", "aria-label": L("점수 고치기 닫기", "Close fix score"), onclick: () => toggleFix(false) }, icon("close"));
  const fixPlus = [0, 1].map((side) => el("button", { class: `btn fix__plus fix__plus--${side ? "red" : "blue"}`, type: "button", "data-side": String(side), onclick: () => H("onTourFix", "plus", side) }, `${SIDE_NAMES[side]} +1`));
  const fixUndo = el("button", { class: "btn fix__undo", type: "button", onclick: () => H("onTourFix", "undo") }, icon("undo"), el("span", {}, L("점수 취소", "Undo point")));
  const fixRecent = el("div", { class: "fix__recent", role: "group", "aria-label": L("최근 점수, 누르면 반대쪽 득점으로", "Recent points; tap one to give it to the other side") });
  const fixNote = el("p", { class: "fix__note", role: "status" }, "");
  const fixPanel = el("section", { class: "fix", "aria-label": L("점수 고치기", "Fix score"), hidden: true },
    el("div", { class: "fix__head" }, el("h2", { class: "fix__title" }, L("점수 고치기", "Fix score")), fixClose),
    fixScore,
    el("div", { class: "fix__row" }, fixPlus[0], fixUndo, fixPlus[1]),
    el("p", { class: "fix__label" }, L("최근 점수 · 누르면 반대쪽 득점으로 바뀜어요", "Recent points · tap one to give it to the other side")),
    fixRecent, fixNote);
  function toggleFix(on = !fixOpen) {
    fixOpen = !!on;
    if (fixOpen) closeSettings();
    setAttr(chipFix, "aria-expanded", String(fixOpen));
    chipFix.disabled = fixOpen;
    syncBackNames();
  }
  const narrow = typeof matchMedia === "function" ? matchMedia("(max-width: 599px)") : { matches: false };
  let perfCrowded = false;

  // ---------- settings popover ----------
  let layoutPref = "auto";
  const segs = {};
  function seg(name, options, onPick) {
    const buttons = options.map(([value, label]) => el("button", { class: "seg__btn", type: "button", "aria-pressed": "false", onclick: () => onPick(value) }, label));
    segs[name] = { buttons, options };
    return el("div", { class: "seg", role: "group", "aria-label": name }, ...buttons);
  }
  function setSeg(name, value) {
    const s = segs[name];
    s.options.forEach(([v], i) => setAttr(s.buttons[i], "aria-pressed", v === value ? "true" : "false"));
  }
  const btnSettingsClose = el("button", { class: "btn btn--quiet", type: "button", "aria-label": L("설정 닫기", "Close settings"), onclick: () => closeSettings() }, icon("close"));
  const keyInput = el("input", { type: "password", name: "upload-key", autocomplete: "off", "aria-label": L("PC 저장 열쇠", "PC save key"), placeholder: L("열쇠 붙여넣기", "Paste key") });
  const keyStatus = el("p", { class: "screen__note", role: "status" }, "");
  const saveState = el("span", { class: "chip chip--save", role: "status" }, "");
  const privacyNote = el("p", { class: "screen__note" }, "");
  const tourPin = el("input", { type: "password", name: "tournament-pin", inputmode: "numeric", autocomplete: "off", "aria-label": L("대회 PIN", "Tournament PIN"), placeholder: L("대회 PIN", "Tournament PIN") });
  const tourForm = el("form", { class: "keyform", onsubmit: (e) => { e.preventDefault(); H("onTourConnect", tourPin.value); tourPin.value = ""; } },
    tourPin, el("button", { class: "btn", type: "submit" }, L("연결", "Connect")));
  const tourMatch = el("select", { class: "select", "aria-label": L("점수를 넣을 경기", "Match to score"), onchange: (e) => H("onTourMatch", e.target.value) });
  const tourLinked = el("div", { class: "tourlink", hidden: true },
    tourMatch,
    // 확인 후 입력 (tournament.js POINT_ENTRY): no mode to choose; "auto" brings the 자동 입력 choice back
    el("p", { class: "screen__note", "data-entry": "confirm" }, ENTRY_NOTE),
    seg(L("자동 입력", "Auto entry"), [["sure", L("확실할 때만", "Sure only")], ["all", L("모든 포인트 자동", "Every point")]], (v) => H("onTourMode", v)),
    el("button", { class: "btn", type: "button", onclick: () => H("onTourDisconnect") }, L("연동 끄기", "Unlink")));
  const tourStatus = el("p", { class: "screen__note", role: "status" }, "");
  const camsNote = el("p", { class: "screen__note", role: "status", hidden: true }, "");
  const endWarnNote = el("p", { class: "screen__note screen__note--warn", role: "status", hidden: true }, END_WARN);
  let tourSig = "";
  const handPlate = { near: el("span", { class: "plate plate--me" }, L("블루 사이드", "Blue side")), far: el("span", { class: "plate plate--opp" }, L("레드 사이드", "Red side")) };
  // 새 버전 있음: only a public install answers with a newer release (update-check.js); asked once a page
  const updateLine = el("a", { class: "screen__note update-line", target: "_blank", rel: "noopener noreferrer", hidden: true });
  let updateAsked = false;
  function askUpdate() {
    if (updateAsked) return;
    updateAsked = true;
    // from this module's address: the page's own address can be "/" (history), which is the tournament app
    fetch(new URL("../api/update", import.meta.url)).then((r) => (r.ok ? r.json() : null)).then((u) => {
      if (!u?.latest || !/^https:\/\/github\.com\//.test(u.url || "")) return;
      updateLine.textContent = L(`새 버전 있음 · v${u.latest}`, `New version · v${u.latest}`);
      setAttr(updateLine, "href", u.url);
      setAttr(updateLine, "aria-label", L(`새 버전 있음 · v${u.latest} · 바뀐 점 보기`, `New version v${u.latest} · see what changed`));
      updateLine.hidden = false;
    }).catch(() => {});
  }
  const popover = el("div", { class: "popover", role: "dialog", "aria-label": L("설정", "Settings"), hidden: true },
    el("h2", { class: "popover__title" }, L("설정", "Settings"), btnSettingsClose),
    updateLine,
    el("div", { class: "field field--wide", "data-field": "lang" }, el("div", { class: "field__label" }, el("span", {}, L("언어", "Language"))),
      seg("language", [["ko", "한국어"], ["en", "English"]], (v) => H("onSetLang", v))), // i18n-data: each language's own name
    el("div", { class: "field" }, el("div", { class: "field__label" }, handPlate.near, el("span", { class: "unit" }, L("라켓 손", "racket hand"))),
      seg(L("앞쪽 라켓 손", "Near hand"), [["R", L("오른손", "Right")], ["L", L("왼손", "Left")]], (v) => H("onSetHand", "near", v))),
    el("div", { class: "field" }, el("div", { class: "field__label" }, handPlate.far, el("span", { class: "unit" }, L("라켓 손", "racket hand"))),
      seg(L("건너편 라켓 손", "Far hand"), [["R", L("오른손", "Right")], ["L", L("왼손", "Left")]], (v) => H("onSetHand", "far", v))),
    el("div", { class: "field field--wide" }, el("div", { class: "field__label" }, el("span", {}, L("화면", "Layout"))),
      seg(L("화면", "Layout"), [["auto", L("자동", "Auto")], ["phone", L("폰", "Phone")], ["tv", L("큰 화면(TV)", "TV")]], (v) => { layoutPref = v; setSeg(L("화면", "Layout"), v); H("onSetLayout", v); })),
    el("div", { class: "field field--wide" }, el("div", { class: "field__label" }, el("span", {}, L("카메라 자리 안내", "Camera placement guide"))),
      seg(L("카메라 자리 안내", "Camera placement guide"), [["off", L("끄기", "Off")], ["on", L("켜기", "On")]], (v) => { setSeg(L("카메라 자리 안내", "Camera placement guide"), v); H("onSetCameraGuide", v === "on"); }),
      el("p", { class: "screen__note" }, L("필요할 때 켜서 자리·각도·크기·흔들림을 단계별로 확인해요", "Turn on when needed to check position, angle, framing and shake step by step"))),
    el("div", { class: "field field--wide" }, el("div", { class: "field__label" }, el("span", {}, L("공 색", "Ball colour"))),
      seg(L("공 색", "Ball colour"), [["white", L("흰색", "White")], ["orange", L("주황(실험)", "Orange (beta)")]], (v) => { setSeg(L("공 색", "Ball colour"), v); H("onSetBallColor", v); })),
    el("div", { class: "field field--wide" }, el("div", { class: "field__label" }, el("span", {}, L("탁구대 끝 뒤에서 찍을 때", "Filming from behind an end"))),
      seg(L("끝 뒤 카메라", "End camera"), [["off", L("기본", "Normal")], ["on", L("공 더 잡기(실험)", "More ball (beta)")]], (v) => { setSeg(L("끝 뒤 카메라", "End camera"), v); H("onSetEndOnCubic", v === "on"); })),
    el("div", { class: "field field--wide" }, el("div", { class: "field__label" }, el("span", {}, L("판정 안정 모드(분석이 느리면 영상 작게)", "Steady-call mode (small video when analysis is slow)"))),
      seg(L("판정 안정 모드", "Steady-call mode"), [["auto", L("자동", "Auto")], ["off", L("끄기", "Off")]], (v) => { setSeg(L("판정 안정 모드", "Steady-call mode"), v); H("onSetStableMode", v); })),
    el("div", { class: "field field--wide" }, el("div", { class: "field__label" }, el("span", {}, L("다시 보기 영상에 오버레이 넣기", "Overlay on replay clips"))),
      seg(L("다시 보기 오버레이", "Replay overlay"), [["on", L("넣기", "On")], ["off", L("영상만", "Video only")]], (v) => { setSeg(L("다시 보기 오버레이", "Replay overlay"), v); H("onSetReplayOverlay", v === "on"); })),
    el("div", { class: "field field--wide" }, el("div", { class: "field__label" }, el("span", {}, L("판정용 영상(시험)", "Analysis video (test)"))),
      seg(L("판정용 영상", "Analysis video"), [["screen", L("화면", "Screen")], ["probe", L("따로 작게", "Small copy")], ["probe-big", L("따로 크게", "Big copy")]], (v) => { setSeg(L("판정용 영상", "Analysis video"), v); H("onSetAnalysisFrom", v); })),
    el("div", { class: "field field--wide" }, el("div", { class: "field__label" }, el("span", {}, L("PC 저장 열쇠", "PC save key")), saveState),
      el("form", { class: "keyform", onsubmit: (e) => { e.preventDefault(); if (!keyInput.value.trim()) { notice(L("열쇠를 붙여 넣어 주세요", "Paste the key first")); return; } H("onSetUploadKey", keyInput.value); keyInput.value = ""; } },
        keyInput, el("button", { class: "btn", type: "submit" }, L("열쇠 저장", "Save key"))),
      keyStatus),
    el("div", { class: "field field--wide" }, el("div", { class: "field__label" }, el("span", {}, L("대회 점수 자동 입력", "Tournament auto entry"))),
      tourForm, tourLinked, tourStatus, camsNote, endWarnNote,
      seg(L("카메라 앞쪽", "Near end"), [[0, L("앞쪽 블루 사이드", "Near: Blue")], [1, L("앞쪽 레드 사이드", "Near: Red")]], (v) => H("onTourNear", v)),
      seg(L("점수 음성", "Score voice"), [[true, L("음성 켜기", "Voice on")], [false, L("음성 끄기", "Voice off")]], (v) => H("onTourVoice", v))),
    privacyNote,
  );
  setSeg(L("화면", "Layout"), layoutPref);
  // each language's name is in that language; lang="ko" marks the one Korean word an English screen keeps
  segs.language.buttons.forEach((b, i) => setAttr(b, "lang", segs.language.options[i][0]));
  setSeg("language", LANG);
  setSeg(L("끝 뒤 카메라", "End camera"), "off");
  setSeg(L("판정용 영상", "Analysis video"), "screen");
  setSeg(L("판정 안정 모드", "Steady-call mode"), "auto");
  setSeg(L("다시 보기 오버레이", "Replay overlay"), "on");
  setSeg(L("공 색", "Ball colour"), "white");
  setSeg(L("카메라 자리 안내", "Camera placement guide"), "off");

  let settingsOpen = false;
  let keySet = false;
  function onDocPointer(e) {
    // the back button closes settings itself (one level per press), so it is not an outside tap here
    if (!popover.contains(e.target) && !btnSettings.contains(e.target) && !e.target.closest("[data-back]")) closeSettings();
  }
  function openSettings() {
    if (settingsOpen) return;
    toggleFix(false);
    settingsOpen = true;
    btnSettings.disabled = true;
    popover.hidden = false;
    askUpdate();
    setAttr(btnSettings, "aria-expanded", "true");
    document.addEventListener("pointerdown", onDocPointer, true);
    btnSettingsClose.focus({ preventScroll: true });
    syncBackNames();
  }
  function closeSettings() {
    if (!settingsOpen) return;
    settingsOpen = false;
    btnSettings.disabled = false;
    popover.hidden = true;
    setAttr(btnSettings, "aria-expanded", "false");
    document.removeEventListener("pointerdown", onDocPointer, true);
    if (document.activeElement && popover.contains(document.activeElement)) btnSettings.focus({ preventScroll: true });
    syncBackNames();
  }
  function toggleSettings() { settingsOpen ? closeSettings() : openSettings(); }

  // ---------- history sheet ----------
  const rallyList = el("ul", { class: "rally-list" });
  // when the picture went small for 판정 안정 모드 or came back, and why (app.js applyStable)
  const stableNote = el("p", { class: "screen__note", hidden: true });
  // The list folds like every long list in the app, remembered on this device: 'closed', 'all' or absent.
  const foldState = () => localStorage.getItem("ppv-fold-rallies");
  const setFold = (value) => {
    if (value) localStorage.setItem("ppv-fold-rallies", value);
    else localStorage.removeItem("ppv-fold-rallies");
    historySig = "";
    renderHistory(lastHistory);
  };
  const foldName = el("span", { class: "fold-name" }, L("랠리", "Rallies"));
  const foldCount = el("span", { class: "fold-count" });
  const foldIcon = el("span", { class: "fold-chev" });
  const foldHead = el("button", { class: "fold-head", type: "button", hidden: true, onclick: () => setFold(foldState() === "closed" ? null : "closed") }, foldName, foldCount, foldIcon);
  const foldMore = el("button", { class: "btn fold-more", type: "button", hidden: true, onclick: () => setFold(foldState() === "all" ? null : "all") });
  const sheetBody = el("div", { class: "sheet__body" }, stableNote, foldHead, rallyList, foldMore);
  const btnClear = el("button", { class: "btn", type: "button", onclick: () => showClearConfirm(true) }, icon("trash"), el("span", {}, L("비우기", "Clear")));
  const footNormal = el("div", { class: "sheet__foot" }, btnClear);
  const btnConfirmNo = el("button", { class: "btn", type: "button", onclick: () => showClearConfirm(false) }, L("취소", "Cancel"));
  const btnConfirmYes = el("button", { class: "btn btn--danger", type: "button", onclick: () => { showClearConfirm(false); H("onClearHistory"); } }, L("비우기", "Clear"));
  const confirmText = el("p", {}, L("기록을 모두 비울까요?", "Clear all history?"));
  const footConfirm = el("div", { class: "sheet__foot", hidden: true }, el("div", { class: "sheet__confirm" }, confirmText, btnConfirmNo, btnConfirmYes));
  const btnSheetX = el("button", { class: "btn btn--quiet", type: "button", "aria-label": L("기록 닫기", "Close history"), onclick: () => H("onCloseHistory") }, icon("close"));
  const sheet = el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": L("랠리 기록", "Rally history"), hidden: true },
    el("div", { class: "sheet__head" }, el("h2", { class: "sheet__title" }, L("랠리 기록", "Rally history")), btnSheetX),
    sheetBody, footNormal, footConfirm);
  const backdrop = el("div", { class: "backdrop", hidden: true, onclick: () => H("onCloseHistory") });
  let sheetOpen = false;
  let historySig = "";
  function showClearConfirm(on) {
    footNormal.hidden = !!on;
    footConfirm.hidden = !on;
    (on ? btnConfirmNo : btnClear).focus({ preventScroll: true });
  }
  function uploadRow(r) {
    const u = r.upload;
    if (!u) return el("span", {});
    const label = { uploading: L("올리는 중", "Uploading"), done: L("올림", "Uploaded"), failed: L("못 올림", "Failed") }[u.status] || "";
    const kids = [el("span", { class: `upchip upchip--${u.status}`, role: "status" }, label)];
    if (u.status === "done" && u.url) kids.push(el("a", { class: "btn btn--link", href: u.url, target: "_blank", rel: "noopener" }, L("공유 링크", "Share link")));
    if (u.status !== "uploading") kids.push(el("button", { class: "btn", type: "button", onclick: () => H("onDeleteRally", r.id) }, icon("trash"), el("span", {}, L("지우기", "Delete"))));
    if (u.error && u.status !== "failed") kids.push(el("span", { class: "upchip upchip--failed" }, u.error));
    return el("div", { class: "rally__upload" }, ...kids);
  }
  let lastHistory = [];
  function renderHistory(list) {
    lastHistory = list;
    const sig = list.map((r) => `${r.id}:${r.shots}:${r.bounces?.length || 0}:${r.upload?.status || ""}:${r.upload?.error || ""}`).join("|");
    if (sig === historySig) return;
    historySig = sig;
    rallyList.replaceChildren();
    foldHead.hidden = !list.length;
    foldMore.hidden = true;
    if (!list.length) {
      rallyList.append(el("li", {}, el("p", { class: "empty" }, L("아직 기록이 없어요. 시작을 누르고 랠리를 해보세요.", "No history yet. Press Start and play a rally."))));
      btnClear.disabled = true;
      return;
    }
    btnClear.disabled = false;
    const items = [...list].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    const state = foldState();
    foldCount.textContent = L(`${items.length}개`, `${items.length}`);
    foldHead.setAttribute("aria-expanded", String(state !== "closed"));
    foldIcon.innerHTML = "";
    foldIcon.append(icon(state === "closed" ? "chevronDown" : "chevronUp"));
    const long = items.length > 10 && state !== "closed";
    foldMore.hidden = !long;
    foldMore.textContent = state === "all" ? L("최근 5개만 보기", "Show latest 5") : L(`전체 ${items.length}개 보기`, `Show all ${items.length}`);
    const shown = state === "closed" ? [] : long && state !== "all" ? items.slice(0, 5) : items;
    for (const r of shown) {
      const map = el("div", { class: "rally__map", "aria-hidden": "true" });
      map.innerHTML = courtSvg(r.bounces || [], true, true);
      rallyList.append(el("li", { class: "rally" },
        el("div", {},
          el("div", { class: "rally__time" }, fmtTimeOfDay(r.startedAt)),
          el("div", { class: "rally__stats" },
            el("span", {}, L("길이 ", "Length "), el("b", {}, fmtDuration(r.durationMs))),
            el("span", {}, L("샷 ", "Shots "), el("b", {}, String(r.shots ?? 0))),
            el("span", {}, L("최고 ", "Top "), el("b", {}, fmtKmh(r.maxSpeedKmh)), " km/h")),
          uploadRow(r)),
        map));
    }
  }
  function openSheet() {
    if (sheetOpen) return;
    sheetOpen = true;
    closeSettings();
    showClearConfirm(false);
    backdrop.hidden = false;
    sheet.hidden = false;
    btnHistory.disabled = true;
    btnSheetX.focus({ preventScroll: true });
    syncBackNames();
  }
  function closeSheet() {
    if (!sheetOpen) return;
    sheetOpen = false;
    btnHistory.disabled = false;
    backdrop.hidden = true;
    sheet.hidden = true;
    historySig = "";
    btnHistory.focus({ preventScroll: true });
    syncBackNames();
  }

  // ---------- screens ----------
  function fileButton(label) {
    const input = el("input", { type: "file", accept: "video/*", "aria-label": label, onchange: (e) => { const f = e.target.files && e.target.files[0]; if (f) H("onOpenFile", f); e.target.value = ""; } });
    return el("label", { class: "btn btn--block btn--file" }, icon("file"), el("span", {}, label), input);
  }
  const introNote = el("p", { class: "screen__note", role: "status" }, L("속도·거리는 화면 기반 추정치예요.", "Speed and distance are estimates from the picture."));
  let shownNotice = null;
  const introSave = el("b", { class: "screen__save" }, "");
  const introPrivacyText = el("span", {}, "");
  const introPinInput = el("input", { type: "password", name: "intro-pin", inputmode: "numeric", maxlength: "4", autocomplete: "off", "aria-label": L("대회 PIN", "Tournament PIN"), placeholder: L("대회 PIN", "Tournament PIN") });
  const introPin = el("form", { class: "keyform screen__pin", hidden: true, onsubmit: (e) => { e.preventDefault(); H("onTourConnect", introPinInput.value); introPinInput.value = ""; } },
    introPinInput, el("button", { class: "btn", type: "submit" }, L("켜기", "Turn on")));
  const introRetry = el("button", { class: "btn", type: "button", hidden: true, onclick: () => H("onRetrySave") }, L("PC 저장 다시 시도", "Retry PC save"));
  const introPrivacy = el("span", {}, introSave, " ", introPrivacyText, introPin, introRetry);
  const introLink = roleLink("");
  const screenIntro = el("div", { class: "screen screen--intro" }, el("div", { class: "screen__inner" },
    el("div", { class: "screen__role" }, backButton(), introLink),
    el("p", { class: "brand" }, "PINGPONG VISION"),
    el("h1", { class: "screen__title", "data-screen-name": "" }, L("탁구 랠리를 폰 카메라로 분석해요", "Analyse table tennis rallies with a phone camera")),
    el("ul", { class: "screen__list" },
      el("li", {}, L("삼각대에 폰을 세우고 탁구대를 비추면 랠리 시간, 샷 수, 샷 속도를 보여줘요.", "Put the phone on a tripod facing the table to see rally time, shot count and shot speed.")),
      el("li", {}, L("두 선수의 자세와 공 궤적, 바운드 위치를 화면 위에 그려요.", "Both players' poses, the ball's path and bounce spots are drawn over the picture.")),
      el("li", {}, L("처음 한 번 탁구대 모서리 4곳을 눌러 코트를 보정해요.", "The first time, tap the table's 4 corners to calibrate the court."))),
    el("p", { class: "screen__privacy" }, icon("shield"), introPrivacy),
    el("div", { class: "screen__actions" },
      el("button", { class: "btn btn--primary btn--big btn--block", type: "button", onclick: () => H("onStartCamera") }, icon("camera"), el("span", {}, L("카메라 시작", "Start camera"))),
      fileButton(L("영상 파일로 시험", "Try a video file"))),
    introNote));

  const loadingText = el("p", { class: "screen__title", role: "status", "data-screen-name": "" }, L("준비하는 중…", "Getting ready…"));
  // real bytes: the fill is received / total; the init step after the download is a busy bar
  const progressFill = el("div", { class: "progress__fill" });
  const progressBar = el("div", { class: "progress progress--busy", role: "progressbar", "aria-label": L("불러오는 중", "Loading"), "aria-valuemin": "0", "aria-valuemax": "100" }, progressFill);
  const progressCount = el("p", { class: "progress__count" }, "");
  const mb = (n) => (n / 1048576).toFixed(1);
  const screenLoading = el("div", { class: "screen screen--loading" }, el("div", { class: "screen__inner" },
    el("div", { class: "screen__role" }, backButton()),
    el("p", { class: "brand" }, "PINGPONG VISION"),
    loadingText,
    progressBar,
    progressCount,
    el("p", { class: "screen__note" }, L("자세 인식 모델은 처음 열 때 한 번만 받아요.", "The pose model downloads once, the first time."))));

  const errTitle = el("h1", { class: "screen__title", "data-screen-name": "" }, L("문제가 생겼어요", "Something went wrong"));
  const errDetail = el("p", { class: "screen__text" }, "");
  const errSteps = el("ol", { class: "screen__list" });
  const errRetryLabel = el("span", {}, L("다시 시도", "Try again"));
  const screenError = el("div", { class: "screen screen--error", role: "alertdialog", "aria-labelledby": "ppv-err-title" }, el("div", { class: "screen__inner" },
    el("div", { class: "screen__role" }, backButton()),
    el("p", { class: "brand" }, "PINGPONG VISION"),
    errTitle, errDetail, errSteps,
    el("div", { class: "screen__actions" },
      el("button", { class: "btn btn--primary btn--big btn--block", type: "button", onclick: () => H("onStartCamera") }, icon("restart"), errRetryLabel),
      fileButton(L("영상 파일로 시험", "Try a video file")))));
  errTitle.id = "ppv-err-title";
  let errSig = "";

  // ---------- calibration bar ----------
  const calibStep = el("span", { class: "calibbar__step" }, "1/4");
  const calibText = el("p", { class: "calibbar__text" }, CALIB_STEPS[0]);
  const calibDots = el("div", { class: "calibbar__dots", "aria-hidden": "true" }, ...[0, 1, 2, 3].map(() => el("i")));
  const calibHint = el("p", { class: "calibbar__hint" }, L("가로로 돌리면 더 정확해요", "Landscape is more accurate"));
  const btnUndoLabel = el("span", {}, L("모서리 취소", "Undo"));
  const btnUndo = el("button", { class: "btn", type: "button", "aria-label": L("마지막 모서리 취소", "Undo last corner"), onclick: () => calibUndo() }, icon("undo"), btnUndoLabel);
  // 정밀하게: fit the four rough taps onto the table's white border; pressed again it fits again from the taps
  const btnPreciseLabel = el("span", {}, L("정밀하게", "Precise"));
  const btnPrecise = el("button", { class: "btn", type: "button", disabled: true, "data-act": "precise", "aria-label": L("정밀하게: 테두리에 맞추기", "Precise: fit to the table edge"), onclick: () => snapCorners() }, icon("calibrate"), btnPreciseLabel);
  const btnRestart = el("button", { class: "btn", type: "button", onclick: () => calibReset() }, icon("restart"), el("span", {}, L("다시", "Reset")));
  const btnConfirm = el("button", { class: "btn btn--primary", type: "button", disabled: true, onclick: () => calibConfirm() }, icon("check"), el("span", {}, L("확인", "OK")));
  // the near end's colour, set once here: one tap swaps blue and red (a person's choice). A fourth button in
  // the actions row, disabled like 확인 until the 4th corner: a row of its own grew the bar after the 4th tap,
  // which moved the picture while the corners were converted (every corner landed ~65 video px low), and
  // kept from the start it cost the picture 52 px on a portrait phone. The picture names the ends (블루 끝 /
  // 레드 끝); the button's name carries the full 왼쪽 블루 · 오른쪽 레드.
  const btnEnds = el("button", { class: "btn", type: "button", disabled: true, "aria-label": L("끝 색 바꾸기", "Swap end colours"), onclick: () => H("onTourNear", calibNear === 1 ? 0 : 1) }, el("span", { class: "calibbar__swap", "aria-hidden": "true" }, "⇄"), el("span", {}, L("색 바꾸기", "Swap")));
  const calibbar = el("div", { class: "calibbar" },
    el("div", { class: "calibbar__guide", role: "status", "aria-live": "polite" }, calibStep, calibText, calibDots, calibHint),
    el("div", { class: "calibbar__actions" }, btnUndo, btnRestart, btnPrecise, btnEnds, btnConfirm));

  // ---------- assemble ----------
  // short message for an action with nothing else to show, same look as the tournament app's toast
  const toastEl = el("div", { id: "toast", class: "toast", role: "status", "aria-live": "polite" });
  let toastTimer = null;
  // Under the top rows (strip, glance, chips on the picture), centred when that is free. It keeps off what
  // the end labels keep off (end-marks.js): the table, the panels and buttons, and what the last HUD frame
  // drew - each player's body, name and standing plates, the LOCK box and bracket, the end labels - by
  // sliding down (centre, left, right) to the first free spot above the lower panels; with none, the old
  // spot. A spot stays while it is free, so the notice does not hop. Re-placed on every render while it
  // shows: the record chips appear only after a calibration confirm, and a notice placed before them sat
  // over them (production capture, 2026-10-31); a notice once covered LOCK and a name plate (2026-11-01).
  let lastHud = null;
  let toastSpot = null;
  function toastBlocks(appRect) {
    const rel = (r) => ({ x: r.left - appRect.left, y: r.top - appRect.top, w: r.width, h: r.height });
    const dom = [players, court, bar, dock, btnFit, pointbar, fixPanel, strip, glance, stageChips, banner, ...app.querySelectorAll("[data-keepout]")]
      .filter((n) => !n.closest("[hidden]") && n.offsetHeight).map((n) => rel(n.getBoundingClientRect()));
    const o = overlay.getBoundingClientRect();
    const sh = (b) => ({ x: b.x + o.left - appRect.left, y: b.y + o.top - appRect.top, w: b.w, h: b.h });
    const h = lastHud;
    const hud = h ? [...Object.values(h.tags || {}), ...Object.values(h.stands || {}).filter((s) => s.w && !s.labelHidden), ...Object.values(h.bodies || {}), ...Object.values(h.endTags || {}), h.lock, h.bracket].filter((b) => b && b.w).map(sh) : [];
    const quad = h && h.ends ? Object.values(h.ends)[0]?.quad?.map((p) => ({ x: p.x + o.left - appRect.left, y: p.y + o.top - appRect.top })) : null;
    return { rects: [...dom, ...hud], quad };
  }
  function toastFree(x, y, w, h, { rects, quad }) {
    if (rects.some((r) => x < r.x + r.w && r.x < x + w && y < r.y + r.h && r.y < y + h)) return false;
    if (!quad) return true;
    for (let i = 0; i <= 6; i++) for (let j = 0; j <= 3; j++) if (insidePolygon({ x: x + (w * i) / 6, y: y + (h * j) / 3 }, quad)) return false;
    return !quad.some((p) => p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h);
  }
  function placeToast() {
    const appRect = app.getBoundingClientRect();
    const base = Math.round(Math.max(0, ...[strip, glance, stageChips, btnFit, pointbar].filter((n) => !n.closest("[hidden]") && n.offsetHeight).map((n) => n.getBoundingClientRect().bottom - appRect.top))) + 8;
    const w = toastEl.offsetWidth, h = toastEl.offsetHeight;
    const blocks = toastBlocks(appRect);
    // the floor: the top of whatever floats in the lower half (fold chip, panels, control bar)
    const floor = Math.min(appRect.height, ...[dock, players, court, bar, fixPanel].filter((n) => !n.closest("[hidden]") && n.offsetHeight)
      .map((n) => n.getBoundingClientRect().top - appRect.top).filter((y) => y > appRect.height / 2)) - 4;
    const keep = toastSpot && toastSpot.base === base && toastSpot.w === w && toastSpot.free && toastFree(toastSpot.x, toastSpot.y, w, h, blocks);
    if (!keep) {
      // rows from just under the top rows downward, then the ones above them; across each row from the
      // centre outward (a landscape phone with the 누가 땄나요 bar open has room only beside the top rows)
      let spot = null;
      const ys = [];
      for (let y = base; y + h <= floor; y += 8) ys.push(y);
      for (let y = base - 8; y >= 4; y -= 8) ys.push(y);
      const mid = (appRect.width - w) / 2, xs = [mid];
      for (let d = 16; d <= mid; d += 16) xs.push(mid - d, mid + d);
      for (const y of ys) {
        for (const x of xs) if (x >= 4 && x + w <= appRect.width - 4 && toastFree(x, y, w, h, blocks)) { spot = { x, y }; break; }
        if (spot) break;
      }
      toastSpot = { ...(spot || { x: mid, y: base }), base, w, free: !!spot };
    }
    const left = `${Math.round(toastSpot.x + w / 2)}px`, top = `${Math.round(toastSpot.y)}px`;
    if (toastEl.style.left !== left) toastEl.style.left = left;
    if (toastEl.style.top !== top) toastEl.style.top = top;
    setAttr(toastEl, "data-free", toastSpot.free ? "1" : "0");
    // nowhere free: the notice does not cover the picture (its chip, if any, still says it)
    toggleClass(toastEl, "toast--nospot", !toastSpot.free);
  }
  // record: false keeps this notice out of the replay clip (the recorder paints the toast otherwise)
  function notice(text, { record = true } = {}) {
    setText(toastEl, text);
    toastEl.dataset.record = record ? "" : "off";
    toastSpot = null;
    placeToast();
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3000);
  }

  // ---------- a panel over an end line says so: a thin end-colour border on the edge hud.js picked
  // (its "블루 끝" / "레드 끝" label is drawn on the canvas just outside that edge; owner: nothing goes on the
  // table, the ball's path). Off when the end lines are off. The court map is not marked: its two ends are
  // drawn in their colours (courtSvg). ----------
  const endMarks = new Map();
  function markPanelEnds(drawn, showEnds) {
    const want = new Set();
    for (const [side, e] of Object.entries((showEnds && drawn?.ends) || {})) {
      if (e.covered < END_TAG.minCovered || !PANEL_IDS.includes(e.by)) continue;
      const panel = e.by === "players" ? players : court;
      const key = `${e.by}:${side}`;
      want.add(key);
      let m = endMarks.get(key);
      if (!m) {
        m = el("span", { class: "panel__end", "aria-hidden": "true" });
        endMarks.set(key, m);
      }
      if (m.parentNode !== panel) panel.append(m);
      setAttr(m, "data-edge", e.edge);
      setAttr(m, "data-end", e.color);
    }
    for (const [key, m] of endMarks) if (!want.has(key)) { m.remove(); endMarks.delete(key); }
  }

  // ---------- players + court map on a free spot (owner: no table of numbers on the table) ----------
  // Landscape phone and tv (overlay fit): each panel goes where it covers none of the calibrated table,
  // the air above it the ball flies through (up to the top of the screen), the players
  // (each joints box of the last 4 s), the ball's trail of the last 4 s, the top rows, the fold chip, the
  // control bar or the other panel. Full size first, then the small size; with no free spot at either the
  // panel folds by itself and the chip says so. A spot stays while it is free, so a panel does not hop;
  // a small or folded panel tries its full size again every few seconds. Portrait keeps its rows.
  const PANEL_HOLD_MS = 4000;
  const held = []; // { t, x, y, w, h } in app px: player bodies and ball points of the last 4 s
  const panelSpot = new Map(); // panel -> { x, y, size, at } (size "l" | "s" | "off")
  let placing = false;
  let heldKey = "";
  function convexHull(pts) {
    const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lo = [], hi = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (const q of p.reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
    return [...lo.slice(0, -1), ...hi.slice(0, -1)];
  }
  // a convex polygon against a box: separated on one of the box axes or one of the polygon's edge normals
  function polyHitsBox(poly, b) {
    const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
    if (Math.max(...xs) <= b.x || Math.min(...xs) >= b.x + b.w || Math.max(...ys) <= b.y || Math.min(...ys) >= b.y + b.h) return false;
    const corners = [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], c = poly[(i + 1) % poly.length];
      const nx = c.y - a.y, ny = a.x - c.x;
      const proj = (q) => q.x * nx + q.y * ny;
      const pp = poly.map(proj), bp = corners.map(proj);
      if (Math.max(...pp) <= Math.min(...bp) || Math.max(...bp) <= Math.min(...pp)) return false;
    }
    return true;
  }
  const boxHits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  // withBar: the 누가 땄나요 bar on its own spot is kept off too (the panels make room for it)
  let lastKeep = null;
  function panelKeepOut(state, appRect, withBar = false) {
    const now = performance.now();
    const o = overlay.getBoundingClientRect();
    const ox = o.left - appRect.left, oy = o.top - appRect.top;
    for (const b of Object.values(lastHud?.bodies || {})) if (b && b.w) held.push({ t: now, x: b.x + ox - 8, y: b.y + oy - 8, w: b.w + 16, h: b.h + 16 });
    // this frame's joints too (the HUD draws them after the panels move; its last frame is one behind),
    // with room for the foot ring under the feet
    for (const side of ["near", "far"]) {
      const pts = (state.players?.[side]?.landmarks || []).filter((lm) => lm && (lm.v == null || lm.v >= 0.5)).map(videoToScreen);
      if (!pts.length) continue;
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
      held.push({ t: now, x: x0 + ox - 16, y: y0 + oy - 12, w: x1 - x0 + 32, h: y1 - y0 + 36 });
    }
    for (const p of (state.ball?.trail || []).slice(-40)) {
      if (!p || !Number.isFinite(p.x)) continue;
      const s = videoToScreen(p);
      held.push({ t: now, x: s.x + ox - 10, y: s.y + oy - 10, w: 20, h: 20 });
    }
    while (held.length && now - held[0].t > PANEL_HOLD_MS) held.shift();
    if (held.length > 600) held.splice(0, held.length - 600);
    const polys = [];
    const corners = state.calibration?.corners;
    if (corners && corners.length === 4 && fit.scale) {
      const q = corners.map((c) => { const s = videoToScreen(c); return { x: s.x + ox, y: s.y + oy }; });
      // the ball flies anywhere above the table, a lob up out of the picture: the table and everything
      // above it to the top of the screen (a court map placed over the table's top caught lobs, clip12 at 1280)
      polys.push(convexHull([...q, ...q.map((p) => ({ x: p.x, y: -appRect.height }))]));
    }
    const ui = [strip, glance, banner, dock, bar, stageChips, btnFit, ...app.querySelectorAll("[data-keepout]"), ...(withBar && pointbar.dataset.spot === "free" && !pointbar.hidden ? [pointbar] : [])].filter((n) => !n.closest("[hidden]") && n.offsetHeight && getComputedStyle(n).visibility !== "hidden").map((n) => {
      const r = n.getBoundingClientRect();
      return { x: r.left - appRect.left - 6, y: r.top - appRect.top - 6, w: r.width + 12, h: r.height + 12, ...(n === pointbar ? { bar: true } : {}) };
    });
    lastKeep = { polys, boxes: [...ui, ...held], at: now };
    return lastKeep;
  }
  const panelFree = (b, k, other) => !(other && boxHits(b, other)) && !k.boxes.some((r) => boxHits(b, r)) && !k.polys.some((p) => polyHitsBox(p, b));
  function setPanelSize(panel, size) {
    setHidden(panel, size === "off");
    if (size !== "off") setAttr(panel, "data-size", size);
  }
  function findSpot(panel, size, k, other, appRect, right) {
    setPanelSize(panel, size);
    const w = panel.offsetWidth + 3, h = panel.offsetHeight + 3; // with its drop shadow
    // inside the safe area (notch sides, home bar): the strip and the fold chip already sit on its edges
    const edge = (n) => (!n.closest("[hidden]") && n.offsetHeight ? n.getBoundingClientRect() : null);
    const s = edge(strip), d = edge(dock), br = edge(bar);
    const minX = Math.max(8, d ? d.left - appRect.left : 0, s ? s.left - appRect.left : 0);
    const maxX = Math.min(appRect.width - 8, s ? s.right - appRect.left : Infinity) - w;
    const minY = Math.max(8, s ? s.top - appRect.top : 0);
    const maxY = Math.min(appRect.height - 8, Math.max(d ? d.bottom - appRect.top : 0, br ? br.bottom - appRect.top : 0) || Infinity) - h;
    if (maxX < minX || maxY < minY) return null;
    const step = Math.max(8, Math.round(Math.min(appRect.width, appRect.height) / 60));
    // rows from the bottom up; across each row from the panel's own side (players left, court right)
    for (let y = maxY; y >= minY; y -= step) {
      for (let i = 0; minX + i * step <= maxX; i++) {
        const x = right ? maxX - i * step : minX + i * step;
        const b = { x, y, w, h };
        if (panelFree(b, k, other)) return { x, y, w, h, size };
      }
    }
    return null;
  }
  function placePanels(state, hudVisible) {
    // folded by the chip, the spots stay so the panels reopen where they were
    const on = hudVisible && fitMode === "overlay";
    if (on && !panelsOpen) return;
    if (!on) {
      if (placing) {
        placing = false;
        setAttr(app, "data-place", "");
        for (const p of [players, court]) { p.style.left = p.style.top = ""; setHidden(p, false); p.removeAttribute("data-size"); }
        panelSpot.clear();
        setAttr(app, "data-psize", "");
        syncDockAuto(0);
      }
      return;
    }
    if (!placing) { placing = true; setAttr(app, "data-place", "js"); }
    // a resize reaches render before the stage is measured again: map the table and the players with this
    // size's fit, not the last one (a stopped camera redraws once, so a stale fit stayed on a player)
    if (!stageW || stage.clientWidth !== stageW || stage.clientHeight !== stageH) measureStage();
    const appRect = app.getBoundingClientRect();
    const key = `${Math.round(appRect.width)}x${Math.round(appRect.height)}|${currentLayout}`;
    // boxes held from another size are in the wrong place
    if (key !== heldKey) { held.length = 0; heldKey = key; }
    const k = panelKeepOut(state, appRect, true);
    // asked for (pressDock): only the buttons and rows keep a panel off, not the table, players or trail
    const asked = replay && panelsAsked ? { polys: [], boxes: k.boxes.filter((b) => b.t == null) } : null;
    const now = performance.now();
    for (const [panel, right] of [[players, false], [court, true]]) {
      const otherPanel = panel === players ? court : players;
      const os = panelSpot.get(otherPanel);
      const other = os && os.size !== "off" ? { x: os.x - 8, y: os.y - 8, w: os.w + 16, h: os.h + 16 } : null;
      let s = panelSpot.get(panel);
      const stale = !s || s.key !== key;
      const keep = !stale && (s.size === "off" ? now - s.at < 1000 : panelFree(s, s.asked && asked ? asked : k, other));
      // a smaller or folded panel tries its bigger sizes again every 3 s, keeping its spot if that fails
      const grow = keep && s.size !== "l" && now - s.at > 3000;
      if (keep && !grow) continue;
      const sizes = currentLayout === "tv" ? ["l", "m", "s"] : ["l", "s"];
      let spot = null;
      for (const size of grow && s.size !== "off" ? sizes.slice(0, sizes.indexOf(s.size)) : sizes) if ((spot = findSpot(panel, size, k, other, appRect, right))) break;
      if (!spot && !keep && asked) for (const size of sizes) if ((spot = findSpot(panel, size, asked, other, appRect, right))) { spot.asked = true; break; }
      if (!spot && keep) { setPanelSize(panel, s.size); s.at = now; continue; }
      s = spot ? { ...spot, key, at: now } : { size: "off", key, at: now, x: 0, y: 0, w: 0, h: 0 };
      panelSpot.set(panel, s);
      setPanelSize(panel, s.size);
      if (s.size !== "off") {
        // .bottom is the 0 x 0 anchor the panels are placed from
        const a = bottom.getBoundingClientRect();
        const left = `${Math.round(s.x - (a.left - appRect.left))}px`, top = `${Math.round(s.y - (a.top - appRect.top))}px`;
        if (panel.style.left !== left) panel.style.left = left;
        if (panel.style.top !== top) panel.style.top = top;
      }
    }
    const sizes = [players, court].map((p) => panelSpot.get(p)?.size || "l");
    setAttr(app, "data-psize", `players:${sizes[0]},court:${sizes[1]}`);
    syncDockAuto(sizes.filter((x) => x === "off").length);
  }
  // ---------- the 누가 땄나요 bar in landscape and on a TV: one low row on a free spot ----------
  // It opens after every point (확인 후 입력). Across the top rows it covered the table's top and a player
  // (852x393), so it takes a spot the way the panels do: off the table and everything above it, the players
  // and the ball's trail of the last 4 s, the top rows, the control bar and both panels, from the bottom up and
  // from the middle out; the panels then make room for it. The spot holds while the same question is open and
  // nothing comes under it (a button should not move under the finger). No free spot: it may cover a panel;
  // still none: its old place under the top rows. Portrait keeps the band under the top rows.
  const POINT_WIDTHS = [760, 640, 520, 440];
  let pointSpot = null;
  function placePointbar(state, key) {
    if (!key || fitMode !== "overlay") {
      if (pointbar.dataset.spot) {
        delete pointbar.dataset.spot;
        for (const k of ["left", "top", "width", "transform"]) pointbar.style[k] = "";
      }
      pointSpot = null;
      return false;
    }
    const appRect = app.getBoundingClientRect();
    const k2 = `${key}|${Math.round(appRect.width)}x${Math.round(appRect.height)}|${currentLayout}`;
    // the same question keeps its spot while nothing new comes under it; a player or the ball moving in
    // moves it, at most once a second (the panels' keep-out of this frame, without the bar itself)
    const moving = !!(pointSpot && pointSpot.key === k2);
    if (moving) {
      const now = performance.now();
      if (pointbar.dataset.spot !== "free" || now - pointSpot.at < 1000 || !lastKeep || now - lastKeep.at > 100) return true;
      const r = pointbar.getBoundingClientRect();
      const b = { x: r.left - appRect.left, y: r.top - appRect.top, w: r.width, h: r.height };
      if (panelFree(b, { polys: lastKeep.polys, boxes: lastKeep.boxes.filter((q) => !q.bar) }, null)) return true;
    }
    const k = panelKeepOut(state, appRect);
    const edge = (n) => (!n.closest("[hidden]") && n.offsetHeight && getComputedStyle(n).visibility !== "hidden" ? n.getBoundingClientRect() : null);
    const panelBoxes = [players, court].map(edge).filter(Boolean).map((r) => ({ x: r.left - appRect.left - 8, y: r.top - appRect.top - 8, w: r.width + 16, h: r.height + 16 }));
    const st = edge(strip), d = edge(dock), br = edge(bar);
    const minX = Math.max(8, st ? st.left - appRect.left : 0);
    const right = Math.min(appRect.width - 8, st ? st.right - appRect.left : Infinity, br && br.left - appRect.left > appRect.width / 2 ? br.left - appRect.left - 8 : Infinity);
    const bottomY = Math.min(appRect.height - 8, Math.max(d ? d.bottom - appRect.top : 0, br ? br.bottom - appRect.top : 0) || Infinity);
    const minY = Math.max(8, st ? st.top - appRect.top : 0);
    const was = moving && pointbar.dataset.spot === "free" ? { left: pointbar.style.left, top: pointbar.style.top, width: pointbar.style.width } : null;
    pointbar.dataset.spot = "free";
    pointbar.style.transform = "none";
    const step = Math.max(8, Math.round(Math.min(appRect.width, appRect.height) / 60));
    let spot = null, overPanel = false;
    // last pass: still off the table, the air above it, the UI and this frame's players and ball, but not the
    // ones held from the last 4 s
    const fresh = { polys: k.polys, boxes: k.boxes.filter((q) => q.t == null || q.t >= k.at) };
    for (const [coverPanels, keep] of [[false, k], [true, k], ...(was ? [] : [[true, fresh]])]) {
      for (const want of POINT_WIDTHS) {
        const w = Math.min(want, right - minX);
        pointbar.style.width = `${Math.round(w)}px`;
        const h = pointbar.offsetHeight + 3;
        const maxX = right - w, maxY = bottomY - h;
        if (maxX < minX || maxY < minY) continue;
        const mid = (minX + maxX) / 2;
        const xs = [];
        for (let x = minX; x <= maxX; x += step) xs.push(x);
        xs.push(maxX);
        xs.sort((p, q) => Math.abs(p - mid) - Math.abs(q - mid));
        for (let y = maxY; y >= minY && !spot; y -= step) {
          for (const x of xs) {
            const b = { x, y, w, h };
            if (panelFree(b, keep, null) && (coverPanels || !panelBoxes.some((r) => boxHits(b, r)))) { spot = b; overPanel = coverPanels; break; }
          }
        }
        if (spot) break;
      }
      if (spot) break;
    }
    if (spot) {
      pointbar.dataset.spot = "free";
      pointbar.style.left = `${Math.round(appRect.left + spot.x)}px`;
      pointbar.style.top = `${Math.round(appRect.top + spot.y)}px`;
    } else if (was) {
      // moving and nowhere clear: stay where it was
      Object.assign(pointbar.style, was);
    } else {
      // nowhere clear: the one low row under the top rows, as wide as the strip
      pointbar.dataset.spot = "top";
      const under = Math.max(0, ...[strip, glance, stageChips, btnFit].map(edge).filter(Boolean).map((r) => r.bottom));
      pointbar.style.left = `${Math.round(appRect.left + minX)}px`;
      pointbar.style.width = `${Math.round(right - minX)}px`;
      pointbar.style.top = `${Math.round(under) + 8}px`;
    }
    pointSpot = { key: k2, at: performance.now() };
    // over a panel: the caller places the panels again now, around the bar (a stopped camera draws no next frame)
    return overPanel ? "over" : true;
  }
  // the fold chip says when a panel folded by itself for want of a free spot
  function syncDockAuto(folded) {
    setAttr(dock, "data-auto", folded ? "off" : "");
    setAttr(dock, "aria-label", panelsOpen
      ? (folded ? L("선수·코트맵 접기 · 탁구대를 가리지 않게 일부 접힘", "Fold players and court map · one folded to keep off the table") : L("선수·코트맵 접기", "Fold players and court map"))
      : L("선수·코트맵 펼치기", "Show players and court map"));
  }

  // ---------- leaving while recording: one confirm (no browser dialog) ----------
  let leaveResolve = null;
  const btnStay = el("button", { class: "btn btn--primary", type: "button", onclick: () => answerLeave(false) }, el("span", {}, L("계속 찍기", "Keep filming")));
  const btnGo = el("button", { class: "btn btn--danger", type: "button", onclick: () => answerLeave(true) }, el("span", {}, L("멈추고 나가기", "Stop and leave")));
  const leaveDlg = el("div", { class: "leave", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "ppv-leave-title", hidden: true },
    el("div", { class: "leave__card" },
      el("p", { class: "leave__title", id: "ppv-leave-title" }, L("찍는 중이에요. 멈추고 나갈까요?", "Still filming. Stop and leave?")),
      el("p", { class: "screen__note" }, L("끝난 랠리 영상과 점수는 다 보낸 뒤에 나가요.", "Finished rally clips and scores are sent before leaving.")),
      el("div", { class: "leave__actions" }, btnStay, btnGo)));
  function answerLeave(go) {
    setHidden(leaveDlg, true);
    const r = leaveResolve;
    leaveResolve = null;
    if (r) r(go);
  }
  function confirmLeave() {
    if (leaveResolve) answerLeave(false);
    closeSettings();
    setHidden(leaveDlg, false);
    btnStay.focus({ preventScroll: true });
    return new Promise((resolve) => { leaveResolve = resolve; });
  }
  // Back closes what is open on top first, then leaves the camera (app.js onLeave).
  function back() {
    if (leaveResolve) return answerLeave(false);
    if (settingsOpen) return closeSettings();
    if (sheetOpen) return H("onCloseHistory");
    if (fixOpen) return toggleFix(false);
    if (currentMode === "calibrating") { calibReset(); return H("onCalibrationCancel"); }
    H("onLeave");
  }
  function syncBackNames() {
    const name = leaveResolve ? L("뒤로: 나가기 취소", "Back: don't leave") : settingsOpen ? L("설정 닫기", "Close settings") : sheetOpen ? L("기록 닫기", "Close history") : fixOpen ? L("점수 고치기 닫기", "Close fix score") : currentMode === "calibrating" ? L("보정 취소", "Cancel calibration") : L("모드 고르기로", "Back to Choose mode");
    for (const button of app.querySelectorAll("[data-back]")) setAttr(button, "aria-label", name);
    for (const button of app.querySelectorAll("[data-back]")) setAttr(button, "data-back-destination", leaveResolve ? "recording" : settingsOpen ? "camera" : sheetOpen ? "camera" : fixOpen ? "camera" : currentMode === "calibrating" ? "camera" : "picker");
    // settings, history or 점수 고치기 open: the fold chip and the fit switch sit under them, so they step away
    setAttr(app, "data-over", settingsOpen || sheetOpen || fixOpen ? "1" : "0");
  }

  const app = el("div", { class: "app", "data-mode": "intro", "data-layout": "phone", "data-fit": "stack" },
    stage, peek, hud, strip, pointbar, bar, popover, fixPanel, calibbar, backdrop, sheet, screenIntro, screenLoading, screenError, leaveDlg, toastEl);
  if (replay) setAttr(app, "data-replay", "1");
  root.replaceChildren(app);
  syncPanels();

  // ---------- geometry: video px <-> CSS px of the overlay (object-fit: contain) ----------
  let stageW = 0, stageH = 0, vidW = 0, vidH = 0;
  let fit = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  function updateFit() {
    if (!stageW || !stageH || !vidW || !vidH) { fit = { x: 0, y: 0, w: stageW, h: stageH, scale: 1 }; return; }
    fit = fitBox(stageW, stageH, vidW, vidH, coverNow());
  }
  // Display only: the engine always reads the full frame. Calibration is always contain, so every
  // corner of the table can be tapped; a tall camera stream starts filled, a wide one whole.
  function coverNow() {
    if (fitMode !== "stack" || currentMode === "calibrating" || !vidW) return false;
    return videoFill ? videoFill === "fill" : vidH > vidW;
  }
  function syncVideoFit() {
    const cover = coverNow();
    setAttr(stage, "data-video-fit", cover ? "cover" : "contain");
    setAttr(app, "data-video-wide", vidW > vidH && !cover ? "1" : "0");
    if (vidW) app.style.setProperty("--vid-ar", `${vidW} / ${vidH}`);
    setText(fitToggleLabel, cover ? L("맞춤", "Fit") : L("채움", "Fill"));
    btnFit.setAttribute("aria-pressed", String(cover));
    btnFit.setAttribute("aria-label", cover ? L("영상 전체 보기", "Show the whole video") : L("영상을 칸에 꽉 채우기", "Fill the frame with the video"));
    setHidden(btnFit, fitMode !== "stack" || !["ready", "running", "stopped"].includes(currentMode));
    updateFit();
  }
  function toggleVideoFit() {
    videoFill = coverNow() ? "fit" : "fill";
    localStorage.setItem("ppv-video-fill", videoFill);
    syncVideoFit();
  }
  function setVideoSize(w, h) {
    if (w > 0 && h > 0 && (w !== vidW || h !== vidH)) { vidW = w; vidH = h; updateFitMode(); syncVideoFit(); }
  }
  function videoToScreen(pt) { return { x: fit.x + pt.x * fit.scale, y: fit.y + pt.y * fit.scale }; }
  function screenToVideo(pt) { return { x: (pt.x - fit.x) / fit.scale, y: (pt.y - fit.y) / fit.scale }; }

  // Order matters: the band-mode stage box is computed from the panel heights and the fit
  // mode, so both must be settled before the stage size (and the overlay backing store) is read.
  function measureStage() {
    const gh = glance.offsetHeight;
    if (gh && gh !== glanceH) { glanceH = gh; app.style.setProperty("--glance-h", `${gh}px`); }
    const bh = bottom.offsetHeight;
    if (bh && bh !== bottomH) { bottomH = bh; app.style.setProperty("--bottom-h", `${bh}px`); }
    updateFitMode();
    const w = stage.clientWidth, h = stage.clientHeight;
    if (w !== stageW || h !== stageH) {
      stageW = w; stageH = h; updateFit();
      layoutCalibMarkers();
    }
  }
  let glanceH = 0;
  let bottomH = 0;
  let fitMode = "stack";
  // "stack": portrait phone, whatever the video's aspect ratio. Status strip, glance row, live
  //          chips, fold chip, players + court and the control bar are grid rows floating on the
  //          full-screen picture; while calibrating the picture is the middle row, uncovered.
  // "overlay": landscape phone and tv. The stage fills the screen; panels sit on its edges.
  function updateFitMode() {
    const portrait = app.clientWidth < app.clientHeight;
    const want = currentLayout === "phone" && portrait ? "stack" : "overlay";
    if (want !== fitMode) { fitMode = want; setAttr(app, "data-fit", want); syncVideoFit(); }
    // portrait: the strip stays one line and the live status sits on the picture
    const home = fitMode === "stack" ? stageChips : strip;
    if (chipRec.parentNode !== home) for (const c of [chipRec, chipTrack, chipEnds, chipCams, chipSlow, chipStable, chipColor]) home === strip ? strip.insertBefore(c, chipPerf) : home.append(c);
  }
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => measureStage()) : null;
  if (ro) { ro.observe(stage); ro.observe(glance); ro.observe(bottom); ro.observe(app); } else window.addEventListener("resize", measureStage);
  video.addEventListener("loadedmetadata", () => setVideoSize(video.videoWidth, video.videoHeight));
  video.addEventListener("resize", () => setVideoSize(video.videoWidth, video.videoHeight));
  // Calibration taps land on a still frame. app.js pauses a file source when calibration begins,
  // but WebKit's media engine sometimes undoes that by itself when the seek app.js queued before
  // the pause completes afterwards: the element resumes with no play() call, or jumps straight to
  // its end. The UI owns the element, so it holds it: pause again, and rewind a file that "ended"
  // while nobody was playing it.
  function holdCalibrationFrame() {
    if (currentMode !== "calibrating" || currentSource !== "file") return;
    if (!video.paused) video.pause();
    if (video.ended || (video.duration > 0 && video.currentTime >= video.duration)) video.currentTime = 0;
  }
  video.addEventListener("playing", holdCalibrationFrame);
  video.addEventListener("ended", holdCalibrationFrame);

  const ctx = overlay.getContext("2d");
  function ensureOverlaySize() {
    if (stage.clientWidth !== stageW || stage.clientHeight !== stageH) measureStage();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(stageW * dpr), h = Math.round(stageH * dpr);
    if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
  }

  // ---------- calibration interaction ----------
  const cameraGuide = createCameraGuide(app, video);
  // The guide card mirrors the calibration message and judges the tapped quad, so it is refreshed on every
  // calibration change (a tap, a drag, 정밀하게's answer), not only on an app render: with a paused file no
  // render comes, and the card kept showing "내 쪽 끝선 왼쪽 모서리를 누르세요" after all four taps (1.1.33).
  let guideState = { enabled: false, calibrating: false };
  function syncCameraGuide() {
    cameraGuide.sync({ ...guideState, quad: calibPts.length === 4 ? calibPts.map(screenToVideo) : null, w: vidW, h: vidH, cornerText: calibText.textContent });
  }
  let calibPts = [];        // stage CSS px, tap order
  let calibMarkers = [];
  let drag = null;
  let posterImg = null;
  const stageRect = { left: 0, top: 0 };
  function refreshStageRect() { const r = stage.getBoundingClientRect(); stageRect.left = r.left; stageRect.top = r.top; }
  function clampToVideo(p) {
    if (!fit.w || !fit.h) return p;
    return { x: Math.max(fit.x, Math.min(fit.x + fit.w, p.x)), y: Math.max(fit.y, Math.min(fit.y + fit.h, p.y)) };
  }
  function updateCalibGuide() {
    const n = calibPts.length;
    // four corners in: the end colour is the step (unless the snap is still running or asks for a drag)
    const endStep = n >= 4 && !snapNote;
    setText(calibStep, endStep ? L("끝 색", "Ends") : n >= 4 ? L("정밀", "Fit") : `${Math.min(n + 1, 4)}/4`);
    setText(calibText, n >= 4 ? snapNote || (calibNear === 1 ? CALIB_END_RED : CALIB_END_BLUE) : CALIB_STEPS[n]);
    calibDots.childNodes.forEach((d, i) => toggleClass(d, "on", i < n));
    btnConfirm.disabled = n < 4 || snapBusy;
    btnUndo.disabled = n === 0 || snapBusy;
    btnRestart.disabled = n === 0 || snapBusy;
    btnPrecise.disabled = n < 4 || snapBusy;
    toggleClass(btnPrecise, "btn--next", n >= 4 && !snapPrev && !snapBusy);
    // once fitted, the undo button takes the fit back first (되돌리기), then corners as before
    setText(btnUndoLabel, snapPrev ? L("되돌리기", "Revert") : L("모서리 취소", "Undo"));
    setAttr(btnUndo, "aria-label", snapPrev ? L("정밀하게 되돌리기: 찍은 점으로", "Revert the fit to your taps") : L("마지막 모서리 취소", "Undo last corner"));
    setText(btnPreciseLabel, snapBusy ? L("맞추는 중", "Fitting") : snapPrev ? L("다시 하기", "Fit again") : L("정밀하게", "Precise"));
    const pts = calibPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    calibPoly.setAttribute("points", pts);
    calibGhost.style.display = snapPrev ? "" : "none";
    if (snapPrev) calibGhost.setAttribute("points", snapPrev.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
    calibGhostPts.forEach((c, i) => {
      const p = snapPrev && snapPrev[i];
      c.style.display = p ? "" : "none";
      if (p) { c.setAttribute("cx", p.x.toFixed(1)); c.setAttribute("cy", p.y.toFixed(1)); }
    });
    updateCalibEnds();
    syncCameraGuide();
  }
  // taps 1-2 are the near end, 3-4 the far end; each gets its colour once both corners are in
  function updateCalibEnds() {
    const colours = ["#2f7dff", "#ff3020"]; // the camera screen's end-line colours (hud.js END_LINE)
    calibEnds.forEach((e, i) => {
      const a = calibPts[i * 2], b = calibPts[i * 2 + 1];
      const show = !!(a && b);
      for (const n of [e.halo, e.line, e.label]) n.style.display = show ? "" : "none";
      if (!show) return;
      const end = i === 0 ? calibNear : 1 - calibNear;
      // 5 px outside the table edge, as on the camera screen (hud.js END_LINE.offset); before all four
      // corners are in, away from the two taps of the other end if there are any
      const others = calibPts.filter((_, j) => j !== i * 2 && j !== i * 2 + 1);
      const c = others.length ? { x: others.reduce((s, o) => s + o.x, 0) / others.length, y: others.reduce((s, o) => s + o.y, 0) / others.length } : null;
      let nx = -(b.y - a.y), ny = b.x - a.x;
      const len = Math.hypot(nx, ny) || 1;
      nx /= len; ny /= len;
      if (c && ((a.x + b.x) / 2 - c.x) * nx + ((a.y + b.y) / 2 - c.y) * ny < 0) { nx = -nx; ny = -ny; }
      const off = c ? 5 : 0;
      for (const n of [e.halo, e.line]) for (const [k, v] of Object.entries({ x1: a.x + nx * off, y1: a.y + ny * off, x2: b.x + nx * off, y2: b.y + ny * off })) n.setAttribute(k, v.toFixed(1));
      e.line.style.stroke = colours[end];
      const low = a.y > b.y ? a : b;
      e.label.setAttribute("x", low.x.toFixed(1));
      e.label.setAttribute("y", (low.y + 30).toFixed(1));
      e.label.style.fill = colours[end];
      e.label.textContent = L(`${SIDE_NAMES[end]} 끝`, `${SIDE_NAMES[end]} end`);
    });
    btnEnds.disabled = calibPts.length < 4;
    setAttr(btnEnds, "aria-label", calibPts.length >= 4 ? L(`${endsWords(calibPts, calibNear)} · 끝 색 바꾸기`, `${endsWords(calibPts, calibNear)} · swap end colours`) : L("끝 색 바꾸기", "Swap end colours"));
  }
  function layoutCalibMarkers() {
    calibMarkers.forEach((m, i) => { const p = calibPts[i]; if (p) { m.style.left = `${p.x}px`; m.style.top = `${p.y}px`; } });
    updateCalibGuide();
  }
  function addCalibPoint(p) {
    const idx = calibPts.length;
    calibPts.push(p);
    const cross = el("span", { class: "calib__pt-x", "aria-hidden": "true" });
    cross.innerHTML = '<svg viewBox="0 0 24 24"><path class="calib__pt-shadow" d="M12 1v8M12 15v8M1 12h8M15 12h8"/><path class="calib__pt-line" d="M12 1v8M12 15v8M1 12h8M15 12h8"/></svg>';
    const marker = el("button", { class: "calib__pt", type: "button", "aria-label": L(`모서리 ${idx + 1} (끌어서 조정)`, `Corner ${idx + 1} (drag to adjust)`) }, cross, el("b", { class: "calib__pt-n" }, String(idx + 1)));
    marker.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!d) return;
      e.preventDefault();
      if (snapNote) dropSnap();
      calibPts[idx] = clampToVideo({ x: calibPts[idx].x + d[0], y: calibPts[idx].y + d[1] });
      layoutCalibMarkers();
    });
    calibMarkers.push(marker);
    calibLayer.append(marker);
    layoutCalibMarkers();
  }
  // 정밀하게 asks the engine to fit the corners onto the table's white border (calib-refine.js, about a
  // second of frames). It always starts from the taps (snapPrev once fitted), so 다시 하기 does not drift.
  // The fitted outline is drawn over the faint taps for the owner to confirm; 되돌리기 brings the taps
  // back. A drag, a key nudge, undo or reset after that invalidates a reply still in flight.
  let snapNote = null;
  let snapSeq = 0;
  let snapPrev = null; // the taps (stage CSS px) before the fit shown now
  let snapBusy = false;
  function snapCorners() {
    if (calibPts.length !== 4 || snapBusy) return;
    const seq = ++snapSeq;
    const base = (snapPrev || calibPts).map((p) => ({ ...p }));
    snapBusy = true;
    snapNote = CALIB_SNAPPING;
    updateCalibGuide();
    const corners = base.map((p) => screenToVideo(p));
    const done = (res) => {
      if (seq !== snapSeq || calibPts.length !== 4) return;
      snapBusy = false;
      if (res && res.ok) {
        snapPrev = base;
        calibPts = res.corners.map((c) => clampToVideo(videoToScreen(c)));
        const px = Math.round(Math.max(...res.moved.map((m) => m * (fit.scale || 1))));
        snapNote = res.shake === "warn" ? calibSnapShaky(Math.round(res.shakePx * (fit.scale || 1) * 10) / 10) : calibSnapDone(px);
        layoutCalibMarkers();
      } else {
        // the points stay as they are (a fit shown before stays too) and the guide says why
        snapNote = calibSnapWhy(res && res.code === "shake" ? { ...res, shakePx: Math.round(res.shakePx * (fit.scale || 1) * 10) / 10 } : res);
        updateCalibGuide();
      }
    };
    if (H("onSnapCorners", corners, done) === undefined) done(null);
  }
  function dropSnap() {
    snapSeq++;
    snapNote = null;
    snapPrev = null;
    snapBusy = false;
  }
  function calibUndo() {
    if (!calibPts.length) return;
    if (snapPrev) {
      calibPts = snapPrev;
      dropSnap();
      snapNote = CALIB_SNAP_UNDONE;
      layoutCalibMarkers();
      return;
    }
    dropSnap();
    calibPts.pop();
    const m = calibMarkers.pop();
    if (m) m.remove();
    layoutCalibMarkers();
  }
  function calibReset() {
    dropSnap();
    calibPts = [];
    calibMarkers.forEach((m) => m.remove());
    calibMarkers = [];
    drag = null;
    loupe.hidden = true;
    updateCalibGuide();
  }
  function calibConfirm() {
    if (calibPts.length < 4) return;
    const corners = calibPts.map((p) => {
      const v = screenToVideo(p);
      return { x: Math.max(0, Math.min(vidW || Infinity, v.x)), y: Math.max(0, Math.min(vidH || Infinity, v.y)) };
    });
    // A corner pinned to the frame edge means that end of the table is out of view (a phone
    // held too close or turned upright): refuse it rather than track on a guessed quad.
    const edge = Math.max(2, Math.min(vidW, vidH) * 0.005);
    if (vidW && vidH && corners.some((c) => c.x <= edge || c.y <= edge || c.x >= vidW - edge || c.y >= vidH - edge)) {
      dropSnap();
      snapNote = CALIB_EDGE;
      updateCalibGuide();
      return;
    }
    if (quadFraction(corners, vidW, vidH) < SMALL_TABLE.frac) notice(L("탁구대가 작아요, 가까이 오거나 가로로 세우면 자동 점수가 잘 돼요", "The table looks small: move closer or turn landscape for better auto scoring"));
    calibReset();
    H("onCalibrationDone", corners);
  }
  function pointFromEvent(e) {
    return clampToVideo({ x: e.clientX - stageRect.left, y: e.clientY - stageRect.top });
  }
  // One pointer handler for the whole layer. A tap (press + release, < DRAG_PX of
  // movement) ALWAYS adds a point while fewer than 4 exist, even on top of an
  // existing marker: table corners can be ~25 CSS px apart on a phone. A marker is
  // dragged only when the pointer moves >= DRAG_PX after pressing on it.
  calibLayer.addEventListener("pointerdown", (e) => {
    if (drag) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    refreshStageRect();
    const marker = e.target.closest(".calib__pt");
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, idx: marker ? calibMarkers.indexOf(marker) : -1, moving: false };
    try { calibLayer.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  });
  calibLayer.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moving) {
      if (drag.idx < 0 || Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_PX) return;
      drag.moving = true;
      toggleClass(calibMarkers[drag.idx], "calib__pt--drag", true);
    }
    const p = pointFromEvent(e);
    if (snapNote) dropSnap();
    calibPts[drag.idx] = p;
    layoutCalibMarkers();
    drawLoupe(p);
  });
  function finishPress(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const press = drag;
    drag = null;
    try { calibLayer.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    if (press.moving) {
      const m = calibMarkers[press.idx];
      if (m) toggleClass(m, "calib__pt--drag", false);
      loupe.hidden = true;
      return;
    }
    if (e.type === "pointercancel") return;
    if (calibPts.length < 4) addCalibPoint(clampToVideo({ x: press.x - stageRect.left, y: press.y - stageRect.top }));
    else if (press.idx >= 0) calibMarkers[press.idx].focus({ preventScroll: true });
  }
  calibLayer.addEventListener("pointerup", finishPress);
  calibLayer.addEventListener("pointercancel", finishPress);
  function loupeSource() {
    if (video.readyState >= 2 && video.videoWidth) return video;
    if (video.poster) {
      if (!posterImg || posterImg.src !== video.poster) { posterImg = new Image(); posterImg.src = video.poster; }
      if (posterImg.complete && posterImg.naturalWidth) return posterImg;
    }
    return null;
  }
  function drawLoupe(p) {
    const src = loupeSource();
    if (!src || !fit.scale) { loupe.hidden = true; return; }
    const dpr = window.devicePixelRatio || 1;
    const size = Math.round(LOUPE_PX * dpr);
    if (loupe.width !== size) { loupe.width = size; loupe.height = size; }
    const lctx = loupe.getContext("2d");
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.imageSmoothingEnabled = false;
    lctx.fillStyle = "#000";
    lctx.fillRect(0, 0, size, size);
    const v = screenToVideo(p);
    const sw = (LOUPE_PX / LOUPE_ZOOM) / fit.scale;
    lctx.drawImage(src, v.x - sw / 2, v.y - sw / 2, sw, sw, 0, 0, size, size);
    lctx.strokeStyle = "rgba(255,211,77,0.9)";
    lctx.lineWidth = Math.max(1, dpr);
    lctx.beginPath();
    lctx.moveTo(size / 2, 0); lctx.lineTo(size / 2, size);
    lctx.moveTo(0, size / 2); lctx.lineTo(size, size / 2);
    lctx.stroke();
    loupe.style.left = `${p.x}px`;
    loupe.style.top = `${p.y}px`;
    loupe.hidden = false;
  }

  // ---------- keyboard ----------
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (leaveResolve) { answerLeave(false); e.preventDefault(); }
    else if (settingsOpen) { closeSettings(); e.preventDefault(); }
    else if (sheetOpen) { H("onCloseHistory"); e.preventDefault(); }
    else if (currentMode === "calibrating") { calibReset(); H("onCalibrationCancel"); e.preventDefault(); }
  });

  // ---------- mode visibility (the hidden attribute wins over every layout rule) ----------
  function applyModeVisibility(mode) {
    const hudOn = mode === "ready" || mode === "running" || mode === "stopped";
    const calibOn = mode === "calibrating";
    hud.hidden = !hudOn;
    strip.hidden = !hudOn && !calibOn;
    bar.hidden = !hudOn;
    calibLayer.hidden = !calibOn;
    calibbar.hidden = !calibOn;
    screenIntro.hidden = mode !== "intro";
    screenLoading.hidden = mode !== "loading";
    screenError.hidden = mode !== "error";
    if (!hudOn) { closeSheet(); }
  }

  // ---------- render ----------
  let currentMode = "intro";
  let currentSource = null;
  let currentLayout = "phone";
  let courtSig = "";
  let runStartedAt = 0;
  let lastRallyActive = false;
  let lastPerfAt = -Infinity;
  let bannerIssue = null;
  let bannerAt = 0;

  function render(state) {
    if (toastEl.classList.contains("show")) queueMicrotask(placeToast);
    if (!state) return;
    keySet = !!(state.save && state.save.keySet);
    const hasPin = !!state.tour?.fix?.can;
    const saved = saveStatus(state.save, hasPin);
    const saveClass = (node) => {
      setText(node, node === chipSave ? saved.chip : saved.label);
      setAttr(node, "data-save-kind", saved.kind);
      toggleClass(node, "chip--lock", saved.kind === "on");
      toggleClass(node, "chip--warn", saved.kind === "bad");
    };
    saveClass(chipSave);
    saveClass(saveState);
    setAttr(chipSave, "title", `${saved.label}. ${saved.hint}`);
    setAttr(chipSave, "aria-label", saved.label);
    setText(introSave, saved.label);
    setAttr(introSave, "data-save-kind", saved.kind);
    // PC save off and no PIN here yet: the PIN box is on this screen, not behind the camera.
    const askSavePin = (saved.kind === "off" || saved.kind === "bad") && !hasPin && saved.chip !== "PC?" && state.save?.supported !== false;
    // Beside a tournament app the camera writes scores only with its PIN: without one the same box asks.
    const needPin = !hasPin && !!state.tour && state.tour.ws !== "none";
    const askPin = askSavePin || needPin;
    introPin.hidden = !askPin;
    introRetry.hidden = !hasPin || saved.kind === "on" || state.save?.supported === false;
    setText(introPrivacyText, saved.kind === "on"
      ? L("끝난 랠리 구간 영상과 기록만 PC로 올라가요.", "Only finished rally clips and records go to the PC.")
      : needPin ? `${NEED_PIN}${askSavePin ? L(". PC 저장도 같이 켜져요", ". PC save turns on too") : ""}`
      : askPin ? saved.hint : `${saved.hint ? `${saved.hint}. ` : ""}${L("영상은 폰 밖으로 나가지 않아요.", "Video never leaves the phone.")}`);
    const mode = state.mode || "intro";
    for (const button of app.querySelectorAll("[data-back]")) button.disabled = !!state.leaving;
    currentSource = state.source || null;
    if (mode !== currentMode) {
      if (currentMode === "calibrating" && mode !== "calibrating") calibReset();
      if (mode === "calibrating") { refreshStageRect(); updateCalibGuide(); }
      if (mode === "running" && currentMode !== "running") runStartedAt = performance.now();
      currentMode = mode;
      setAttr(app, "data-mode", mode);
      applyModeVisibility(mode);
      closeSettings();
      updateFitMode();
      measureStage();
    }
    if (mode === "calibrating") holdCalibrationFrame();
    const layout = state.layout === "tv" ? "tv" : "phone";
    if (layout !== currentLayout) {
      currentLayout = layout;
      setAttr(app, "data-layout", layout);
      invalidateHudTheme();
      updateFitMode();
      measureStage();
    }
    if (coverNow() !== (stage.getAttribute("data-video-fit") === "cover")) syncVideoFit();
    else setHidden(btnFit, fitMode !== "stack" || !["ready", "running", "stopped"].includes(currentMode));
    if (state.video) setVideoSize(state.video.width, state.video.height);
    else if (video.videoWidth) setVideoSize(video.videoWidth, video.videoHeight);
    setSeg(L("카메라 자리 안내", "Camera placement guide"), state.cameraGuide ? "on" : "off");
    guideState = { enabled: !!state.cameraGuide, calibrating: mode === "calibrating" };
    syncCameraGuide();

    if (mode === "loading") {
      setText(loadingText, state.loadingText || L("준비하는 중…", "Getting ready…"));
      const ld = state.loading;
      const sized = !!(ld && ld.phase === "download" && ld.total > 0);
      toggleClass(progressBar, "progress--busy", !sized);
      if (sized) {
        const pct = Math.min(100, Math.floor((ld.received / ld.total) * 100));
        progressFill.style.width = `${pct}%`;
        setAttr(progressBar, "aria-valuenow", String(pct));
        setText(progressCount, `${mb(ld.received)} / ${mb(ld.total)}MB · ${pct}%`);
      } else {
        progressFill.style.width = "";
        progressBar.removeAttribute("aria-valuenow");
        setText(progressCount, ld && ld.phase === "init" ? L("다 받았어요. 준비 중…", "Downloaded. Getting ready…") : "");
      }
    }
    if (mode === "error") {
      const err = state.error || {};
      const sig = JSON.stringify([err.title, err.detail, err.steps]);
      if (sig !== errSig) {
        errSig = sig;
        setText(errTitle, err.title || L("문제가 생겼어요", "Something went wrong"));
        setText(errDetail, err.detail || "");
        errSteps.replaceChildren(...(err.steps || []).map((s) => el("li", {}, s)));
        errSteps.hidden = !(err.steps && err.steps.length);
        setText(errRetryLabel, currentSource === "file" ? L("카메라 시작", "Start camera") : err.retry || L("다시 시도", "Try again"));
      }
    }

    if (state.save && state.save.notice) {
      // The note sits under the buttons, below the fold on a phone; a new notice (setup link
      // traded or refused) must be seen without scrolling.
      if (state.save.notice !== shownNotice) {
        shownNotice = state.save.notice;
        setText(introNote, shownNotice);
        requestAnimationFrame(() => introNote.scrollIntoView({ block: "nearest" }));
      }
    } else if (state.estimateNote) setText(introNote, L(`${state.estimateNote}예요.`, `${state.estimateNote}.`));

    const tv = state.tour || { matches: [] };
    if (tv.errorFresh && tv.error !== introNote.textContent) {
      setText(introNote, tv.error);
      requestAnimationFrame(() => introNote.scrollIntoView({ block: "nearest" }));
    }
    const linkText = tv.ws === "none" ? L("대회 연결 없이 혼자 쓰는 중", "Solo, no tournament link")
      : tv.ws === "offline" ? L("대회 연결 끊김 · 다시 연결 중", "Tournament link lost · reconnecting")
      : tv.needPick ? L("설정에서 경기 선택", "Pick a match in Settings")
      : !tv.connected ? (tv.ws === "online" ? NEED_PIN : L("대회에 연결하는 중", "Connecting to the tournament"))
      : tv.match ? L(`대회 연결됨 · ${tv.match.no}경기 ${tv.match.names[0]} vs ${tv.match.names[1]}`, `Linked · match ${tv.match.no} ${tv.match.names[0]} vs ${tv.match.names[1]}`) : L("대회 연결됨 · 칠 경기가 없어요", "Linked · no match to play");
    // how many cameras are on this match: "카메라 1대" / "카메라 2대 합치기" (owner, 2026-10-31)
    const mv = state.multi || { count: 0, cams: [] };
    const camWord = mv.count >= 2 ? L(`카메라 ${mv.count}대 합치기`, `${mv.count} cameras merged`) : mv.count === 1 ? L("카메라 1대", "1 camera") : L("카메라", "Camera");
    setText(chipLinkText, `${camWord} · ${tv.ws === "none" ? L("혼자", "solo") : tv.ws === "offline" ? L("끊김", "offline") : tv.needPick ? L("경기?", "match?") : !tv.connected ? L("PIN 필요", "PIN needed") : tv.match ? L(`${tv.match.no}경기`, `match ${tv.match.no}`) : L("연결", "linked")}`);
    const camState = (c, short) => (!c.me && c.ball == null ? L("연결 중", "connecting") : !c.me && c.fresh === false ? L("느림", "slow") : c.ball === "seen" ? (short ? L("보임", "seen") : L("공 보임", "ball seen")) : short ? L("놓침", "lost") : L("공 놓침", "ball lost"));
    const camLine = (c) => `${c.me ? L("이 폰", "this phone") : L("다른 폰", "other phone")}(${c.primary ? L("주", "main") : L("보조", "backup")}) ${camState(c, false)}`;
    const clockText = mv.errMs != null ? L(`시계 ±${mv.errMs}ms`, `clock ±${mv.errMs}ms`) : L("시계 맞추는 중", "syncing clocks");
    const camsText = mv.count >= 2 ? `${mv.cams.map(camLine).join(" · ")} · ${clockText}` : "";
    setAttr(chipLink, "title", camsText ? `${linkText} · ${camsText}` : linkText);
    const other = mv.count >= 2 ? mv.cams.find((c) => !c.me) : null;
    setHidden(chipCams, !other);
    // with two cameras a warning that the picked end colours look opposite rides on this chip
    const endsNow = mv.ends?.state || null;
    const endsShort = endsNow === "mismatch" ? L("끝 색 반대?", "ends swapped?") : null;
    // the landscape strip has no room left (main ends 5 px before the controls): there the chip stays as it
    // was and only turns the warning colour; on the picture (portrait) the state is spelled out
    const inStrip = chipCams.parentNode === strip;
    // in the landscape strip (no room for more) the warning takes the place of the ball and clock state; while
    // 점수 보류 stands it says that instead of which camera (누가 땄나요 asks for every point)
    // (the landscape strip has room for one word in front: "보류" there, as long as "보조" was)
    const role = other ? (other.primary ? L("주", "main") : L("보조", "backup")) : "";
    const camWarn = mv.hold ? `${inStrip ? HOLD_STRIP : HOLD_SHORT} · ${endsShort}` : `${role} · ${endsShort}`;
    if (other) setText(chipCams, endsShort && inStrip ? camWarn : `${role} ${camState(other, true)} · ±${mv.errMs ?? "?"}ms${endsShort ? ` · ${mv.hold ? camWarn : endsShort}` : ""}`);
    toggleClass(chipCams, "chip--warn", endsNow === "mismatch");
    setAttr(chipCams, "role", endsNow === "mismatch" ? "button" : null);
    setAttr(chipCams, "tabindex", endsNow === "mismatch" ? "0" : null);
    setAttr(chipCams, "aria-label", endsNow === "mismatch" ? L("끝 색 반대? · 설정 열기", "Ends swapped? · open Settings") : null);
    setHidden(endWarnNote, endsNow !== "mismatch");
    setText(endWarnNote, mv.hold ? END_WARN_HOLD : END_WARN);
    setHidden(camsNote, !camsText);
    setText(camsNote, camsText);
    toggleClass(chipLink, "chip--warn", tv.ws !== "none" && (tv.ws === "offline" || !!tv.needPick || !tv.connected));
    toggleClass(chipLink, "chip--lock", tv.ws !== "offline" && !!tv.connected && !tv.needPick);
    setText(introLink.lastChild, L(`카메라 · ${linkText}`, `Camera · ${linkText}`));
    setHidden(tourForm, !!tv.connected);
    setHidden(tourLinked, !tv.connected);
    const sig = JSON.stringify([tv.matchId, tv.matches.map((m) => [m.id, m.no, m.names])]);
    if (sig !== tourSig) {
      tourSig = sig;
      tourMatch.replaceChildren(...(tv.matches.length
        ? tv.matches.map((m) => el("option", { value: m.id, selected: m.id === tv.matchId }, L(`${m.no}경기 · ${m.names[0]} vs ${m.names[1]}`, `Match ${m.no} · ${m.names[0]} vs ${m.names[1]}`)))
        : [el("option", { value: "" }, L("칠 경기가 없어요", "No match to play"))]));
      if (tv.matches.length && !tv.matchId) tourMatch.prepend(el("option", { value: "", selected: true, disabled: true }, L("어느 경기를 찍나요?", "Which match are you filming?")));
    }
    setSeg(L("카메라 앞쪽", "Near end"), tv.near);
    if (calibNear !== tv.near) {
      calibNear = tv.near === 1 ? 1 : 0;
      updateCalibGuide();
    }
    // 끝 색: where blue and red are in this picture; with two cameras, whether the colours agree
    const words = state.calibration?.corners ? endsWords(state.calibration.corners, tv.near) : "";
    // one camera: its own chip; with two the row keeps the other camera's chip only (the landscape row has
    // no room for both), and the picked colours stay on the end lines and in settings
    const endText = (state.multi?.count || 0) >= 2 ? "" : words;
    const lonelyHold = (state.multi?.count || 0) < 2 && !!state.multi?.hold;
    setHidden(chipEnds, !(endText || lonelyHold) || state.mode !== "running");
    setText(chipEnds, lonelyHold ? HOLD_REASON : endText);
    toggleClass(chipEnds, "chip--warn", lonelyHold);
    setAttr(chipEnds, "role", lonelyHold ? "button" : null);
    setAttr(chipEnds, "tabindex", lonelyHold ? "0" : null);
    setAttr(chipEnds, "aria-label", lonelyHold ? L(`${HOLD_REASON} · 설정 열기`, `${HOLD_REASON} · open settings`) : null);
    if (lonelyHold) setHidden(endWarnNote, false);
    // each end keeps its colour: --c-me / --c-opp are the near / far END colours (blue or red)
    for (const [side, prop] of [["near", "--c-me"], ["far", "--c-opp"]]) {
      const p = state.players?.[side];
      if (!p) continue;
      setText(handPlate[side], p.label);
      setText(courtKey[side], SIDE_NAMES[p.end] || "");
      const c = endColourVar(p.end);
      if (app.style.getPropertyValue(prop) !== c) app.style.setProperty(prop, c);
    }
    setSeg(L("자동 입력", "Auto entry"), tv.mode);
    // 확인 후 입력: the auto-entry choice is not offered, the note says how points go in
    const segEntry = segs[L("자동 입력", "Auto entry")].buttons[0].parentNode;
    setHidden(segEntry, tv.entry === "confirm");
    setHidden(segEntry.previousElementSibling, tv.entry !== "confirm");
    setSeg(L("점수 음성", "Score voice"), tv.voice !== false);
    const tm = tv.match;
    const ends = tv.entry === "confirm" ? L("포인트가 끝나면 카메라 판정을 한 번 눌러 확정해요.", "When a point ends, tap the camera's call once to confirm.") : L("포인트가 끝나면 점수가 자동으로 들어가요.", "Each point is scored automatically.");
    setText(tourStatus, tv.ws === "offline" ? L("대회 연결 끊김 · 다시 연결되면 점수 자동 입력을 이어가요.", "Tournament link lost · auto entry resumes on reconnect.") : tv.error || (tv.connected
      ? (tm ? L(`앞쪽 ${state.players.near.label} · 건너편 ${state.players.far.label}. ${ends}`, `Near ${state.players.near.label} · far ${state.players.far.label}. ${ends}`) : tv.matches.length ? L("점수를 넣을 경기를 골라 주세요.", "Pick the match to score.") : L("칠 경기가 없어요. 다음 대회를 기다려 주세요.", "No match to play. Wait for the next tournament."))
      : tv.notice ? `${tv.notice} · ${NEED_PIN}` : L(`${NEED_PIN}. 대회 PIN을 넣으면 포인트마다 점수가 자동으로 들어가요.`, `${NEED_PIN}. With the tournament PIN, every point is scored automatically.`)));
    const pend = tv.pending;
    const showErr = !pend && tv.connected && tv.errorFresh;
    setHidden(pointbar, !(pend || showErr));
    // the 3 s cancel bar sits right under the top rows (back and chips, the record strip, the live chips),
    // never on them: pinned to the screen top it covered all three on a portrait phone (lead, 2026-10-31)
    if (pend || showErr) {
      const under = Math.max(0, ...[strip, glance, stageChips, btnFit].filter((n) => !n.closest("[hidden]") && n.offsetHeight && getComputedStyle(n).visibility !== "hidden").map((n) => n.getBoundingClientRect().bottom));
      if (fitMode !== "overlay") {
        pointbar.style.top = `${Math.round(under) + 8}px`;
        fitPointbar();
      }
    }
    toggleClass(pointbar, "pointbar--error", !!showErr);
    setHidden(pointCancel, !pend || !!pend.choice);
    setHidden(pointPicks, !(pend && pend.choice));
    const sus = pend && pend.suspect;
    setHidden(pointAsks, !sus);
    setHidden(askLet, !(sus && sus.let));
    setHidden(askFault, !(sus && sus.fault));
    toggleClass(pointbar, "pointbar--choice", !!(pend && (pend.choice || sus)));
    if (pend && pend.choice) {
      // 확인 후 입력: the camera's call is already chosen (marked on its button), one tap enters it
      const pre = pend.pre === 0 || pend.pre === 1 ? pend.pre : null;
      setText(pointText, pend.hold ? `${WHO_WON} ${HOLD_REASON}` : pre != null ? `${WHO_WON} ${CONFIRM_TEXT(SIDE_NAMES[pre], pend.sure)}` : pend.guess === 0 || pend.guess === 1 ? `${WHO_WON} ${L(`카메라 추정 ${SIDE_NAMES[pend.guess]} · 확실하지 않음`, `Camera guess ${SIDE_NAMES[pend.guess]} · not sure`)}` : L(`누가 땄나요? 판정이 확실하지 않아요 (${pend.reason})`, `Who won it? The call isn't sure (${pend.reason})`));
      for (const [btn, side] of [[pickBlue, 0], [pickRed, 1]]) {
        const who = tm ? tm.names[tm.ends[side]] : "";
        const mine = pre === side;
        const label = `${L(`${SIDE_NAMES[side]} 득점`, `Point ${SIDE_NAMES[side]}`)}|${who}|${mine}`;
        if (btn.dataset.label !== label) {
          btn.dataset.label = label;
          btn.replaceChildren(el("span", {}, L(`${SIDE_NAMES[side]} 득점`, `Point ${SIDE_NAMES[side]}`)), ...(tm || mine ? [el("small", {}, mine ? `${CAMERA_CALL}${who ? ` · ${who}` : ""}` : who)] : []));
        }
        toggleClass(btn, "pointbar__pick--pre", mine);
        setAttr(btn, "aria-pressed", pre == null ? null : String(mine));
      }
    } else if (pend) {
      const score = pend.score ? ` ${pend.score[0]}:${pend.score[1]}${pend.gameEnded ? L(" 게임", " game") : ""}` : "";
      setText(pointText, L(`${SIDE_NAMES[pend.end ?? pend.side]} ${pend.name} 득점 · ${pend.reason}${score}`, `Point ${SIDE_NAMES[pend.end ?? pend.side]} ${pend.name} · ${pend.reason}${score}`));
      const left = Math.max(1, Math.ceil((pend.until - Date.now()) / 1000));
      setText(pointCancel, L(`취소 ${left}`, `Cancel ${left}`));
    } else if (showErr) setText(pointText, L(`대회 연결: ${tv.error}`, `Tournament: ${tv.error}`));

    // 점수 고치기 (PIN phone, linked, a match to fix; the camera keeps running under it)
    const fx = tv.fix || {};
    const fixT = fx.target;
    const canFix = !!(fx.can && tv.connected && fixT && (mode === "ready" || mode === "running" || mode === "stopped"));
    if (!canFix && fixOpen) toggleFix(false);
    setHidden(chipFix, !canFix);
    setHidden(fixPanel, !(canFix && fixOpen));
    if (canFix && fixOpen) {
      // portrait phone: the control bar is in the page flow, so sit right on its top edge and
      // cover the stats panels completely (the camera image stays in view above)
      const stack = app.dataset.fit === "stack";
      const b = stack ? `${Math.round(app.getBoundingClientRect().bottom - bar.getBoundingClientRect().top)}px` : "";
      if (fixPanel.style.bottom !== b) fixPanel.style.bottom = b;
      const s = fixT.score || { current: { a: 0, b: 0 }, won: [0, 0] };
      const done = fixT.status === "done";
      // the buttons and chips are in end colours: blue = whoever stands at the blue end now
      const ends = fixT.ends || [0, 1];
      const endOf = (slot) => (ends[0] === slot ? 0 : 1);
      const cur = [s.current.a, s.current.b];
      const over = done ? L(" 끝", " over") : "";
      setText(fixScore, L(`${fixT.no}경기${over} · ${SIDE_NAMES[0]} ${cur[ends[0]]} : ${cur[ends[1]]} ${SIDE_NAMES[1]} · 게임 ${s.won[ends[0]]}:${s.won[ends[1]]}`, `Match ${fixT.no}${over} · ${SIDE_NAMES[0]} ${cur[ends[0]]} : ${cur[ends[1]]} ${SIDE_NAMES[1]} · games ${s.won[ends[0]]}:${s.won[ends[1]]}`));
      const busy = !!fx.busy;
      for (const b of fixPlus) b.disabled = busy || done;
      fixUndo.disabled = busy || !fixT.log.length;
      const n = fixT.log.length;
      const from = Math.max(0, n - 3);
      const sig = JSON.stringify([fixT.id, n, fixT.log.slice(from), busy, fixT.names, ends]);
      if (sig !== fixSig) {
        fixSig = sig;
        const chips = [];
        for (let i = from; i < n; i++) {
          const side = fixT.log[i];
          const end = endOf(side);
          const ago = n - 1 - i;
          const when = ago ? L(`${ago}점 전`, `${ago} ${ago === 1 ? "pt" : "pts"} ago`) : L("방금", "just now");
          chips.push(el("button", {
            class: `btn fix__point fix__point--${end ? "red" : "blue"}`, type: "button", "data-index": String(i), disabled: busy,
            "aria-label": L(`${when} ${SIDE_NAMES[end]} ${fixT.names[side]} 득점, 눌러서 ${SIDE_NAMES[1 - end]} ${fixT.names[1 - side]} 득점으로`, `${when}: Point ${SIDE_NAMES[end]} ${fixT.names[side]}; tap to make it Point ${SIDE_NAMES[1 - end]} ${fixT.names[1 - side]}`),
            onclick: () => H("onTourFix", "flip", i, side),
          }, el("small", {}, when), el("span", {}, `${SIDE_NAMES[end]}→${SIDE_NAMES[1 - end]}`)));
        }
        fixRecent.replaceChildren(...(chips.length ? chips : [el("p", { class: "fix__empty" }, L("아직 들어간 점수가 없어요", "No points yet"))]));
      }
      setText(fixNote, busy ? L("고치는 중… 카메라는 계속 찍어요", "Fixing… the camera keeps filming") : tv.errorFresh ? L(`대회 연결: ${tv.error}`, `Tournament: ${tv.error}`) : L("카메라는 계속 찍어요", "The camera keeps filming"));
    }

    const hudVisible = mode === "ready" || mode === "running" || mode === "stopped";
    if (mode === "calibrating") setText(recText, L("코트 보정", "Calibrate"));
    if (hudVisible) {
      const rally = state.rally || {};
      setText(timeNum, fmtRallyTime(rally.timeMs));
      setText(shotsNum, String(rally.shots ?? 0));
      setText(speedNum, fmtKmh(rally.speedKmh));
      const calibrated = !!state.calibration?.corners;

      // status strip (guideline 23): recording chip + tracking chip + perf
      const liveNow = mode === "running";
      toggleClass(chipRec, "chip--live", liveNow);
      setText(recText, liveNow ? L(`기록 중 ${fmtClock(performance.now() - runStartedAt)}`, `REC ${fmtClock(performance.now() - runStartedAt)}`) : mode === "stopped" ? L("정지됨", "Stopped") : L("준비됨", "Ready"));
      // state.tracking arrives from the engine; until it does, derive it from what is known
      const tracking = TRACKING[state.tracking] ? state.tracking : !calibrated ? "no-calibration" : state.ball?.lock ? "locked" : "searching";
      const track = TRACKING[tracking];
      setHidden(chipTrack, !(liveNow || track.kind === "warn"));
      setText(chipTrack, track.text);
      toggleClass(chipTrack, "chip--lock", track.kind === "lock");
      toggleClass(chipTrack, "chip--warn", track.kind === "warn");
      setHidden(chipSlow, !(liveNow && state.slowPhone));
      setHidden(chipStable, !(liveNow && state.stable?.compact));
      setAttr(app, "data-stable", liveNow && state.stable?.compact ? "1" : "0");
      setHidden(chipColor, !(liveNow && state.colorHint));
      toggleClass(chipFix, "chip--icon", !!(liveNow && state.colorHint));
      // a phone strip fits the colour hint or the PC save chip, not both; settings still shows PC save
      setHidden(chipSave, !!(liveNow && state.colorHint) && narrow.matches);
      // the hint and the PC save chip matter more than the fps readout; a phone strip has no room for it
      const perfOff = !!(liveNow && state.colorHint) || narrow.matches;
      if (state.colorHint) setText(chipColor, state.colorHint);
      const now = performance.now();
      if (state.perf && now - lastPerfAt > 500) {
        lastPerfAt = now;
        setText(chipPerf, `${Math.round(state.perf.fps || 0)}fps ${Math.round(state.perf.ms || 0)}ms`);
        // the fps readout is also the first to go when the strip would run into the button column (the
        // English chips are longer): shown for one measure, kept only if the strip still fits
        if (!perfOff) {
          chipPerf.hidden = false;
          perfCrowded = strip.scrollWidth > strip.clientWidth + 1;
        }
      }
      setHidden(chipPerf, perfOff || perfCrowded);
      // calibration issue (guideline 25): sentence in the banner, 코트 보정 button asks for the tap
      // the sentence shows for a few seconds when it appears, then only the chip and the gold
      // 코트 보정 button keep saying it, so the picture is not covered for the whole rally
      const issue = state.calibrationIssue || null;
      if (issue !== bannerIssue) { bannerIssue = issue; bannerAt = now; }
      setHidden(banner, !issue || now - bannerAt > BANNER_MS);
      if (issue) setText(bannerText, issue);
      toggleClass(btnCalib, "btn--attention", !!issue || track.kind === "warn");

      // players: MOVE shares one scale so the two bars compare; 손목 is the wrist bend in degrees
      const moveMax = Math.max(state.players?.near?.moveM || 0, state.players?.far?.moveM || 0);
      const moveScale = Math.max(MOVE_SCALE_M, Math.ceil(moveMax / MOVE_SCALE_M) * MOVE_SCALE_M);
      for (const side of ["near", "far"]) {
        const p = state.players?.[side] || {};
        const r = playerRows[side];
        setText(r.name, p.label);
        setHidden(r.off, !p.offscreen);
        setText(r.moveNum, fmtMeters(p.moveM));
        setStyleVar(r.moveFill, "--pct", pct((p.moveM || 0) / moveScale));
        setText(r.wristNum, fmtDeg(p.wristDeg));
        setStyleVar(r.wristFill, "--pct", pct((p.wristDeg || 0) / WRIST_SCALE_DEG));
        setText(r.shotNum, fmtKmh(p.shotKmh));
        setStyleVar(r.shotFill, "--pct", pct((p.shotKmh || 0) / SHOT_SCALE_KMH));
      }

      // court map
      const bounces = state.bounces || [];
      const last = bounces[bounces.length - 1];
      const stands = { near: state.players?.near?.stand || null, far: state.players?.far?.stand || null };
      const standSig = ["near", "far"].map((s) => { const st = stands[s]; return st ? `${st.x.toFixed(2)},${st.y.toFixed(2)},${st.stale ? 1 : 0}` : "-"; }).join("/");
      const sig = `${calibrated}|${bounces.length}|${last ? `${last.tx},${last.ty},${last.side}` : ""}|${standSig}`;
      if (sig !== courtSig) {
        courtSig = sig;
        courtSvgWrap.innerHTML = courtSvg(bounces, calibrated, false, stands);
        courtHint.hidden = calibrated;
        for (const s of ["near", "far"]) {
          const st = stands[s];
          setText(standDist[s], st ? (st.behindM >= 0.05 ? `${st.behindM.toFixed(1)}m` : L("옆", "side")) : "");
          toggleClass(standDist[s], "court__dist--stale", !!(st && st.stale));
        }
      }
      setText(courtCount, L(`바운드 ${bounces.length}회`, `${bounces.length} ${bounces.length === 1 ? "bounce" : "bounces"}`));

      // rally-end announcement (guideline 44: one live region, once per rally)
      const active = !!rally.active;
      if (lastRallyActive && !active && mode === "running") {
        const shots = rally.shots ?? 0;
        setText(live, L(`랠리 종료. ${rally.shots ?? 0}샷, 최고 ${fmtKmh(rally.maxSpeedKmh)} km/h`, `Rally over. ${shots} ${shots === 1 ? "shot" : "shots"}, top ${fmtKmh(rally.maxSpeedKmh)} km/h`));
      }
      lastRallyActive = active;

      // control bar
      const running = mode === "running";
      setText(toggleLabel, running ? L("정지", "Stop") : L("카메라 시작", "Start camera"));
      const want = running ? "stop" : "play";
      if (toggleIcon._n !== want) { toggleIcon._n = want; toggleIcon.innerHTML = iconSvg(want); }
      setAttr(btnToggle, "aria-pressed", running ? "true" : "false");
      if (state.players) {
        setSeg(L("앞쪽 라켓 손", "Near hand"), state.players.near?.hand || "R");
        setSeg(L("건너편 라켓 손", "Far hand"), state.players.far?.hand || "R");
      }
      if (state.layoutPref && state.layoutPref !== layoutPref) { layoutPref = state.layoutPref; setSeg(L("화면", "Layout"), layoutPref); }
      setSeg(L("끝 뒤 카메라", "End camera"), state.endOnCubic ? "on" : "off");
      setSeg(L("판정용 영상", "Analysis video"), state.analysisFrom || "screen");
      setSeg(L("판정 안정 모드", "Steady-call mode"), state.stableMode === "off" ? "off" : "auto");
      setSeg(L("다시 보기 오버레이", "Replay overlay"), state.replayOverlay === false ? "off" : "on");
      setSeg(L("공 색", "Ball colour"), state.ballColor === "orange" ? "orange" : "white");
      const save = state.save || {};
      setText(keyStatus, save.keyError || saved.hint);
      setText(privacyNote, saved.kind === "on" ? L("랠리 구간 영상만 PC로 올라가고, 그 밖의 카메라 영상은 폰 밖으로 안 나가요. 속도·거리는 추정치예요.", "Only rally clips go to the PC; other camera video stays on the phone. Speed and distance are estimates.") : L(`${saved.hint} · 영상은 폰 밖으로 나가지 않아요. 속도·거리는 화면 기반 추정치예요.`, `${saved.hint} · Video never leaves the phone. Speed and distance are estimates from the picture.`));
    }

    btnHistory.disabled = sheetOpen;
    syncBackNames();
    placePanels(state, hudVisible);
    {
      const pend = state.tour?.pending;
      const open = !pointbar.hidden;
      if (placePointbar(state, open ? `${pend?.seq ?? ""}|${pend?.choice ? 1 : 0}|${pointbar.className}|${pointText.textContent}` : null) === "over") placePanels(state, hudVisible);
    }
    // overlay canvas
    if (hudVisible || mode === "calibrating") {
      if (!stageW) measureStage();
      ensureOverlaySize();
      let drawn = null;
      if (mode === "calibrating") {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        if (state.calibration?.corners && !calibPts.length) drawn = drawHud(ctx, { ...state, players: null, ball: null, lastShot: null }, videoToScreen);
      } else {
        const stageRect = stage.getBoundingClientRect();
        // labels start under the top rows; a notice while one shows is a box they keep off (it keeps off them)
        const covered = [glance, strip, banner, stageChips, btnFit].filter((n) => !n.closest("[hidden]")).map((n) => n.getBoundingClientRect().bottom - stageRect.top);
        // what is on screen: a replay keeps the control bar in the layout but does not show it (visibility)
        const seen = (n) => !n.closest("[hidden]") && getComputedStyle(n).visibility !== "hidden";
        const barRect = bar.getBoundingClientRect();
        const barOverlapsRight = seen(bar) && barRect.left > stageRect.left + stageRect.width / 2 && barRect.top < stageRect.bottom;
        // labels stay above whatever floats along the bottom edge (fold chip, players, control bar)
        const keepout = [...app.querySelectorAll("[data-keepout]")];
        const low = [dock, players, court, bar, fixPanel, ...keepout].filter((n) => seen(n) && n.offsetHeight)
          .map((n) => n.getBoundingClientRect().top - stageRect.top).filter((y) => y > stageRect.height / 2);
        // panels and buttons over the picture (players, court, bar, fold chip, the 채움 switch, the 3 s
        // cancel / 누가 땄나요 bar while it shows): labels keep off them, and a standing mark under one is left out
        const ids = new Map([[players, "players"], [court, "court"], [bar, "bar"], [dock, "dock"], [btnFit, "fit"], [pointbar, "pointbar"]]);
        const avoid = [players, court, bar, dock, btnFit, pointbar, ...keepout].filter(seen).map((n) => {
          const r = n.getBoundingClientRect();
          return { x: r.left - stageRect.left, y: r.top - stageRect.top, w: r.width, h: r.height, id: ids.get(n) || "replay" };
        }).filter((r) => r.w > 0 && r.x < stageRect.width && r.y < stageRect.height && r.x + r.w > 0 && r.y + r.h > 0);
        if (toastEl.classList.contains("show")) {
          const t = toastEl.getBoundingClientRect();
          avoid.push({ x: t.left - stageRect.left, y: t.top - stageRect.top, w: t.width, h: t.height, id: "toast" });
        }
        // a replay over the whole picture: the bottom row (선수·코트, the replay chips) is one band across it; a
        // standing mark down there is left out (the court map shows where they stand), not drawn beside a button
        if (replay && fitMode === "overlay") {
          const row = [dock, ...keepout].filter((n) => seen(n) && n.offsetHeight).map((n) => n.getBoundingClientRect().top - stageRect.top).filter((y) => y > stageRect.height / 2);
          if (row.length) { const y = Math.min(...row) - 4; avoid.push({ x: 0, y, w: stageRect.width, h: stageRect.height - y, id: "replay" }); }
        }
        drawn = drawHud(ctx, state, videoToScreen, {
          top: Math.max(4, ...covered.filter((b) => b > 0 && b < stageRect.height).map((b) => b + 4)),
          right: barOverlapsRight ? barRect.left - stageRect.left - 4 : Infinity,
          bottom: Math.min(stageRect.height, ...low) - 4,
          avoid,
        });
        markPanelEnds(drawn, state.showEnds !== false);
        lastHud = drawn;
      }
      // QA-observable facts about the last frame: is a LOCK box on screen, which canvas font sizes
      setAttr(overlay, "data-lock", drawn && drawn.lock ? "1" : "0");
      if (drawn) { setAttr(overlay, "data-fonts", drawn.fonts); setAttr(overlay, "data-font", drawn.font); }
      // name tags where they were drawn (CSS px in the overlay), so QA can compare camera and replay
      setAttr(overlay, "data-tags", drawn ? Object.entries(drawn.tags).map(([s, r]) => `${s}:${r.x},${r.y},${r.w},${r.h}`).join("|") : "");
      // end lines: colour, how much is hidden and by what, the table quad, arrow tags and name plates (QA)
      setAttr(overlay, "data-ends", drawn && drawn.ends ? JSON.stringify({ ends: Object.fromEntries(Object.entries(drawn.ends).map(([s, e]) => [s, { color: e.color, covered: e.covered, by: e.by }])), quad: Object.values(drawn.ends)[0]?.quad || null, endTags: drawn.endTags, tags: drawn.tags, bodies: drawn.bodies, stands: drawn.stands, lock: drawn.lock, bracket: drawn.bracket }) : "");
      setAttr(overlay, "data-stands", drawn && drawn.stands ? Object.entries(drawn.stands).map(([s, r]) => `${s}:${r.hidden ? "panel" : r.label}${r.stale ? "~" : ""}`).join("|") : "");
    }

    // history sheet
    if (state.showHistory) {
      openSheet();
      renderHistory(state.history || []);
      const log = (state.stable?.log || []).slice(-3).reverse();
      setHidden(stableNote, !log.length);
      setText(stableNote, log.map((e) => {
        const base = e.basePct != null ? L(`, 처음의 ${e.basePct}%`, `, ${e.basePct}% of start`) : "";
        return L(`${fmtTimeOfDay(e.at)} 판정 안정 모드 → ${e.what} (분석 ${e.fps}fps${base}, 반복 ${e.repeatPct}%)`, `${fmtTimeOfDay(e.at)} steady-call mode → ${e.what} (analysis ${e.fps}fps${base}, repeats ${e.repeatPct}%)`);
      }).join(" · "));
    }
    else closeSheet();
  }

  applyModeVisibility(currentMode);
  measureStage();
  updateCalibGuide();

  return { video, render, videoToScreen, screenToVideo, back, confirmLeave, notice };
}
