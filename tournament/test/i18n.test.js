import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { scanCss, scanFiles, scanHtml, scanSource, shippedFiles } from '../scripts/i18n-scan.js';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const lines = (r) => r.bad.map((b) => b.line);

test('every Korean string the app ships has its English half (no screen is left in Korean in English mode)', () => {
  const { bad } = scanFiles(root, shippedFiles(root));
  expect(bad.map((b) => `${b.file}:${b.line} ${b.text}`)).toEqual([]);
});

// A local `const L = 34` in player-view.js trendChart hid the text helper, so every player page with a
// trend threw 'L is not a function' and stayed on its loading line.
test('no shipped file binds its own L over the text helper', () => {
  const bad = [];
  for (const f of shippedFiles(root).filter((p) => p.endsWith('.js') && !p.endsWith('/public/i18n.js'))) {
    readFileSync(f, 'utf8').split('\n').forEach((text, i) => {
      if (/\b(?:const|let|var)\s+L\s*=/.test(text)) bad.push(`${f.slice(root.length + 1)}:${i + 1}`);
    });
  }
  expect(bad).toEqual([]);
});

test('the scan covers the screens, the pages and the server', () => {
  const files = shippedFiles(root).map((f) => f.slice(root.length + 1));
  for (const f of ['public/app.js', 'public/index.html', 'public/style.css', 'server.js', 'public/engine.js']) expect(files).toContain(f);
  expect(files.some((f) => f.startsWith('test/'))).toBe(false);
});

test('a plain Korean string, a Korean second half and a Korean name in code are found; a pair and a comment are not', () => {
  const src = [
    "const a = L('경기', 'Match');",
    "const b = '경기';",
    "const c = L('경기', '경기');",
    '// 경기 in a comment',
    "throw new RuleError('없음', 'None');",
    'const d = { 포핸드: 1 };',
    "const e = fail('없음');",
  ].join('\n');
  expect(lines(scanSource(src))).toEqual([2, 3, 6, 7]);
});

test('templates: a pair inside an expression passes, Korean text around it does not', () => {
  const src = [
    'const a = `<b>${L(`${n}명`, `${n} players`)}</b>`;',
    'const b = `<b>${n}명</b>`;',
    'const c = L(`${x ? `켜짐` : `꺼짐`}`, `${x ? "on" : "off"}`);',
    'const d = `${L("켜기", "On")} · ${"끄기"}`;',
  ].join('\n');
  expect(lines(scanSource(src))).toEqual([2, 3, 3, 4]);
});

test('a line marked i18n-data is counted apart, and a Korean regex is not screen text only when marked', () => {
  const r = scanSource(["const KINDS = new Set(['서브']); // i18n-data", 'const re = /[가-힣]/;'].join('\n'));
  expect(r.data.map((d) => d.line)).toEqual([1]);
  expect(lines(r)).toEqual([2]);
});

test('HTML text and CSS content are screen text; HTML comments and CSS comments are not', () => {
  expect(lines(scanHtml('<p>불러오는 중</p>\n<!-- 주석 -->\n<script>const x = L("가", "a");</script>'))).toEqual([1]);
  expect(lines(scanCss('/* 경기 */\n.a::after { content: "경기"; }'))).toEqual([2]);
});
