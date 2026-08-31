// Tangled Threads — Three.js scene: cozy fiber-art worktable.
// Deterministic visual seed; render layers: environment / gameplay / selection / effects.

import * as THREE from 'three';
import { THEMES, STRAND_COLORS, STRAND_COLORS_CVD } from './content.js';

export const LAYER_ENV = 0;
export const LAYER_GAME = 1;
export const LAYER_SELECT = 2;
export const LAYER_FX = 3;

const CELL = 1.0;         // world units per board cell
const STRAND_R = 0.16;    // strand tube radius
const FRAMING = { dist: 9.5, tilt: 0.62, fov: 42 }; // authored camera constants

let renderer = null, scene = null, camera = null, canvas = null;
let world = null;          // group rebuilt per level
let boardCells = [];       // pickable cell meshes
let spoolMeshes = [];      // pickable spool meshes (userData.strand)
let strandGroups = [];     // per-strand group with tube + beads
let selRing = null, ghost = null;
let quality = 2, reducedMotion = false, cvd = false;
let theme = THEMES[0];
let levelRef = null;
let animT = 0, lastTime = 0, rafId = 0, hidden = false;
let onFrameCb = null;
let shakeAmp = 0;
let fxPool = [];

export function cellToWorld(level, cell) {
  const r = Math.floor(cell / level.cols), c = cell % level.cols;
  return new THREE.Vector3((c - (level.cols - 1) / 2) * CELL, 0, (r - (level.rows - 1) / 2) * CELL);
}

export function worldToScreen(v3) {
  const v = v3.clone().project(camera);
  return { x: (v.x * 0.5 + 0.5) * canvas.clientWidth, y: (-v.y * 0.5 + 0.5) * canvas.clientHeight };
}

function strandColor(i) { return (cvd ? STRAND_COLORS_CVD : STRAND_COLORS)[i % 6]; }

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
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(FRAMING.fov, 1, 0.1, 100);

  const key = new THREE.DirectionalLight(0xfff2e0, 2.4);
  key.position.set(3, 7, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0xcfd8e6, 0x3a2c22, 0.85));
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));

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
  canvas.addEventListener('webglcontextrestored', () => { if (levelRef) buildLevel(levelRef); resize(); loop(performance.now()); });

  applyQuality();
  resize();
  return { ok: true };
}

export function setQuality(tier) { quality = tier; applyQuality(); }
export function setReducedMotion(v) { reducedMotion = v; }
export function setCvdPalette(v) { cvd = v; if (levelRef) buildLevel(levelRef); }

function applyQuality() {
  if (!renderer) return;
  const dprCap = [1, 1.5, 2][quality];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
  renderer.shadowMap.enabled = quality > 0;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene?.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
}

export function resize() {
  if (!renderer) return;
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Fit the board: pull back in portrait.
  const lvl = levelRef;
  const fit = lvl ? Math.max(lvl.cols, lvl.rows) : 5;
  const portraitBoost = h > w ? 1.45 : 1.0;
  const dist = FRAMING.dist * (fit / 5) * portraitBoost;
  camera.position.set(0, dist * FRAMING.tilt * 2, dist * (1 - FRAMING.tilt * 0.4));
  camera.lookAt(0, 0, 0.3);
  camera.updateProjectionMatrix();
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
}

export function buildLevel(level) {
  levelRef = level;
  theme = THEMES[level.theme % THEMES.length];
  disposeWorld();
  world = new THREE.Group();
  scene.background = new THREE.Color(theme.bg);

  // Table.
  const tableSize = Math.max(level.cols, level.rows) * CELL + 6;
  const table = new THREE.Mesh(
    new THREE.BoxGeometry(tableSize, 0.5, tableSize),
    new THREE.MeshStandardMaterial({ color: theme.table, roughness: 0.75, metalness: 0.05 })
  );
  table.position.y = -0.35;
  table.receiveShadow = true;
  table.layers.set(LAYER_ENV);
  world.add(table);

  // Board cloth pad under cells.
  const pad = new THREE.Mesh(
    new THREE.BoxGeometry(level.cols * CELL + 0.7, 0.08, level.rows * CELL + 0.7),
    new THREE.MeshStandardMaterial({ color: theme.cloth, roughness: 1 })
  );
  pad.position.y = -0.06;
  pad.receiveShadow = true;
  pad.layers.set(LAYER_ENV);
  world.add(pad);

  // Cells (pickable).
  const cellGeo = new THREE.BoxGeometry(CELL * 0.94, 0.12, CELL * 0.94);
  const matA = new THREE.MeshStandardMaterial({ color: theme.boardA, roughness: 0.9 });
  const matB = new THREE.MeshStandardMaterial({ color: theme.boardB, roughness: 0.9 });
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

  // Spools: wooden cylinder with colored thread band (color + distinct band pattern per index).
  level.strands.forEach((s, i) => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.34, 0.55, 24),
      new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.6 })
    );
    body.castShadow = true;
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(0.315, 0.315, 0.3, 24),
      new THREE.MeshStandardMaterial({ color: strandColor(s.color), roughness: 0.55 })
    );
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.38, 0.38, 0.06, 24),
      new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.6 })
    );
    cap.position.y = 0.3;
    g.add(body, band, cap);
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
    const anchor = new THREE.Mesh(
      new THREE.SphereGeometry(0.26, 18, 18),
      new THREE.MeshStandardMaterial({ color: strandColor(s.color), roughness: 0.45 })
    );
    anchor.castShadow = true;
    anchor.userData = { strand: i, anchor: true };
    anchor.layers.set(LAYER_GAME);
    g.add(anchor);
    const tip = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 18, 18),
      new THREE.MeshStandardMaterial({ color: strandColor(s.color), roughness: 0.4, emissive: strandColor(s.color), emissiveIntensity: 0.15 })
    );
    tip.castShadow = true;
    tip.userData = { strand: i, tip: true };
    tip.layers.set(LAYER_GAME);
    g.add(tip);
    strandGroups.push(g);
    world.add(g);
  });

  // Needle-cushion prop (environment storytelling, non-interactive).
  const cushion = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xa03040, roughness: 0.9 })
  );
  cushion.position.set(level.cols * CELL * 0.5 + 1.2, -0.1, -level.rows * CELL * 0.5 - 0.6);
  cushion.layers.set(LAYER_ENV);
  cushion.castShadow = true;
  world.add(cushion);

  scene.add(world);
  resize();
}

