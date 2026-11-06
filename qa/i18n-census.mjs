// Every screen of the one app (tournament at "/", camera at "/vision/") in one language, at phone
// portrait 393x852, phone landscape 852x393 and TV 1920x1080: a full-page capture of each, and three
// counts measured in the real page with the real pixel font (Chromium decodes the woff2; this host's
// headless WebKit does not):
//   hangul   - Korean characters in visible text, aria-label / placeholder / title / alt, the page title
//              and every canvas fillText/strokeText (HUD). Seeded names are Latin (--lang=en), so every
//              Hangul character is an untranslated string; text inside [lang="ko"] (the 한국어 choice) is
//              the one Korean word an English screen keeps on purpose.
//   clipped  - text cut by its own box or a clipping ancestor (overflow hidden/clip, text-overflow), or
//              pushed past the screen's left or right edge outside a horizontal scroller.
//   overlap  - two visible texts or two controls drawn over each other, or a text hidden under something
//              that is not a fixed/sticky layer, a dialog or the toast (those cover content on purpose).
// Each screen is measured at every scroll step of the page and of open scroll panels.
//   bun qa/i18n-census.mjs --vision=<tree> --tournament=<tree> --clip=<webm> --lang=en|ko --out=<dir> [--port=9320] [--views=phone,land,tv] [--only=<screen,...>]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { CORNERS, fakeCamera, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const lang = args.lang === "en" ? "en" : "ko";
const out = args.out;
mkdirSync(out, { recursive: true });
const VIEWS = {
  phone: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  land: { viewport: { width: 852, height: 393 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  land1280: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tv: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
};
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const views = (args.views || "phone,land,land1280,tv").split(",");
const only = args.only ? new Set(args.only.split(",")) : null;
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9320), ascii: lang === "en" });
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });

