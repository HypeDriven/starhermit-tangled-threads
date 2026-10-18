// Tangled Threads — graphics quality model: presets, per-category overrides,
// StarHermit hardware-level detection, per-preset budgets and a cost summary. Pure (no three.js) so the settings panel,
// the renderer and the unit tests agree on what a setting means.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],
  detail: ['plain', 'detailed'],
  particles: ['off', 'low', 'high'],
  ambient: ['static', 'animated'],
};

// Each preset is a row of tiers plus a render scale and a device-pixel-ratio cap.
const TABLE = {
  low: { scale: 1, dprCap: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', detail: 'plain', particles: 'low', ambient: 'static' },
  balanced: { scale: 1, dprCap: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', detail: 'detailed', particles: 'low', ambient: 'animated' },
  high: { scale: 1, dprCap: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', detail: 'detailed', particles: 'high', ambient: 'animated' },
  ultra: { scale: 1.25, dprCap: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', detail: 'detailed', particles: 'high', ambient: 'animated' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
// 5090; src/gpu-level.js → window.StarHermitGpu, a classic script loaded before the game): Low from 0,
// Balanced from 4, High from 10, Ultra from 17. Phones, tablets and ≤ 4 GB machines are capped at level 9.
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
  const G = gpuApi();
  const sys = { webgl: true, webgl2: true, ...(system || {}), gpu: String(gpu || '') };
  if (!gpu) sys.webgl = false; // no renderer string: no usable WebGL
  return G ? G.detectLevel(sys) : (gpu ? LEVELS.balanced : 0);
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU (the hardware level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/*
 * Per-preset asset and effect budget. Each preset holds 60 FPS on the weakest GPU Auto gives it (Low →
 * level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). Board, strands,
 * spools, hit areas and rules are identical on every preset — only visuals change.
 *   material  shading model: lambert (Low) / standard (Balanced) / physical yarn sheen + lacquer (High, Ultra)
 *   texture   procedural wood texture size in px (felt ½, yarn and thread ¼; Surface detail on)
 *   bump      bump maps on wood, felt, yarn and thread (Surface detail on)
 *   tube      strand tube: radial segments and length segments per cell
 *   sphere    bead / ghost sphere width segments (height ¾)
 *   lathe     spool / prop lathe and cylinder segments
 *   sparks    sparks per reel burst at Particles "high" (low: half), scaled with the level
 *   motes     dust motes in the lamp light (Particles high), scaled with the level
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
  low: { material: 'lambert', texture: 128, bump: false, tube: [8, 5], sphere: 14, lathe: 16, sparks: 12, motes: 30, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', texture: 128, bump: false, tube: [10, 7], sphere: 18, lathe: 24, sparks: 16, motes: 50, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', texture: 256, bump: true, tube: [14, 10], sphere: 24, lathe: 32, sparks: 16, motes: 90, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', texture: 512, bump: true, tube: [16, 12], sphere: 32, lathe: 48, sparks: 24, motes: 150, bloomRes: 1, aoRes: 1 },
};
export const SPARK_MAX = 48;
export const MOTE_MAX = 300;
const PARTICLE_SHARE = { off: 0, low: 0.5, high: 1 };

/** A preset's concrete budget for a hardware level (particle counts scale ≤ 2× within the preset). */
export function budgetFor(preset, level) {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const G = gpuApi(), floor = LEVELS[preset] || 0;
  const lv = Math.max(Number.isFinite(level) ? level : floor, floor);
  const k = G ? Math.min(2, G.scaleBudget(1, lv, floor)) : 1;
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return b;
}

/** Sparks per reel burst for a resolved setting (Particles tier share of the preset's budget). */
export function sparkCount(r) {
  return Math.round(r.budget.sparks * (PARTICLE_SHARE[r.particles] ?? 0));
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const out = {
    preset,
    auto,
    dprCap: row.dprCap,
    scale: row.scale * clamp(Number(s.render_scale) || 1, 0.5, 2),
  };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budgetFor(preset, out.level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing runs only when something needs it; otherwise the canvas MSAA is used.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** Choosing a preset clears every per-category override (scale/adaptive/fps are kept). */
export function choosePreset(saved, preset) {
  const s = { ...(saved || {}) };
  for (const cat of Object.keys(CATEGORIES)) delete s[cat];
  s.preset = PRESETS.includes(preset) ? preset : 'auto';
  return s;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

const EN = {
  noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
  bloom: 'bloom', reflections: 'reflections', noAA: 'no anti-aliasing', px: '{w}×{h} px',
};

/** One-line cost summary; `labels` localizes the fragments. */
export function describe(r, pixels, labels = EN) {
  const L = { ...EN, ...labels };
  const parts = [
    r.shadows === 'off' ? L.noShadows : L.shadows.replace('{n}', SHADOW_MAP[r.shadows]),
    r.ao === 'off' ? null : r.ao === 'high' ? L.aoHigh : L.ao,
    r.bloom === 'on' ? L.bloom : null,
    r.reflections === 'on' ? L.reflections : null,
    r.antialias === 'off' ? L.noAA : r.antialias.toUpperCase(),
    pixels ? L.px.replace('{w}', pixels[0]).replace('{h}', pixels[1]) : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
