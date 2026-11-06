// The app's language: 'ko' (default) or 'en'. One device key for the tournament app and the camera
// app at /vision/ (same origin), so choosing it on 모드 고르기 or in either settings changes both.
// Every screen string is written as L('한국어', 'English') beside its use; test/i18n.test.js fails on a
// Korean string that is not the first half of such a pair. A switch reloads the page, so strings built
// once at load (module constants, the camera screen's DOM) are always in the chosen language.
export const LANG_KEY = 'pp-lang';
export const LANGS = ['ko', 'en'];

function stored() {
  try {
    return globalThis.localStorage?.getItem(LANG_KEY) ?? null;
  } catch {
    return null;
  }
}

export const LANG = stored() === 'en' ? 'en' : 'ko';
export const EN = LANG === 'en';
export const L = (ko, en) => (EN ? en : ko);
// Intl locale for dates and numbers on screen.
export const LOCALE = EN ? 'en-US' : 'ko-KR';

// Store the choice and reload so every screen is drawn again in it. Returns false when nothing changes.
export function setLang(lang) {
  if (!LANGS.includes(lang) || lang === LANG) return false;
  localStorage.setItem(LANG_KEY, lang);
  location.reload();
  return true;
}

// Server error bodies carry both languages: { error: Korean, en: English }; old servers send Korean only.
export const errorText = (body, fallback) => (EN && body?.en) || body?.error || fallback;

if (globalThis.document) document.documentElement.lang = LANG;

// Server side: a JSON error body in both languages (the client picks with errorText).
export const fail = (ko, en, extra = {}) => ({ error: ko, en, ...extra });