// In the page: the three counts for what is on screen now.
function measure() {
  const hit = document.createElement("style");
  hit.textContent = "* { pointer-events: auto !important; }";
  document.head.append(hit);
  try {
  return (() => {
  const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]/;
  const vw = innerWidth, vh = innerHeight;
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
      parts.unshift(e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.classList.length ? "." + [...e.classList].slice(0, 2).join(".") : "") + (e.dataset.act ? `[${e.dataset.act}]` : ""));
    }
    return parts.join(">");
  };
  const shown = (el) => el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? !!el.getClientRects().length;
  const keep = (el) => !el.closest('[lang="ko"]:not(html)');
  const hangul = [];
  const clipped = [];
  const overlap = [];
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || !n.data.trim() || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName) || !shown(el)) continue;
    if (HANGUL.test(n.data) && keep(el)) hangul.push({ where: path(el), text: n.data.trim().slice(0, 80) });
    const range = document.createRange();
    range.selectNodeContents(n);
    // a glyph's content area can be taller than a tight line-height (big score digits): compare the part
    // inside the element's own box, which is where the line is laid out
    const box = el.getBoundingClientRect();
    for (const g of range.getClientRects()) {
      if (g.width <= 1 || g.height <= 1) continue;
      const top = Math.max(g.top, box.top), bottom = Math.min(g.bottom, box.bottom);
      const r = bottom - top > 1 ? new DOMRect(g.left, top, g.width, bottom - top) : g;
      texts.push({ el, r, glyph: g, text: n.data.trim().slice(0, 40) });
    }
  }
  for (const el of document.querySelectorAll("[aria-label],[placeholder],[title],img[alt]")) {
    if (!shown(el) || !keep(el)) continue;
    for (const a of ["aria-label", "placeholder", "title", "alt"]) {
      const v = el.getAttribute(a);
      if (v && HANGUL.test(v)) hangul.push({ where: path(el) + "@" + a, text: v.slice(0, 80) });
    }
  }
  if (HANGUL.test(document.title)) hangul.push({ where: "title", text: document.title });
  for (const t of window.__canvasText ?? []) if (HANGUL.test(t)) hangul.push({ where: "canvas", text: t.slice(0, 80) });

  // the layer a node paints in: a fixed or sticky bar, a dialog, the toast, or the page itself.
  // Things in different layers cover each other on purpose (a bar over scrolled content).
  const MODAL = "dialog, #toast, [role=dialog], .popover, .sheet, .backdrop, .screen";
  // A fixed or sticky bar is its own layer only on a page that scrolls (content passes under it on
  // purpose). On a screen that never scrolls (the camera) everything shares one layer, so a chip row that
  // runs into the button column is an overlap.
  const scrolls = document.scrollingElement.scrollHeight > innerHeight + 1;
  const modalOf = (el) => el.closest(MODAL) ?? document.body;
  // pinned: stays put when the page scrolls (inside a fixed or sticky box, or the page does not scroll)
  // pinned: stays put when its scroller scrolls (inside a fixed or sticky box); content of a page or a
  // panel that scrolls moves, and may pass under a sticky head or a fixed bar on purpose
  const pinned = (el) => {
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.position === "fixed" || cs.position === "sticky") return true;
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && a.scrollHeight > a.clientHeight + 1) return false;
    }
    return !scrolls;
  };
  // two things in the same layer: not a dialog over the page, and not page content passing under a
  // fixed bar. Two pinned things (a chip row and the button column on the camera) are one layer.
  const sameLayer = (a, b) => modalOf(a) === modalOf(b) && pinned(a) === pinned(b);
  const layerOf = (el) => modalOf(el);
  // false when the box is scrolled out of (or cut off by) a scrolling / clipping ancestor: not on screen
  const inView = (el, r) => {
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const b = a.getBoundingClientRect();
      if (cx < b.left || cx > b.right || cy < b.top || cy > b.bottom) return false;
      if (cs.position === "fixed") break;
    }
    return true;
  };
  // clipped: compare each text line box with its clipping ancestors and the screen edges. A line box can
  // be a little taller than a tight line-height (the font's ascent and descent), so a vertical cut counts
  // only when the clipping box's content really overflows it.
  // text kept only for screen readers (a 1 px clipped box) is not drawn: no clipping or overlap to measure
  // only a box that cuts its own content to nothing hides text: a zero-height wrapper around a fixed
  // screen (the camera app's) does not
  const srOnly = (el) => { for (let a = el; a && a !== document.body; a = a.parentElement) { const b = a.getBoundingClientRect(); const cs = getComputedStyle(a); const cuts = cs.overflow !== "visible" || cs.clip !== "auto"; if (cs.clip === "rect(0px, 0px, 0px, 0px)" || (cuts && (b.width <= 1 || b.height <= 1))) return true; } return false; };
  const painted = (a) => { const cs = getComputedStyle(a); return ["VIDEO", "IMG", "CANVAS", "svg"].includes(a.tagName) || cs.backgroundImage !== "none" || !/rgba\([^)]*,\s*0\)|transparent/.test(cs.backgroundColor) || parseFloat(cs.borderTopWidth) > 0; };
  for (let i = texts.length - 1; i >= 0; i--) if (srOnly(texts[i].el)) texts.splice(i, 1);
  // spill: a line sticking out of the nearest box that is drawn (a button, chip, card)
  for (const { el, r, text } of texts) {
    let box = null;
    for (let a = el; a && a !== document.body; a = a.parentElement) { if (painted(a)) { box = a; break; } }
    if (!box) continue;
    const b = box.getBoundingClientRect();
    if (r.left < b.left - 1 || r.right > b.right + 1) clipped.push({ where: path(el), by: path(box), text, axis: "spill" });
  }
  for (const { el, r, text } of texts) {
    let hscroll = false;
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const box = a.getBoundingClientRect();
      const ox = cs.overflowX, oy = cs.overflowY;
      if (ox === "auto" || ox === "scroll") { hscroll = true; }
      if (oy === "auto" || oy === "scroll" || ox === "auto" || ox === "scroll") break;
      const cutX = (ox === "hidden" || ox === "clip") && (r.left < box.left - 1 || r.right > box.right + 1);
      const cutY = (oy === "hidden" || oy === "clip") && a.scrollHeight > a.clientHeight + 1 && (r.top < box.top - 2 || r.bottom > box.bottom + 2);
      if (cutX || cutY) { clipped.push({ where: path(el), by: path(a), text, axis: cutX ? "x" : "y" }); break; }
      if (cs.textOverflow === "ellipsis" && a.scrollWidth > a.clientWidth + 1) { clipped.push({ where: path(el), by: path(a), text, axis: "ellipsis" }); break; }
      if (cs.position === "fixed") break;
    }
    if (!hscroll && (r.left < -1 || r.right > vw + 1)) clipped.push({ where: path(el), by: "screen", text, axis: "x" });
  }

  // a word broken across two lines (a label too long for its button): the word's range has two line boxes
  const seenWord = new Set();
  for (const { el } of texts) {
    if (seenWord.has(el)) continue;
    seenWord.add(el);
    for (const n of el.childNodes) {
      if (n.nodeType !== 3) continue;
      // a break after a hyphen, dash, slash or middle dot is a normal line break, not a cut word
      const re = /[^\s\-\u2013\u2014\/\u00b7]+/g;
      let m;
      while ((m = re.exec(n.data))) {
        // Korean breaks between syllables by design; a cut word is a Latin word split over two lines
        if (m[0].length < 2 || !/[A-Za-z]{2}/.test(m[0])) continue;
        const range = document.createRange();
        range.setStart(n, m.index);
        range.setEnd(n, m.index + m[0].length);
        const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0.5).map((r) => Math.round(r.top)));
        if (lines.size > 1) clipped.push({ where: path(el), by: "line break", text: m[0], axis: "word" });
      }
    }
  }
  // overlap: texts and controls that are on screen now
  const onScreen = (r) => r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  const visibleTexts = [];
  for (const t of texts) {
    if (!onScreen(t.r) || !inView(t.el, t.r)) continue;
    const cx = Math.min(vw - 1, Math.max(0, t.r.left + t.r.width / 2)), cy = Math.min(vh - 1, Math.max(0, t.r.top + t.r.height / 2));
    const top = document.elementFromPoint(cx, cy);
    if (!top || top === t.el || t.el.contains(top) || top.contains(t.el)) { visibleTexts.push(t); continue; }
    if (!sameLayer(top, t.el)) continue;
    // a transparent layer on top (a tap area, an empty overlay) hides nothing
    if (!painted(top) && !top.textContent.trim()) continue;
    // a label inside a control sits on that control by design
    if (top.closest("button,a,label,[role=button]")?.contains(t.el)) { visibleTexts.push(t); continue; }
    overlap.push({ kind: "covered", where: path(t.el), by: path(top), text: t.text });
  }
  const hit = (a, b, m) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > m && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > m;
  for (let i = 0; i < visibleTexts.length; i++) for (let j = i + 1; j < visibleTexts.length; j++) {
    const a = visibleTexts[i], b = visibleTexts[j];
    if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el) || !sameLayer(a.el, b.el)) continue;
    if (hit(a.r, b.r, 1)) overlap.push({ kind: "text", where: path(a.el), with: path(b.el), text: `${a.text} | ${b.text}` });
  }
  const controls = [...document.querySelectorAll("button,a[href],input,select,textarea,[role=button]")].filter((e) => shown(e) && !e.disabled && onScreen(e.getBoundingClientRect()) && inView(e, e.getBoundingClientRect()));
  // a text (in a chip, a panel, or bare) running into a control it is not part of
  for (const tx of visibleTexts) for (const c of controls) {
    if (c.contains(tx.el) || tx.el.contains(c) || !sameLayer(c, tx.el)) continue;
    if (hit(tx.r, c.getBoundingClientRect(), 1)) overlap.push({ kind: "text-control", where: path(tx.el), with: path(c), text: tx.text });
  }
  for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
    const a = controls[i], b = controls[j];
    if (a.contains(b) || b.contains(a) || !sameLayer(a, b)) continue;
    if (hit(a.getBoundingClientRect(), b.getBoundingClientRect(), 1)) overlap.push({ kind: "control", where: path(a), with: path(b) });
  }
  // a panel over the calibrated table (owner rule: no table of numbers on the table): the four corners
  // in video px mapped to the screen the way the picture is fitted, against every panel on the picture
  const cal = window.__ppv?.state?.calibration?.corners;
  const video = document.querySelector(".stage__video");
  if (cal && cal.length === 4 && video && video.videoWidth) {
    const vr = video.getBoundingClientRect();
    const cover = video.closest("[data-video-fit]")?.getAttribute("data-video-fit") === "cover";
    const k = (cover ? Math.max : Math.min)(vr.width / video.videoWidth, vr.height / video.videoHeight);
    const ox = vr.left + (vr.width - video.videoWidth * k) / 2, oy = vr.top + (vr.height - video.videoHeight * k) / 2;
    const quad = cal.map((p) => ({ x: ox + p.x * k, y: oy + p.y * k }));
    const inside = (x, y) => { let c = false; for (let i = 0, j = 3; i < 4; j = i++) { const a = quad[i], b = quad[j]; if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c; } return c; };
    for (const panel of document.querySelectorAll(".panel")) {
      if (!shown(panel)) continue;
      const r = panel.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      // share of a 12 x 12 grid of points in the panel that fall on the table top
      let hits = 0;
      for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) if (inside(r.left + ((i + 0.5) * r.width) / 12, r.top + ((j + 0.5) * r.height) / 12)) hits++;
      if (hits) overlap.push({ kind: "panel-table", where: path(panel), text: `${hits}/144 of the panel on the table` });
    }
  }
  return { hangul, clipped, overlap };
  })();
  } finally {
    hit.remove();
  }
}

