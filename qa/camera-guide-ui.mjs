// One small smoke, both phone orientations. All servers/data are isolated by
// startOneApp; its explicit port check refuses another run's servers.
// bun qa/camera-guide-ui.mjs --clip=<webm> --shaky=<webm> --corners=<JSON file>
//   --tournament=<checkout> [--engine=chromium|webkit] [--out=<directory>]
// Korean by default; PPV_LANG=en also checks the English UI.
import { chromium, webkit } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fakeCamera, startOneApp } from "./one-app-harness.mjs";
import { assertPortsFree } from "./ports.mjs";
import { QA_LANG, tx, withLang } from "./qa-lang.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
for (const name of ["clip", "shaky", "corners", "tournament"]) if (!args[name]) throw new TypeError(`Missing --${name}`);
const engine = args.engine || "chromium";
if (!["chromium", "webkit"].includes(engine)) throw new RangeError(`Unknown engine ${engine}`);
const vision = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const out = `${args.out || `${vision}/evidence/camera-guide`}/${engine}-${QA_LANG}`;
const truth = JSON.parse(readFileSync(args.corners, "utf8"));
mkdirSync(out, { recursive: true });
await assertPortsFree({ proxy: 9650, tour: 9651, vision: 9652 });
// Launch first, so an unavailable browser cannot leave app servers behind.
const browser = withLang(await (engine === "webkit"
  ? webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {})
  : chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] })));
