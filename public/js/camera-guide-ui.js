// Optional calibration overlay. Owns only guidance, sensors and a tiny motion sample;
// it never changes corners, calibration acceptance, recording or the analysis pipeline.
import { L } from "./i18n.js";
import { judgePosition, judgeAngle, judgeFraming, judgeLevel, judgeShake, estimateShift } from "./camera-guide.js";

const TITLES = [L("자리", "Position"), L("각도", "Angle"), L("크기", "Framing"), L("수평·흔들림", "Level & shake"), L("모서리", "Corners")];

// Like ui.js, leave unchanged text nodes intact between press and release.
// Replacing button children every camera frame can cancel WebKit's native click.
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

export function createCameraGuide(app, video) {
  let card = null, step = 0, active = false, input = null, orientation = null;
  let feedback, calibration, advice, title, dots, next, skip, sensor;
  let listening = false, sensorState = "idle", generation = 0;
  let previous = null, samples = [], started = null;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  function receive(e) {
    if (!Number.isFinite(e.beta) || !Number.isFinite(e.gamma)) return;
    const beta = e.beta * Math.PI / 180, gamma = e.gamma * Math.PI / 180;
    const angle = screen.orientation?.angle ?? window.orientation ?? 0;
    const roll = Math.atan2(-Math.cos(beta) * Math.sin(gamma), Math.sin(beta)) * 180 / Math.PI - angle;
    orientation = {
      pitch: Math.asin(Math.cos(beta) * Math.cos(gamma)) * 180 / Math.PI,
      roll: ((roll + 540) % 360) - 180,
    };
    sensorState = "ready";
    paint();
  }
  async function sensors() {
    const api = window.DeviceOrientationEvent;
    if (!api) { sensorState = "unavailable"; paint(); return; }
    // Called only from a guide button's user gesture, as required by iOS.
    try {
      if (api.requestPermission && await api.requestPermission() !== "granted") {
        sensorState = "denied"; paint(); return;
      }
      if (!active) return;
      if (!listening) window.addEventListener("deviceorientation", receive);
      listening = true;
      sensorState = "requested";
      paint();
    } catch (error) {
      if (!(error instanceof DOMException) && !(error instanceof Error)) throw error;
      sensorState = "unavailable";
      paint();
    }
  }
  function judgement() {
    const { quad, w, h } = input;
    switch (step) {
      case 0: return judgePosition(quad, w, h);
      case 1: return judgeAngle(orientation);
      case 2: return judgeFraming(quad, w, h);
      case 3: {
        const level = judgeLevel(orientation);
        const shake = judgeShake(started !== null && performance.now() - started >= 1000 ? samples.map((s) => s.value) : []);
        return { ok: level.ok === false || shake.ok === false ? false : shake.ok, value: shake.value, text: `${level.text} · ${shake.text}` };
      }
      case 4: return { ok: null, value: null, text: L("정밀하게 → 끝 색 확인 → 확인으로 마쳐요", "Precise → check end colours → OK to finish") };
      default: throw new RangeError(`Unknown guide step ${step}`);
    }
  }
  function paint() {
    if (!card || !input) return;
    const result = judgement();
    setText(title, `${step + 1}/5 ${TITLES[step]}`);
    let text = result.text;
    if (step === 0) text = `${L("긴 쪽 옆, 네트 가까이 · 가운데에서 약 3-4m", "Long side, near the net · about 3-4m from centre")} · ${text}`;
    if (step === 2 && input.quad?.length === 4) text += ` · ${judgePosition(input.quad, input.w, input.h).text}`;
    // The calibration's tap order, end colour and fit result always take the first line.
    // Only the placement advice may be shortened by the card's second-line ellipsis.
    setText(calibration, input.cornerText);
    setText(advice, text);
    if (card.dataset.step !== String(step + 1)) card.dataset.step = String(step + 1);
    if (card.dataset.ok !== String(result.ok)) card.dataset.ok = String(result.ok);
    dots.forEach((d, i) => setText(d, i === step ? "●" : "○"));
    const disabled = step === 4 || result.ok === false || ([0, 2, 3].includes(step) && result.ok === null);
    if (next.disabled !== disabled) next.disabled = disabled;
    setText(next, L("다음", "Next"));
    setText(skip, step === 4 ? L("안내 닫기", "Close guide") : L("건너뛰기", "Skip"));
    const hidden = ![1, 3].includes(step) || sensorState !== "idle";
    if (sensor.hidden !== hidden) sensor.hidden = hidden;
    // Only publish stable judgement changes, not frame-by-frame numbers to screen readers.
    const label = `${input.cornerText} · ${text}`;
    if (feedback.getAttribute("aria-label") !== label) feedback.setAttribute("aria-label", label);
  }
  function advance() {
    if (step >= 4) return;
    if (step === 0 && sensorState === "idle") void sensors();
    step++;
    previous = null; samples = []; started = null;
    generation++;
    if (step === 3) sample(generation);
    paint();
  }
  function sample(gen) {
    const tick = () => {
      if (!active || gen !== generation || step !== 3) return;
      if (video.readyState >= 2 && video.videoWidth) {
        const w = 160, h = Math.max(24, Math.round(w * video.videoHeight / video.videoWidth));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; previous = null; }
        ctx.drawImage(video, 0, 0, w, h);
        const rgba = ctx.getImageData(0, 0, w, h).data;
        const grey = new Uint8Array(w * h);
        for (let i = 0; i < grey.length; i++) grey[i] = (rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2]) / 3;
        const now = performance.now();
        if (previous) {
          const shift = estimateShift(previous, grey, w, h);
          if (shift !== null) {
            started ??= now;
            samples.push({ at: now, value: shift * 960 / w });
          }
        }
        samples = samples.filter((s) => now - s.at <= 1000);
        previous = grey;
        paint();
      }
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  }
  function mount() {
    card = document.createElement("section");
    card.className = "camera-guide";
    card.setAttribute("aria-label", L("카메라 자리 안내", "Camera placement guide"));
    title = document.createElement("strong");
    const progress = document.createElement("span");
    progress.className = "camera-guide__dots";
    progress.setAttribute("aria-hidden", "true");
    dots = TITLES.map(() => { const d = document.createElement("span"); progress.append(d); return d; });
    feedback = document.createElement("p");
    feedback.className = "camera-guide__text";
    feedback.tabIndex = 0;
    calibration = document.createElement("span");
    calibration.className = "camera-guide__calibration";
    advice = document.createElement("span");
    advice.className = "camera-guide__advice";
    feedback.append(calibration, advice);
    next = document.createElement("button");
    skip = document.createElement("button");
    sensor = document.createElement("button");
    for (const b of [next, skip, sensor]) { b.type = "button"; b.className = "btn"; }
    next.classList.add("btn--primary");
    sensor.textContent = L("센서 켜기", "Enable sensor");
    sensor.addEventListener("click", sensors);
    next.addEventListener("click", advance);
    skip.addEventListener("click", () => {
      if (step === 4) { dismiss(); return; }
      advance();
    });
    const row = document.createElement("div");
    row.className = "camera-guide__row";
    row.append(title, progress, sensor, next, skip);
    card.append(feedback, row);
    app.append(card);
    paint();
  }
  let dismissed = false;
  function dismiss() {
    dismissed = true;
    cleanup();
  }
  function cleanup() {
    generation++;
    active = false;
    previous = null; samples = []; started = null;
    if (listening) window.removeEventListener("deviceorientation", receive);
    listening = false;
    card?.remove();
    card = null;
  }
  return {
    sync(value) {
      input = value;
      if (!value.enabled || !value.calibrating) {
        if (active) cleanup();
        dismissed = false; step = 0; orientation = null; sensorState = "idle";
        return;
      }
      if (dismissed) return;
      active = true;
      if (!card) mount();
      paint();
    },
  };
}
