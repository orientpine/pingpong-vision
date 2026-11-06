// The language choice on 모드 고르기 reached the way a phone reaches it (open the address, START), not
// through /?role: choosing English (and back to 한국어) keeps the mode picker with every mode button the
// same plain look, opens no mode and changes no remembered mode. Three devices: a new one, one that
// remembers 카메라 with the PIN (the owner's phone: it used to jump to the camera screen), one that
// remembers 관전 (it used to land on the match screen with 관전 painted in the role bar).
// Phone 393 portrait and 852 landscape; a capture per device, view and language.
//   bun qa/lang-mode.mjs --engine=chromium|webkit --vision=<tree> --tournament=<tree> --clip=<webm> --out=<dir> [--port=9360]
import { chromium, webkit } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const engine = args.engine || "chromium";
const out = `${args.out}/${engine}`;
mkdirSync(out, { recursive: true });
const touch = { deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: "block" };
const VIEWS = { p393: { viewport: { width: 393, height: 852 }, ...touch }, l852: { viewport: { width: 852, height: 393 }, ...touch } };
const DEVICES = { fresh: null, camera: "camera", viewer: "viewer" };
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9360) });
const browser = engine === "webkit" ? await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {}) : await chromium.launch();
const fails = [];
const rows = [];
const check = (name, ok, seen) => { rows.push({ name, ok, seen }); console.log(`${ok ? "PASS" : "FAIL"} ${engine} ${name} ${JSON.stringify(seen)}`); if (!ok) fails.push(name); };

// What the screen shows: the path, the picker's cards (class and paint), a role bar's painted button,
// the page language and the remembered mode.
const read = (page) => page.evaluate(() => {
  const cards = [...document.querySelectorAll(".role-card")].map((c) => { const s = getComputedStyle(c); return { role: c.dataset.role, cls: c.className, bg: s.backgroundColor, border: s.borderTopColor, focus: document.activeElement === c }; });
  return {
    path: location.pathname,
    lang: document.documentElement.lang,
    picker: !!document.querySelector(".role-pick"),
    cards,
    plain: cards.length >= 3 && cards.every((c) => c.bg === cards[0].bg && c.border === cards[0].border && !/\b(on|pressed)\b/.test(c.cls) && !c.focus),
    barOn: [...document.querySelectorAll(".roles button.on, .roles button[aria-pressed='true']")].map((b) => b.dataset.role),
    role: localStorage.getItem("pp-role"),
  };
});

try {
  for (const [vname, view] of Object.entries(VIEWS)) {
    for (const [dname, role] of Object.entries(DEVICES)) {
      const ctx = await browser.newContext(view);
      await ctx.addInitScript(({ role, pin }) => {
        if (sessionStorage.getItem("qa-seeded")) return;
        sessionStorage.setItem("qa-seeded", "1");
        if (role) localStorage.setItem("pp-role", role);
        if (role === "camera") localStorage.setItem("pp-pin", pin);
      }, { role, pin: app.pin });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e.message || e).slice(0, 200)));
      await page.goto(app.origin + "/");
      await page.waitForSelector(".start-go");
      await page.locator(".start-go").tap();
      await page.waitForSelector(".role-card");
      await page.evaluate(() => document.fonts.ready);
      const before = await read(page);
      await page.screenshot({ path: `${out}/${vname}-${dname}-1-ko.png` });
      check(`${vname} ${dname}: START opens the picker, every mode the same`, before.picker && before.plain && before.lang === "ko", before);

      for (const [lang, n] of [["en", 2], ["ko", 3]]) {
        await Promise.all([page.waitForEvent("load"), page.locator(`.role-pick [data-act="lang"][data-lang="${lang}"]`).tap()]);
        // Give a wrong turn (the camera's location.replace, a late render) time to happen before reading.
        await page.waitForTimeout(1500);
        await page.waitForLoadState("load");
        const r = await read(page);
        await page.screenshot({ path: `${out}/${vname}-${dname}-${n}-${lang}.png` });
        check(`${vname} ${dname}: ${lang} keeps the picker, no mode chosen or painted`, r.path === "/" && r.picker && r.plain && r.barOn.length === 0 && r.lang === lang && r.role === role, r);
        // Off the picker there is no language button to press back: the next step has nothing to test.
        if (!r.picker) break;
      }
      check(`${vname} ${dname}: no page error`, errors.length === 0, errors);
      await ctx.close();
    }
  }
} finally {
  writeFileSync(`${out}/report.json`, JSON.stringify({ engine, fails, rows }, null, 1));
  await browser.close();
  await app.stop();
}
console.log(`LANG_MODE_DONE ${engine} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
