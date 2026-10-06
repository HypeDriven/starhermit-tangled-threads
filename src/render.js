// Tangled Threads — Three.js scene: cozy fiber-art worktable.
// Deterministic visual seed; render layers: environment / gameplay / selection / effects.
// Graphics quality (presets + per-effect overrides) comes from gfx.js and applies live.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { THEMES, STRAND_COLORS, STRAND_COLORS_CVD } from './content.js';
import { detectPreset, resolve, describe, SHADOW_MAP } from './gfx.js';

export const LAYER_ENV = 0;
export const LAYER_GAME = 1;
export const LAYER_SELECT = 2;
export const LAYER_FX = 3;

const CELL = 1.0;         // world units per board cell
const STRAND_R = 0.16;    // strand tube radius
const FRAMING = { dist: 9.5, tilt: 0.62, fov: 42 }; // authored camera constants
const KEY_DIR = new THREE.Vector3(3, 7, 4).normalize();
const KEY_INTENSITY = 2.4;

let renderer = null, scene = null, camera = null, canvas = null;
let keyLight = null, rimLight = null, hemi = null, amb = null;
let world = null;          // group rebuilt per level
let boardCells = [];       // pickable cell meshes
let spoolMeshes = [];      // pickable spool meshes (userData.strand)
let strandGroups = [];     // per-strand group with tube + beads
let selRing = null, ghost = null;
let reducedMotion = false, cvd = false;
let theme = THEMES[0];
let levelRef = null;
let lastState = null, lastSelection = -1;
let showcase = false;      // title backdrop: decorative board, slow camera drift
let animT = 0, lastTime = 0, rafId = 0, hidden = false;
let onFrameCb = null;
let shakeAmp = 0;
let fxPool = [];
let tubeCache = [];        // per-strand tube mesh, rebuilt on each state sync
let motes = null;          // ambient dust in the lamp light (particles: high)
const camBase = new THREE.Vector3();
const camTarget = new THREE.Vector3(0, 0, 0.3);

// Graphics state.
let gpu = '', detected = 'balanced', savedGfx = {};
let gfx = resolve({}, 'balanced');
let composer = null, postKey = null, postFailed = false;
let size = [0, 0], pixelRatio = 1, adaptiveScale = 1, frames = [], fps = 0;
let envTex = null;
const tex = {};            // procedural textures, built once

export function cellToWorld(level, cell) {
  const r = Math.floor(cell / level.cols), c = cell % level.cols;
  return new THREE.Vector3((c - (level.cols - 1) / 2) * CELL, 0, (r - (level.rows - 1) / 2) * CELL);
}

export function worldToScreen(v3) {
  const v = v3.clone().project(camera);
  return { x: (v.x * 0.5 + 0.5) * canvas.clientWidth, y: (-v.y * 0.5 + 0.5) * canvas.clientHeight };
}

function strandColor(i) { return (cvd ? STRAND_COLORS_CVD : STRAND_COLORS)[i % 6]; }
const detailed = () => gfx.detail === 'detailed';
const animated = () => gfx.ambient === 'animated' && !reducedMotion;

/* ---------------- procedural textures (deterministic) ---------------- */

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Tileable value noise on a square lattice.
// Coordinates spanning 0..nx / 0..ny across the texture tile seamlessly.
function makeNoise(seed, nx, ny = nx) {
  const r = rng(seed); const g = new Float32Array(nx * ny).map(() => r());
  const at = (x, y) => g[((y % ny + ny) % ny) * nx + ((x % nx + nx) % nx)];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return (at(xi, yi) * (1 - u) + at(xi + 1, yi) * u) * (1 - v) + (at(xi, yi + 1) * (1 - u) + at(xi + 1, yi + 1) * u) * v;
  };
}

function canvasTexture(w, h, fn, { color = true, repeat = [1, 1] } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y); const i = (y * w + x) * 4;
    img.data[i] = r * 255; img.data[i + 1] = g * 255; img.data[i + 2] = b * 255; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return t;
}

function textures() {
  if (tex.wood) return tex;
  // Wood: long grain along x, growth rings warped by low-frequency noise.
  const n1 = makeNoise(11, 4, 8), n2 = makeNoise(29, 16, 64);
  const woodVal = (x, y, amt) => {
    const u = x / 256, v = y / 256;
    const warp = n1(u * 4, v * 8) * 1.5;
    const ring = 0.5 + 0.5 * Math.sin((v * 16 + warp) * Math.PI * 2);
    const fibre = n2(u * 16, v * 64) - 0.5;
    return 1 - amt * (0.55 * Math.pow(ring, 4) + 0.45 * (0.5 + fibre));
  };
  tex.wood = canvasTexture(256, 256, (x, y) => { const k = woodVal(x, y, 0.22); return [k, k * 0.98, k * 0.95]; });
  tex.woodFine = canvasTexture(256, 256, (x, y) => { const k = woodVal(x, y, 0.12); return [k, k * 0.985, k * 0.965]; });
  tex.woodBump = canvasTexture(256, 256, (x, y) => { const k = woodVal(x, y, 0.5); return [k, k, k]; }, { color: false });
  // Felt: soft fibre flecks.
  const f1 = makeNoise(5, 64), f2 = makeNoise(7, 16);
  const feltVal = (x, y) => 0.86 + 0.1 * f1(x / 2, y / 2) + 0.06 * f2(x / 8, y / 8);
  tex.felt = canvasTexture(128, 128, (x, y) => { const k = feltVal(x, y); return [k, k, k]; }, { repeat: [3, 3] });
  tex.feltBump = canvasTexture(128, 128, (x, y) => { const k = feltVal(x, y); return [k, k, k]; }, { color: false, repeat: [3, 3] });
  // Yarn: twisted plies — diagonal stripes; u runs along the strand, v around it.
  const yarnVal = (x, y) => {
    const s = 0.5 + 0.5 * Math.sin(((x / 64) * 2 + (y / 64) * 3) * Math.PI * 2);
    return 0.72 + 0.28 * Math.pow(s, 0.7);
  };
  tex.yarn = canvasTexture(64, 64, (x, y) => { const k = yarnVal(x, y); return [k, k, k]; });
  tex.yarnBump = canvasTexture(64, 64, (x, y) => { const k = yarnVal(x, y); return [k, k, k]; }, { color: false });
  // Wound thread on a spool: fine horizontal turns with a slight lean.
  const threadVal = (x, y) => 0.78 + 0.22 * Math.pow(0.5 + 0.5 * Math.sin((y / 64 * 18 + x / 64 * 0.5) * Math.PI * 2), 0.6);
  tex.thread = canvasTexture(64, 64, (x, y) => { const k = threadVal(x, y); return [k, k, k]; });
  tex.threadBump = canvasTexture(64, 64, (x, y) => { const k = threadVal(x, y); return [k, k, k]; }, { color: false });
  // Soft round sprite for dust motes and sparks.
  tex.dot = canvasTexture(32, 32, (x, y) => { const d = Math.hypot(x - 15.5, y - 15.5) / 16; const k = Math.max(0, 1 - d) ** 2; return [k, k, k]; }, { color: false });
  return tex;
}

