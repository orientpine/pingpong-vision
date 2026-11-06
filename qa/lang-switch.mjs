// The language choice on the real one-app (tournament at "/", camera at "/vision/") on a 393x852 phone:
//   1 a new device opens 모드 고르기 in Korean with 한국어 chosen;
//   2 English there switches the page (reload) and survives another reload;
//   3 the tournament 설정 tab shows the same choice and switches back to Korean;
//   4 English again, then 카메라: the camera screen opens in English;
//   5 the camera's settings switch it back to Korean; while recording the switch only says to stop first.
// Each step prints PASS/FAIL with what it read and leaves a capture.
//   bun qa/lang-switch.mjs --vision=<tree> --tournament=<tree> --clip=<webm> --out=<dir> [--port=9340]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { CORNERS, fakeCamera, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out;
mkdirSync(out, { recursive: true });
const HANGUL = /[\uac00-\ud7a3]/;
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9340), ascii: true });
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const steps = [];
const check = (name, ok, seen) => { steps.push({ name, ok, seen }); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(seen)}`); };
try {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  await ctx.addInitScript(() => sessionStorage.setItem("pp-started", "1"));
  await ctx.addInitScript(fakeCamera, app.origin + "/__qa/cam.webm");
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e.message || e).slice(0, 200)));
  const read = () => p.evaluate(() => ({ lang: document.documentElement.lang, stored: localStorage.getItem("pp-lang"), h1: document.querySelector(".role-pick .h1")?.textContent ?? null, on: document.querySelector('.lang-seg [aria-checked="true"]')?.dataset.lang ?? null }));
  const reloadAfter = async (fn) => { await Promise.all([p.waitForEvent("load"), fn()]); await p.waitForLoadState("load"); };

  await p.goto(app.origin + "/?role");
  await p.waitForSelector(".role-card");
  let r = await read();
  await p.screenshot({ path: `${out}/1-picker-ko.png` });
  check("1 new device: picker in Korean, 한국어 chosen", r.lang === "ko" && r.stored === null && r.on === "ko" && HANGUL.test(r.h1 ?? ""), r);

  await reloadAfter(() => p.locator('.role-pick [data-act="lang"][data-lang="en"]').click());
  await p.waitForSelector(".role-card");
  r = await read();
  await p.screenshot({ path: `${out}/2-picker-en.png` });
  check("2a English on the picker: page in English", r.lang === "en" && r.stored === "en" && r.on === "en" && !HANGUL.test(r.h1 ?? "x"), r);
  await p.reload();
  await p.waitForSelector(".role-card");
  r = await read();
  check("2b still English after reload", r.lang === "en" && r.on === "en" && !HANGUL.test(r.h1 ?? "x"), r);

  await p.evaluate((pin) => localStorage.setItem("pp-pin", pin), app.pin);
  await p.locator('.role-card[data-role="referee"]').click();
  await p.waitForSelector(".nav");
  await p.locator('[data-act="tab"][data-tab="settings"]').click();
  await p.waitForSelector('[data-card="lang"]');
  const navEn = await p.locator('[data-act="tab"][data-tab="settings"]').innerText();
  await p.screenshot({ path: `${out}/3a-settings-en.png`, fullPage: true });
  await reloadAfter(() => p.locator('[data-card="lang"] [data-act="lang"][data-lang="ko"]').click());
  await p.waitForSelector('[data-card="lang"]');
  const navKo = await p.locator('[data-act="tab"][data-tab="settings"]').innerText();
  const langKo = await p.evaluate(() => [document.documentElement.lang, localStorage.getItem("pp-lang"), document.querySelector('[data-card="lang"] [aria-checked="true"]')?.dataset.lang]);
  await p.screenshot({ path: `${out}/3b-settings-ko.png`, fullPage: true });
  check("3 settings tab: English shown, switched back to Korean", navEn.trim() === "Settings" && navKo.trim() === "설정" && langKo.join() === "ko,ko,ko", { navEn, navKo, langKo });

  await reloadAfter(() => p.locator('[data-card="lang"] [data-act="lang"][data-lang="en"]').click());
  await p.goto(app.origin + "/?role");
  await p.waitForSelector(".role-card");
  await p.locator('.role-card[data-role="camera"]').click();
  await p.waitForURL(/\/vision\//);
  await p.waitForFunction(() => window.__ppv);
  const cam = await p.evaluate(() => ({ lang: document.documentElement.lang, start: [...document.querySelectorAll("button")].map((b) => b.innerText.trim()).find((t) => /camera/i.test(t)) ?? null, hangul: [...document.querySelectorAll("button, h1, h2, p")].filter((e) => e.getClientRects().length && /[\uac00-\ud7a3]/.test(e.innerText) && !e.closest('[lang="ko"]')).map((e) => e.innerText.slice(0, 40)) }));
  await p.screenshot({ path: `${out}/4-camera-en.png` });
  check("4 camera screen opens in English", cam.lang === "en" && cam.start === "Start camera" && cam.hangul.length === 0, cam);

  await p.locator(".screen--intro .btn--primary").first().click();
  await p.waitForFunction(() => ["calibrating", "running"].includes(window.__ppv?.state.mode), null, { timeout: 180000 });
  const vid = await p.evaluate(() => window.__ppv.state.video);
  for (const c of CORNERS) {
    const pt = await p.evaluate(({ x, y }) => { const v = document.querySelector("video"); const r = v.getBoundingClientRect(); const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight); return { x: r.left + (r.width - v.videoWidth * k) / 2 + x * k, y: r.top + (r.height - v.videoHeight * k) / 2 + y * k }; }, { x: c.x * (vid.width / 1920), y: c.y * (vid.height / 1080) });
    await p.touchscreen.tap(pt.x, pt.y);
    await p.waitForTimeout(200);
  }
  await p.locator(".calibbar__actions button").last().tap();
  await p.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 30000 });
  await p.locator(".btn--bar[aria-haspopup=dialog]").click();
  await p.waitForSelector(".popover:not([hidden])");
  await p.locator('[data-field="lang"] button[lang="ko"]').click();
  await p.waitForTimeout(800);
  const blocked = await p.evaluate(() => ({ lang: document.documentElement.lang, stored: localStorage.getItem("pp-lang"), mode: window.__ppv.state.mode, notice: document.body.innerText.includes("Stop recording to change the language") }));
  await p.screenshot({ path: `${out}/5a-camera-recording-blocked.png` });
  check("5a while recording the switch only asks to stop first", blocked.lang === "en" && blocked.stored === "en" && blocked.mode === "running" && blocked.notice, blocked);

  await p.locator(".btn--bar[aria-haspopup=dialog]").click().catch(() => {});
  await p.getByRole("button", { name: /^Stop$/ }).first().click();
  await p.waitForFunction(() => window.__ppv.state.mode !== "running", null, { timeout: 15000 }).catch(() => {});
  const mode = await p.evaluate(() => window.__ppv.state.mode);
  if (await p.locator(".popover:not([hidden])").count() === 0) await p.locator(".btn--bar[aria-haspopup=dialog]").click();
  await reloadAfter(() => p.locator('[data-field="lang"] button[lang="ko"]').click());
  await p.waitForFunction(() => window.__ppv);
  const back = await p.evaluate(() => ({ lang: document.documentElement.lang, stored: localStorage.getItem("pp-lang"), start: [...document.querySelectorAll("button")].map((b) => b.innerText.trim()).find((t) => t.includes("카메라 시작")) ?? null }));
  await p.screenshot({ path: `${out}/5b-camera-ko.png` });
  check("5b camera settings switch back to Korean (after stop)", back.lang === "ko" && back.stored === "ko" && back.start !== null, { ...back, stoppedMode: mode });
  check("no page errors", errors.length === 0, errors);
  await ctx.close();
} finally {
  writeFileSync(`${out}/lang-switch.json`, JSON.stringify(steps, null, 2));
  await browser.close();
  await app.stop();
}
const pass = steps.length && steps.every((s) => s.ok);
console.log(`LANG_SWITCH ${pass ? "PASS" : "FAIL"} ${steps.filter((s) => s.ok).length}/${steps.length}`);
process.exit(pass ? 0 : 1);
