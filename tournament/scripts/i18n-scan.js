// Finds Korean text in shipped source that has no English half. Every Hangul string must be the first
// argument of a pair call - L('한국어', 'English'), new RuleError(ko, en), fail(ko, en) - followed by a
// comma (the English argument). Comments are skipped. A line that holds stored data or a matching rule
// (not screen text) says so with the comment i18n-data; the test lists those lines so they stay visible.
//   bun scripts/i18n-scan.js        prints every offender as file:line text, exit 1 when there is one
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

export const PAIRS = new Set(['L', 'RuleError', 'fail']);
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]/;
const REGEX_AFTER = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await']);
const IDENT = /[A-Za-z_$0-9]/;

// String, template and regex literals with their offsets, and the code spans between them. A template
// is read in pieces (text up to each ${, then from each } on); every piece points at its first piece
// (head), and the last piece is marked closed. Template expressions are code, so a pair inside one is found.
export function tokens(src) {
  const lits = [];
  const code = [];
  const stack = []; // one entry per open ${: braces opened inside it and the template it belongs to
  let i = 0;
  let codeStart = 0;
  const flush = (end) => { if (end > codeStart) code.push([codeStart, end]); };
  const prev = () => {
    let k = i - 1;
    while (k >= 0 && /\s/.test(src[k])) k--;
    if (k < 0) return { ch: null, word: null };
    if (!IDENT.test(src[k])) return { ch: src[k], word: null };
    let s = k;
    while (s > 0 && IDENT.test(src[s - 1])) s--;
    return { ch: src[k], word: src.slice(s, k + 1) };
  };
  const template = (start, head) => {
    let text = '';
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { text += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') {
        i++;
        const piece = { kind: 'template', start, end: i, text, closed: true };
        piece.head = head ?? piece;
        lits.push(piece);
        return;
      }
      if (c === '$' && src[i + 1] === '{') {
        i += 2;
        const piece = { kind: 'template', start, end: i, text, closed: false };
        piece.head = head ?? piece;
        lits.push(piece);
        stack.push({ depth: 0, head: piece.head });
        return;
      }
      text += c;
      i++;
    }
    const piece = { kind: 'template', start, end: i, text, closed: true };
    piece.head = head ?? piece;
    lits.push(piece);
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      flush(i);
      const e = src.indexOf('\n', i);
      i = e < 0 ? src.length : e;
      codeStart = i;
      continue;
    }
    if (c === '/' && n === '*') {
      flush(i);
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? src.length : e + 2;
      codeStart = i;
      continue;
    }
    if (c === "'" || c === '"') {
      flush(i);
      const start = i++;
      let text = '';
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') { text += src[i + 1]; i += 2; } else text += src[i++];
      }
      i++;
      const lit = { kind: 'string', start, end: i, text, closed: true };
      lit.head = lit;
      lits.push(lit);
      codeStart = i;
      continue;
    }
    if (c === '`') {
      flush(i);
      const start = i++;
      template(start, null);
      codeStart = i;
      continue;
    }
    if (c === '}' && stack.length) {
      const top = stack[stack.length - 1];
      if (top.depth === 0) {
        flush(i);
        stack.pop();
        const start = i++;
        template(start, top.head);
        codeStart = i;
        continue;
      }
      top.depth--;
    }
    if (c === '{' && stack.length) stack[stack.length - 1].depth++;
    if (c === '/') {
      const { ch, word } = prev();
      if (ch === null || REGEX_AFTER.has(ch) || (word && REGEX_WORDS.has(word))) {
        flush(i);
        const start = i++;
        let cls = false;
        while (i < src.length && src[i] !== '\n') {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '[') cls = true;
          else if (src[i] === ']') cls = false;
          else if (src[i] === '/' && !cls) break;
          i++;
        }
        i++;
        while (/[a-z]/.test(src[i] ?? '')) i++;
        const lit = { kind: 'regex', start, end: i, text: src.slice(start, i), closed: true };
        lit.head = lit;
        lits.push(lit);
        codeStart = i;
        continue;
      }
    }
    i++;
  }
  flush(src.length);
  return { lits, code };
}

function callOf(src, lit) {
  let k = lit.start - 1;
  while (k >= 0 && /\s/.test(src[k])) k--;
  if (src[k] !== '(') return null;
  k--;
  while (k >= 0 && /\s/.test(src[k])) k--;
  const end = k + 1;
  while (k >= 0 && IDENT.test(src[k])) k--;
  return src.slice(k + 1, end) || null;
}

