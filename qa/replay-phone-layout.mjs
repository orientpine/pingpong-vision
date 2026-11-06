// 다시 보기 on a phone, the way a player opens it: the tournament app's 다시 보기 button opens the full-screen
// replay (tournament app.js openReplay -> this app's replay.html in an iframe) over a saved clip with its
// overlay track. For every screen shape it records where the replay starts playing, then pauses on two
// moments (just after the serve, and the end, as in a phone capture) and measures the layout: the picture's box
// against the screen, boxes that overlap (panels, chips, buttons, and every text or meter inside them),
// text cut off, and panels over the picture. Writes <tag>-<engine>-<shape>-<moment>.png and <tag>-<engine>.json.
//   bun qa/replay-phone-layout.mjs --vision=<checkout> --tournament=<checkout> --saves=<dir with copied save folders>
//       --id=<save id> --tag=before|after --out=<dir> [--engine=chromium|webkit] [--shapes=land874,land844,port402,port390] [--port=9740]
// --saves holds copies (never the live save folder): each <id>/ has record.json, overlay.json.gz and video.*.
// WebKit here cannot play the phone's H.264, so give it a copy whose video is VP8 webm with the same times.
// Neither engine here has the notch or the home bar, so the host page gets an iPhone 16 Pro safe area as CSS
// (landscape 0/62/21/62, portrait 62/0/34/0 px, top/right/bottom/left): --sa-t/r/b/l on :root, and with
// --legacy-insets=1 (a build whose .replay-full padding reads env() itself) that padding with the same values.
// --blur=1 blurs the picture (CSS filter on the video only, the layout is the same) for captures that go into
// the repository: the clips are club recordings, with people in them.
// The replay page inside the iframe gets the same insets as --safe-t/r/b/l: a phone capture shows iOS hands them
// to the iframe too (its picture is 566 - 62 - 64 - 21 = 419 px wide, and its glance starts 62 + 8 px in).
import { chromium, webkit } from "playwright";
import { cpSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out;
mkdirSync(out, { recursive: true });
const engine = args.engine || "chromium";
const phone = (w, h) => ({ viewport: { width: w, height: h }, deviceScaleFactor: 3, isMobile: engine !== "firefox", hasTouch: true });
// rot874: opened upright, then the phone is turned (the replay was already playing)
const SHAPES = { land874: phone(874, 402), land844: phone(844, 390), port402: phone(402, 874), port390: phone(390, 844), rot874: phone(402, 874) };
const shapes = (args.shapes || "land874,land844,port402,port390").split(",");
const INSETS = { land: [0, 62, 21, 62], port: [62, 0, 34, 0] };
const insetCss = (shape) => {
  const [t, r, b, l] = INSETS[shape.startsWith("land") || shape.startsWith("rot") ? "land" : "port"];
  const vars = `:root{--sa-t:${t}px !important;--sa-r:${r}px !important;--sa-b:${b}px !important;--sa-l:${l}px !important}`;
  const legacy = args["legacy-insets"] === "1" ? `.replay-full{padding:max(8px,${t}px) max(8px,${r}px) max(8px,${b}px) max(8px,${l}px) !important}` : "";
  const blur = args.blur === "1" ? "video{filter:blur(14px)}" : "";
  return { host: vars + legacy + blur, replay: `:root{--safe-t:${t}px !important;--safe-r:${r}px !important;--safe-b:${b}px !important;--safe-l:${l}px !important}${blur}` };
};
const saveDir = join(args.saves, args.id);
const videoName = readdirSync(saveDir).find((n) => n.startsWith("video."));
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: join(saveDir, videoName), port: Number(args.port || 9740) });
cpSync(saveDir, join(app.tmp, "saves", args.id), { recursive: true });
// the last point carries the copied clip (the harness seeded game 2 at 7:5; its last point is index 18)
const st = await app.api("/api/state");
const m = st.derived.matches.find((x) => x.id === app.matchId);
const lastIndex = m.points.length - 1;
await app.api("/api/action", { type: "clip", matchId: app.matchId, index: lastIndex, url: `/vision/s/${args.id}` }, { "x-pin": app.pin });

