import { describe as suite, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// src/gpu-level.js is a classic script in the page (window.StarHermitGpu); evaluate it the same way here.
new Function('window', 'module', readFileSync(new URL('../src/gpu-level.js', import.meta.url), 'utf8'))(globalThis, undefined);
const { detectPreset, detectLevel, presetForLevel, budgetFor, sparkCount, resolve, presetTier, choosePreset, describe, PRESETS, CATEGORIES, LEVELS, BUDGETS, SPARK_MAX, MOTE_MAX } = await import('../src/gfx.js');
const { GFX_STRINGS, pickLocale } = await import('../src/gfx-i18n.js');

const DESK = { cores: 8, memoryGb: 8 };
const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

suite('gfx quality model', () => {
  it('hardware level picks the Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
    expect(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', DESK)).toBe('low');
    expect(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK)).toBe(0);
    expect(detectPreset('', DESK)).toBe('low');
    expect(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK)).toBe('low');
    expect(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK)).toBe('low');
    expect(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK)).toBe('balanced');
    expect(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK)).toBe('high');
    expect(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK)).toBe('ultra');
    expect(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK)).toBe(20);
    expect(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK)).toBe('ultra');
    for (const [p, lv] of Object.entries(LEVELS)) expect(presetForLevel(lv)).toBe(p);
    expect(presetForLevel(3)).toBe('low');
    expect(presetForLevel(16)).toBe('high');
  });

  it('phones and tablets are Balanced at most; software GPUs stay Low', () => {
    expect(detectPreset('Adreno (TM) 740', PHONE)).toBe('balanced');
    expect(detectLevel('Adreno (TM) 740', PHONE)).toBeLessThanOrEqual(9);
    expect(detectPreset('Apple M2', PHONE)).toBe('balanced');
    expect(detectPreset('SwiftShader', PHONE)).toBe('low');
  });

  it('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
    const keys = ['material', 'texture', 'bump', 'tube', 'sphere', 'lathe', 'sparks', 'motes', 'bloomRes', 'aoRes'];
    for (const p of PRESETS) for (const k of keys) expect(BUDGETS[p][k], `${p}.${k}`).not.toBeUndefined();
    for (let i = 1; i < PRESETS.length; i++) for (const k of ['texture', 'sphere', 'lathe', 'sparks', 'motes', 'bloomRes', 'aoRes']) {
      expect(BUDGETS[PRESETS[i]][k], `${PRESETS[i]}.${k}`).toBeGreaterThanOrEqual(BUDGETS[PRESETS[i - 1]][k]);
      expect(BUDGETS[PRESETS[i]].tube[0]).toBeGreaterThanOrEqual(BUDGETS[PRESETS[i - 1]].tube[0]);
    }
    expect(PRESETS.map((p) => BUDGETS[p].material)).toEqual(['lambert', 'standard', 'physical', 'physical']);
    expect(PRESETS.map((p) => BUDGETS[p].bloomRes)).toEqual([0.5, 0.5, 0.5, 1]);
    expect(resolve({ preset: 'high' }, 'low', 10).budget).toEqual(BUDGETS.high);
    expect(resolve({ preset: 'ultra' }, 'low', 0).budget).toEqual(resolve({ preset: 'ultra' }, 'ultra', 17).budget);
    expect(budgetFor('balanced', 9).motes).toBeGreaterThan(budgetFor('balanced', 4).motes);
    expect(budgetFor('ultra', 20).sparks).toBeLessThanOrEqual(SPARK_MAX);
    expect(budgetFor('ultra', 20).motes).toBeLessThanOrEqual(MOTE_MAX);
    expect(sparkCount(resolve({ preset: 'high' }, 'low', 10))).toBe(BUDGETS.high.sparks);
    expect(sparkCount(resolve({ preset: 'low' }, 'low', 0))).toBe(BUDGETS.low.sparks / 2);
    expect(resolve({}, 'low', 0).budget.material).toBe('lambert');
  });

  it('resolves auto, explicit presets and overrides', () => {
    const a = resolve({}, 'low');
    expect(a.auto).toBe(true);
    expect(a.preset).toBe('low');
    expect(a.post).toBe(false);
    expect(a.shadows).toBe('off');
    const h = resolve({ preset: 'high', bloom: 'off', shadows: 'bogus' }, 'low');
    expect(h.auto).toBe(false);
    expect(h.preset).toBe('high');
    expect(h.bloom).toBe('off');
    expect(h.shadows).toBe(presetTier('high', 'shadows'));
    expect(h.adaptive).toBe(true);
    expect(h.showFps).toBe(false);
  });

  it('clamps render scale to 50–200%', () => {
    expect(resolve({ preset: 'high', render_scale: 5 }).scale).toBe(2);
    expect(resolve({ preset: 'high', render_scale: 0.1 }).scale).toBe(0.5);
    expect(resolve({ preset: 'ultra', render_scale: 1 }).scale).toBeCloseTo(1.25);
  });

  it('choosing a preset clears overrides but keeps scale/adaptive/fps', () => {
    const s = choosePreset({ preset: 'high', bloom: 'off', ao: 'high', render_scale: 1.5, adaptive: false, show_fps: true }, 'low');
    expect(s).toEqual({ preset: 'low', render_scale: 1.5, adaptive: false, show_fps: true });
    expect(choosePreset({}, 'auto').preset).toBe('auto');
  });

  it('every preset defines every category with a legal tier', () => {
    for (const p of PRESETS) for (const [cat, tiers] of Object.entries(CATEGORIES)) expect(tiers).toContain(presetTier(p, cat));
  });

  it('describes cost', () => {
    const d = describe(resolve({ preset: 'high' }), [800, 600]);
    expect(d).toContain('2048² shadows');
    expect(d).toContain('800×600 px');
  });

  it('localizes every string in all required locales', () => {
    const keys = (o, pre = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, pre + k + '.') : [pre + k]));
    const base = keys(GFX_STRINGS['en-US']).sort();
    for (const loc of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) {
      expect(keys(GFX_STRINGS[loc]).sort()).toEqual(base);
    }
    expect(pickLocale('es-MX')).toBe('es-419');
    expect(pickLocale('fr-CA')).toBe('fr-CA');
    expect(pickLocale('zz')).toBe('en-US');
  });
});