// Measure at each scroll step of the page and of every scrollable panel; keep each finding once.
async function measureAll(page) {
  const seen = new Set();
  const all = { hangul: [], clipped: [], overlap: [] };
  const add = (r) => { for (const k of Object.keys(all)) for (const f of r[k]) { const id = k + JSON.stringify(f); if (!seen.has(id)) { seen.add(id); all[k].push(f); } } };
  const panels = await page.evaluate(() => {
    const list = [document.scrollingElement];
    for (const e of document.querySelectorAll("*")) {
      const cs = getComputedStyle(e);
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && e.scrollHeight > e.clientHeight + 4 && e.getClientRects().length) list.push(e);
    }
    window.__panels = list;
    return list.map((e) => Math.ceil(e.scrollHeight / Math.max(1, e.clientHeight * 0.8)));
  });
  for (let p = 0; p < panels.length; p++) {
    for (let s = 0; s < Math.min(panels[p], 12); s++) {
      await page.evaluate(([p, s]) => { const e = window.__panels[p]; e.scrollTop = s * e.clientHeight * 0.8; }, [p, s]);
      await page.waitForTimeout(60);
      add(await page.evaluate(measure));
    }
    await page.evaluate((p) => { window.__panels[p].scrollTop = 0; }, p);
  }
  return all;
}