/** Warm lamp-lit backdrop: a radial glow behind the table instead of a flat fill. */
function backdrop(hex) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const base = new THREE.Color(hex);
  const hi = base.clone().lerp(new THREE.Color(0xffd9a0), 0.18).multiplyScalar(1.35);
  const lo = base.clone().multiplyScalar(0.55);
  const g = ctx.createRadialGradient(128, 70, 10, 128, 110, 190);
  g.addColorStop(0, '#' + hi.getHexString()); g.addColorStop(0.55, '#' + base.getHexString()); g.addColorStop(1, '#' + lo.getHexString());
  ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------------- init ---------------- */

function readGpu(gl) {
  try {
    // Firefox exposes the unmasked name through RENDERER and warns on the debug extension.
    const ext = /firefox/i.test(navigator.userAgent) ? null : gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
  } catch { return ''; }
}

function isMobileDevice() {
  try {
    return navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  } catch { return false; }
}

export function initRender(canvasEl) {
  canvas = canvasEl;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  gpu = readGpu(renderer.getContext());
  detected = detectPreset(gpu, { mobile: isMobileDevice() });
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(FRAMING.fov, 1, 0.1, 100);
  // Layers are an authoring/picking concern: the camera draws all of them and
  // every light lits all of them; only the raycaster narrows to LAYER_GAME.
  camera.layers.enableAll();

  // Key: a warm work lamp above-left. Rim: cool window light from behind for strand silhouettes.
  keyLight = new THREE.DirectionalLight(0xfff2e0, KEY_INTENSITY);
  keyLight.position.copy(KEY_DIR).multiplyScalar(14);
  keyLight.shadow.bias = -0.0004;
  keyLight.shadow.normalBias = 0.02;
  keyLight.shadow.radius = 3;
  rimLight = new THREE.DirectionalLight(0xbcd2ff, 0.45);
  rimLight.position.set(-4, 5, -7);
  hemi = new THREE.HemisphereLight(0xcfd8e6, 0x3a2c22, 0.85);
  amb = new THREE.AmbientLight(0xffffff, 0.25);
  for (const l of [keyLight, rimLight, hemi, amb]) { l.layers.enableAll(); scene.add(l); }
  scene.add(keyLight.target);

  // Selection ring + ghost preview live on the selection layer.
  selRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.42, 0.05, 10, 32),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })
  );
  selRing.rotation.x = -Math.PI / 2;
  selRing.layers.set(LAYER_SELECT);
  selRing.visible = false;
  scene.add(selRing);
  ghost = new THREE.Mesh(
    new THREE.SphereGeometry(STRAND_R * 1.1, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 })
  );
  ghost.layers.set(LAYER_SELECT);
  ghost.visible = false;
  scene.add(ghost);

  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); cancelAnimationFrame(rafId); });
  canvas.addEventListener('webglcontextrestored', () => {
    envTex = null; postKey = null;
    applyEnvironment();
    if (levelRef) rebuild();
    resize(); loop(performance.now());
  });

  setGraphics(savedGfx);
  resize();
  return { ok: true };
}

/* ---------------- graphics settings ---------------- */

/** Apply saved graphics settings ({ preset, render_scale, adaptive, show_fps, <category> }). Live, no reload. */
export function setGraphics(saved) {
  savedGfx = saved || {};
  const prev = gfx;
  gfx = resolve(savedGfx, detected);
  document.body.dataset.gfxPreset = gfx.preset;
  document.body.dataset.gfxAuto = String(gfx.auto);
  if (canvas) canvas.dataset.gfxPreset = gfx.preset;
  if (!renderer) return;
  const sz = SHADOW_MAP[gfx.shadows];
  renderer.shadowMap.enabled = sz > 0;
  keyLight.castShadow = sz > 0;
  if (sz > 0 && keyLight.shadow.mapSize.x !== sz) {
    keyLight.shadow.mapSize.set(sz, sz);
    keyLight.shadow.map?.dispose();
    keyLight.shadow.map = null;
  }
  applyEnvironment();
  if (prev.detail !== gfx.detail || prev.particles !== gfx.particles) rebuild();
  adaptiveScale = 1; frames = [];
  postKey = null; postFailed = false; // rebuild the post chain on the next frame
  fpsVisible(gfx.showFps);
  // Materials pick up shadow-map / environment changes on recompile.
  scene.traverse((o) => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; }); });
}