/* ---------------- state -> view sync ---------------- */

let tubeCache = [];

export function syncState(state, selection = -1) {
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
      m.material.emissiveIntensity = i === selection ? 0.8 : 0.15;
    });
    const lift = i === selection && !reducedMotion ? 0.14 : 0;
    anchor.position.y += lift; tip.position.y += lift;
    if (pts.length >= 2 && !s.done) {
      const curve = new THREE.CatmullRomCurve3(pts.map((p) => p.clone().add(new THREE.Vector3(0, lift, 0))));
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, Math.max(8, pts.length * 6), STRAND_R, 10, false),
        new THREE.MeshStandardMaterial({ color: strandColor(s.color), roughness: 0.5 })
      );
      tube.castShadow = true;
      tube.userData = { strand: i };
      tube.layers.set(LAYER_GAME);
      tubeCache[i] = tube;
      g.add(tube);
    }
    // Spool celebration scale when done.
    const spool = spoolMeshes[i];
    if (spool) spool.scale.setScalar(s.done ? (reducedMotion ? 1.05 : 1.05 + Math.sin(animT * 3) * 0.03) : 1);
    // Selection ring at the tip.
    if (i === selection && !s.done) {
      selRing.visible = true;
      selRing.position.copy(tip.position);
      selRing.position.y = 0.07;
      selRing.material.color.setHex(strandColor(s.color));
    }
  });
  if (selection < 0) selRing.visible = false;
}

export function showGhost(worldPos, colorIdx, visible) {
  ghost.visible = visible;
  if (visible) {
    ghost.position.copy(worldPos);
    ghost.position.y = 0.2;
    ghost.material.color.setHex(strandColor(colorIdx));
  }
}

export function shake(amount) { if (!reducedMotion) shakeAmp = Math.min(0.15, amount); }

export function burstAt(worldPos, colorIdx) {
  if (reducedMotion || quality === 0) return;
  const n = quality === 1 ? 8 : 16;
  for (let i = 0; i < n; i++) {
    const p = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 6, 6),
      new THREE.MeshBasicMaterial({ color: strandColor(colorIdx), transparent: true })
    );
    p.position.copy(worldPos);
    p.userData = {
      vel: new THREE.Vector3((Math.random() - 0.5) * 2.4, Math.random() * 2.5 + 0.5, (Math.random() - 0.5) * 2.4),
      life: 1,
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
  const rect = canvas.getBoundingClientRect();
  pointerV.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerV.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerV, camera);
  raycaster.layers.set(LAYER_GAME);
  const targets = [...boardCells];
  for (const g of spoolMeshes) targets.push(...g.children);
  for (const g of strandGroups) targets.push(...g.children);
  const hits = raycaster.intersectObjects(targets, false);
  if (!hits.length) return null;
  const u = hits[0].object.userData;
  if (u.spool) return { kind: 'spool', strand: u.strand, cell: levelRef.strands[u.strand].spool };
  if (u.anchor || u.tip) return { kind: 'strand', strand: u.strand };
  if (u.strand !== undefined) return { kind: 'strand', strand: u.strand };
  if (u.cell !== undefined) return { kind: 'cell', cell: u.cell };
  return null;
}

/* ---------------- frame loop ---------------- */

export function onFrame(cb) { onFrameCb = cb; }
export function setHidden(v) {
  hidden = v;
  if (!hidden && renderer) { lastTime = performance.now(); loop(lastTime); }
}

function loop(now) {
  cancelAnimationFrame(rafId);
  if (!renderer || hidden) return;
  const dt = Math.min(0.05, (now - lastTime) / 1000 || 0);
  lastTime = now;
  if (!reducedMotion) animT += dt;

  // Camera shake (event-tiered, low amplitude, never affects picking truth).
  if (shakeAmp > 0.001) {
    camera.position.x = (Math.random() - 0.5) * shakeAmp;
    shakeAmp *= Math.pow(0.001, dt); // fast decay
  } else {
    camera.position.x = 0;
  }

  // FX particles.
  for (let i = fxPool.length - 1; i >= 0; i--) {
    const p = fxPool[i];
    p.userData.life -= dt * 1.4;
    if (p.userData.life <= 0) {
      world?.remove(p); p.geometry.dispose(); p.material.dispose();
      fxPool.splice(i, 1);
      continue;
    }
    p.position.addScaledVector(p.userData.vel, dt);
    p.userData.vel.y -= 4 * dt;
    p.material.opacity = p.userData.life;
  }

  if (onFrameCb) onFrameCb(dt);
  renderer.render(scene, camera);
  rafId = requestAnimationFrame(loop);
}

export function startLoop() { lastTime = performance.now(); loop(lastTime); }

export function getDrawStats() {
  if (!renderer) return null;
  return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
}
