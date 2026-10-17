// i18n.test.js — every string key used in index.html and src/*.js exists in
// all nine locales, with the same {placeholders} as US English.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { STRINGS } from '../src/strings.js';
import { levelName, t } from '../src/i18n.js';

const ROOT = new URL('..', import.meta.url);
const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const html = readFileSync(new URL('index.html', ROOT), 'utf8');
const code = readdirSync(new URL('src/', ROOT)).filter((f) => f.endsWith('.js') && f !== 'strings.js')
  .map((f) => readFileSync(new URL('src/' + f, ROOT), 'utf8')).join('\n');

const used = new Set();
for (const m of html.matchAll(/data-i18n(?:-html|-aria)?="([^"]+)"/g)) used.add(m[1]);
for (const m of code.matchAll(/\bt\('([A-Za-z0-9]+)'(?!\s*\+)/g)) used.add(m[1]);
for (const d of ['Easy', 'Medium', 'Hard']) used.add('diff' + d);
// Keys built at runtime (tables and concatenation in main.js / i18n.js / platform.js).
for (const m of code.matchAll(/'((?:sync|info|mode|name|err|ach|color|cmp|diff|part|cell)[A-Z][A-Za-z]*)'/g)) used.add(m[1]);
for (let n = 1; n <= 5; n++) used.add('tut' + n);
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

describe('localization', () => {
  it('ships the nine locales', () => expect(Object.keys(STRINGS).sort()).toEqual([...LOCALES].sort()));
  it('found the keys in markup and code', () => expect(used.size).toBeGreaterThan(100));
  for (const loc of LOCALES) {
    it(`${loc} has every used key with matching placeholders`, () => {
      const missing = [...used].filter((k) => typeof STRINGS[loc][k] !== 'string');
      expect(missing).toEqual([]);
      for (const k of used) expect(vars(STRINGS[loc][k]), `${loc}.${k}`).toBe(vars(STRINGS['en-US'][k]));
    });
  }
  it('non-English locales are translated', () => {
    for (const loc of LOCALES.filter((l) => !l.startsWith('en'))) {
      const same = [...used].filter((k) => STRINGS[loc][k] === STRINGS['en-US'][k] && !/^(Tutorial|Total|Home|Pause \(Esc\))$/.test(STRINGS[loc][k]));
      expect(same.length, `${loc}: ${same.join(', ')}`).toBeLessThan(4);
    }
  });
  it('names levels', () => {
    expect(levelName('practice-easy')).toBe('Practice (easy)');
    expect(levelName('stage-7')).toBe('Stage 7');
    expect(t('hudReeled', { done: 1, total: 3 })).toBe('Reeled 1/3');
  });
});
