// The camera guide card follows the calibration with no app render in between. A paused video file gives
// no render, and the card shown in production 1.1.33 kept "내 쪽 끝선 왼쪽 모서리를 누르세요" after all four
// taps and after 정밀하게. The real page runs in headless Chromium on a synthetic table clip (made here
// with ffmpeg, no recording of people), served by this checkout's server.js on a throwaway port.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
// table top on a 960x540 picture: blue with a 4 px white border on a brown floor, low enough that the
// guide card over the top of a landscape picture leaves its far corners free to tap
const TABLE = { x: 180, y: 220, w: 600, h: 240 };
const CORNERS = [{ x: 180, y: 460 }, { x: 780, y: 460 }, { x: 780, y: 220 }, { x: 180, y: 220 }];
let dir, server, browser, origin;

const freePort = () => new Promise((res) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

beforeAll(async () => {
  dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ppv-guide-sync-"));
  const clip = join(dir, "table.webm");
  const vf = `drawbox=x=${TABLE.x}:y=${TABLE.y}:w=${TABLE.w}:h=${TABLE.h}:color=white:t=fill,drawbox=x=${TABLE.x + 4}:y=${TABLE.y + 4}:w=${TABLE.w - 8}:h=${TABLE.h - 8}:color=0x141e8c:t=fill`;
  const ff = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x967828:s=960x540:d=2:r=30", "-vf", vf, "-c:v", "libvpx", "-b:v", "1M", clip]);
  if (ff.status !== 0) throw new Error(`ffmpeg: ${ff.stderr}`);
  const port = await freePort();
  // every address and folder points into the throwaway dir: nothing reaches a running tournament or saves
  server = spawn("bun", [join(root, "server.js")], { cwd: root, env: { ...process.env, PORT: String(port), PPV_SAVE_DIR: join(dir, "saves"), PPV_KEY_FILE: join(dir, "key"), PPV_SETUP_FILE: join(dir, "setup.json"), PPV_TOURNAMENT_URL: "http://127.0.0.1:9", PPV_TOURNAMENT_DATA: join(dir, "t.json") }, stdio: "ignore" });
  origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch {}
    await Bun.sleep(100);
  }
  browser = await chromium.launch();
  globalThis.__clip = clip;
});

afterAll(async () => {
  await browser?.close();
  server?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("with no render after the taps, the guide card shows each tap instruction, the end colour, the 정밀하게 answer and the position check", async () => {
  const ctx = await browser.newContext({ viewport: { width: 852, height: 393 }, hasTouch: true, serviceWorkers: "block" });
  await ctx.addInitScript(() => { sessionStorage.setItem("pp-started", "1"); localStorage.setItem("ppv.cameraGuide", "true"); });
  const page = await ctx.newPage();
  await page.goto(`${origin}/vision/`, { waitUntil: "load" });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: /영상 파일로 시험/ }).first().click()]);
  await chooser.setFiles(globalThis.__clip);
  await page.waitForFunction(() => window.__ppv?.state.mode === "calibrating", null, { timeout: 120000 });
  await page.locator('.camera-guide[data-step="1"]').waitFor();
  const card = () => page.evaluate(() => ({ line: document.querySelector(".camera-guide__calibration")?.textContent, bar: document.querySelector(".calibbar__text")?.textContent, ok: document.querySelector(".camera-guide")?.dataset.ok }));
  const seen = [];
  for (const c of CORNERS) {
    const pt = await page.evaluate(({ x, y }) => { const v = document.querySelector(".stage__video"); const r = v.getBoundingClientRect(); const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight); return { x: r.left + (r.width - v.videoWidth * s) / 2 + x * s, y: r.top + (r.height - v.videoHeight * s) / 2 + y * s }; }, { x: c.x + 12, y: c.y - 9 });
    await page.touchscreen.tap(pt.x, pt.y);
    seen.push(await card());
  }
  for (const s of seen) expect(s.line).toBe(s.bar);
  expect(seen[0].line).toContain("내 쪽 끝선 오른쪽");
  expect(seen[3].line).toContain("끝이에요");
  expect(seen[3].ok).not.toBe("null");
  await page.locator('[data-act="precise"]').click();
  await page.waitForFunction(() => { const b = document.querySelector('[data-act="precise"]'); return b && !b.disabled && !/맞추는 중/.test(b.textContent); }, null, { timeout: 15000 });
  const after = await card();
  expect(after.line).toBe(after.bar);
  expect(after.line).toMatch(/맞췄어요|찾았어요|아니에요|멀어요|흔들려|읽었어요/);
  await ctx.close();
}, 180000);