/** What the settings panel shows: GPU, auto choice, resolved tiers, cost summary. */
export function graphicsInfo(labels) {
  const px = [Math.round(size[0] * pixelRatio), Math.round(size[1] * pixelRatio)];
  return { gpu, detected, resolved: gfx, summary: describe(gfx, px, labels), fps: Math.round(fps), adaptiveScale, postFailed, available: !!renderer };
}

export function getDetectedPreset() { return detected; }

function applyEnvironment() {
  if (!scene) return;
  if (gfx.reflections === 'on') {
    if (!envTex) {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const room = new RoomEnvironment();
      envTex = pmrem.fromScene(room, 0.04).texture;
      room.dispose?.(); pmrem.dispose();
    }
    scene.environment = envTex;
    scene.environmentIntensity = 0.42;
    hemi.intensity = 0.5; amb.intensity = 0.08;
  } else {
    scene.environment = null;
    hemi.intensity = 0.85; amb.intensity = 0.25;
  }
}

function fpsVisible(on) {
  let el = document.getElementById('fps-meter');
  if (on && !el) {
    el = document.createElement('div');
    el.id = 'fps-meter';
    el.setAttribute('aria-hidden', 'true');
    document.body.append(el);
  }
  if (el) el.hidden = !on;
}

export function setReducedMotion(v) { reducedMotion = v; }
export function setCvdPalette(v) { if (cvd === v) return; cvd = v; if (levelRef) rebuild(); }

export function resize() {
  if (!renderer) return;
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  camera.aspect = w / h;
  // Fit the board: pull back in portrait.
  const lvl = levelRef;
  const fit = lvl ? Math.max(lvl.cols, lvl.rows) : 5;
  const portraitBoost = h > w ? 1.45 : 1.0;
  const dist = FRAMING.dist * (fit / 5) * portraitBoost;
  camBase.set(0, dist * FRAMING.tilt * 2, dist * (1 - FRAMING.tilt * 0.4));
  camera.position.copy(camBase);
  camera.lookAt(camTarget);
  camera.clearViewOffset();
  camera.aspect = w / h; // clearViewOffset keeps it, setViewOffset would not
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  applyPlayFrame(w, h);
  size = [0, 0]; // re-apply drawing-buffer size on the next frame
}

/* ---------------- play framing ---------------- */

let chromeFn = null;

/**
 * `fn()` returns the HUD elements over the canvas during play (null off the
 * play screen). The board is framed into the canvas rect they leave free.
 */
export function setFramingChrome(fn) { chromeFn = fn; }

/** Re-fit the board after the HUD appeared, vanished or changed size. */
export function reframe() { resize(); }

function ndcBounds(points) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const v = new THREE.Vector3();
  for (const p of points) {
    v.copy(p).project(camera);
    x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
  }
  return { x0, x1, y0, y1 };
}

/**
 * Lens shift + zoom (setViewOffset) over the authored camera: the board
 * (frame + spools) fills the canvas left free by the HUD. Full-width bars
 * and full-height rails are always kept clear; smaller corner pieces (the
 * docked board mirror, a short action column) only when the board would end
 * up beneath them. The authored position/angle and picking stay unchanged.
 */
function applyPlayFrame(W, H) {
  const chrome = showcase ? null : chromeFn?.();
  if (!chrome || !levelRef) return;
  const hx = levelRef.cols * CELL * 0.5 + 0.45, hz = levelRef.rows * CELL * 0.5 + 0.45;
  const pts = [];
  for (const x of [-hx, hx]) for (const y of [0, 0.7]) for (const z of [-hz, hz]) pts.push(new THREE.Vector3(x, y, z));
  const b = ndcBounds(pts);
  const ins = { t: 0, b: 0, l: 0, r: 0 };
  const inset = (p, axis) => {
    if (axis === 'v') {
      if ((p.y0 + p.y1) / 2 < H / 2) ins.t = Math.max(ins.t, p.y1); else ins.b = Math.max(ins.b, H - p.y0);
    } else if ((p.x0 + p.x1) / 2 < W / 2) ins.l = Math.max(ins.l, p.x1); else ins.r = Math.max(ins.r, W - p.x0);
  };
  const pieces = [];
  for (const el of chrome) {
    const r = el.getBoundingClientRect();
    const p = { x0: Math.max(0, r.left), x1: Math.min(W, r.right), y0: Math.max(0, r.top), y1: Math.min(H, r.bottom) };
    if (p.x1 - p.x0 < 1 || p.y1 - p.y0 < 1) continue;
    if (p.x1 - p.x0 > W * 0.5) inset(p, 'v');
    else if (p.y1 - p.y0 > H * 0.5) inset(p, 'h');
    else pieces.push(p);
  }
  const m = Math.round(Math.min(W, H) * 0.03);
  const toNdc = (r) => ({ x0: (2 * r.x0) / W - 1, x1: (2 * r.x1) / W - 1, y0: 1 - (2 * r.y1) / H, y1: 1 - (2 * r.y0) / H });
  let f = null;
  for (let pass = 0, passes = pieces.length; pass <= passes; pass++) {
    const sx0 = ins.l + m, sx1 = W - ins.r - m, sy0 = ins.t + m, sy1 = H - ins.b - m;
    if (sx1 - sx0 < W * 0.3 || sy1 - sy0 < H * 0.3) break;
    const s = toNdc({ x0: sx0, x1: sx1, y0: sy0, y1: sy1 });
    const z = Math.min(3, Math.max(0.3, Math.min((s.x1 - s.x0) / (b.x1 - b.x0), (s.y1 - s.y0) / (b.y1 - b.y0))));
    // Board centre c lands on free-rect centre: (c - window) · z = centre.
    f = { z, x: (b.x0 + b.x1) / 2 - (s.x0 + s.x1) / 2 / z, y: (b.y0 + b.y1) / 2 - (s.y0 + s.y1) / 2 / z };
    const sb = { x0: (b.x0 - f.x) * z, x1: (b.x1 - f.x) * z, y0: (b.y0 - f.y) * z, y1: (b.y1 - f.y) * z };
    const hit = pieces.find((p) => {
      const q = toNdc(p);
      return sb.x0 < q.x1 && sb.x1 > q.x0 && sb.y0 < q.y1 && sb.y1 > q.y0;
    });
    if (!hit) break;
    pieces.splice(pieces.indexOf(hit), 1);
    const costV = ((hit.y0 + hit.y1) / 2 < H / 2 ? hit.y1 : H - hit.y0) / H;
    const costH = ((hit.x0 + hit.x1) / 2 < W / 2 ? hit.x1 : W - hit.x0) / W;
    inset(hit, costV <= costH ? 'v' : 'h');
  }
  if (!f) return;
  // Virtual frame = the authored view (2·aspect × 2); render the 2/z window centred on (x, y).
  const A = camera.aspect, sz = 2 / f.z;
  camera.setViewOffset(2 * A, 2, (f.x + 1 - sz / 2) * A, 1 - f.y - sz / 2, sz * A, sz);
}

