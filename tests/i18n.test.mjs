// i18n.test.mjs — every string key the engine client (native/*.ts) shows
// exists in all nine locales, with the same {placeholders} as US English,
// in assets/strings.json (account strings are the engine's starhermit.*).
import { describe, it, expect } from './expect.mjs';
import { readFileSync, readdirSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const STRINGS = JSON.parse(readFileSync(new URL('assets/strings.json', ROOT), 'utf8'));
const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const code = readdirSync(new URL('native/', ROOT)).filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(new URL('native/' + f, ROOT), 'utf8')).join('\n');

const used = new Set();
for (const m of code.matchAll(/\b(?:T|rich)\("([A-Za-z0-9]+)"(?!\s*\+)/g)) used.add(m[1]);
for (const d of ['Easy', 'Medium', 'Hard']) used.add('diff' + d);
// keys from tables in main.ts / screens.ts (ERR, COLOR_KEYS, ACH_KEYS, MODES, INFO, the cell parts, the sync labels)
for (const m of code.matchAll(/"((?:sync|info|mode|name|err|ach|color|cmp|diff|part|cell|rule|tut)[A-Z0-9][A-Za-z0-9]*)"/g)) used.add(m[1]);
for (let n = 1; n <= 5; n++) used.add('tut' + n);
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

describe('localization', () => {
  it('ships the nine locales', () => expect(Object.keys(STRINGS).sort()).toEqual([...LOCALES].sort()));
  it('found the keys in the client', () => expect(used.size).toBeGreaterThan(100));
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
});
