// The look per graphics level: the browser build's four presets and budgets
// (src/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the reel sparks and dust motes scaled within the tier by the level
// (frame().levelIndex, at most 2×), as the browser build scaled them by its
// hardware level. The runtime owns the rest of what the old Graphics tab
// did: Auto and the level choice, render scale and the pixel-ratio cap,
// adaptive resolution, the frame-rate limit and readout. The old tab's
// per-effect overrides are not offered (the runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Shading: Lambert (Low), Standard (Balanced), Physical lacquer and clear coats (High, Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Wood texture size in px (felt ½, yarn and thread ¼). */
  texture: 128 | 256 | 512;
  bump: boolean;
  /** Strand tube: radial segments, length segments per cell. */
  tube: [number, number];
  sphere: number;
  lathe: number;
  sparks: number;
  motes: number;
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
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
const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, detailed: false, particles: "low", animated: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, detailed: true, particles: "low", animated: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, detailed: true, particles: "high", animated: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, detailed: true, particles: "high", animated: true },
};
/** gfx.js BUDGETS. */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 128, bump: false, tube: [8, 5], sphere: 14, lathe: 16, sparks: 12, motes: 30, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", texture: 128, bump: false, tube: [10, 7], sphere: 18, lathe: 24, sparks: 16, motes: 50, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", texture: 256, bump: true, tube: [14, 10], sphere: 24, lathe: 32, sparks: 16, motes: 90, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", texture: 512, bump: true, tube: [16, 12], sphere: 32, lathe: 48, sparks: 24, motes: 150, bloomRes: 1, aoRes: 1 },
};
/** The first level index of each tier. */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };
export const SPARK_MAX = 48;
export const MOTE_MAX = 300;
const PARTICLE_SHARE = { off: 0, low: 0.5, high: 1 };

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return { preset, ...TABLE[preset], budget: b };
}
/** gfx.js sparkCount: sparks per reel burst. */
export function sparkCount(l: Look): number { return Math.round(l.budget.sparks * PARTICLE_SHARE[l.particles]); }