/* ---------------- level construction ---------------- */

function disposeWorld() {
  if (!world) return;
  world.traverse((o) => {
    o.geometry?.dispose?.();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
  });
  scene.remove(world);
  world = null;
  boardCells = []; spoolMeshes = []; strandGroups = [];
  fxPool = [];
  tubeCache = [];   // tubes lived inside `world`; they are gone with it
  motes = null;
}

function rebuild() {
  if (!levelRef) return;
  buildLevel(levelRef, { showcase, keepState: true });
  if (lastState) syncState(lastState, lastSelection);
}

function beadMaterial(color, emissive) {
  const params = { color, roughness: 0.4, emissive: emissive ? color : 0x000000, emissiveIntensity: emissive ? 0.15 : 1 };
  if (!detailed()) return new THREE.MeshStandardMaterial(params);
  // Glossy lacquered wooden bead.
  return new THREE.MeshPhysicalMaterial({ ...params, roughness: 0.48, clearcoat: 0.6, clearcoatRoughness: 0.4 });
}

function strandMaterial(color) {
  if (!detailed()) return new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
  const t = textures();
  // Soft yarn: twisted-ply texture plus a fibre sheen at grazing angles.
  return new THREE.MeshPhysicalMaterial({
    color, roughness: 0.78, map: t.yarn, bumpMap: t.yarnBump, bumpScale: 1.4,
    sheen: 0.8, sheenRoughness: 0.45, sheenColor: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.3),
  });
}

function tableMap(t) {
  const m = t.wood.clone(); m.repeat.set(3, 3);
  return m;
}

function makeSpool(color) {
  const g = new THREE.Group();
  if (!detailed()) {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.55, 24), new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.6 }));
    body.castShadow = true;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.315, 0.315, 0.3, 24), new THREE.MeshStandardMaterial({ color, roughness: 0.55 }));
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.06, 24), new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.6 }));
    cap.position.y = 0.3;
    g.add(body, band, cap);
    return g;
  }
  const t = textures();
  // Turned wooden bobbin: flanged lathe profile, with wound thread in the waist.
  const prof = [[0, -0.3], [0.37, -0.3], [0.39, -0.27], [0.37, -0.22], [0.25, -0.2], [0.24, 0.2], [0.37, 0.22], [0.39, 0.27], [0.37, 0.3], [0.1, 0.31], [0.08, 0.26], [0, 0.26]]
    .map(([x, y]) => new THREE.Vector2(x, y));
  const wood = new THREE.MeshPhysicalMaterial({ color: 0x9a7650, roughness: 0.5, map: t.wood, clearcoat: 0.5, clearcoatRoughness: 0.35 });
  const body = new THREE.Mesh(new THREE.LatheGeometry(prof, 32), wood);
  body.castShadow = true; body.receiveShadow = true;
  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(0.325, 0.325, 0.4, 32, 1, true),
    new THREE.MeshPhysicalMaterial({ color, roughness: 0.7, map: t.thread, bumpMap: t.threadBump, bumpScale: 1.2, sheen: 0.6, sheenRoughness: 0.5, sheenColor: new THREE.Color(color) })
  );
  band.castShadow = true;
  // Coloured label disc on top so the spool's colour reads from the playing angle.
  const label = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 28), new THREE.MeshPhysicalMaterial({ color, roughness: 0.45, clearcoat: 0.6 }));
  label.position.y = 0.305;
  g.add(body, band, label);
  return g;
}