const fails = [];
const rows = [];
async function context(view, { role = null, pin = false, tab = "match", started = true, camera = false, extra = {} } = {}) {
  const ctx = await browser.newContext({ ...VIEWS[view], ...(VIEWS[view].isMobile ? { userAgent: UA } : {}), serviceWorkers: "block" });
  await ctx.addInitScript(() => {
    window.__canvasText = new Set();
    for (const C of [globalThis.CanvasRenderingContext2D, globalThis.OffscreenCanvasRenderingContext2D]) {
      if (!C) continue;
      for (const m of ["fillText", "strokeText"]) {
        const real = C.prototype[m];
        C.prototype[m] = function (text, ...rest) { window.__canvasText.add(String(text)); return real.call(this, text, ...rest); };
      }
    }
  });
  // every write of the language key, with where it came from (a screen that ends in the wrong language says why)
  await ctx.addInitScript(() => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, val) {
      if (k === "pp-lang" && this === localStorage) {
        const log = JSON.parse(sessionStorage.getItem("__langLog") || "[]");
        log.push({ val, at: location.pathname, stack: String(new Error().stack).split("\n").slice(2, 6).join(" | ") });
        real.call(sessionStorage, "__langLog", JSON.stringify(log));
      }
      return real.call(this, k, val);
    };
  });
  await ctx.addInitScript(({ started }) => { if (started && location.origin !== "null") sessionStorage.setItem("pp-started", "1"); }, { started });
  const kv = { "pp-lang": lang, "pp-tab": tab, ...extra };
  if (role) kv["pp-role"] = role;
  if (pin) kv["pp-pin"] = app.pin;
  await ctx.addInitScript((kv) => { if (!sessionStorage.getItem("__seeded")) { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); sessionStorage.setItem("__seeded", "1"); } }, kv);
  if (camera) await ctx.addInitScript(fakeCamera, app.origin + "/__qa/cam.webm");
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e.message || e).slice(0, 200)));
  return { ctx, page };
}

