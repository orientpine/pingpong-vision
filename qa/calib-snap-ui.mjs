// The 정밀하게 button, pressed the way the owner does it: on the real calibration screen with a camera clip
// of a table, tap the four corners roughly (each pushed --rough px off the read corners), press 정밀하게 and
// read where the corners went; press 되돌리기 (back to the taps), press 정밀하게 again (fit again), press 확인
// and compare the stored calibration with what was on screen. Then the two cases that must keep the points:
// corners tapped far off the table (a reason is shown, nothing moves) and, with --shaky, a shaking clip (the
// shake is reported). A tree without the button (main) gets the same four taps and a screenshot only.
//   bun qa/calib-snap-ui.mjs --vision=<tree> --tournament=<tree> --clip=<still webm> [--shaky=<shaking webm>]
//     --corners=<json [{x,y}x4] in clip px> [--engine=chromium|webkit] [--views=393x852,852x393]
//     [--rough=30] [--line=3] [--cm=5.5] [--port=9640] [--out=<dir>] [--tag=after]
// Prints PRECISE <view> ... PASS|FAIL per view and PRECISE_CHECK PASS|FAIL; exits 1 on FAIL.
// WebKit needs a VP8 webm clip (WPE does not decode H.264) and PPV_WEBKIT where the stock build fails.
import { chromium, webkit } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { quadError } from "./calib-error.mjs";
import { fakeCamera, startOneApp } from "./one-app-harness.mjs";
import { tx, withLang } from "./qa-lang.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out || "evidence/calib-snap-ui";
const tag = args.tag || "after";
mkdirSync(out, { recursive: true });
const engine = args.engine || "chromium";
const views = (args.views || "393x852,852x393").split(",").map((v) => v.split("x").map(Number));
const truth = JSON.parse(args.corners);
const rough = Number(args.rough || 30);
// Gate on the sides and the table top, not the corners (result-after redefinition, see calib-error.mjs: the
// first gate was every corner within 3 px; the sharp far corners of a club side view read 5-6 px off with both
// sides on the border). A read side within --line px of the fitted one, the table top within --cm: 5.5 cm
// is how far two readings of the same corners by the same person differ on the table top (gt/second-read.json,
// 6.6 / 5.5 cm at the two tripod spots; lead, 2026-11-05: the gate may not be looser than that).
const lineTol = Number(args.line || 3);
const cmTol = Number(args.cm || 5.5);
// each corner pushed rough px in its own direction (a skewed quad, not a shifted one), fixed so runs repeat
const DIRS = [[0.8, -0.6], [-0.6, 0.8], [0.7, 0.7], [-0.8, -0.6]];
const taps = truth.map((p, i) => ({ x: p.x + DIRS[i][0] * rough, y: p.y + DIRS[i][1] * rough }));
// off the table: the same quad 140 px lower, on the floor under the table (--far-dy), where no fit may be taken
const farTaps = truth.map((p) => ({ x: p.x, y: p.y + Number(args["far-dy"] || 140) }));

// the browser first: a launch that fails (no WebKit build here) must not leave the app servers on the QA ports
const browser = withLang(await (engine === "webkit" ? webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {}) : chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] })));
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9640), files: args.shaky ? { "/__qa/shaky.webm": args.shaky } : {} }).catch(async (e) => { await browser.close(); throw e; });
const rows = [];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const maxDist = (a, b) => Math.max(...a.map((p, i) => dist(p, b[i])));
const r1 = (v) => Math.round(v * 10) / 10;

