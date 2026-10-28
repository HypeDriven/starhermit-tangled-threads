// save.test.mjs — the engine client's save model (src/save.js): merging two
// devices' saves as the browser build merged them, the browser build's
// checksummed cloud slot read as a foreign save, the old settings KV; and
// the generator's engine-independent sort (src/content.js v8Sort against
// Chrome's recorded comparator calls, so every engine makes Chrome's levels).
import { describe, it, expect } from './expect.mjs';
import { readFileSync } from 'node:fs';
import * as save from '../src/save.js';
import { generateLevel, validateLevel, v8Sort, dailySeedString } from '../src/content.js';
import { mulberry32 } from '../src/rules.js';

const prog = (o) => ({ ...save.emptyProgress(), ...o });

describe('save model', () => {
  it('normalizes anything into a save', () => {
    expect(save.normalize(null)).toEqual(save.emptySave());
    expect(save.normalize({ progress: { stagesDone: { 'stage-1': '900', x: 'nan' }, daysPlayed: { '2026-10-01': 1 } }, tutorialDone: 1 }))
      .toEqual({ v: 1, progress: prog({ stagesDone: { 'stage-1': 900 }, daysPlayed: { '2026-10-01': true } }), tutorialDone: true });
  });
  it('merges two devices: best scores, union of days, earliest achievement', () => {
    const a = { progress: prog({ stagesDone: { 'stage-1': 1500, 'stage-2': 900 }, achievements: { 'first-completion': 200 }, daysPlayed: { d1: true } }) };
    const b = { progress: prog({ stagesDone: { 'stage-1': 1200, 'stage-3': 1000 }, achievements: { 'first-completion': 100, 'streak-3': 300 }, daysPlayed: { d2: true } }), tutorialDone: true };
    const m = save.mergeSave(a, b);
    expect(m.progress.stagesDone).toEqual({ 'stage-1': 1500, 'stage-2': 900, 'stage-3': 1000 });
    expect(m.progress.achievements).toEqual({ 'first-completion': 100, 'streak-3': 300 });
    expect(Object.keys(m.progress.daysPlayed).sort()).toEqual(['d1', 'd2']);
    expect(m.tutorialDone).toBe(true);
    expect(save.sameSave(m, save.mergeSave(b, a))).toBe(true);
  });
  it('reads the browser build cloud slot (checksummed) and refuses a broken one', () => {
    const data = { settings: { cvdPalette: true, leftHanded: false, tutorialDone: true, volumes: { music: 0.2 } }, progress: prog({ bestScores: { 'daily-2026-10-01': 1700 } }) };
    const text = JSON.stringify({ v: 1, data, check: save.checksum(data) });
    const f = save.readForeign(text);
    expect(f.save.progress.bestScores).toEqual({ 'daily-2026-10-01': 1700 });
    expect(f.save.tutorialDone).toBe(true);
    expect(f.options).toEqual({ cvdPalette: true, leftHanded: false });
    expect(save.readForeign(JSON.stringify({ v: 1, data, check: 'x' }))).toBe(null);
    expect(save.readForeign('nope')).toBe(null);
  });
  it('reads the old settings KV', () => {
    expect(save.readLegacySettings({ cvdPalette: true, leftHanded: 'yes', tutorialDone: true, volumes: {} })).toEqual({ options: { cvdPalette: true }, tutorialDone: true });
    expect(save.BROWSER_KEYS).toContain('graphics');
  });
});

describe('generator sort', () => {
  it("calls the comparator exactly as Chrome's sort did", () => {
    const { traces } = JSON.parse(readFileSync(new URL('./fixtures/chrome-sort.json', import.meta.url), 'utf8'));
    expect(traces.length).toBeGreaterThan(100);
    for (const t of traces) {
      const r = mulberry32(t.seed), calls = [];
      const a = v8Sort([...Array(t.n).keys()], (x, y) => { calls.push([x, y]); return r() - 0.5; });
      expect(calls).toEqual(t.calls);
      expect(a).toEqual(t.arr);
    }
  });
  it("makes Chrome's boards (stage 12 as the browser build showed it)", () => {
    const l = generateLevel('stage-12');
    expect(l.par).toBe(12);
    expect(l.strands.map((s) => s.spool)).toEqual([7, 4, 1]);
  });
  it('generates and validates every level id and ten years of Dailies', () => {
    const ids = ['tutorial', 'practice-easy', 'practice-medium', 'practice-hard'];
    for (let n = 1; n <= 40; n++) ids.push('stage-' + n);
    for (let n = 1; n <= 12; n++) ids.push('challenge-' + n);
    for (let d = 0; d < 3653; d++) ids.push(dailySeedString(new Date(Date.UTC(2024, 0, 1) + d * 86400000)));
    for (const id of ids) expect(validateLevel(generateLevel(id)).ok, id).toBe(true);
  });
});