function addProps(level) {
  const hx = level.cols * CELL * 0.5, hz = level.rows * CELL * 0.5;
  const env = (m) => { m.layers.set(LAYER_ENV); m.castShadow = true; m.receiveShadow = true; world.add(m); return m; };
  // Needle cushion.
  const cushionMat = detailed()
    ? new THREE.MeshPhysicalMaterial({ color: 0xa03040, roughness: 0.9, map: textures().felt, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xff9aa8) })
    : new THREE.MeshStandardMaterial({ color: 0xa03040, roughness: 0.9 });
  const cushion = env(new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), cushionMat));
  cushion.position.set(hx + 1.2, -0.1, -hz - 0.6);
  if (!detailed()) return;
  const t = textures();
  // Pins in the cushion.
  const r = rng(level.cols * 131 + level.rows);
  const pinHeads = [0xe8b54a, 0xf5efe6, 0x2878d6, 0x32aa3c, 0xd62828];
  const shaft = new THREE.MeshStandardMaterial({ color: 0xcfd3d8, metalness: 1, roughness: 0.25 });
  for (let i = 0; i < 6; i++) {
    const a = r() * Math.PI * 2, tilt = 0.25 + r() * 0.5;
    const pin = new THREE.Group();
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.45, 6), shaft);
    s.position.y = 0.22;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), new THREE.MeshPhysicalMaterial({ color: pinHeads[i % pinHeads.length], roughness: 0.25, clearcoat: 1 }));
    head.position.y = 0.45;
    pin.add(s, head);
    pin.traverse((o) => { o.layers.set(LAYER_ENV); o.castShadow = true; });
    pin.position.set(cushion.position.x + Math.cos(a) * 0.25, cushion.position.y + 0.2, cushion.position.z + Math.sin(a) * 0.25);
    pin.rotation.set(Math.sin(a) * tilt, 0, -Math.cos(a) * tilt);
    world.add(pin);
  }
  // Brass thimble.
  const thimProf = [[0.2, -0.02], [0.22, -0.02], [0.21, 0], [0.19, 0.15], [0.17, 0.27], [0.12, 0.31], [0, 0.32]].map(([x, y]) => new THREE.Vector2(x, y));
  const thimble = env(new THREE.Mesh(new THREE.LatheGeometry(thimProf, 28), new THREE.MeshStandardMaterial({ color: 0xd8b26a, metalness: 1, roughness: 0.3, bumpMap: t.feltBump, bumpScale: 2 })));
  thimble.position.set(-hx - 1.1, -0.08, hz + 0.3);
  // Ball of spare yarn.
  const ball = env(new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 20), new THREE.MeshPhysicalMaterial({
    color: 0x6f8fb8, roughness: 0.85, map: t.thread, bumpMap: t.threadBump, bumpScale: 2, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xcfe0ff),
  })));
  ball.rotation.set(0.6, 0.3, 0.9);
  ball.position.set(-hx - 1.3, 0.3, -hz + 0.4);
  // Running stitch around the felt pad.
  const stitch = new THREE.BoxGeometry(0.15, 0.018, 0.028);
  const perim = [];
  const ex = hx + 0.25, ez = hz + 0.25;
  for (let x = -ex + 0.1; x <= ex - 0.1; x += 0.3) { perim.push([x, -ez, 0], [x, ez, 0]); }
  for (let z = -ez + 0.1; z <= ez - 0.1; z += 0.3) { perim.push([-ex, z, Math.PI / 2], [ex, z, Math.PI / 2]); }
  const stitches = new THREE.InstancedMesh(stitch, new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.cloth).lerp(new THREE.Color(0xe8d5b0), 0.45), roughness: 0.9 }), perim.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
  perim.forEach(([x, z, rot], i) => stitches.setMatrixAt(i, m4.compose(new THREE.Vector3(x, -0.015, z), q.setFromAxisAngle(up, rot), one)));
  stitches.layers.set(LAYER_ENV);
  stitches.receiveShadow = true;
  world.add(stitches);
}

