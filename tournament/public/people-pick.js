// The registered-people dropdown under a player field: '이름,네자리' entries from GET /api/players (PIN;
// absent until feat/player-code lands), keys already in the desk queue, and names from the public
// people list (name known, four digits still to type). Typing filters by the first characters or their
// initial consonants (ㅊㅂ matches 홍길동); the list is drawn straight into the DOM, never through
// app.js render, because render waits while a field has focus. Used by desk-view.js and player-view.js.
// Markup: <input data-people-pick ...><ul class="pp-sugg" role="listbox"></ul>

import { L } from './i18n.js';

const INITIALS = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'; // i18n-data: Korean initial-consonant (초성) matching rule
const LIMIT = 6;
let cache = null;
let loading = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const initialOf = (ch) => {
  const c = ch.codePointAt(0) - 0xac00;
  return c >= 0 && c < 11172 ? INITIALS[Math.floor(c / 588)] : ch;
};

// A typed character matches the same character or a syllable starting with that initial consonant.
const startsLike = (text, query) => [...query].every((q, i) => {
  const ch = text[i];
  return ch !== undefined && (ch === q || (INITIALS.includes(q) && initialOf(ch) === q));
});

// '홍길동，0712' / '홍길동 0712' -> '홍길동,0712'; a bare name stays a name.
export const normalizeKey = (text) => String(text ?? '').normalize('NFKC').trim().replace(/[\s，]*,[\s，]*|\s+(?=\d{4}$)/g, ',');
export const nameOf = (key) => (key === null || key === undefined ? null : String(key).replace(/,\d{4}$/, ''));

// entries: [{ entry: '홍길동,0712' | '홍길동', name, code|null, note }]. Coded entries come first.
export async function peopleEntries(pin, { force = false } = {}) {
  if (cache && !force && Date.now() - cache.at < 30_000) return cache.list;
  if (loading && !force) return loading;
  loading = (async () => {
    const coded = new Map();
    const add = (name, code, note) => { if (name && code && !coded.has(`${name},${code}`)) coded.set(`${name},${code}`, { entry: `${name},${code}`, name, code, note }); };
    const get = async (url, withPin) => {
      try {
        const res = await fetch(url, withPin && pin ? { headers: { 'x-pin': pin } } : undefined);
        return res.ok ? await res.json() : null;
      } catch { return null; }
    };
    if (pin) {
      const registered = await get('/api/players', true);
      for (const p of registered?.players ?? []) add(p.name, p.code, L('등록된 선수', 'Registered player'));
      const desk = await get('/api/desk/jobs', true);
      for (const j of desk?.jobs ?? []) for (const key of [j.players?.near, j.players?.far]) { const m = /^(.+),(\d{4})$/.exec(key ?? ''); if (m) add(m[1], m[2], L('올린 영상', 'Uploaded video')); }
    }
    const pub = await get('/api/analysis/people', false);
    const names = [...coded.values()].map((e) => e.name);
    const plain = (pub?.people ?? []).filter((p) => !names.includes(p.name)).map((p) => ({ entry: p.name, name: p.name, code: null, note: L(`기록 ${p.matches}경기 · 네자리를 이어 적어요`, `${p.matches} ${p.matches === 1 ? 'match' : 'matches'} · add the 4 digits`) }));
    const list = [...coded.values(), ...plain];
    cache = { list, at: Date.now() };
    loading = null;
    return list;
  })();
  return loading;
}

export const forgetPeople = () => { cache = null; };

// The entries whose '이름,네자리' starts like the typed text; an exact entry already typed shows nothing.
// NFC, not NFKC: NFKC turns a typed initial consonant (U+314A) into a conjoining jamo that matches nothing.
export function suggest(entries, typed) {
  const query = String(typed ?? '').normalize('NFC').trim().replace(/，/g, ',').replace(/\s*,\s*|\s+(?=\d{1,4}$)/g, ',');
  if (!query || entries.some((e) => e.entry === query)) return [];
  return entries.filter((e) => startsLike(e.entry, query)).slice(0, LIMIT);
}

function listOf(input) {
  const ul = input.nextElementSibling;
  return ul?.classList.contains('pp-sugg') ? ul : null;
}

function draw(input, items) {
  const ul = listOf(input);
  if (!ul) return;
  ul.innerHTML = items.map((e, i) => `<li role="option" aria-selected="${i === 0}"><button type="button" tabindex="-1" data-pp-entry="${esc(e.entry)}" data-pp-code="${e.code ?? ''}"><b>${esc(e.entry)}</b><small>${esc(e.note)}</small></button></li>`).join('');
  ul.hidden = items.length === 0;
}

const clear = (input) => { const ul = listOf(input); if (ul) { ul.innerHTML = ''; ul.hidden = true; } };

// Puts the entry in the field; a name without a code leaves the caret after the comma for the digits.
function pick(input, button) {
  const entry = button.dataset.ppEntry;
  input.value = button.dataset.ppCode ? entry : `${entry},`;
  clear(input);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

let pin = () => null;
export function bindPeoplePick(getPin) { pin = getPin; }

// The listeners need a page; the matching above is also used by tests without one.
if (typeof document !== 'undefined') installListeners();

function installListeners() {
document.addEventListener('input', async (e) => {
  const input = e.target;
  if (!input.matches?.('input[data-people-pick]') || e.isTrusted === false) return;
  const typed = input.value;
  const entries = await peopleEntries(pin());
  if (document.activeElement !== input || input.value !== typed) return;
  draw(input, suggest(entries, typed));
});

document.addEventListener('focusin', (e) => {
  const input = e.target;
  if (!input.matches?.('input[data-people-pick]')) return;
  peopleEntries(pin()).then((entries) => { if (document.activeElement === input && input.value) draw(input, suggest(entries, input.value)); });
});

document.addEventListener('focusout', (e) => {
  if (e.target.matches?.('input[data-people-pick]')) setTimeout(() => { if (document.activeElement !== e.target) clear(e.target); }, 150);
});

// pointerdown, before the field blurs; the suggestion buttons are not focusable themselves.
document.addEventListener('pointerdown', (e) => {
  const b = e.target.closest?.('.pp-sugg [data-pp-entry]');
  if (!b) return;
  e.preventDefault();
  const input = b.closest('.pp-sugg').previousElementSibling;
  pick(input, b);
});

document.addEventListener('keydown', (e) => {
  const input = e.target;
  if (!input.matches?.('input[data-people-pick]')) return;
  const ul = listOf(input);
  const items = ul && !ul.hidden ? [...ul.querySelectorAll('li')] : [];
  if (!items.length) return;
  const at = items.findIndex((li) => li.getAttribute('aria-selected') === 'true');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = (at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items.forEach((li, i) => li.setAttribute('aria-selected', String(i === next)));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    pick(input, items[Math.max(0, at)].querySelector('button'));
  } else if (e.key === 'Escape') {
    clear(input);
  }
});
}