async function openCalib(w, h, clipUrl) {
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: w, height: h }, deviceScaleFactor: 3, isMobile: engine !== "webkit" ? true : undefined, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1" });
  await ctx.addInitScript(() => { sessionStorage.setItem("pp-started", "1"); });
  await ctx.addInitScript(fakeCamera, clipUrl);
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, { "pp-pin": app.pin, "pp-role": "camera" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e).slice(0, 300)));
  await page.goto(app.origin + "/vision/", { waitUntil: "load" });
  await page.getByRole("button", { name: tx(/카메라 시작/, /Start camera/) }).click();
  await page.waitForFunction(() => ["calibrating", "running", "error"].includes(window.__ppv?.state.mode), null, { timeout: 180000 });
  const mode = await page.evaluate(() => window.__ppv.state.mode);
  if (mode !== "calibrating") throw new Error(`not calibrating: ${mode} ${JSON.stringify(await page.evaluate(() => window.__ppv.state.error))} ${errors.join(" | ")}`);
  return { ctx, page, errors };
}
// clip px <-> page px through the video box (object-fit contain, as qa/calib-taps.mjs)
const toPage = (page, pts) => page.evaluate((pts) => {
  const v = document.querySelector(".stage__video");
  const r = v.getBoundingClientRect();
  const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
  return pts.map(({ x, y }) => ({ x: r.left + (r.width - v.videoWidth * k) / 2 + x * k, y: r.top + (r.height - v.videoHeight * k) / 2 + y * k }));
}, pts);
// the corner markers on screen, in clip px: each marker's anchor is its left/top in the calibration layer
// (its box also holds the corner number, so the box centre is not the corner)
const markers = (page) => page.evaluate(() => {
  const v = document.querySelector(".stage__video");
  const r = v.getBoundingClientRect();
  const lay = document.querySelector(".calib").getBoundingClientRect();
  const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
  return [...document.querySelectorAll(".calib__pt")].map((m) => {
    const px = lay.left + parseFloat(m.style.left);
    const py = lay.top + parseFloat(m.style.top);
    return { x: (px - r.left - (r.width - v.videoWidth * k) / 2) / k, y: (py - r.top - (r.height - v.videoHeight * k) / 2) / k };
  });
});
const guide = (page) => page.evaluate(() => document.querySelector(".calibbar__text")?.textContent || "");
const ghost = (page) => page.evaluate(() => {
  const g = document.querySelector(".calib__ghost");
  return !!g && getComputedStyle(g).display !== "none" && (g.getAttribute("points") || "").trim().split(/\s+/).length === 4;
});
// where the picture sits: a guide message that grew a line moves it, and the taps (stage px) then point
// at other video px (the first run here: a three-line message moved every corner about 20 clip px)
const videoBox = (page) => page.evaluate(() => { const r = document.querySelector(".stage__video").getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(","); });
const precise = (page) => page.locator('.calibbar__actions [data-act="precise"]');
async function tapAll(page, pts) {
  for (const p of await toPage(page, pts)) {
    await page.touchscreen.tap(p.x, p.y);
    await page.waitForTimeout(120);
  }
}
// press 정밀하게 and wait for its answer (the label leaves 맞추는 중), returning how long it took
async function pressPrecise(page) {
  const t0 = Date.now();
  await precise(page).tap();
  await page.waitForFunction(() => {
    const b = document.querySelector('.calibbar__actions [data-act="precise"]');
    return b && !b.disabled && !/맞추는 중|Fitting/.test(b.textContent);
  }, null, { timeout: 15000 });
  return Date.now() - t0;
}
const buttons = (page) => page.evaluate(() => [...document.querySelectorAll(".calibbar__actions button")].map((b) => ({ text: b.innerText.replace(/\s+/g, " ").trim(), over: b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1, disabled: b.disabled, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) })));