let browser = null;
const report = { tag: args.tag, engine, id: args.id.slice(0, 6), shapes: {} };

// inside the replay page: the first time playback ran and the first picture it presented
function firstPlay() {
  if (!location.pathname.endsWith("/replay.html")) return;
  window.__qaPlay = { playingAt: null, firstFrame: null };
  document.addEventListener("playing", (e) => { if (window.__qaPlay.playingAt === null) window.__qaPlay.playingAt = e.target.currentTime; }, true);
  const rvfc = HTMLVideoElement.prototype.requestVideoFrameCallback;
  if (rvfc) {
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (cb) {
      return rvfc.call(this, (now, meta) => { if (window.__qaPlay.firstFrame === null) window.__qaPlay.firstFrame = meta.mediaTime; cb(now, meta); });
    };
  }
}

// every box on screen in page px, in both documents (the host's buttons and the replay page inside it)
function measureReplay() {
  const overlayOff = () => document.querySelector(".replay-full__frame").contentDocument.querySelector(".app").getAttribute("data-overlay") !== "on";
  const shown = (e) => {
    if (!e || e.closest("[hidden]")) return false;
    for (let n = e; n; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false; }
    const r = e.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };
  const box = (r, dx = 0, dy = 0) => ({ x: Math.round(r.left + dx), y: Math.round(r.top + dy), w: Math.round(r.width), h: Math.round(r.height) });
  const name = (e) => `${e.tagName.toLowerCase()}.${String(e.className || "").trim().split(/\s+/).slice(0, 2).join(".")}${e.textContent.trim() ? `"${e.textContent.trim().slice(0, 14)}"` : ""}`;
  const frame = document.querySelector(".replay-full__frame");
  const fr = frame.getBoundingClientRect();
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  const v = doc.querySelector("video");
  const vr = v.getBoundingClientRect();
  const k = Math.min(vr.width / v.videoWidth, vr.height / v.videoHeight);
  const picture = { x: Math.round(fr.left + vr.left + (vr.width - v.videoWidth * k) / 2), y: Math.round(fr.top + vr.top + (vr.height - v.videoHeight * k) / 2), w: Math.round(v.videoWidth * k), h: Math.round(v.videoHeight * k) };
  // the biggest picture this screen could show whole (contain in the full viewport)
  const kMax = Math.min(innerWidth / v.videoWidth, innerHeight / v.videoHeight);
  const fullArea = v.videoWidth * kMax * v.videoHeight * kMax;
  const hostButtons = [...document.querySelectorAll(".replay-full button")].filter((b) => shown(b)).map((b) => ({ name: name(b), ...box(b.getBoundingClientRect()) }));
  const app = doc.querySelector(".app");
  const shownIn = (e) => {
    if (!e || e.closest("[hidden]")) return false;
    for (let n = e; n; n = n.parentElement) { const cs = win.getComputedStyle(n); if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false; }
    const r = e.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };
  // the blocks a viewer reads or presses: the three glance panels, both panels, the fold chip, the replay's chips
  const blocks = [...app.querySelectorAll(".panel--glance, .players, .court, .dock, .replay__overlay, .replay__chip, .toast")].filter(shownIn).map((e) => ({ name: name(e), el: e, ...box(e.getBoundingClientRect(), fr.left, fr.top) }));
  // leaves: an element with its own text, or a meter
  const ownText = (e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const leaves = [...app.querySelectorAll(".hud *, .replay__overlay, .replay__overlay *, .replay__chip, .replay__chip *")].filter((e) => shownIn(e) && (ownText(e) || e.classList.contains("meter"))).map((e) => ({ name: name(e), el: e, ...box(e.getBoundingClientRect(), fr.left, fr.top) }));
  const hit = (a, b) => {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 1 && h > 1 ? w * h : 0;
  };
  const overlaps = [];
  const all = [...blocks, ...hostButtons];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j];
    if (a.el && b.el && (a.el.contains(b.el) || b.el.contains(a.el))) continue;
    const area = hit(a, b);
    if (area) overlaps.push(`${a.name} x ${b.name} ${area}px2`);
  }
  // the name, standing and end plates the HUD draws on the canvas (data-ends, overlay CSS px) against the boxes
  const ov = app.querySelector(".stage__overlay");
  const orr = ov.getBoundingClientRect();
  const plates = [];
  try {
    const d = JSON.parse(ov.getAttribute("data-ends") || "null");
    const add = (name, r) => { if (r && r.w && !r.labelHidden && !r.hidden) plates.push({ name, x: Math.round(fr.left + orr.left + r.x), y: Math.round(fr.top + orr.top + r.y), w: Math.round(r.w), h: Math.round(r.h) }); };
    if (d) {
      for (const [s, r] of Object.entries(d.tags || {})) add(`tag ${s}`, r);
      for (const [s, r] of Object.entries(d.stands || {})) add(`stand ${s}`, r);
      for (const [s, r] of Object.entries(d.endTags || {})) add(`end ${s}`, r);
    }
  } catch {}
  if (overlayOff()) plates.length = 0;
  const plateOverlaps = [];
  for (const p of plates) for (const b of all) { const area = hit(p, b); if (area > 4) plateOverlaps.push(`${p.name} x ${b.name} ${area}px2`); }
  // landscape: no plate in the bottom row's band (선수·코트 and the replay chips run across the picture there)
  const rowEls = [...app.querySelectorAll(".dock, .replay__bar .replay__chip")].filter(shownIn).map((e) => e.getBoundingClientRect().top + fr.top);
  if (app.getAttribute("data-fit") === "overlay" && rowEls.length) {
    const rowTop = Math.min(...rowEls);
    for (const p of plates) if (p.y + p.h > rowTop + 1) plateOverlaps.push(`${p.name} in the bottom row band (${p.y + p.h} > ${Math.round(rowTop)})`);
  }
  // the court map's foot: at most two rows, blue at the left edge and red at the right edge
  const foot = app.querySelector(".court__foot");
  if (foot && shownIn(foot)) {
    const fb = foot.getBoundingClientRect();
    const kids = [...foot.children].filter(shownIn).map((k) => k.getBoundingClientRect());
    const rows = new Set(kids.map((k) => Math.round(k.top / 4))).size;
    const me = foot.querySelector(".c-me").getBoundingClientRect(), opp = foot.querySelector(".c-opp").getBoundingClientRect();
    if (rows > 2 || Math.abs(me.left - fb.left) > 2 || Math.abs(opp.right - fb.right) > 2) plateOverlaps.push(`court foot ragged: ${rows} rows, blue left ${Math.round(me.left - fb.left)}, red right ${Math.round(fb.right - opp.right)}`);
  }
  const textOverlaps = [...plateOverlaps];
  for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
    const a = leaves[i], b = leaves[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const area = hit(a, b);
    if (area) textOverlaps.push(`${a.name} x ${b.name} ${area}px2`);
  }
  // cut text: wider than its box, or out of its panel, or out of the screen
  const cut = [];
  for (const l of leaves) {
    const e = l.el;
    // (a 1 px box is a visually hidden label, read by screen readers only)
    if (ownText(e) && e.clientWidth > 2 && e.scrollWidth > e.clientWidth + 1) cut.push(`${l.name} scroll ${e.scrollWidth}>${e.clientWidth}`);
    const panel = e.closest(".panel, .dock, .replay__overlay, .replay__chip");
    if (panel && panel !== e) {
      const p = panel.getBoundingClientRect(), r = e.getBoundingClientRect();
      if (r.left < p.left - 1 || r.right > p.right + 1 || r.top < p.top - 1 || r.bottom > p.bottom + 1) cut.push(`${l.name} out of ${name(panel).slice(0, 24)}`);
    }
    if (l.x < -1 || l.y < -1 || l.x + l.w > innerWidth + 1 || l.y + l.h > innerHeight + 1) cut.push(`${l.name} off screen`);
  }
  for (const b of hostButtons) if (b.x < -1 || b.y < -1 || b.x + b.w > innerWidth + 1 || b.y + b.h > innerHeight + 1) cut.push(`${b.name} off screen`);
  const overPicture = blocks.filter((b) => /players|court/.test(b.name)).map((b) => `${b.name.slice(0, 20)} ${Math.round((100 * hit(b, picture)) / (b.w * b.h))}%`);
  // empty side room: the widest vertical band beside the picture with nothing on it
  const xs = [...all, ...leaves].map((b) => [b.x, b.x + b.w]);
  const freeRight = innerWidth - Math.max(picture.x + picture.w, ...xs.map((q) => q[1]));
  const freeLeft = Math.min(picture.x, ...xs.map((q) => q[0]));
  const small = [...hostButtons, ...blocks.filter((b) => /dock|replay__/.test(b.name))].filter((b) => b.w < 44 || b.h < 44).map((b) => `${b.name} ${b.w}x${b.h}`);
  return {
    viewport: `${innerWidth}x${innerHeight}`, frame: box(fr), picture, pictureShare: Math.round((100 * picture.w * picture.h) / fullArea),
    hostButtons: hostButtons.map((b) => `${b.name} ${b.x},${b.y} ${b.w}x${b.h}`), blocks: blocks.map((b) => `${b.name} ${b.x},${b.y} ${b.w}x${b.h}`),
    overlaps, textOverlaps, cut, overPicture, freeLeft, freeRight, smallTargets: small,
    psize: app.getAttribute("data-psize"), panels: app.getAttribute("data-panels"), mediaT: Number(app.getAttribute("data-media-t")),
  };
}

