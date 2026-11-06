// The start screen's "V x.y.z" comes from package.json through the server, never typed anywhere else.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'pp-version-'));
let base;
const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));
let proc;

beforeAll(async () => {
  proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'server.js')], { env: { ...process.env, PORT: '0', DATA_DIR: dataDir }, stdout: 'pipe', stderr: 'inherit' });
  const reader = proc.stdout.getReader();
  let out = '';
  while (!out.includes('listening')) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`server exited before listening: ${out}`);
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  base = `http://127.0.0.1:${out.match(/:(\d+) \(data:/)[1]}`;
});

afterAll(() => {
  proc?.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

test('the version every screen gets is the one in package.json, and the start screen shows it as V x.y.z', async () => {
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  const state = await (await fetch(`${base}/api/state`)).json();
  expect(state.version).toBe(pkg.version);
  const app = await (await fetch(`${base}/app.js`)).text();
  expect(app).toContain('`V ${S.state.version}`');
  expect(app).not.toContain(`V ${pkg.version}`);
});

test('the start screen draws V x.y.z in whole dots: read back from the drawn cells it is package.json\'s version, none cut', async () => {
  const { VER_DOT, VER_GLYPH, drawVersion } = await import('../public/start.js');
  const dots = [];
  const canvas = { width: 0, height: 0, style: {}, getContext: () => ({ fillStyle: '', fillRect: (x, y, w, h) => dots.push([x, y, w, h]) }) };
  drawVersion(canvas, `V ${pkg.version}`, '#888');
  expect(dots.every(([x, y, w, h]) => w === 1 && h === 1 && x >= 0 && y >= 0 && x < canvas.width && y < canvas.height)).toBe(true);
  expect([canvas.style.width, canvas.style.height]).toEqual([`${canvas.width * VER_DOT}px`, `${canvas.height * VER_DOT}px`]);
  const on = new Set(dots.map(([x, y]) => `${x},${y}`)), col = (x) => [0, 1, 2, 3, 4].map((y) => (on.has(`${x},${y}`) ? '#' : '.'));
  let text = '', run = [], gap = 0;
  const flush = () => {
    if (!run.length) return;
    const rows = [0, 1, 2, 3, 4].map((y) => run.map((c) => c[y]).join(''));
    text += Object.keys(VER_GLYPH).find((k) => VER_GLYPH[k].join() === rows.join()) ?? '?';
    run = [];
  };
  for (let x = 0; x <= canvas.width; x++) {
    const c = x < canvas.width ? col(x) : ['.', '.', '.', '.', '.'];
    if (c.includes('#')) { if (gap > 1) text += ' '; gap = 0; run.push(c); } else { flush(); gap++; }
  }
  expect(text).toBe(`V ${pkg.version}`);
});
