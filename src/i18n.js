// Tangled Threads — localization runtime.
// The language comes from sh-language.js (window.StarHermitLanguage): explicit
// game choice (ui.language) → StarHermit account preferredLanguage → device
// languages → en-US. A change re-applies static markup and notifies listeners
// (onLanguage) so code-built text re-renders in place.

import { STRINGS } from './strings.js';

export const SUPPORTED = Object.keys(STRINGS);
let lang = 'en-US';
let dict = STRINGS[lang];
const listeners = new Set();

export function locale() { return lang; }

/** Localized string for key with {placeholders} filled from vars. */
export function t(key, vars) {
  const s = (dict && dict[key]) ?? STRINGS['en-US'][key] ?? key;
  return vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)) : s;
}

/** Re-apply data-i18n (text), data-i18n-html (trusted markup) and data-i18n-aria. */
export function applyStatic(root = typeof document !== 'undefined' ? document : null) {
  if (!root) return;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  if (root.documentElement) root.documentElement.lang = lang;
}

/** fn(locale) runs after every language change. */
export function onLanguage(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function setLocale(next) {
  lang = STRINGS[next] ? next : 'en-US';
  dict = STRINGS[lang];
  if (typeof document !== 'undefined') applyStatic(document);
  for (const fn of listeners) { try { fn(lang); } catch (e) { console.error(e); } }
}

const SL = typeof window !== 'undefined' ? window.StarHermitLanguage : null;
export const language = SL ? SL.create({ game: 'tangled-threads', supported: SUPPORTED, apply: setLocale }) : null;

/** Display name of a level id in the current language. */
export function levelName(id) {
  let m;
  if (id === 'tutorial') return t('lvlTutorial');
  if ((m = /^stage-(\d+)$/.exec(id))) return t('lvlStage', { n: m[1] });
  if ((m = /^practice-(easy|medium|hard)$/.exec(id))) return t('lvlPractice', { level: t('diff' + m[1][0].toUpperCase() + m[1].slice(1)) });
  if ((m = /^challenge-(\d+)$/.exec(id))) return t('lvlChallenge', { n: m[1] });
  if ((m = /^daily-(.+)$/.exec(id))) return t('lvlDaily', { date: m[1] });
  return id;
}