function commaAfter(src, at) {
  let k = at;
  while (k < src.length && /\s/.test(src[k])) k++;
  return src[k] === ',';
}

export function scanSource(src, file = '<source>') {
  const lines = src.split('\n');
  const lineAt = (at) => src.slice(0, at).split('\n').length;
  const marked = (line) => /i18n-data/.test(lines[line - 1] ?? '');
  const bad = [];
  const data = [];
  const { lits, code } = tokens(src);
  const closing = new Map();
  for (const lit of lits) if (lit.closed) closing.set(lit.head, lit);
  const report = (at) => {
    const line = lineAt(at);
    if (marked(line)) data.push({ file, line });
    else bad.push({ file, line, text: lines[line - 1].trim().slice(0, 160) });
  };
  for (const lit of lits) {
    if (!HANGUL.test(lit.text)) continue;
    const head = lit.head;
    const end = closing.get(head) ?? head;
    const paired = lit.kind !== 'regex' && PAIRS.has(callOf(src, head)) && commaAfter(src, end.end);
    if (!paired) report(lit.start);
  }
  for (const [s, e] of code) {
    const m = HANGUL.exec(src.slice(s, e));
    if (m) report(s + m.index);
  }
  bad.sort((a, b) => a.line - b.line);
  return { bad, data };
}

// HTML: text and attributes outside <script> and comments; inline scripts are scanned as JS.
export function scanHtml(src, file = '<html>') {
  const lines = src.split('\n');
  const lineAt = (at) => src.slice(0, at).split('\n').length;
  const bad = [];
  const data = [];
  const plain = (from, to) => {
    const first = lineAt(from);
    src.slice(from, to).split('\n').forEach((text, k) => {
      if (!HANGUL.test(text)) return;
      const line = first + k;
      if (/i18n-data/.test(lines[line - 1])) data.push({ file, line });
      else bad.push({ file, line, text: lines[line - 1].trim().slice(0, 160) });
    });
  };
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>|<!--[\s\S]*?-->/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    plain(last, m.index);
    if (m[1] !== undefined) {
      const off = lineAt(m.index + m[0].indexOf('>') + 1) - 1;
      const r = scanSource(m[1], file);
      bad.push(...r.bad.map((b) => ({ ...b, line: b.line + off })));
      data.push(...r.data.map((b) => ({ ...b, line: b.line + off })));
    }
    last = m.index + m[0].length;
  }
  plain(last, src.length);
  return { bad, data };
}

// CSS: generated content is screen text too; comments are skipped.
export function scanCss(src, file = '<css>') {
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const bad = [];
  stripped.split('\n').forEach((text, k) => { if (HANGUL.test(text)) bad.push({ file, line: k + 1, text: src.split('\n')[k].trim().slice(0, 160) }); });
  return { bad, data: [] };
}

export function scanFiles(root, paths) {
  const bad = [];
  const data = [];
  for (const path of paths) {
    const src = readFileSync(path, 'utf8');
    const file = relative(root, path);
    const r = path.endsWith('.html') ? scanHtml(src, file) : path.endsWith('.css') ? scanCss(src, file) : scanSource(src, file);
    bad.push(...r.bad);
    data.push(...r.data);
  }
  return { bad, data };
}

// The files this app ships: every screen script, page and stylesheet, and the server code whose errors
// reach a screen. Tests, QA harnesses and operator shell scripts are not screen text.
export const SHIPPED = ['public/**/*.{js,html,css}', '*.js'];

export function shippedFiles(root) {
  const seen = new Set();
  for (const pattern of SHIPPED) for (const f of new Bun.Glob(pattern).scanSync({ cwd: root })) seen.add(`${root}/${f}`);
  return [...seen].filter((f) => !f.includes('/node_modules/')).sort();
}

if (import.meta.main) {
  const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const { bad, data } = scanFiles(root, shippedFiles(root));
  const counts = {};
  for (const b of bad) counts[b.file] = (counts[b.file] ?? 0) + 1;
  for (const b of bad) console.log(`${b.file}:${b.line} ${b.text}`);
  console.log(`\n${bad.length} untranslated, ${data.length} i18n-data lines`, JSON.stringify(counts));
  process.exit(bad.length ? 1 : 0);
}