function buildMotes(level) {
  if (gfx.particles !== 'high') return;
  const n = 90, r = rng(77);
  const pos = new Float32Array(n * 3);
  const span = Math.max(level.cols, level.rows) * CELL + 2;
  for (let i = 0; i < n; i++) { pos[i * 3] = (r() - 0.5) * span; pos[i * 3 + 1] = 0.3 + r() * 3.2; pos[i * 3 + 2] = (r() - 0.5) * span; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  motes = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xffe2b0, size: 0.06, map: textures().dot, alphaMap: textures().dot, transparent: true, opacity: 0.55,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  motes.userData = { span, seed: Array.from({ length: n }, () => r() * Math.PI * 2) };
  motes.layers.set(LAYER_FX);
  world.add(motes);
}

/** Fit the key light's shadow box tightly around the board and its props. */
function fitShadow(level) {
  const half = Math.max(level.cols, level.rows) * CELL * 0.5 + 2.2;
  const sc = keyLight.shadow.camera;
  sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
  sc.near = 4; sc.far = 26;
  sc.updateProjectionMatrix();
  keyLight.target.position.set(0, 0, 0);
}

export function buildLevel(level, opts = {}) {
  levelRef = level;
  showcase = !!opts.showcase;
  if (!opts.showcase && !opts.keepState) { lastState = null; lastSelection = -1; }
  theme = THEMES[level.theme % THEMES.length];
  if (!renderer || !scene) return;   // no WebGL: the DOM mirror is the playfield
  disposeWorld();
  world = new THREE.Group();
  if (scene.background?.isTexture) scene.background.dispose();
  scene.background = detailed() ? backdrop(theme.bg) : new THREE.Color(theme.bg);
  const t = detailed() ? textures() : null;

  // Table.
  const tableSize = Math.max(level.cols, level.rows) * CELL + 6;
  const table = new THREE.Mesh(
    new THREE.BoxGeometry(tableSize, 0.5, tableSize),
    detailed()
      ? new THREE.MeshStandardMaterial({ color: theme.table, roughness: 0.62, metalness: 0.02, map: tableMap(t), bumpMap: t.woodBump, bumpScale: 1 })
      : new THREE.MeshStandardMaterial({ color: theme.table, roughness: 0.75, metalness: 0.05 })
  );
  table.position.y = -0.35;
  table.receiveShadow = true;
  table.layers.set(LAYER_ENV);
  world.add(table);

  // Board cloth pad under cells.
  const pad = new THREE.Mesh(
    new THREE.BoxGeometry(level.cols * CELL + 0.7, 0.08, level.rows * CELL + 0.7),
    detailed()
      ? new THREE.MeshPhysicalMaterial({ color: theme.cloth, roughness: 1, map: t.felt, bumpMap: t.feltBump, bumpScale: 2, sheen: 1, sheenRoughness: 0.6, sheenColor: new THREE.Color(theme.cloth).multiplyScalar(2.2) })
      : new THREE.MeshStandardMaterial({ color: theme.cloth, roughness: 1 })
  );
  pad.position.y = -0.06;
  pad.receiveShadow = true;
  pad.layers.set(LAYER_ENV);
  world.add(pad);

  // Cells (pickable): bevelled wooden tiles when detailed.
  const cellGeo = detailed()
    ? new RoundedBoxGeometry(CELL * 0.94, 0.12, CELL * 0.94, 2, 0.035)
    : new THREE.BoxGeometry(CELL * 0.94, 0.12, CELL * 0.94);
  const cellMat = (color, ox) => {
    if (!detailed()) return new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
    const map = t.woodFine.clone(); map.offset.set(ox, ox * 0.37);
    return new THREE.MeshStandardMaterial({ color, roughness: 0.72, map, bumpMap: t.woodBump, bumpScale: 0.5 });
  };
  const matA = cellMat(theme.boardA, 0.13), matB = cellMat(theme.boardB, 0.61);
  for (let cell = 0; cell < level.cols * level.rows; cell++) {
    const r = Math.floor(cell / level.cols), c = cell % level.cols;
    const m = new THREE.Mesh(cellGeo, (r + c) % 2 ? matA : matB);
    m.position.copy(cellToWorld(level, cell));
    m.receiveShadow = true;
    m.userData = { cell };
    m.layers.set(LAYER_GAME);
    boardCells.push(m);
    world.add(m);
  }

  // Spools: wooden bobbin with colored thread band (color + distinct band pattern per index).
  level.strands.forEach((s, i) => {
    const g = makeSpool(strandColor(s.color));
    g.position.copy(cellToWorld(level, s.spool));
    g.position.y = 0.35;
    g.userData = { strand: i, spool: true };
    g.traverse((o) => { o.userData = { strand: i, spool: true }; o.layers.set(LAYER_GAME); });
    spoolMeshes.push(g);
    world.add(g);
  });

  // Strands: anchor bead + tube rebuilt on state updates.
  level.strands.forEach((s, i) => {
    const g = new THREE.Group();
    g.userData = { strand: i };
    const anchor = new THREE.Mesh(new THREE.SphereGeometry(0.26, 24, 18), beadMaterial(strandColor(s.color), false));
    anchor.material.roughness = detailed() ? 0.5 : 0.45;
    anchor.castShadow = true;
    anchor.userData = { strand: i, anchor: true };
    anchor.layers.set(LAYER_GAME);
    g.add(anchor);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.24, 24, 18), beadMaterial(strandColor(s.color), true));
    tip.castShadow = true;
    tip.userData = { strand: i, tip: true };
    tip.layers.set(LAYER_GAME);
    g.add(tip);
    strandGroups.push(g);
    world.add(g);
  });

  addProps(level);
  buildMotes(level);
  fitShadow(level);

  scene.add(world);
  resize();
}

/** Title backdrop: a decorative board mid-solve behind the menu, with a slow camera drift. */
export function showShowcase(level, state) {
  if (!renderer) return;
  buildLevel(level, { showcase: true });
  syncState(state, -1);
}

/* ---------------- state -> view sync ---------------- */

export function syncState(state, selection = -1) {
  lastState = state; lastSelection = selection;
  if (!world || !levelRef) return;
  state.strands.forEach((s, i) => {
    const g = strandGroups[i];
    if (!g) return;
    // Remove old tube.
    if (tubeCache[i]) {
      g.remove(tubeCache[i]);
      tubeCache[i].geometry.dispose();
      tubeCache[i].material.dispose();
      tubeCache[i] = null;
    }
    const pts = s.path.map((cell) => {
      const p = cellToWorld(levelRef, cell);
      p.y = 0.18;
      return p;
    });
    const anchor = g.children.find((o) => o.userData.anchor);
    const tip = g.children.find((o) => o.userData.tip);
    anchor.position.copy(pts[0]);
    tip.position.copy(pts[pts.length - 1]);
    const doneFade = s.done ? 0.15 : 1;
    [anchor, tip].forEach((m) => {
      m.material.transparent = s.done;
      m.material.opacity = doneFade;
      m.material.emissiveIntensity = i === selection ? 0.8 : m.userData.tip ? 0.15 : 0;
    });
    const lift = i === selection && !reducedMotion ? 0.14 : 0;
    anchor.position.y += lift; tip.position.y += lift;
    if (pts.length >= 2 && !s.done) {
      const curve = new THREE.CatmullRomCurve3(pts.map((p) => p.clone().add(new THREE.Vector3(0, lift, 0))));
      const segs = Math.max(8, pts.length * (detailed() ? 10 : 6));
      const geo = new THREE.TubeGeometry(curve, segs, STRAND_R, detailed() ? 14 : 10, false);
      // Stretch the yarn texture so the twist keeps a constant pitch along the strand.
      const uv = geo.attributes.uv, len = curve.getLength() * 2.2;
      for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) * len);
      const tube = new THREE.Mesh(geo, strandMaterial(strandColor(s.color)));
      tube.castShadow = true;
      tube.receiveShadow = detailed();
      tube.userData = { strand: i };
      tube.layers.set(LAYER_GAME);
      tubeCache[i] = tube;
      g.add(tube);
    }
    // Spool celebration scale when done (pulses per frame when ambient motion is on).
    const spool = spoolMeshes[i];
    if (spool) { spool.userData.done = s.done; spool.scale.setScalar(s.done ? 1.05 : 1); }
    // Selection ring at the tip.
    if (i === selection && !s.done) {
      selRing.visible = true;
      selRing.position.copy(tip.position);
      selRing.position.y = 0.07;
      selRing.material.color.setHex(strandColor(s.color)).multiplyScalar(1.4);
    }
  });
  if (selection < 0) selRing.visible = false;
}

