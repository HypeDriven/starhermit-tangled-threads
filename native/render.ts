// The cozy fiber-art worktable on starhermit:scene, as the browser build's
// src/render.js drew it with three.js r185: the authored perspective camera
// (42°, pulled back in portrait), the walnut/rosewood/… table and felt pad,
// the checkered wooden cells (bevelled when detailed), a bobbin per strand
// (lathe-turned with wound thread and a coloured label when detailed), each
// strand as an anchor bead, a yarn tube along its path and a glowing tip
// bead (lifted when selected, with the breathing selection ring), the props
// (needle cushion; pins, brass thimble, yarn ball and the running stitch
// when detailed), dust motes in the lamp light, reel sparks, the hover ghost,
// the event shake and the title backdrop's slow camera drift.
//
// Engine minor 23 follows three.js r185: the lights keep render.js's
// intensities (no ÷ π) and the key light's shadow uses render.js's own
// shadow camera (fitShadow), bias, normal bias and radius with PCF. The
// reflections are render.js's: the RoomEnvironment through PMREM (sigma
// 0.04) as scene.environment at environmentIntensity 0.42 (the hemisphere
// and ambient fill lowered with it); r185's RoomEnvironment() is the
// 900-candela room lowered 3.5, so the port passes the renderer and sets
// position.y = -3.5 (engine spec, Porting environments). The old composer
// (RenderPass in half floats → GTAO → UnrealBloom 0.5 / 0.45 / 0.88 →
// OutputPass with ACES at 1.05 → the display-space grade + vignette →
// SMAA / FXAA, or the canvas's MSAA) is the runtime's renderer.ao / bloom /
// grade / antialias. The procedural textures are baked into assets/tex
// (tools/bake-textures.mjs: render.js's noise, per-pixel painting is too slow
// in the engine's interpreter). MeshPhysicalMaterial's sheen (the yarn's,
// felt's and thread's fibre sheen) is not drawn by the engine.
//
// The old canvas filled the window behind the DOM HUD; the board is framed
// into the rectangle the HUD leaves free with a view offset (render.js
// applyPlayFrame, unchanged), from the HUD pieces' window rectangles.
import {
  ACESFilmicToneMapping, AdditiveBlending, AmbientLight, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CatmullRomCurve3,
  Color, CylinderGeometry, DirectionalLight, Group, HemisphereLight, InstancedMesh, LatheGeometry, Matrix4, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, PCFShadowMap, PMREMGenerator, PerspectiveCamera, Points,
  PointsMaterial, Quaternion, Raycaster, RepeatWrapping, RoomEnvironment, RoundedBoxGeometry, SRGBColorSpace, NoColorSpace,
  SphereGeometry, TextureLoader, TorusGeometry, TubeGeometry, Vector2, Vector3, pointerToNdc, renderer, scene,
  type Material, type Object3D, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import { Content, type LevelDef, type State, type Theme } from "./game.ts";
import { MOTE_MAX, sparkCount, type Look } from "./quality.ts";

export interface Rect { x: number; y: number; width: number; height: number }
const CELL = 1.0;
const STRAND_R = 0.16;
const FRAMING = { dist: 9.5, tilt: 0.62, fov: 42 };
const KEY_DIR = new Vector3(3, 7, 4).normalize();
const KEY_INTENSITY = 2.4;

const camera = new PerspectiveCamera(FRAMING.fov, 1, 0.1, 100);
const keyLight = new DirectionalLight(0xfff2e0, KEY_INTENSITY);
keyLight.position.copy(KEY_DIR).multiplyScalar(14);
keyLight.shadow.bias = -0.0004;
keyLight.shadow.normalBias = 0.02;
keyLight.shadow.radius = 3;
const rimLight = new DirectionalLight(0xbcd2ff, 0.45);
rimLight.position.set(-4, 5, -7);
const hemi = new HemisphereLight(0xcfd8e6, 0x3a2c22, 0.85);
const amb = new AmbientLight(0xffffff, 0.25);
scene.add(keyLight, rimLight, hemi, amb, keyLight.target);
renderer.shadowMap.type = PCFShadowMap;

const selRing = new Mesh(new TorusGeometry(0.42, 0.05, 10, 32), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
selRing.rotation.x = -Math.PI / 2;
selRing.visible = false;
const ghost = new Mesh(new SphereGeometry(STRAND_R * 1.1, 12, 12), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
ghost.visible = false;
scene.add(selRing, ghost);

let world: Group | null = null;
let boardCells: Mesh[] = [];
let spoolMeshes: Group[] = [];
let strandGroups: Group[] = [];
let tubeCache: (Mesh | null)[] = [];
let fxPool: Mesh[] = [];
let motes: Points | null = null;
let moteSeed: number[] = [];
let moteSpan = 1;
let reducedMotion = false, cvd = false;
let theme: Theme = Content.THEMES[0]!;
let levelRef: LevelDef | null = null;
let lastState: Pick<State, "strands"> | null = null, lastSelection = -1;
let showcase = false;
let animT = 0;
let shakeAmp = 0;
const camBase = new Vector3();
const camTarget = new Vector3(0, 0, 0.3);
let look: Look | null = null;
let envTex: Texture | null = null;
let backdropTex: Texture | null = null;

export function cellToWorld(level: LevelDef, cell: number): Vector3 {
  const r = Math.floor(cell / level.cols), c = cell % level.cols;
  return new Vector3((c - (level.cols - 1) / 2) * CELL, 0, (r - (level.rows - 1) / 2) * CELL);
}
function strandColor(i: number): number { return (cvd ? Content.STRAND_COLORS_CVD : Content.STRAND_COLORS)[i % 6]!; }
const detailed = (): boolean => !!look?.detailed;
const animated = (): boolean => !!look?.animated && !reducedMotion;

// ---------------------------------------------------------------- textures (assets/tex, baked from render.js)
interface Tex { size: number; wood: Texture; woodFine: Texture; woodBump: Texture; felt: Texture; feltBump: Texture; yarn: Texture; yarnBump: Texture; thread: Texture; threadBump: Texture; dot: Texture }
const loader = new TextureLoader();
const texCache = new Map<number, Tex>();
let dotTex: Texture | null = null;
function load(path: string, color: boolean, repeat: [number, number] = [1, 1]): Texture {
  const t = loader.load(path, undefined, undefined, (e: unknown) => console.warn(`texture ${path}: ${e instanceof Error ? e.message : String(e)}`));
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.colorSpace = color ? SRGBColorSpace : NoColorSpace;
  t.anisotropy = 8;
  return t;
}
function textures(): Tex {
  const n = look!.budget.texture;
  let t = texCache.get(n);
  if (t) return t;
  dotTex ??= load("assets/tex/dot.png", false);
  t = {
    size: n,
    wood: load(`assets/tex/wood-${n}.png`, true), woodFine: load(`assets/tex/wood-fine-${n}.png`, true), woodBump: load(`assets/tex/wood-bump-${n}.png`, false),
    felt: load(`assets/tex/felt-${n}.png`, true, [3, 3]), feltBump: load(`assets/tex/felt-${n}.png`, false, [3, 3]),
    yarn: load(`assets/tex/yarn-${n}.png`, true), yarnBump: load(`assets/tex/yarn-${n}.png`, false),
    thread: load(`assets/tex/thread-${n}.png`, true), threadBump: load(`assets/tex/thread-${n}.png`, false),
    dot: dotTex,
  };
  texCache.set(n, t);
  return t;
}

const hexOf = (c: Color): string => "#" + c.getHex().toString(16).padStart(6, "0");
/** render.js backdrop: a warm lamp-lit radial glow behind the table. */
function backdrop(hex: number): Texture {
  const c = new OffscreenCanvas(256, 256);
  const ctx = c.getContext("2d")!;
  const base = new Color(hex);
  const hi = base.clone().lerp(new Color(0xffd9a0), 0.18).multiplyScalar(1.35);
  const lo = base.clone().multiplyScalar(0.55);
  const g = ctx.createRadialGradient(128, 70, 10, 128, 110, 190);
  g.addColorStop(0, hexOf(hi)); g.addColorStop(0.55, hexOf(base)); g.addColorStop(1, hexOf(lo));
  ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------- the look
function applyEnvironment(): void {
  if (look?.reflections) {
    if (!envTex) {
      try {
        const pmrem = new PMREMGenerator(renderer);
        const room = new RoomEnvironment(renderer);
        room.position.y = -3.5;
        envTex = pmrem.fromScene(room, 0.04).texture;
      } catch (e) { console.warn(`environment: ${String(e)}`); }
    }
    scene.environment = envTex;
    scene.environmentIntensity = 0.42;
    hemi.intensity = 0.5; amb.intensity = 0.08;
  } else {
    scene.environment = null;
    hemi.intensity = 0.85; amb.intensity = 0.25;
  }
}

/** render.js setGraphics: the runtime's quality tier applied live (the board rebuilt when detail or budgets change). */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  const prev = look;
  look = next;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const sz = next.shadows;
  renderer.shadowMap.enabled = sz > 0;
  keyLight.castShadow = sz > 0;
  if (sz > 0) keyLight.shadow.mapSize = sz;
  // High threshold: only the selected tip, reel sparks and hot highlights bloom.
  renderer.bloom = next.bloom ? { strength: 0.5, radius: 0.45, threshold: 0.88, resolution: next.budget.bloomRes } : null;
  // GTAOPass: radius 0.5, distance exponent 1.5, thickness 1, scale 1, 16 / 8 samples; the Poisson denoise per tier.
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: next.ao === "high" ? 0.85 : 0.7, radius: 0.5, distanceExponent: 1.5, thickness: 1.0, scale: 1.0,
    samples: next.ao === "high" ? 16 : 8, resolution: next.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // GradeShader after OutputPass (display space): a 0.18 S-curve (≈ contrast 0.09 as a slope), saturation 1.07,
  // cool shadows / warm highlights by a smoothstep of luma from 0.25 to 0.85, a 0.26 vignette from 0.38 to 0.8 (y × 0.85).
  renderer.grade = next.grade ? {
    space: "display", contrast: 0.09, saturation: 1.07, split: [0.25, 0.85], shadows: [0.97, 0.99, 1.03], highlights: [1.035, 1.0, 0.955],
    vignette: { amount: 0.26, inner: 0.38, outer: 0.8, scale: [1, 0.85] },
  } : null;
  renderer.antialias = next.antialias;
  applyEnvironment();
  const pb = prev?.budget;
  const changed = !prev || !pb || prev.detailed !== next.detailed || prev.particles !== next.particles ||
    (["material", "texture", "bump", "sphere", "lathe", "motes"] as const).some((k) => pb[k] !== next.budget[k]) || String(pb.tube) !== String(next.budget.tube);
  if (changed) rebuild();
}
export function setReducedMotion(v: boolean): void { reducedMotion = v; if (lastState) syncState(lastState, lastSelection); }
export function setCvdPalette(v: boolean): void { if (cvd === v) return; cvd = v; rebuild(); }

// ---------------------------------------------------------------- materials (render.js surface)
interface SurfaceParams {
  color: number | Color; roughness?: number; metalness?: number; map?: Texture | null; bumpMap?: Texture | null; bumpScale?: number;
  emissive?: number | Color; emissiveIntensity?: number; transparent?: boolean; opacity?: number;
}
const LAMBERT_KEYS = new Set(["color", "map", "emissive", "emissiveIntensity", "transparent", "opacity"]);
/** Lambert on Low, Standard on Balanced, Physical (clear coat) on High/Ultra; bump maps only where the budget allows. */
function surface(params: SurfaceParams, extras: { clearcoat?: number; clearcoatRoughness?: number } | null = null): MeshStandardMaterial | MeshLambertMaterial {
  const tier = look!.budget.material, p: Record<string, unknown> = { ...params };
  if (!look!.budget.bump) { delete p.bumpMap; delete p.bumpScale; }
  if (tier === "lambert") return new MeshLambertMaterial(Object.fromEntries(Object.entries(p).filter(([k]) => LAMBERT_KEYS.has(k))));
  if (tier === "standard" || !extras) return new MeshStandardMaterial(p);
  return new MeshPhysicalMaterial({ ...p, ...extras });
}
const sphereGeo = (r: number, k = 1): SphereGeometry => new SphereGeometry(r, Math.round(look!.budget.sphere * k), Math.round(look!.budget.sphere * k * 0.75));
function beadMaterial(color: number, emissive: boolean): MeshStandardMaterial | MeshLambertMaterial {
  const params: SurfaceParams = { color, roughness: 0.4, emissive: emissive ? color : 0x000000, emissiveIntensity: emissive ? 0.15 : 1 };
  if (!detailed()) return surface(params);
  return surface({ ...params, roughness: 0.48 }, { clearcoat: 0.6, clearcoatRoughness: 0.4 });
}
function strandMaterial(color: number): MeshStandardMaterial | MeshLambertMaterial {
  if (!detailed()) return surface({ color, roughness: 0.5 });
  const t = textures();
  // soft yarn: twisted-ply texture (render.js's fibre sheen is not drawn by the engine)
  return surface({ color, roughness: 0.78, map: t.yarn, bumpMap: t.yarnBump, bumpScale: 1.4 }, {});
}

function makeSpool(color: number): Group {
  const g = new Group(), seg = look!.budget.lathe;
  if (!detailed()) {
    const body = new Mesh(new CylinderGeometry(0.3, 0.34, 0.55, seg), surface({ color: 0x8a6a48, roughness: 0.6 }));
    body.castShadow = true;
    const band = new Mesh(new CylinderGeometry(0.315, 0.315, 0.3, seg), surface({ color, roughness: 0.55 }));
    const cap = new Mesh(new CylinderGeometry(0.38, 0.38, 0.06, seg), surface({ color: 0x6b4a2f, roughness: 0.6 }));
    cap.position.y = 0.3;
    g.add(body, band, cap);
    return g;
  }
  const t = textures();
  const prof = [[0, -0.3], [0.37, -0.3], [0.39, -0.27], [0.37, -0.22], [0.25, -0.2], [0.24, 0.2], [0.37, 0.22], [0.39, 0.27], [0.37, 0.3], [0.1, 0.31], [0.08, 0.26], [0, 0.26]]
    .map(([x, y]) => new Vector2(x!, y!));
  const wood = surface({ color: 0x9a7650, roughness: 0.5, map: t.wood }, { clearcoat: 0.5, clearcoatRoughness: 0.35 });
  const body = new Mesh(new LatheGeometry(prof, seg), wood);
  body.castShadow = true; body.receiveShadow = true;
  const band = new Mesh(new CylinderGeometry(0.325, 0.325, 0.4, seg, 1, true),
    surface({ color, roughness: 0.7, map: t.thread, bumpMap: t.threadBump, bumpScale: 1.2 }, {}));
  band.castShadow = true;
  const label = new Mesh(new CylinderGeometry(0.2, 0.2, 0.02, Math.round(seg * 0.875)), surface({ color, roughness: 0.45 }, { clearcoat: 0.6 }));
  label.position.y = 0.305;
  g.add(body, band, label);
  return g;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function addProps(level: LevelDef, w: Group): void {
  const hx = level.cols * CELL * 0.5, hz = level.rows * CELL * 0.5;
  const env = (m: Mesh): Mesh => { m.castShadow = true; m.receiveShadow = true; w.add(m); return m; };
  const cushionMat = detailed() ? surface({ color: 0xa03040, roughness: 0.9, map: textures().felt }, {}) : surface({ color: 0xa03040, roughness: 0.9 });
  const cs = look!.budget.sphere;
  const cushion = env(new Mesh(new SphereGeometry(0.5, cs, Math.round(cs * 0.67), 0, Math.PI * 2, 0, Math.PI / 2), cushionMat));
  cushion.position.set(hx + 1.2, -0.1, -hz - 0.6);
  if (!detailed()) return;
  const t = textures();
  const r = rng(level.cols * 131 + level.rows);
  const pinHeads = [0xe8b54a, 0xf5efe6, 0x2878d6, 0x32aa3c, 0xd62828];
  const shaft = surface({ color: 0xcfd3d8, metalness: 1, roughness: 0.25 });
  for (let i = 0; i < 6; i++) {
    const a = r() * Math.PI * 2, tilt = 0.25 + r() * 0.5;
    const pin = new Group();
    const s = new Mesh(new CylinderGeometry(0.012, 0.012, 0.45, 6), shaft);
    s.position.y = 0.22;
    const head = new Mesh(new SphereGeometry(0.045, 12, 10), surface({ color: pinHeads[i % pinHeads.length]!, roughness: 0.25 }, { clearcoat: 1 }));
    head.position.y = 0.45;
    s.castShadow = true; head.castShadow = true;
    pin.add(s, head);
    pin.position.set(cushion.position.x + Math.cos(a) * 0.25, cushion.position.y + 0.2, cushion.position.z + Math.sin(a) * 0.25);
    pin.rotation.set(Math.sin(a) * tilt, 0, -Math.cos(a) * tilt);
    w.add(pin);
  }
  const thimProf = [[0.2, -0.02], [0.22, -0.02], [0.21, 0], [0.19, 0.15], [0.17, 0.27], [0.12, 0.31], [0, 0.32]].map(([x, y]) => new Vector2(x!, y!));
  const thimble = env(new Mesh(new LatheGeometry(thimProf, Math.round(look!.budget.lathe * 0.875)), surface({ color: 0xd8b26a, metalness: 1, roughness: 0.3, bumpMap: t.feltBump, bumpScale: 2 })));
  thimble.position.set(-hx - 1.1, -0.08, hz + 0.3);
  const ball = env(new Mesh(sphereGeo(0.42, 1.33), surface({ color: 0x6f8fb8, roughness: 0.85, map: t.thread, bumpMap: t.threadBump, bumpScale: 2 }, {})));
  ball.rotation.set(0.6, 0.3, 0.9);
  ball.position.set(-hx - 1.3, 0.3, -hz + 0.4);
  // running stitch around the felt pad
  const stitch = new BoxGeometry(0.15, 0.018, 0.028);
  const perim: [number, number, number][] = [];
  const ex = hx + 0.25, ez = hz + 0.25;
  for (let x = -ex + 0.1; x <= ex - 0.1; x += 0.3) perim.push([x, -ez, 0], [x, ez, 0]);
  for (let z = -ez + 0.1; z <= ez - 0.1; z += 0.3) perim.push([-ex, z, Math.PI / 2], [ex, z, Math.PI / 2]);
  const stitches = new InstancedMesh(stitch, surface({ color: new Color(theme.cloth).lerp(new Color(0xe8d5b0), 0.45), roughness: 0.9 }), perim.length);
  const m4 = new Matrix4(), q = new Quaternion(), up = new Vector3(0, 1, 0), one = new Vector3(1, 1, 1);
  perim.forEach(([x, z, rot], i) => stitches.setMatrixAt(i, m4.compose(new Vector3(x, -0.015, z), q.setFromAxisAngle(up, rot), one)));
  stitches.receiveShadow = true;
  w.add(stitches);
}

function buildMotes(level: LevelDef, w: Group): void {
  if (look!.particles !== "high") return;
  const n = Math.min(MOTE_MAX, look!.budget.motes), r = rng(77);
  const pos = new Float32Array(n * 3);
  const span = Math.max(level.cols, level.rows) * CELL + 2;
  for (let i = 0; i < n; i++) { pos[i * 3] = (r() - 0.5) * span; pos[i * 3 + 1] = 0.3 + r() * 3.2; pos[i * 3 + 2] = (r() - 0.5) * span; }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  // render.js used the dot as map and alphaMap; the baked dot carries the falloff in colour and alpha
  motes = new Points(geo, new PointsMaterial({ color: 0xffe2b0, size: 0.06, map: textures().dot, transparent: true, opacity: 0.55, depthWrite: false, blending: AdditiveBlending }));
  moteSpan = span;
  moteSeed = Array.from({ length: n }, () => r() * Math.PI * 2);
  w.add(motes);
}

/** render.js fitShadow: the key light's shadow box tightly around the board and its props. */
function fitShadow(level: LevelDef): void {
  const half = Math.max(level.cols, level.rows) * CELL * 0.5 + 2.2;
  const sc = keyLight.shadow.camera as unknown as { left: number; right: number; top: number; bottom: number; near: number; far: number; updateProjectionMatrix(): void };
  sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
  sc.near = 4; sc.far = 26;
  sc.updateProjectionMatrix();
  keyLight.target.position.set(0, 0, 0);
}

function disposeWorld(): void {
  if (!world) return;
  world.traverse((o: Object3D) => {
    const m = o as Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as Material | Material[] | undefined;
    if (mat) for (const x of Array.isArray(mat) ? mat : [mat]) x.dispose();
  });
  scene.remove(world);
  world = null;
  boardCells = []; spoolMeshes = []; strandGroups = []; fxPool = []; tubeCache = [];
  motes = null;
}
function rebuild(): void {
  if (!levelRef || !look) return;
  buildLevel(levelRef, { showcase, keepState: true });
  if (lastState) syncState(lastState, lastSelection);
}

/** render.js buildLevel. */
export function buildLevel(level: LevelDef, opts: { showcase?: boolean; keepState?: boolean } = {}): void {
  levelRef = level;
  showcase = !!opts.showcase;
  if (!opts.showcase && !opts.keepState) { lastState = null; lastSelection = -1; }
  theme = Content.THEMES[level.theme % Content.THEMES.length]!;
  if (!look) return;
  disposeWorld();
  const w = new Group();
  world = w;
  backdropTex?.dispose();
  backdropTex = null;
  if (detailed()) { backdropTex = backdrop(theme.bg); scene.background = backdropTex; }
  else scene.background = new Color(theme.bg);
  const t = detailed() ? textures() : null;

  const tableSize = Math.max(level.cols, level.rows) * CELL + 6;
  let tableMap: Texture | null = null;
  if (t) { tableMap = t.wood.clone(); tableMap.repeat.set(3, 3); }
  const table = new Mesh(new BoxGeometry(tableSize, 0.5, tableSize), t
    ? surface({ color: theme.table, roughness: 0.62, metalness: 0.02, map: tableMap, bumpMap: t.woodBump, bumpScale: 1 })
    : surface({ color: theme.table, roughness: 0.75, metalness: 0.05 }));
  table.position.y = -0.35;
  table.receiveShadow = true;
  w.add(table);

  const pad = new Mesh(new BoxGeometry(level.cols * CELL + 0.7, 0.08, level.rows * CELL + 0.7), t
    ? surface({ color: theme.cloth, roughness: 1, map: t.felt, bumpMap: t.feltBump, bumpScale: 2 }, {})
    : surface({ color: theme.cloth, roughness: 1 }));
  pad.position.y = -0.06;
  pad.receiveShadow = true;
  w.add(pad);

  const cellGeo = t ? new RoundedBoxGeometry(CELL * 0.94, 0.12, CELL * 0.94, 2, 0.035) : new BoxGeometry(CELL * 0.94, 0.12, CELL * 0.94);
  const cellMat = (color: number, ox: number): MeshStandardMaterial | MeshLambertMaterial => {
    if (!t) return surface({ color, roughness: 0.9 });
    const map = t.woodFine.clone(); map.offset.set(ox, ox * 0.37);
    return surface({ color, roughness: 0.72, map, bumpMap: t.woodBump, bumpScale: 0.5 });
  };
  const matA = cellMat(theme.boardA, 0.13), matB = cellMat(theme.boardB, 0.61);
  for (let cell = 0; cell < level.cols * level.rows; cell++) {
    const r = Math.floor(cell / level.cols), c = cell % level.cols;
    const m = new Mesh(cellGeo, (r + c) % 2 ? matA : matB);
    m.position.copy(cellToWorld(level, cell));
    m.receiveShadow = true;
    m.userData = { cell };
    boardCells.push(m);
    w.add(m);
  }

  level.strands.forEach((s, i) => {
    const g = makeSpool(strandColor(s.color));
    g.position.copy(cellToWorld(level, s.spool));
    g.position.y = 0.35;
    g.userData = { strand: i, spool: true };
    g.traverse((o: Object3D) => { o.userData = { strand: i, spool: true }; });
    spoolMeshes.push(g);
    w.add(g);
  });

  level.strands.forEach((s, i) => {
    const g = new Group();
    g.userData = { strand: i };
    const anchorMat = beadMaterial(strandColor(s.color), false);
    if ("roughness" in anchorMat) anchorMat.roughness = detailed() ? 0.5 : 0.45;
    const anchor = new Mesh(sphereGeo(0.26), anchorMat);
    anchor.castShadow = true;
    anchor.userData = { strand: i, anchor: true };
    const tip = new Mesh(sphereGeo(0.24), beadMaterial(strandColor(s.color), true));
    tip.castShadow = true;
    tip.userData = { strand: i, tip: true };
    g.add(anchor, tip);
    strandGroups.push(g);
    w.add(g);
  });

  addProps(level, w);
  buildMotes(level, w);
  fitShadow(level);
  scene.add(w);
  frameKey = "";
}

/** Title backdrop: a decorative board mid-solve behind the menu, with a slow camera drift. */
export function showShowcase(level: LevelDef, state: Pick<State, "strands">): void {
  buildLevel(level, { showcase: true });
  syncState(state, -1);
}

// ---------------------------------------------------------------- state → view
type BeadMat = MeshStandardMaterial | MeshLambertMaterial;
/** render.js syncState: beads at the path's ends, the tube along it, the selection lift and ring. */
export function syncState(state: Pick<State, "strands">, selection = -1): void {
  lastState = state; lastSelection = selection;
  if (!world || !levelRef || !look) return;
  const level = levelRef;
  state.strands.forEach((s, i) => {
    const g = strandGroups[i];
    if (!g) return;
    const old = tubeCache[i];
    if (old) {
      g.remove(old);
      old.geometry.dispose();
      (old.material as Material).dispose();
      tubeCache[i] = null;
    }
    const pts = s.path.map((cell) => { const p = cellToWorld(level, cell); p.y = 0.18; return p; });
    const anchor = g.children.find((o) => o.userData.anchor) as Mesh;
    const tip = g.children.find((o) => o.userData.tip) as Mesh;
    anchor.position.copy(pts[0]!);
    tip.position.copy(pts[pts.length - 1]!);
    const doneFade = s.done ? 0.15 : 1;
    for (const m of [anchor, tip]) {
      const mat = m.material as BeadMat;
      mat.transparent = s.done;
      mat.opacity = doneFade;
      mat.emissiveIntensity = i === selection ? 0.8 : m.userData.tip ? 0.15 : 0;
    }
    const lift = i === selection && !reducedMotion ? 0.14 : 0;
    anchor.position.y += lift; tip.position.y += lift;
    if (pts.length >= 2 && !s.done) {
      const curve = new CatmullRomCurve3(pts.map((p) => p.clone().add(new Vector3(0, lift, 0))));
      const [radial, perCell] = look!.budget.tube;
      const segs = Math.max(8, pts.length * perCell);
      const geo = new TubeGeometry(curve, segs, STRAND_R, radial, false);
      // stretch the yarn texture so the twist keeps a constant pitch along the strand
      const uv = geo.getAttribute("uv") as BufferAttribute, len = curve.getLength() * 2.2;
      for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) * len);
      uv.needsUpdate = true;
      const tube = new Mesh(geo, strandMaterial(strandColor(s.color)));
      tube.castShadow = true;
      tube.receiveShadow = detailed();
      tube.userData = { strand: i };
      tubeCache[i] = tube;
      g.add(tube);
    }
    const spool = spoolMeshes[i];
    if (spool) { spool.userData.done = s.done; spool.scale.setScalar(s.done ? 1.05 : 1); }
    if (i === selection && !s.done) {
      selRing.visible = true;
      selRing.position.copy(tip.position);
      selRing.position.y = 0.07;
      (selRing.material as MeshBasicMaterial).color.setHex(strandColor(s.color)).multiplyScalar(1.4);
    }
  });
  if (selection < 0) selRing.visible = false;
}

export function showGhost(worldPos: Vector3 | null, colorIdx: number, visible: boolean): void {
  ghost.visible = visible && !!worldPos;
  if (ghost.visible && worldPos) {
    ghost.position.copy(worldPos);
    ghost.position.y = 0.2;
    (ghost.material as MeshBasicMaterial).color.setHex(strandColor(colorIdx));
  }
}
export function shake(amount: number): void { if (!reducedMotion) shakeAmp = Math.min(0.15, amount); }

let sparkGeo: SphereGeometry | null = null;
let fxRand = rng(4242);
/** render.js burstAt: over-bright sparks (they alone catch the bloom) at the reel. */
export function burstAt(worldPos: Vector3, colorIdx: number): void {
  if (!world || !look || reducedMotion || look.particles === "off") return;
  const n = sparkCount(look);
  sparkGeo ??= new SphereGeometry(0.05, 6, 6);
  for (let i = 0; i < n; i++) {
    const p = new Mesh(sparkGeo, new MeshBasicMaterial({ color: new Color(strandColor(colorIdx)).multiplyScalar(2.2), transparent: true }));
    p.position.copy(worldPos);
    p.userData = { vel: new Vector3((fxRand() - 0.5) * 2.4, fxRand() * 2.5 + 0.5, (fxRand() - 0.5) * 2.4), life: 1 };
    world.add(p);
    fxPool.push(p);
  }
}
/** Clear the ghost and sparks when the board changes. */
export function clearFx(): void { showGhost(null, 0, false); fxRand = rng(4242); }

// ---------------------------------------------------------------- framing (render.js resize + applyPlayFrame)
let frameKey = "";
let win = { w: 1, h: 1 };
let chrome: Rect[] | null = null;
/** The HUD's window rectangles over the canvas during play (null off the play screen). */
export function setChrome(rects: Rect[] | null): void { chrome = rects; }
export function reframe(): void { frameKey = ""; }

function resize(): void {
  const { w, h } = win;
  camera.aspect = w / h;
  const fit = levelRef ? Math.max(levelRef.cols, levelRef.rows) : 5;
  const portraitBoost = h > w ? 1.45 : 1.0;
  const dist = FRAMING.dist * (fit / 5) * portraitBoost;
  camBase.set(0, dist * FRAMING.tilt * 2, dist * (1 - FRAMING.tilt * 0.4));
  camera.position.copy(camBase);
  camera.lookAt(camTarget);
  camera.clearViewOffset();
  camera.aspect = w / h;
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  applyPlayFrame(w, h);
}
function ndcBounds(points: Vector3[]): { x0: number; x1: number; y0: number; y1: number } {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const v = new Vector3();
  for (const p of points) {
    v.copy(p).project(camera);
    x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
  }
  return { x0, x1, y0, y1 };
}
interface Box { x0: number; x1: number; y0: number; y1: number }
/**
 * render.js applyPlayFrame: lens shift + zoom (setViewOffset) over the authored camera so the board (frame +
 * spools) fills the window left free by the HUD. Full-width bars and full-height rails are always kept clear;
 * smaller corner pieces (the docked board mirror, a short action column) only when the board would end up
 * beneath them.
 */
function applyPlayFrame(W: number, H: number): void {
  const pieces0 = showcase ? null : chrome;
  if (!pieces0 || !levelRef) return;
  const hx = levelRef.cols * CELL * 0.5 + 0.45, hz = levelRef.rows * CELL * 0.5 + 0.45;
  const pts: Vector3[] = [];
  for (const x of [-hx, hx]) for (const y of [0, 0.7]) for (const z of [-hz, hz]) pts.push(new Vector3(x, y, z));
  const b = ndcBounds(pts);
  const ins = { t: 0, b: 0, l: 0, r: 0 };
  const inset = (p: Box, axis: "v" | "h"): void => {
    if (axis === "v") {
      if ((p.y0 + p.y1) / 2 < H / 2) ins.t = Math.max(ins.t, p.y1); else ins.b = Math.max(ins.b, H - p.y0);
    } else if ((p.x0 + p.x1) / 2 < W / 2) ins.l = Math.max(ins.l, p.x1); else ins.r = Math.max(ins.r, W - p.x0);
  };
  const pieces: Box[] = [];
  for (const r of pieces0) {
    const p = { x0: Math.max(0, r.x), x1: Math.min(W, r.x + r.width), y0: Math.max(0, r.y), y1: Math.min(H, r.y + r.height) };
    if (p.x1 - p.x0 < 1 || p.y1 - p.y0 < 1) continue;
    if (p.x1 - p.x0 > W * 0.5) inset(p, "v");
    else if (p.y1 - p.y0 > H * 0.5) inset(p, "h");
    else pieces.push(p);
  }
  const m = Math.round(Math.min(W, H) * 0.03);
  const toNdc = (r: Box): Box => ({ x0: (2 * r.x0) / W - 1, x1: (2 * r.x1) / W - 1, y0: 1 - (2 * r.y1) / H, y1: 1 - (2 * r.y0) / H });
  let f: { z: number; x: number; y: number } | null = null;
  for (let pass = 0, passes = pieces.length; pass <= passes; pass++) {
    const sx0 = ins.l + m, sx1 = W - ins.r - m, sy0 = ins.t + m, sy1 = H - ins.b - m;
    if (sx1 - sx0 < W * 0.3 || sy1 - sy0 < H * 0.3) break;
    const s = toNdc({ x0: sx0, x1: sx1, y0: sy0, y1: sy1 });
    const z = Math.min(3, Math.max(0.3, Math.min((s.x1 - s.x0) / (b.x1 - b.x0), (s.y1 - s.y0) / (b.y1 - b.y0))));
    f = { z, x: (b.x0 + b.x1) / 2 - (s.x0 + s.x1) / 2 / z, y: (b.y0 + b.y1) / 2 - (s.y0 + s.y1) / 2 / z };
    const ff = f;
    const sb = { x0: (b.x0 - ff.x) * z, x1: (b.x1 - ff.x) * z, y0: (b.y0 - ff.y) * z, y1: (b.y1 - ff.y) * z };
    const hit = pieces.find((p) => {
      const q = toNdc(p);
      return sb.x0 < q.x1 && sb.x1 > q.x0 && sb.y0 < q.y1 && sb.y1 > q.y0;
    });
    if (!hit) break;
    pieces.splice(pieces.indexOf(hit), 1);
    const costV = ((hit.y0 + hit.y1) / 2 < H / 2 ? hit.y1 : H - hit.y0) / H;
    const costH = ((hit.x0 + hit.x1) / 2 < W / 2 ? hit.x1 : W - hit.x0) / W;
    inset(hit, costV <= costH ? "v" : "h");
  }
  if (!f) return;
  const A = camera.aspect, sz = 2 / f.z;
  camera.setViewOffset(2 * A, 2, (f.x + 1 - sz / 2) * A, 1 - f.y - sz / 2, sz * A, sz);
}

// ---------------------------------------------------------------- picking
const raycaster = new Raycaster();
const ndc = new Vector2();
export type Hit = { kind: "spool"; strand: number; cell: number } | { kind: "strand"; strand: number; cell: number | undefined } | { kind: "cell"; cell: number };
/** render.js pick, at a window point (physical pixels), with the authored camera (shake and drift never change it). */
export function pick(x: number, y: number): Hit | null {
  if (!levelRef || !world) return null;
  const shaken = camera.position.clone();
  camera.position.copy(camBase);
  camera.lookAt(camTarget);
  camera.updateMatrixWorld();
  pointerToNdc(x, y, ndc);
  raycaster.setFromCamera(ndc, camera);
  const targets: Object3D[] = [...boardCells];
  for (const g of spoolMeshes) targets.push(...g.children);
  for (const g of strandGroups) targets.push(...g.children);
  const hits = raycaster.intersectObjects(targets, false);
  camera.position.copy(shaken);
  camera.lookAt(camTarget);
  camera.updateMatrixWorld();
  if (!hits.length) return null;
  const u = hits[0]!.object.userData as { spool?: boolean; strand?: number; cell?: number };
  if (u.spool && u.strand !== undefined) return { kind: "spool", strand: u.strand, cell: levelRef.strands[u.strand]!.spool };
  if (u.strand !== undefined) return { kind: "strand", strand: u.strand, cell: worldToCell(hits[0]!.point) };
  if (u.cell !== undefined) return { kind: "cell", cell: u.cell };
  return null;
}
export function worldToCell(point: Vector3): number | undefined {
  if (!levelRef) return undefined;
  const c = Math.round(point.x / CELL + (levelRef.cols - 1) / 2);
  const r = Math.round(point.z / CELL + (levelRef.rows - 1) / 2);
  if (c < 0 || c >= levelRef.cols || r < 0 || r >= levelRef.rows) return undefined;
  return r * levelRef.cols + c;
}
/** A cell's centre on screen (window px) with the authored camera, for tests. */
export function cellScreen(cell: number): { x: number; y: number } | null {
  if (!levelRef) return null;
  const v = cellToWorld(levelRef, cell);
  v.y = 0.06;
  v.project(camera);
  return { x: ((v.x + 1) / 2) * win.w, y: ((1 - v.y) / 2) * win.h };
}

// ---------------------------------------------------------------- each frame (render.js loop)
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }
export function update(dt: number, w: number, h: number): void {
  dt = Math.min(0.05, dt);
  if (w > 0 && h > 0) {
    const fk = `${w}x${h}:${showcase}:${levelRef?.id}:${JSON.stringify(chrome?.map((r) => [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]) ?? null)}`;
    if (fk !== frameKey) { frameKey = fk; win = { w, h }; resize(); }
  }
  const moving = animated();
  if (!reducedMotion) animT += dt;
  camera.position.copy(camBase);
  if (showcase && moving) {
    const a = Math.sin(animT * 0.12) * 0.32;
    camera.position.set(camBase.x * Math.cos(a) + camBase.z * Math.sin(a), camBase.y, -camBase.x * Math.sin(a) + camBase.z * Math.cos(a));
  }
  if (shakeAmp > 0.001) {
    camera.position.x += (fxRand() - 0.5) * shakeAmp;
    shakeAmp *= Math.pow(0.001, dt);
  }
  camera.lookAt(camTarget);
  keyLight.intensity = KEY_INTENSITY * (moving ? 1 + 0.025 * Math.sin(animT * 1.3) + 0.015 * Math.sin(animT * 3.7) : 1);
  selRing.scale.setScalar(moving ? 1 + 0.06 * Math.sin(animT * 4) : 1);
  for (const sp of spoolMeshes) if (sp.userData.done) sp.scale.setScalar(moving ? 1.05 + Math.sin(animT * 3) * 0.03 : 1.05);
  if (motes && moving) {
    const p = motes.geometry.getAttribute("position") as BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      let y = p.getY(i) + dt * 0.08;
      if (y > 3.6) y = 0.3;
      p.setY(i, y);
      p.setX(i, p.getX(i) + Math.sin(animT * 0.5 + moteSeed[i]!) * dt * 0.05);
      if (Math.abs(p.getX(i)) > moteSpan / 2) p.setX(i, -Math.sign(p.getX(i)) * moteSpan / 2);
    }
    p.needsUpdate = true;
  }
  for (let i = fxPool.length - 1; i >= 0; i--) {
    const p = fxPool[i]!;
    const u = p.userData as { vel: Vector3; life: number };
    u.life -= dt * 1.4;
    if (u.life <= 0) {
      world?.remove(p); (p.material as Material).dispose();
      fxPool.splice(i, 1);
      continue;
    }
    p.position.addScaledVector(u.vel, dt);
    u.vel.y -= 4 * dt;
    (p.material as MeshBasicMaterial).opacity = u.life;
  }
}
