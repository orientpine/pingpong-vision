// Advisory setup thresholds: docs/camera-guide-qa.md
// (2026-11-04), steps 1-4. None of these judgements rejects a calibration.
import { L } from "./i18n.js";
import { quadFraction } from "./guards.js";

export function judgePosition(quad, w, h) {
  if (!quad || quad.length !== 4 || !w || !h) return { ok: null, value: null, text: L("네 모서리를 찍으면 자리를 확인해요", "Tap four corners to check position") };
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const value = (d(quad[1], quad[2]) + d(quad[3], quad[0])) / (d(quad[0], quad[1]) + d(quad[2], quad[3]));
  // Same <2 end-on proxy as pipeline.js:endOnView; >=3 is preferred, not camera azimuth.
  return { ok: value >= 2, value, text: value >= 3 ? L("긴 쪽 옆자리예요", "Beside the long side") : value >= 2 ? L("비스듬한 자리예요 · 긴 쪽 옆을 권해요", "Oblique view · prefer the long side") : L("끝 뒤예요 · 긴 쪽 옆으로 옮겨요", "End view · move beside the long side") };
}

export function judgeFraming(quad, w, h) {
  if (!quad || quad.length !== 4 || !w || !h) return { ok: null, value: null, text: L("네 모서리를 대충 찍어 주세요", "Tap the four corners roughly") };
  const value = quadFraction(quad, w, h);
  const inside = quad.every((p) => p.x >= w * 0.02 && p.x <= w * 0.98 && p.y >= h * 0.02 && p.y <= h * 0.98);
  // Evidence step_3_table_frame: 2% margin, 5% warning (guards.js), 6-8% target.
  return { ok: inside && value >= 0.05, value, text: !inside ? L("모서리를 화면 안쪽 2% 이상 남겨요", "Leave at least 2% around every corner") : value < 0.05 ? L("탁구대가 작아요 · 더 가까이 와요", "Table too small · move closer") : L(`탁구대 ${(value * 100).toFixed(1)}% · 권장 6-8%`, `Table ${(value * 100).toFixed(1)}% · aim for 6-8%`) };
}

// Orientation is { pitch, roll } in physical degrees, not a table edge's perspective slope.
export function judgeLevel(orientation) {
  const value = orientation?.roll;
  if (!Number.isFinite(value)) return { ok: null, value: null, text: L("수평을 맞춰 삼각대에 고정해요 · 센서 없음", "Level the phone on a tripod · no sensor") };
  // Evidence step_4_level_shake: target <=3 degrees, warn >5; provisional.
  return { ok: Math.abs(value) <= 3, value, text: Math.abs(value) > 5 ? L(`수평을 맞춰요 · ${value.toFixed(1)}°`, `Level the phone · ${value.toFixed(1)}°`) : L(`기울기 ${value.toFixed(1)}° · 목표 ±3°`, `Roll ${value.toFixed(1)}° · aim for ±3°`) };
}

export function judgeAngle(orientation) {
  const value = orientation?.pitch;
  if (!Number.isFinite(value)) return { ok: null, value: null, text: L("높이 1.4-1.8m · 아래로 10-25° (시작 권장)", "Height 1.4-1.8m · aim down 10-25° (starting range)") };
  // Evidence step_2_height_angle: physical pitch is provisional, not homography angle.
  return { ok: value >= 10 && value <= 25, value, text: L(`높이 1.4-1.8m · 아래로 ${value.toFixed(1)}° · 권장 10-25°`, `Height 1.4-1.8m · down ${value.toFixed(1)}° · aim for 10-25°`) };
}

// Samples are consecutive-frame translation magnitudes, normalized to 960px frame width.
export function judgeShake(samples) {
  if (!samples.length) return { ok: null, value: null, text: L("1초 동안 흔들림을 재요", "Measuring shake for one second") };
  const sorted = [...samples].sort((a, b) => a - b);
  const value = sorted[Math.max(0, Math.ceil(sorted.length * 0.9) - 1)];
  // Evidence step_4_level_shake: p90 <=1px target, >2px warning, at 960px width.
  return { ok: value <= 1, value, text: value > 2 ? L(`흔들려요 · ${value.toFixed(1)}px · 삼각대를 고정해요`, `Shaking · ${value.toFixed(1)}px · secure the tripod`) : L(`흔들림 ${value.toFixed(1)}px · 목표 1px 이하`, `Shake ${value.toFixed(1)}px · aim for ≤1px`) };
}

// Projection-profile matching at ~160px width. Four arguments describe one image pair's
// buffer layout (not independent options). Subpixel interpolation keeps the 960px threshold
// meaningful after downscaling; flat frames cannot establish motion and return null.
export function estimateShift(prevGrey, grey, w, h) {
  const shifts = [];
  for (const axis of [0, 1]) {
    const n = axis === 0 ? w : h;
    const a = new Float64Array(n), b = new Float64Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = axis === 0 ? x : y;
      a[i] += prevGrey[y * w + x];
      b[i] += grey[y * w + x];
    }
    const mean = a.reduce((s, v) => s + v, 0) / n;
    if (a.reduce((s, v) => s + (v - mean) ** 2, 0) < 1) return null;
    const costs = [];
    for (let shift = -5; shift <= 5; shift++) {
      let sum = 0;
      for (let i = 6; i < n - 6; i++) sum += (a[i] - b[i + shift]) ** 2;
      costs.push(sum);
    }
    const best = costs.indexOf(Math.min(...costs));
    const mid = costs[best], left = costs[best - 1], right = costs[best + 1];
    const curve = left + right - 2 * mid;
    const sub = Number.isFinite(curve) && curve > 0 ? Math.max(-0.5, Math.min(0.5, (left - right) / (2 * curve))) : 0;
    shifts.push(best - 5 + sub);
  }
  return Math.hypot(...shifts);
}