export function showGhost(worldPos, colorIdx, visible) {
  if (!ghost) return;
  ghost.visible = visible;
  if (visible) {
    ghost.position.copy(worldPos);
    ghost.position.y = 0.2;
    ghost.material.color.setHex(strandColor(colorIdx));
  }
}

export function shake(amount) { if (!reducedMotion) shakeAmp = Math.min(0.15, amount); }

let sparkGeo = null;
export function burstAt(worldPos, colorIdx) {
  if (!world || reducedMotion || gfx.particles === 'off') return;
  const n = gfx.particles === 'low' ? 8 : 16;
  sparkGeo ||= new THREE.SphereGeometry(0.05, 6, 6);
  for (let i = 0; i < n; i++) {
    // Over-bright sparks so they (and only they) catch the bloom at the reel moment.
    const p = new THREE.Mesh(sparkGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(strandColor(colorIdx)).multiplyScalar(2.2), transparent: true }));
    p.position.copy(worldPos);
    p.userData = {
      vel: new THREE.Vector3((Math.random() - 0.5) * 2.4, Math.random() * 2.5 + 0.5, (Math.random() - 0.5) * 2.4),
      life: 1, spark: true,
    };
    p.layers.set(LAYER_FX);
    world.add(p);
    fxPool.push(p);
  }
}

/* ---------------- picking ---------------- */

const raycaster = new THREE.Raycaster();
const pointerV = new THREE.Vector2();

/** Raycast only gameplay-layer objects. Returns { kind, cell?, strand? } or null. */
export function pick(clientX, clientY) {
  if (!renderer || !levelRef) return null;
  // Camera shake/drift must never change raycast truth: pick with the authored camera.
  const shaken = camera.position.clone();
  camera.position.copy(camBase);
  camera.lookAt(camTarget);
  camera.updateMatrixWorld();
  const rect = canvas.getBoundingClientRect();
  pointerV.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerV.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerV, camera);
  raycaster.layers.set(LAYER_GAME);
  const targets = [...boardCells];
  for (const g of spoolMeshes) targets.push(...g.children);
  for (const g of strandGroups) targets.push(...g.children);
  const hits = raycaster.intersectObjects(targets, false);
  camera.position.copy(shaken);
  camera.lookAt(camTarget);
  camera.updateMatrixWorld();
  if (!hits.length) return null;
  const u = hits[0].object.userData;
  if (u.spool) return { kind: 'spool', strand: u.strand, cell: levelRef.strands[u.strand].spool };
  // Strand beads/tubes span cells: report which cell was touched so callers can
  // tell "pull back one cell" from "that is my own body".
  if (u.strand !== undefined) return { kind: 'strand', strand: u.strand, cell: worldToCell(hits[0].point) };
  if (u.cell !== undefined) return { kind: 'cell', cell: u.cell };
  return null;
}

/** Inverse of cellToWorld; undefined when the point falls outside the board. */
export function worldToCell(point) {
  if (!levelRef) return undefined;
  const c = Math.round(point.x / CELL + (levelRef.cols - 1) / 2);
  const r = Math.round(point.z / CELL + (levelRef.rows - 1) / 2);
  if (c < 0 || c >= levelRef.cols || r < 0 || r >= levelRef.rows) return undefined;
  return r * levelRef.cols + c;
}

/* ---------------- post-processing ---------------- */

// Colour grade + vignette, applied in display space after tone mapping: a gentle
// S-curve (never flattens contrast), slight saturation, warm lamp highlights.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.26 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.18);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.07);
      s *= mix(vec3(0.97, 0.99, 1.03), vec3(1.035, 1.0, 0.955), smoothstep(0.25, 0.85, l));
      c = mix(c, s, uAmount);
      float d = length((vUv - 0.5) * vec2(1.0, 0.85));
      c *= 1.0 - uVignette * smoothstep(0.38, 0.8, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

function makePostKey(w, h) {
  return gfx.post ? [gfx.ao, gfx.bloom, gfx.grade, gfx.antialias, w, h, pixelRatio].join('|') : 'none';
}

function buildPost(w, h) {
  composer?.dispose?.();
  composer = null;
  if (!gfx.post || postFailed) return;
  const pw = Math.max(1, Math.round(w * pixelRatio)), ph = Math.max(1, Math.round(h * pixelRatio));
  try {
    const target = new THREE.WebGLRenderTarget(pw, ph, { type: THREE.HalfFloatType, samples: gfx.antialias === 'msaa' ? 4 : 0 });
    const c = new EffectComposer(renderer, target);
    c.setPixelRatio(pixelRatio);
    c.setSize(w, h);
    c.addPass(new RenderPass(scene, camera));
    if (gfx.ao !== 'off') {
      // Contact darkening where strands, beads and spools meet the board.
      const ao = new GTAOPass(scene, camera, pw, ph);
      ao.output = GTAOPass.OUTPUT.Default;
      ao.blendIntensity = gfx.ao === 'high' ? 0.85 : 0.7;
      ao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 1.5, thickness: 1.0, scale: 1.0, samples: gfx.ao === 'high' ? 16 : 8 });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: gfx.ao === 'high' ? 6 : 4, rings: 2, samples: gfx.ao === 'high' ? 16 : 8 });
      c.addPass(ao);
    }
    // High threshold: only the selected tip, reel sparks and hot highlights bloom.
    if (gfx.bloom === 'on') c.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.5, 0.45, 0.88));
    c.addPass(new OutputPass());
    if (gfx.grade === 'on') c.addPass(new ShaderPass(GradeShader));
    if (gfx.antialias === 'smaa') c.addPass(new SMAAPass());
    if (gfx.antialias === 'fxaa') {
      const fxaa = new ShaderPass(FXAAShader);
      fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
      c.addPass(fxaa);
    }
    composer = c;
  } catch {
    // Post-processing is an enhancement: render directly and let the Graphics panel say so.
    postFailed = true;
    composer = null;
  }
}

