import { describe as suite, it, expect } from 'vitest';
import { detectPreset, resolve, presetTier, choosePreset, describe, PRESETS, CATEGORIES } from '../src/gfx.js';
import { GFX_STRINGS, pickLocale } from '../src/gfx-i18n.js';

suite('gfx quality model', () => {
  it('detects presets from GPU strings', () => {
    expect(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)')).toBe('low');
    expect(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe('low');
    expect(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)')).toBe('high');
    expect(detectPreset('Apple M2')).toBe('high');
    expect(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)')).toBe('balanced');
    expect(detectPreset('')).toBe('balanced');
  });

  it('caps Auto at balanced on mobile', () => {
    expect(detectPreset('Apple M2', { mobile: true })).toBe('balanced');
    expect(detectPreset('SwiftShader', { mobile: true })).toBe('low');
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