try {
  browser = engine === "webkit" ? await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {}) : await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  for (const shape of shapes) {
    const ctx = await browser.newContext(SHAPES[shape]);
    await ctx.addInitScript(() => { sessionStorage.setItem("pp-started", "1"); localStorage.setItem("pp-role", "viewer"); localStorage.setItem("pp-sound", "0"); });
    await ctx.addInitScript(firstPlay);
    await ctx.addInitScript((css) => {
      const text = location.pathname.endsWith("/replay.html") ? css.replay : css.host;
      document.addEventListener("DOMContentLoaded", () => { const st = document.createElement("style"); st.dataset.qa = "insets"; st.textContent = text; document.head.append(st); });
    }, insetCss(shape));
    const page = await ctx.newPage();
    await page.goto(app.origin + "/");
    await page.waitForSelector(".pscore, .tv-score");
    await page.evaluate(() => document.fonts.ready);
    // the app redraws on its websocket state, so the button can be replaced under the press: click retries
    await page.locator('[data-act="clip-play"]').first().click();
    const frameEl = await page.waitForSelector(".replay-full__frame", { timeout: 15000 });
    const frame = await frameEl.contentFrame();
    await frame.waitForFunction(() => window.__ppvReplay && window.__ppvReplay.track && document.fonts.status === "loaded", null, { timeout: 20000 });
    await frame.waitForFunction(() => window.__qaPlay && window.__qaPlay.playingAt !== null && window.__ppvReplay.video.currentTime > 0.2, null, { timeout: 20000 });
    if (shape === "rot874") {
      await page.setViewportSize({ width: 874, height: 402 });
      await page.waitForTimeout(800);
    }
    const start = await frame.evaluate(() => ({ ...window.__qaPlay, startMs: window.__ppvReplay.startMs ?? null, err: window.__ppvReplay.video.error && window.__ppvReplay.video.error.code, duration: window.__ppvReplay.video.duration }));
    // where the rally starts in this clip (the first frame with the rally on, less its own elapsed time)
    const rallyMs = await frame.evaluate(() => {
      const { times, states } = window.__ppvReplay.track;
      const i = states.findIndex((s) => s.rally && s.rally.active);
      return i < 0 ? null : Math.max(0, times[i] - (states[i].rally.timeMs || 0));
    });
    const res = { start: { ...start, rallyMs }, moments: {} };
    for (const [moment, at] of [["serve", (rallyMs ?? 0) + 600], ["end", null]]) {
      await frame.evaluate(async (ms) => {
        const v = window.__ppvReplay.video;
        v.pause();
        const t = ms === null ? v.duration - 0.15 : ms / 1000;
        if (Math.abs(v.currentTime - t) > 0.01) { v.currentTime = t; await new Promise((r) => v.addEventListener("seeked", r, { once: true })); }
        // the end: play the last pictures out, so the page shows what it shows when a clip ends (다시 보기)
        if (ms === null) await Promise.race([new Promise((r) => { v.addEventListener("ended", r, { once: true }); v.play().catch(r); }), new Promise((r) => setTimeout(r, 4000))]);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }, at);
      // the panels take their spot over a few frames (ui.js placePanels); let them settle
      await page.waitForTimeout(700);
      if (moment === "end") await page.evaluate(() => document.querySelector(".replay-full")?.replayEnded?.());
      await page.waitForTimeout(200);
      res.moments[moment] = await page.evaluate(measureReplay);
      await page.screenshot({ path: join(out, `${args.tag}-${engine}-${shape}-${moment}.png`) });
    }
    // a panel folded for want of room: press 선수·코트 as a viewer would, and measure the panels it then shows
    if (/off/.test(res.moments.end.psize || "")) {
      await frame.locator(".dock").click();
      await page.waitForTimeout(700);
      res.moments.asked = await page.evaluate(measureReplay);
      await page.screenshot({ path: join(out, `${args.tag}-${engine}-${shape}-asked.png`) });
    }
    report.shapes[shape] = res;
    const s = res.moments.serve, e = res.moments.end;
    console.log(`REPLAY_PHONE ${args.tag} ${engine} ${shape} startAt=${start.playingAt?.toFixed(2)} firstFrame=${start.firstFrame?.toFixed?.(2)} rally=${rallyMs} picture=${s.pictureShare}% overlaps=${s.overlaps.length}/${e.overlaps.length} text=${s.textOverlaps.length}/${e.textOverlaps.length} cut=${s.cut.length}/${e.cut.length} free=${e.freeLeft}|${e.freeRight}${res.moments.asked ? ` asked: psize=${res.moments.asked.psize} overlaps=${res.moments.asked.overlaps.length} text=${res.moments.asked.textOverlaps.length} cut=${res.moments.asked.cut.length}` : ""}`);
    await ctx.close();
  }
} finally {
  await browser?.close().catch(() => {});
  await app.stop();
}
// the bar (PLAN Q1-Q4): nothing overlaps or is cut, every button 44 px, the picture as big as the screen lets it,
// playback from a second before the rally (from 0 when that is under 0.3 s), and 선수·코트 opens what it folded
const fails = [];
for (const [shape, r] of Object.entries(report.shapes)) {
  for (const [moment, m] of Object.entries(r.moments)) {
    for (const k of ["overlaps", "textOverlaps", "cut", "smallTargets"]) if (m[k].length) fails.push(`${shape}/${moment} ${k}: ${m[k].slice(0, 3).join("; ")}`);
    if (moment !== "asked" && m.pictureShare < 95) fails.push(`${shape}/${moment} picture ${m.pictureShare}% of the screen's whole-picture fit`);
    if (moment === "asked" && /off/.test(m.psize || "")) fails.push(`${shape}/asked still folded: ${m.psize}`);
  }
  const want = r.start.rallyMs !== null && r.start.rallyMs - 1000 >= 300 ? r.start.rallyMs - 1000 : 0;
  if (Math.abs(r.start.playingAt * 1000 - want) > 120) fails.push(`${shape} starts at ${Math.round(r.start.playingAt * 1000)} ms, want ${want} (rally ${r.start.rallyMs})`);
}
report.check = fails;
writeFileSync(join(out, `${args.tag}-${engine}.json`), JSON.stringify(report, null, 2));
console.log(`REPLAY_PHONE_CHECK ${args.tag} ${engine} ${fails.length ? "FAIL" : "PASS"} ${fails.length}${fails.length ? `\n  ${fails.join("\n  ")}` : ""}`);
console.log(`REPLAY_PHONE_DONE ${args.tag} ${engine}`);
if (fails.length) process.exitCode = 1;