// Adaptive resolution: step the render scale down when frames are slow, back up when fast.
function adapt(ms) {
  frames.push(ms);
  if (frames.length < 90) return false;
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
  frames.length = 0;
  fps = 1000 / avg;
  const el = document.getElementById('fps-meter');
  if (el && !el.hidden) el.textContent = `${Math.round(fps)} fps · ${Math.round(pixelRatio * 100) / 100}×`;
  if (!gfx.adaptive) return false;
  const before = adaptiveScale;
  if (avg > 26) adaptiveScale = Math.max(0.6, adaptiveScale - 0.1);
  else if (avg < 14 && adaptiveScale < 1) adaptiveScale = Math.min(1, adaptiveScale + 0.05);
  return before !== adaptiveScale;
}

/* ---------------- frame loop ---------------- */

export function onFrame(cb) { onFrameCb = cb; }
export function setHidden(v) {
  hidden = v;
  if (!hidden && renderer) { lastTime = performance.now(); frames = []; loop(lastTime); }
}

function loop(now) {
  cancelAnimationFrame(rafId);
  if (!renderer || hidden) return;
  const ms = Math.min(250, now - lastTime || 16);
  const dt = Math.min(0.05, ms / 1000);
  lastTime = now;
  const moving = animated();
  if (!reducedMotion) animT += dt;

  // Camera: authored base + slow drift on the title backdrop + event shake. Never affects picking.
  camera.position.copy(camBase);
  if (showcase && moving) {
    const a = Math.sin(animT * 0.12) * 0.32;
    camera.position.set(camBase.x * Math.cos(a) + camBase.z * Math.sin(a), camBase.y, -camBase.x * Math.sin(a) + camBase.z * Math.cos(a));
  }
  if (shakeAmp > 0.001) {
    camera.position.x += (Math.random() - 0.5) * shakeAmp;
    shakeAmp *= Math.pow(0.001, dt); // fast decay
  }
  camera.lookAt(camTarget);

  // Ambient motion: lamp shimmer, selection-ring breathing, reeled spools pulsing, drifting dust.
  keyLight.intensity = KEY_INTENSITY * (moving ? 1 + 0.025 * Math.sin(animT * 1.3) + 0.015 * Math.sin(animT * 3.7) : 1);
  selRing.scale.setScalar(moving ? 1 + 0.06 * Math.sin(animT * 4) : 1);
  for (const sp of spoolMeshes) if (sp.userData.done) sp.scale.setScalar(moving ? 1.05 + Math.sin(animT * 3) * 0.03 : 1.05);
  if (motes && moving) {
    const p = motes.geometry.attributes.position, seed = motes.userData.seed, span = motes.userData.span;
    for (let i = 0; i < p.count; i++) {
      let y = p.getY(i) + dt * 0.08;
      if (y > 3.6) y = 0.3;
      p.setY(i, y);
      p.setX(i, p.getX(i) + Math.sin(animT * 0.5 + seed[i]) * dt * 0.05);
      if (Math.abs(p.getX(i)) > span / 2) p.setX(i, -Math.sign(p.getX(i)) * span / 2);
    }
    p.needsUpdate = true;
  }

  // FX particles.
  for (let i = fxPool.length - 1; i >= 0; i--) {
    const p = fxPool[i];
    p.userData.life -= dt * 1.4;
    if (p.userData.life <= 0) {
      world?.remove(p); p.material.dispose();
      fxPool.splice(i, 1);
      continue;
    }
    p.position.addScaledVector(p.userData.vel, dt);
    p.userData.vel.y -= 4 * dt;
    p.material.opacity = p.userData.life;
  }

  if (onFrameCb) onFrameCb(dt);

  // Pixel ratio = min(dpr, preset cap) × preset/user scale × adaptive scale.
  const rescale = adapt(ms);
  const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
  const ratio = Math.min(window.devicePixelRatio || 1, gfx.dprCap) * gfx.scale * adaptiveScale;
  if (w !== size[0] || h !== size[1] || ratio !== pixelRatio || rescale) {
    size = [w, h];
    pixelRatio = ratio;
    renderer.setPixelRatio(ratio);
    renderer.setSize(w, h, false);
  }
  const key = makePostKey(w, h);
  if (key !== postKey) { postKey = key; buildPost(w, h); }
  if (composer) {
    try { composer.render(dt); } catch { postFailed = true; composer = null; renderer.render(scene, camera); }
  } else renderer.render(scene, camera);
  rafId = requestAnimationFrame(loop);
}

export function startLoop() { lastTime = performance.now(); loop(lastTime); }

export function getDrawStats() {
  if (!renderer) return null;
  return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
}
