// The look per graphics level: the browser build's four presets and budgets
// (src/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the reel sparks and dust motes scaled within the tier by the level
// (frame().levelIndex, at most 2×), as the browser build scaled them by its
// hardware level. The runtime owns the rest of what the old Graphics tab
// did: Auto and the level choice, render scale and the pixel-ratio cap,
// adaptive resolution, the frame-rate limit and readout. The old tab's
// per-effect overrides are not offered (the runtime's Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Shading: Lambert (Low), Standard (Balanced), Physical lacquer and clear coats (High, Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Wood texture size in px (felt ½, yarn and thread ¼). */
  texture: number;
  bump: boolean;
  /** Strand tube: radial segments, length segments per cell. */
  tube: [number, number];
  sphere: number;
  lathe: number;
  sparks: number;
  motes: number;
}
export interface Look {
  preset: QualityTier;
  /** The level's shadow map size, 0 = off. */
  shadows: number;
  /** The level's ambient occlusion, null = off. */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution, null = off. */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  /** Textured wood, felt, yarn; lathe-turned bobbins; the props (pins, thimble, yarn ball, stitches); the lamp backdrop. */
  detailed: boolean;
  particles: "off" | "low" | "high";
  /** Lamp shimmer, the selection ring's breathing, reeled spools pulsing, the title's camera drift, drifting dust. */
  animated: boolean;
  budget: Budget;
}

/** gfx.js TABLE (scale and dprCap are the runtime's render scale now). */
const ART: Record<QualityTier, Omit<Look, "preset" | "budget" | "shadows" | "ao" | "bloom" | "grade" | "antialias">> = {
  low: { reflections: false, detailed: false, particles: "low", animated: false },
  balanced: { reflections: true, detailed: true, particles: "low", animated: true },
  high: { reflections: true, detailed: true, particles: "high", animated: true },
  ultra: { reflections: true, detailed: true, particles: "high", animated: true },
};
/** gfx.js BUDGETS. */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 128, bump: false, tube: [8, 5], sphere: 14, lathe: 16, sparks: 12, motes: 30 },
  balanced: { material: "standard", texture: 128, bump: false, tube: [10, 7], sphere: 18, lathe: 24, sparks: 16, motes: 50 },
  high: { material: "physical", texture: 256, bump: true, tube: [14, 10], sphere: 24, lathe: 32, sparks: 16, motes: 90 },
  ultra: { material: "physical", texture: 512, bump: true, tube: [16, 12], sphere: 32, lathe: 48, sparks: 24, motes: 150 },
};
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };
export const SPARK_MAX = 48;
export const MOTE_MAX = 300;
const PARTICLE_SHARE = { off: 0, low: 0.5, high: 1 };

/** The look for a level's settings. */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  b.texture = Math.min(b.texture, s.maxTextureSize);
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
  };
}
/** gfx.js sparkCount: sparks per reel burst. */
export function sparkCount(l: Look): number { return Math.round(l.budget.sparks * PARTICLE_SHARE[l.particles]); }