async function shot(name, view, page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  const file = `${out}/${lang}-${view}-${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  const m = await measureAll(page);
  const htmlLang = await page.evaluate(() => document.documentElement.lang);
  if (process.env.PROBE) console.log("  PROBE-MEASURE " + JSON.stringify(await page.evaluate(measure)).slice(0, 3000));
  if (process.env.PROBE) console.log("  PROBE-ELEMENT " + JSON.stringify(await page.evaluate((sel) => { const t = document.querySelector(sel); const r = t.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { top: top && top.tagName + "." + top.className, checkVis: t.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) }; }, process.env.PROBE)));
  if (process.env.PROBE) console.log("  PROBE " + JSON.stringify(await page.evaluate((sel) => {
    const box = (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; };
    const chain = (e) => { const out = []; for (let a = e; a && a !== document.documentElement; a = a.parentElement) { const cs = getComputedStyle(a); out.push(a.tagName.toLowerCase() + "." + [...a.classList].join(".") + ":" + cs.position + "/" + cs.overflow + "/z" + cs.zIndex); } return out; };
    const t = document.querySelector(sel);
    return { scrolls: document.scrollingElement.scrollHeight + ">" + innerHeight, target: t && { text: t.textContent, box: box(t), chain: chain(t) }, buttons: [...document.querySelectorAll("nav.bar button, .bar button")].map((b) => ({ t: b.textContent.trim(), box: box(b), chain: chain(b).slice(0, 4) })) };
  }, process.env.PROBE)));
  const langLog = await page.evaluate(() => sessionStorage.getItem("__langLog"));
  if (htmlLang !== lang) console.log(`  langLog: ${langLog}`);
  const row = { lang, view, name, file, htmlLang, hangul: m.hangul.length, clipped: m.clipped.length, overlap: m.overlap.length, errors: page.errors.length, detail: m, pageErrors: page.errors };
  rows.push(row);
  const bad = (lang === "en" && row.hangul) || row.clipped || row.overlap || row.errors || htmlLang !== lang;
  if (bad) fails.push(`${lang}-${view}-${name}`);
  console.log(`SCREEN ${lang} ${view} ${name} lang=${htmlLang} hangul=${row.hangul} clipped=${row.clipped} overlap=${row.overlap} errors=${row.errors} ${bad ? "FAIL" : "PASS"}`);
  for (const k of ["hangul", "clipped", "overlap"]) for (const f of m[k].slice(0, 6)) console.log(`  ${k}: ${JSON.stringify(f)}`);
}

const tour = (path = "/") => app.origin + path;
// a real tap on the first match, scrolled to the middle of the screen first (the fixed tab bar and the
// sticky header can sit over a button near the edges)
async function tap(p, sel) {
  const b = p.locator(sel).first();
  await b.evaluate((e) => e.scrollIntoView({ block: "center" }));
  await b.click();
}
// Each screen: how to reach it from a fresh device. The writes it makes (setup form, PIN dialog) never submit.
const SCREENS = {
  start: { open: { started: false }, go: async (p) => { await p.goto(tour()); await p.waitForSelector(".start-go"); } },
  picker: { go: async (p) => { await p.goto(tour("/?role")); await p.waitForSelector(".role-card"); } },
  "pin-dialog": { go: async (p) => { await p.goto(tour("/?role")); await p.locator('.role-card[data-role="camera"]').click(); await p.waitForSelector("dialog[open]"); } },
  "ref-match": { open: { role: "referee", pin: true }, go: async (p) => { await p.goto(tour()); await p.waitForSelector(".pscore"); } },
  "ref-bracket": { open: { role: "referee", pin: true, tab: "bracket" }, go: async (p) => { await p.goto(tour()); await p.waitForSelector(".nav"); } },
  "ref-standings": { open: { role: "referee", pin: true, tab: "standings" }, go: async (p) => { await p.goto(tour()); await p.waitForSelector(".nav"); } },
  "ref-history": { open: { role: "referee", pin: true, tab: "history" }, go: async (p) => { await p.goto(tour()); await p.waitForSelector('[data-act="hist-open"]'); } },
  "ref-history-detail": { open: { role: "referee", pin: true, tab: "history" }, go: async (p) => { await p.goto(tour()); await tap(p, '[data-act="hist-open"]'); await p.waitForSelector(".hist-bar"); } },
  "ref-settings": { open: { role: "referee", pin: true, tab: "settings" }, go: async (p) => { await p.goto(tour()); await p.waitForSelector("#pin-card"); } },
  "ref-setup": { open: { role: "referee", pin: true, tab: "settings" }, go: async (p) => { await p.goto(tour()); await p.locator('[data-act="setup-new"]').click(); await p.locator('[data-ask="1"]').click(); await p.waitForSelector('[data-draft="name"]'); } },
  "ref-mode": { open: { role: "referee", pin: true }, go: async (p) => { await p.goto(tour()); await tap(p, '[data-act="ref-enter"]'); await p.waitForSelector('[data-act="ref-exit"]'); } },
  "viewer-match": { open: { role: "viewer" }, go: async (p) => { await p.goto(tour()); await p.waitForSelector(".pscore, .tv-side"); } },
  "viewer-settings": { open: { role: "viewer", tab: "settings" }, views: ["phone", "land"], go: async (p) => { await p.goto(tour()); await p.waitForSelector("#pin-card"); } },
  "replay": { open: { role: "viewer" }, views: ["phone", "land"], go: async (p) => { await p.goto(tour()); await tap(p, '[data-act="clip-play"]'); await p.waitForTimeout(1500); } },
  "analysis": { open: { role: "referee", pin: true }, go: async (p) => { await p.goto(tour()); await tap(p, '[data-act="an-open"]'); await p.waitForSelector(".analysis"); await p.waitForTimeout(800); } },
  "player": { open: { role: "referee", pin: true, tab: "history" }, go: async (p) => { await p.goto(tour()); await tap(p, '[data-act="pl-open"]'); await p.waitForTimeout(1500); } },
  "desk": { open: { role: "desk", pin: true }, go: async (p) => { await p.goto(tour()); await p.waitForTimeout(1500); } },
  "camera-intro": { open: { role: "camera", pin: true, camera: true }, go: async (p) => { await p.goto(tour("/vision/")); await p.waitForFunction(() => window.__ppv); await p.waitForTimeout(500); } },
  "camera-calibrate": { open: { role: "camera", pin: true, camera: true }, go: async (p) => { await openCamera(p); } },
  "camera-running": { open: { role: "camera", pin: true, camera: true }, go: async (p) => { await openCamera(p); await calibrate(p); await p.waitForTimeout(2500); } },
  "camera-settings": { open: { role: "camera", pin: true, camera: true }, go: async (p) => { await openCamera(p); await calibrate(p); await p.locator(".btn--bar[aria-haspopup=dialog]").click(); await p.waitForSelector(".popover:not([hidden])"); } },
  "camera-history": { open: { role: "camera", pin: true, camera: true }, go: async (p) => { await openCamera(p); await calibrate(p); await p.locator(".bar button").nth(3).click(); await p.waitForTimeout(600); } },
  "share-page": { open: { role: "viewer" }, go: async (p) => { await p.goto(tour(await savedClip())); await p.waitForSelector("main h1"); await p.waitForTimeout(1500); } },
  "replay-page": { open: { role: "viewer" }, go: async (p) => { const clip = (await savedClip()).replace(/^\/vision\//, ""); await p.goto(tour(`/vision/replay.html?clip=${encodeURIComponent(clip)}`)); await p.waitForFunction(() => document.querySelector("video")?.readyState >= 2, null, { timeout: 30000 }); await p.waitForTimeout(1500); } },
};

// the share path (/vision/s/<id>) of the clip the harness saved on a point (tournament.log[match].clips is { index: path })
async function savedClip() {
  const st = await app.api("/api/state");
  const clip = Object.values(st.tournament.log ?? {}).flatMap((e) => Object.values(e.clips ?? {}))[0];
  if (!clip) throw new Error("no saved clip");
  return clip;
}

async function openCamera(p) {
  await p.goto(tour("/vision/"));
  await p.waitForFunction(() => window.__ppv);
  await p.locator(".screen--intro .btn--primary").first().click();
  await p.waitForFunction(() => ["calibrating", "running", "error"].includes(window.__ppv?.state.mode), null, { timeout: 180000 });
}
async function calibrate(p) {
  if (await p.evaluate(() => window.__ppv.state.mode) !== "calibrating") return;
  const vid = await p.evaluate(() => window.__ppv.state.video);
  for (const c of CORNERS) {
    const pt = await p.evaluate(({ x, y }) => {
      const v = document.querySelector("video");
      const r = v.getBoundingClientRect();
      const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
      return { x: r.left + (r.width - v.videoWidth * k) / 2 + x * k, y: r.top + (r.height - v.videoHeight * k) / 2 + y * k };
    }, { x: c.x * (vid.width / 1920), y: c.y * (vid.height / 1080) });
    // a TV context has no touch: a mouse click lands the same corner
    if (await p.evaluate(() => navigator.maxTouchPoints > 0)) await p.touchscreen.tap(pt.x, pt.y); else await p.mouse.click(pt.x, pt.y);
    await p.waitForTimeout(200);
  }
  await p.locator(".calibbar__actions button").last().click();
  await p.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 30000 });
}

try {
  for (const [name, s] of Object.entries(SCREENS)) {
    if (only && !only.has(name)) continue;
    for (const view of views) {
      if (s.views && !s.views.includes(view)) continue;
      const { ctx, page } = await context(view, s.open ?? {});
      try {
        await s.go(page);
        await shot(name, view, page);
      } catch (err) {
        fails.push(`${lang}-${view}-${name}`);
        const toast = await page.evaluate(() => document.getElementById("toast")?.textContent || document.querySelector(".toast, [role=status]")?.textContent || "").catch(() => "");
        console.log(`SCREEN ${lang} ${view} ${name} FAIL step: ${String(err.message || err).split("\n")[0]} toast=${JSON.stringify(toast.slice(0, 120))} pageErrors=${JSON.stringify(page.errors)}`);
        await page.screenshot({ path: `${out}/${lang}-${view}-${name}-stepfail.png` }).catch(() => {});
      }
      await ctx.close();
    }
  }
} finally {
  writeFileSync(`${out}/census-${lang}.json`, JSON.stringify({ lang, rows, fails }, null, 2));
  await browser.close();
  await app.stop();
}
const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
console.log(`I18N_CENSUS lang=${lang} screens=${rows.length} hangul=${sum("hangul")} clipped=${sum("clipped")} overlap=${sum("overlap")} errors=${sum("errors")} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