const app = await startOneApp({
  vision, tournament: args.tournament,
  clip: args.clip, port: 9650,
  files: { "/__qa/shaky.webm": args.shaky },
}).catch(async (error) => { await browser.close(); throw error; });
const rows = [];
let currentPage = null, currentView = null;
const box = (page) => page.locator(".stage__video").evaluate((v) => {
  const r = v.getBoundingClientRect();
  return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100) / 100);
});
// Boolean properties remove/re-add attributes during the existing calibration flow.
// Attribute order and an absent versus empty class are not calibration behaviour.
// Preserve every class token and other attribute value, without serialisation order.
const calibrationDOM = (page) => page.locator(".calibbar").evaluate((bar) => {
  function snapshot(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    return {
      tag: node.nodeName,
      classes: [...node.classList].sort(),
      attrs: [...node.attributes].filter((a) => a.name !== "class").map((a) => [a.name, a.value]).sort(([a], [b]) => a.localeCompare(b)),
      children: [...node.childNodes].map(snapshot),
    };
  }
  return JSON.stringify(snapshot(bar));
});
async function calibrationMessage(page) {
  await page.waitForFunction(() => document.querySelector(".camera-guide__calibration")?.textContent === document.querySelector(".calibbar__text")?.textContent);
  return page.evaluate(() => {
    const source = document.querySelector(".calibbar__text"), copy = document.querySelector(".camera-guide__calibration");
    const range = document.createRange();
    range.selectNodeContents(copy);
    const rects = [...range.getClientRects()];
    let shown = true;
    for (let p = copy; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.display === "none" || s.visibility !== "visible" || Number(s.opacity) === 0) shown = false;
    }
    const visible = shown && rects.length > 0 && copy.scrollWidth <= copy.clientWidth + 1 && rects.every((r) =>
      r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight &&
      [0.05, 0.5, 0.95].every((f) => {
        const hit = document.elementFromPoint(r.left + r.width * f, r.top + r.height / 2);
        return hit === copy || copy.contains(hit);
      }));
    return { text: copy.textContent, sourceText: source.textContent, visible, corners: document.querySelectorAll(".calib__pt").length, step: document.querySelector(".calibbar__step").textContent };
  });
}
async function taps(page, messages) {
  const points = await page.locator(".stage__video").evaluate((v, pts) => {
    const r = v.getBoundingClientRect(), k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    return pts.map((p) => ({ x: r.x + (r.width - v.videoWidth * k) / 2 + (p.x + 2) * k, y: r.y + (r.height - v.videoHeight * k) / 2 + (p.y + 2) * k }));
  }, truth);
  for (let i = 0; i < points.length; i++) {
    if (messages) messages.push(await calibrationMessage(page));
    await page.touchscreen.tap(points[i].x, points[i].y);
    await page.waitForFunction((n) => document.querySelectorAll(".calib__pt").length === n, i + 1);
  }
}
const confirm = (page) => page.locator(".calibbar__actions button").last().click();
async function measureControls(page) {
  return page.locator(".camera-guide button:visible").evaluateAll((buttons) => buttons.map((b) => {
    const r = b.getBoundingClientRect();
    return { text: b.textContent, width: r.width, height: r.height };
  }));
}
const placement = (page) => page.locator(".camera-guide").evaluate((card) => {
  const r = card.getBoundingClientRect();
  const markers = [...document.querySelectorAll(".calib__pt")].map((p) => p.getBoundingClientRect());
  if (markers.length !== 4) throw new RangeError(`Expected four markers, got ${markers.length}`);
  const table = {
    left: Math.min(...markers.map((p) => p.left)) - 24,
    right: Math.max(...markers.map((p) => p.right)) + 24,
    top: Math.min(...markers.map((p) => p.top)) - 24,
    bottom: Math.max(...markers.map((p) => p.bottom)) + 24,
  };
  const overlapPx2 = Math.max(0, Math.min(r.right, table.right) - Math.max(r.left, table.left))
    * Math.max(0, Math.min(r.bottom, table.bottom) - Math.max(r.top, table.top));
  const lines = [".camera-guide__calibration", ".camera-guide__advice"].reduce((n, selector) => {
    const line = card.querySelector(selector);
    // Ellipsis can produce several Range fragments on the same rendered line.
    return n + Math.ceil(line.getBoundingClientRect().height / parseFloat(getComputedStyle(line).lineHeight));
  }, 0);
  return { step: card.dataset.step, overlapPx2, lines, card: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, table };
});
try {
  for (const [width, height] of [[393, 852], [852, 393]]) {
    const view = `${width}x${height}`;
    currentView = view;
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width, height }, deviceScaleFactor: 1, isMobile: engine !== "webkit", hasTouch: true });
    await context.addInitScript(fakeCamera, app.origin + "/__qa/cam.webm");
    await context.addInitScript((pin) => {
      sessionStorage.setItem("pp-started", "1");
      localStorage.setItem("pp-pin", pin);
      localStorage.setItem("pp-role", "camera");
      // Explicitly unavailable: both sensor-dependent recommendations must remain skippable.
      Object.defineProperty(window, "DeviceOrientationEvent", { value: undefined, configurable: true });
    }, app.pin);
    const page = await context.newPage();
    currentPage = page;
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(app.origin + "/vision/", { waitUntil: "load" });
    await page.getByRole("button", { name: tx(/^카메라 시작/, /^Start camera/) }).click();
    await page.waitForFunction(() => window.__ppv?.state.mode === "calibrating", null, { timeout: 180000 });
    const baseline = await box(page);
    const bar = await calibrationDOM(page);
    if (await page.locator(".camera-guide").count()) throw new Error("guide visible by default");
    await page.screenshot({ path: `${out}/${view}-off.png` });
    await taps(page);
    await confirm(page);
    await page.waitForFunction(() => window.__ppv.state.mode === "running");
    await page.getByRole("button", { name: tx(/^설정$/, /^Settings$/) }).click();
    const setting = page.getByRole("group", { name: tx("카메라 자리 안내", "Camera placement guide"), exact: true });
    await setting.getByRole("button", { name: tx("켜기", "On"), exact: true }).click();
    await page.locator(".popover").getByRole("button", { name: tx("설정 닫기", "Close settings"), exact: true }).click();
    await page.getByRole("button", { name: tx(/^코트 보정$/, /^Calibrate$/) }).click();
    await page.locator('.camera-guide[data-step="1"]').waitFor();
    const guide = page.locator(".camera-guide");
    const next = guide.getByRole("button", { name: tx("다음", "Next"), exact: true });
    const skip = guide.getByRole("button", { name: tx("건너뛰기", "Skip"), exact: true });
    const advance = async (button, step) => {
      const changed = page.locator(`.camera-guide[data-step="${step}"]`).waitFor({ timeout: 5000 });
      await button.click();
      await changed;
    };
    const boxes = [await box(page)];
    const placements = [], tapMessages = [], stepMessages = [];
    const shot = async (step) => {
      if (await guide.getAttribute("data-step") !== String(step)) throw new RangeError(`Not on guide step ${step}`);
      stepMessages.push({ guideStep: step, ...await calibrationMessage(page) });
      placements.push(await placement(page));
      boxes.push(await box(page));
      await page.screenshot({ path: `${out}/${view}-step-${step}.png` });
    };
    if (await page.locator(".calib__pt").count() !== 0) throw new RangeError("Guide walk must start with zero corners");
    await page.screenshot({ path: `${out}/${view}-zero-corners.png` });
    await taps(page, tapMessages);
    await page.waitForFunction(() => document.querySelector(".camera-guide")?.dataset.ok === "true");
    const endMessage = await calibrationMessage(page);
    const fitted = page.waitForFunction((before) => !document.querySelector('[data-act="precise"]').disabled && document.querySelector(".calibbar__text").textContent !== before, endMessage.sourceText, { timeout: 15000 });
    await page.locator('[data-act="precise"]').click();
    await fitted;
    const preciseMessage = await calibrationMessage(page);
    console.log(`CALIBRATION_MESSAGES ${engine} ${view} ${JSON.stringify({ tapMessages, endMessage, preciseMessage })}`);
    await shot(1);
    await advance(next, 2);
    await shot(2);
    if (await next.isDisabled()) throw new Error("missing sensor blocks the angle step");
    await advance(next, 3);
    await page.waitForFunction(() => document.querySelector(".camera-guide")?.dataset.ok === "true");
    await shot(3);
    boxes.push(await box(page));
    await advance(next, 4);
    await page.waitForFunction(() => document.querySelector(".camera-guide")?.dataset.ok === "true", null, { timeout: 20000 });
    await shot(4);
    const idle = await measureControls(page);
    await next.hover();
    const hovered = await measureControls(page);
    await next.focus();
    await page.screenshot({ path: `${out}/${view}-focus.png` });
    await page.evaluate(async (src) => { window.__qaCamVideo.src = src; await window.__qaCamVideo.play(); }, app.origin + "/__qa/shaky.webm");
    await page.waitForFunction(() => document.querySelector(".camera-guide")?.dataset.ok === "false", null, { timeout: 20000 });
    await guide.locator(".camera-guide__advice").filter({ hasText: tx(/흔들려요 ·/, /Shaking ·/) }).waitFor();
    stepMessages.push({ guideStep: 4, ...await calibrationMessage(page) });
    placements.push(await placement(page));
    await page.screenshot({ path: `${out}/${view}-shaky.png` });
    const shaky = await guide.locator(".camera-guide__advice").textContent();
    if (!await next.isDisabled()) throw new Error("shaky picture can advance without skipping");
    await advance(skip, 5);
    await shot(5);
    boxes.push(await box(page));
    await confirm(page);
    await page.waitForFunction(() => window.__ppv.state.mode === "running");
    if (await guide.count()) throw new Error("guide survives confirmation");
    const stable = boxes.every((r) => r.every((n, i) => Math.abs(n - baseline[i]) <= 1));
    const targetSize = idle.every((b) => b.width >= 24 && b.height >= 24);
    const stateStable = JSON.stringify(idle) === JSON.stringify(hovered);
    const persisted = await page.evaluate(() => localStorage.getItem("ppv.cameraGuide") === "true");
    await page.getByRole("button", { name: tx(/^설정$/, /^Settings$/) }).click();
    await setting.getByRole("button", { name: tx("끄기", "Off"), exact: true }).click();
    await page.locator(".popover").getByRole("button", { name: tx("설정 닫기", "Close settings"), exact: true }).click();
    await page.getByRole("button", { name: tx(/^코트 보정$/, /^Calibrate$/) }).click();
    const offBar = await calibrationDOM(page);
    const noGuide = await page.locator(".camera-guide").count() === 0;
    const barSame = offBar === bar;
    const tableClear = placements.every((p) => p.overlapPx2 === 0);
    const twoLines = placements.every((p) => p.lines <= 2);
    const messagesVisible = [...tapMessages, endMessage, preciseMessage, ...stepMessages].every((m) => m.visible && m.text === m.sourceText);
    const tapOrder = tapMessages.length === 4 && tapMessages.every((m, i) => m.corners === i && m.step === `${i + 1}/4`);
    const row = { engine, lang: QA_LANG, view, tapMessages, endMessage, preciseMessage, stepMessages, messagesVisible, tapOrder, placements, tableClear, twoLines, stable, boxes, baseline, targetSize, stateStable, persisted, noGuide, barSame, shaky, errors };
    if (!barSame) row.barDifference = { before: JSON.parse(bar), after: JSON.parse(offBar) };
    row.pass = messagesVisible && tapOrder && tableClear && twoLines && stable && targetSize && stateStable && persisted && noGuide && barSame && errors.length === 0;
    rows.push(row);
    console.log(`CAMERA_GUIDE ${engine} ${QA_LANG} ${view} ${row.pass ? "PASS" : "FAIL"} messages=${messagesVisible} tapOrder=${tapOrder} overlap=${Math.max(...placements.map((p) => p.overlapPx2))} lines=${Math.max(...placements.map((p) => p.lines))} ${JSON.stringify(row)}`);
    await context.close();
  }
} catch (error) {
  console.error(error);
  if (currentPage && !currentPage.isClosed()) await currentPage.screenshot({ path: `${out}/${currentView}-failure.png` });
  console.log(`CAMERA_GUIDE ${engine} ${QA_LANG} ${currentView} FAIL ${String(error)}`);
  rows.push({ pass: false, error: String(error) });
} finally {
  await browser.close();
  await app.stop();
}
writeFileSync(`${out}/results.json`, JSON.stringify(rows, null, 2));
const pass = rows.length === 2 && rows.every((r) => r.pass);
console.log(`CAMERA_GUIDE ${engine} ${QA_LANG} ${pass ? "PASS" : "FAIL"}`);
if (!pass) process.exitCode = 1;