try {
  for (const [w, h] of views) {
    const view = `${w}x${h}`;
    const shot = (page, name) => page.screenshot({ path: `${out}/${tag}-${engine}-${view}-${name}.png` });
    const row = { engine, view, tag, checks: {}, notes: {} };
    const check = (name, ok, note) => { row.checks[name] = !!ok; if (note !== undefined) row.notes[name] = note; };
    const { ctx, page, errors } = await openCalib(w, h, app.origin + "/__qa/cam.webm");
    await page.waitForTimeout(800);
    const box0 = await videoBox(page);
    const boxes = [];
    await tapAll(page, taps);
    await page.waitForTimeout(300);
    const tapped = await markers(page);
    row.notes.tapErrPx = tapped.map((p, i) => r1(dist(p, truth[i])));
    await shot(page, "1-rough");
    const has = (await precise(page).count()) === 1;
    if (tag === "before") {
      // main: the snap ran on its own after the 4th tap; how far it put the corners from the read ones
      await page.waitForTimeout(2500);
      const now = await markers(page);
      row.notes.afterAutoSnapErrPx = now.map((p, i) => r1(dist(p, truth[i])));
      row.notes.guide = await guide(page);
      row.notes.preciseButton = has;
      await shot(page, "2-auto");
      // the same off-table taps and shaking clip as after, to show what main says there
      for (const [name, url, pts] of [["far", "/__qa/cam.webm", farTaps], ...(args.shaky ? [["shaky", "/__qa/shaky.webm", taps]] : [])]) {
        const o = await openCalib(w, h, app.origin + url);
        await o.page.waitForTimeout(800);
        await tapAll(o.page, pts);
        await o.page.waitForTimeout(2500);
        row.notes[`${name}Guide`] = await guide(o.page);
        row.notes[`${name}ErrPx`] = (await markers(o.page)).map((p, i) => r1(dist(p, truth[i])));
        await shot(o.page, `5-${name}`);
        errors.push(...o.errors);
        await o.ctx.close();
      }
      row.pass = !errors.length;
      row.notes.errors = errors;
      rows.push(row);
      await ctx.close();
      console.log(`PRECISE ${engine} ${view} before: button=${has} autoSnapErr=${JSON.stringify(row.notes.afterAutoSnapErrPx)} guide="${row.notes.guide}"`);
      continue;
    }
    check("button", has);
    const btns = await buttons(page);
    row.notes.buttons = btns;
    check("buttonsFit", btns.length === 5 && btns.every((b) => !b.over), btns.map((b) => b.text + (b.over ? "!OVER" : "")).join("|"));
    // every 정밀하게 message at its longest fits the guide's two lines here (a third line moves the picture)
    const lines = await page.evaluate(async () => {
      const { CALIB_SNAP_SAMPLES } = await import("/vision/js/ui.js");
      const t = document.querySelector(".calibbar__text");
      const keep = t.textContent;
      const lh = parseFloat(getComputedStyle(t).lineHeight);
      const res = CALIB_SNAP_SAMPLES().map((m) => { t.textContent = m; return { m, lines: Math.round(t.getBoundingClientRect().height / lh) }; });
      t.textContent = keep;
      return res;
    });
    const long = lines.filter((l) => l.lines > 2);
    check("messagesTwoLines", lines.length >= 11 && !long.length, long.map((l) => `${l.lines}:${l.m}`).join(" / ") || `${lines.length} ok`);
    // nothing moves the corners after the 4th tap; a tap lands within 1.5 CSS px of where it was sent (WPE
    // WebKit's touch points landed up to 1.13 CSS px off, 2.9 clip px on a 393 px portrait phone; Chromium 0.5)
    const clipPerCss = await page.evaluate(() => { const v = document.querySelector(".stage__video"); const r = v.getBoundingClientRect(); return 1 / Math.min(r.width / v.videoWidth, r.height / v.videoHeight); });
    check("tapsStayAfter4th", maxDist(tapped, await markers(page)) < 0.5 && maxDist(tapped, taps) <= 1.5 * clipPerCss, `${r1(maxDist(tapped, taps))} <= ${r1(1.5 * clipPerCss)}`);
    // 1. press 정밀하게
    row.notes.ms = await pressPrecise(page);
    const fitted = await markers(page);
    row.notes.fitErrPx = fitted.map((p, i) => r1(dist(p, truth[i])));
    row.notes.guideFitted = await guide(page);
    boxes.push(await videoBox(page));
    const qe = quadError(fitted, truth);
    row.notes.fitLineMaxPx = r1(qe.lineMaxPx);
    row.notes.fitTableMaxCm = r1(qe.tableMaxCm);
    check("fitOnBorder", qe.lineMaxPx <= lineTol && qe.tableMaxCm <= cmTol, `${r1(qe.lineMaxPx)} px / ${r1(qe.tableMaxCm)} cm`);
    check("ghostShown", await ghost(page));
    check("fitSaysMoved", /맞췄어요|Fitted/.test(row.notes.guideFitted), row.notes.guideFitted);
    await shot(page, "2-fitted");
    // 2. 되돌리기
    const undoLabel = await page.locator(".calibbar__actions button").first().innerText();
    check("undoIsRevert", /되돌리기|Revert/.test(undoLabel), undoLabel.trim());
    await page.locator(".calibbar__actions button").first().tap();
    await page.waitForTimeout(200);
    const reverted = await markers(page);
    boxes.push(await videoBox(page));
    check("revertToTaps", reverted.length === 4 && maxDist(reverted, tapped) < 0.5, r1(maxDist(reverted, tapped)));
    check("ghostGoneAfterRevert", !(await ghost(page)));
    await shot(page, "3-reverted");
    // 3. 다시 하기 (press again)
    await pressPrecise(page);
    const again = await markers(page);
    boxes.push(await videoBox(page));
    check("pictureStays", boxes.every((b) => b === box0), [box0, ...boxes].join(" | "));
    const qa = quadError(again, truth);
    check("fitAgain", qa.lineMaxPx <= lineTol && qa.tableMaxCm <= cmTol, `${r1(qa.lineMaxPx)} px / ${r1(qa.tableMaxCm)} cm`);
    // 4. 확인: the stored calibration is what was on screen
    // a loaded PC can hold one tap past the 30 s default (dev7 852x393 at load ~28); the confirm itself is instant
    await page.getByRole("button", { name: tx(/^확인/, /^OK/) }).tap({ timeout: 90000 });
    await page.waitForFunction(() => window.__ppv.state.mode === "running" && !!window.__ppv.state.calibration, null, { timeout: 20000 });
    const stored = await page.evaluate(() => window.__ppv.state.calibration.corners);
    const scale = await page.evaluate(() => { const v = document.querySelector(".stage__video"); return window.__ppv.state.video.width / v.videoWidth; });
    const storedClip = stored.map((p) => ({ x: p.x / scale, y: p.y / scale }));
    check("storedIsShown", maxDist(storedClip, again) <= 1, r1(maxDist(storedClip, again)));
    await shot(page, "4-running");
    await ctx.close();
    // 5. off the table: nothing moves, a reason is shown
    {
      const { ctx, page, errors: e2 } = await openCalib(w, h, app.origin + "/__qa/cam.webm");
      await page.waitForTimeout(800);
      const fbox = await videoBox(page);
      await tapAll(page, farTaps);
      const before = await markers(page);
      await pressPrecise(page);
      const after = await markers(page);
      row.notes.guideFar = await guide(page);
      check("pictureStaysFar", (await videoBox(page)) === fbox);
      check("farKeepsPoints", maxDist(before, after) < 0.5, r1(maxDist(before, after)));
      check("farSaysWhy", /못 찾|멀어|아니에요|같지 않|흔들|No edge|too far|not the table|does not look/.test(row.notes.guideFar), row.notes.guideFar);
      check("farNoGhost", !(await ghost(page)));
      await shot(page, "5-far");
      errors.push(...e2);
      await ctx.close();
    }
    // 6. shaking clip: the shake is reported (fitted with a warning, or kept with the reason)
    if (args.shaky) {
      const { ctx, page, errors: e3 } = await openCalib(w, h, app.origin + "/__qa/shaky.webm");
      await page.waitForTimeout(800);
      const sbox = await videoBox(page);
      await tapAll(page, taps);
      await pressPrecise(page);
      row.notes.guideShaky = await guide(page);
      check("pictureStaysShaky", (await videoBox(page)) === sbox);
      row.notes.shakyErrPx = (await markers(page)).map((p, i) => r1(dist(p, truth[i])));
      check("shakeReported", /흔들|shake/.test(row.notes.guideShaky), row.notes.guideShaky);
      await shot(page, "6-shaky");
      errors.push(...e3);
      await ctx.close();
    }
    check("noPageErrors", !errors.length, errors);
    row.pass = Object.values(row.checks).every(Boolean);
    rows.push(row);
    const failed = Object.entries(row.checks).filter(([, v]) => !v).map(([k]) => k);
    console.log(`PRECISE ${engine} ${view} ${row.pass ? "PASS" : "FAIL"} fit=${JSON.stringify(row.notes.fitErrPx)} line=${row.notes.fitLineMaxPx}px table=${row.notes.fitTableMaxCm}cm ms=${row.notes.ms} guide="${row.notes.guideFitted}" far="${row.notes.guideFar}" shaky="${row.notes.guideShaky || "-"}"${failed.length ? " failed=" + failed.join(",") : ""}`);
  }
} finally {
  writeFileSync(`${out}/${tag}-${engine}-report.json`, JSON.stringify(rows, null, 2));
  await browser.close();
  await app.stop();
}
const pass = rows.length === views.length && rows.every((r) => r.pass);
console.log(`PRECISE_CHECK ${pass ? "PASS" : "FAIL"} ${rows.filter((r) => r.pass).length}/${views.length} ${engine} ${tag}`);
process.exit(pass ? 0 : 1);
