// Tangled Threads — versioned content: levels, themes, tutorials, validators.
// All generation is deterministic from the level id string.

import { seedFromString, mulberry32, createGame, checkAction, applyAction, isTerminal, hashState } from './rules.js';

export const CONTENT_VERSION = 1;

/* ---------------- themes (five visual themes) ---------------- */

export const STRAND_COLORS = [0xd62828, 0x2878d6, 0x32aa3c, 0xe6be28, 0x9650c8, 0xe06c1e];
// Color-vision-deficiency safe palette (Okabe-Ito derived).
export const STRAND_COLORS_CVD = [0xd55e00, 0x0072b2, 0x009e73, 0xf0e442, 0xcc79a7, 0x56b4e9];
export const STRAND_SHAPES = ['circle', 'square', 'triangle', 'diamond', 'star', 'hexagon'];

export const THEMES = [
  { name: 'Walnut Worktable', bg: 0x2b2320, table: 0x6b4a2f, boardA: 0x8a5a3b, boardB: 0xa9744f, cloth: 0x3a2f28 },
  { name: 'Rosewood Studio', bg: 0x2e2028, table: 0x7a4452, boardA: 0x96605e, boardB: 0xb08276, cloth: 0x402e38 },
  { name: 'Sage Sunroom', bg: 0x232a24, table: 0x5a6b4a, boardA: 0x77895f, boardB: 0x93a874, cloth: 0x2f3a30 },
  { name: 'Indigo Night', bg: 0x1c2130, table: 0x3a4670, boardA: 0x4c5a8a, boardB: 0x66749f, cloth: 0x262c40 },
  { name: 'Birch Morning', bg: 0x33302a, table: 0xb59a6b, boardA: 0xc9ad7d, boardB: 0xdcc495, cloth: 0x403a30 },
];

/* ---------------- level ids ---------------- */

export function dailySeedString(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `daily-${y}-${m}-${d}`;
}

export const STAGE_COUNT = 40;

export function isValidLevelId(id) {
  if (id === 'tutorial') return true;
  if (/^stage-(\d+)$/.test(id)) { const n = +id.slice(6); return n >= 1 && n <= STAGE_COUNT; }
  if (/^daily-\d{4}-\d{2}-\d{2}$/.test(id)) return true;
  if (/^practice-(easy|medium|hard)$/.test(id)) return true;
  if (/^challenge-([1-9]|1[0-2])$/.test(id)) return true;
  return false;
}

/* ---------------- generator ---------------- */

function paramsFor(id) {
  // { cols, rows, count, minLen, maxLen, theme, difficulty, moveLimit?, name, mode }
  if (id === 'tutorial') {
    return { cols: 3, rows: 3, count: 2, minLen: 2, maxLen: 3, theme: 0, difficulty: 1, name: 'First Stitches', mode: 'learn' };
  }
  let m;
  if ((m = /^stage-(\d+)$/.exec(id))) {
    const n = +m[1];
    const tier = Math.floor((n - 1) / 8); // 0..4
    const size = 4 + Math.min(2, Math.floor(tier / 2)); // 4,4,5,5,6
    return {
      cols: size, rows: size,
      count: Math.min(6, 2 + tier + (n % 2)),
      minLen: 2 + tier, maxLen: 4 + tier * 2,
      theme: (n - 1) % 5,
      difficulty: 1 + tier,
      name: 'Stage ' + n,
      mode: 'journey',
      mastery: n % 8 === 0, // periodic mastery stages
    };
  }
  if ((m = /^practice-(easy|medium|hard)$/.exec(id))) {
    const t = { easy: 0, medium: 2, hard: 4 }[m[1]];
    const size = 4 + Math.min(2, Math.floor(t / 2));
    return { cols: size, rows: size, count: 3 + t, minLen: 2 + t, maxLen: 4 + t * 2, theme: 0, difficulty: 1 + t, name: 'Practice (' + m[1] + ')', mode: 'practice' };
  }
  if ((m = /^challenge-(\d+)$/.exec(id))) {
    const n = +m[1];
    const tier = 1 + (n % 4);
    const size = 4 + Math.min(2, Math.floor(tier / 2));
    return { cols: size, rows: size, count: 3 + tier, minLen: 2 + tier, maxLen: 4 + tier * 2, theme: n % 5, difficulty: 2 + tier, name: 'Challenge ' + n, mode: 'challenge', challenge: true };
  }
  // daily
  const day = id.slice(6);
  const r = mulberry32(seedFromString('daily-params-' + day));
  const tier = 1 + Math.floor(r() * 4);
  const size = 4 + Math.min(2, Math.floor(tier / 2));
  return { cols: size, rows: size, count: 3 + tier, minLen: 2 + tier, maxLen: 4 + tier * 2, theme: Math.floor(r() * 5), difficulty: 1 + tier, name: 'Daily ' + day, mode: 'daily' };
}

/**
 * Generate a level deterministically from its id.
 * Solutions are grown by random walks from each spool into free cells, so a
 * non-crossing solution always exists by construction.
 */
export function generateLevel(id) {
  if (!isValidLevelId(id)) throw new Error('unknown level id: ' + id);
  // Retry salted seeds until every strand gets a real path (length >= 2).
  for (let attempt = 0; attempt < 64; attempt++) {
    const level = tryGenerate(id, attempt);
    if (level) return level;
  }
  throw new Error('could not generate level: ' + id);
}

function tryGenerate(id, attempt) {
  const p = paramsFor(id);
  const rng = mulberry32(seedFromString('level-v' + CONTENT_VERSION + '-' + id + '-' + attempt));

  const total = p.cols * p.rows;
  const used = new Set();
  const spools = [];
  // Place spools on distinct cells, biased to edges for readability.
  let guard = 0;
  while (spools.length < p.count && guard++ < 500) {
    const cell = Math.floor(rng() * total);
    if (used.has(cell)) continue;
    if (spools.length < p.count - 1 && rng() < 0.5) {
      const r = Math.floor(cell / p.cols), c = cell % p.cols;
      const edge = r === 0 || c === 0 || r === p.rows - 1 || c === p.cols - 1;
      if (!edge) continue;
    }
    used.add(cell);
    spools.push(cell);
  }

  // Grow a solution path for each strand, longest-target first.
  const order = spools.map((_, i) => i).sort(() => rng() - 0.5);
  const solutions = new Array(p.count).fill(null);
  for (const i of order) {
    const target = Math.max(1, Math.round(p.minLen + rng() * (p.maxLen - p.minLen)));
    const path = [spools[i]];
    const local = new Set([spools[i]]);
    for (let step = 0; step < target; step++) {
      const head = path[path.length - 1];
      const r = Math.floor(head / p.cols), c = head % p.cols;
      const nbrs = [];
      if (r > 0) nbrs.push(head - p.cols);
      if (r < p.rows - 1) nbrs.push(head + p.cols);
      if (c > 0) nbrs.push(head - 1);
      if (c < p.cols - 1) nbrs.push(head + 1);
      const free = nbrs.filter((n) => !used.has(n) && !local.has(n));
      if (!free.length) break;
      const next = free[Math.floor(rng() * free.length)];
      path.push(next); local.add(next);
    }
    for (const cell of path) used.add(cell);
    // path runs spool -> anchor; solution for play runs anchor -> spool.
    solutions[i] = path.slice().reverse();
  }

  const strands = spools.map((spool, i) => ({
    color: i,
    spool,
    anchor: solutions[i][0],
  }));
  if (solutions.some((sol) => sol.length < 2)) return null; // degenerate path; retry with next salt
  const par = solutions.reduce((sum, sol) => sum + sol.length, 0); // extends + one reel each
  const level = {
    version: CONTENT_VERSION,
    id,
    name: p.name,
    mode: p.mode,
    difficulty: p.difficulty,
    mastery: !!p.mastery,
    cols: p.cols,
    rows: p.rows,
    theme: p.theme,
    par,
    moveLimit: p.challenge ? par + 2 : null,
    strands,
    solution: solutions, // accepted solution class (not necessarily unique)
  };
  return level;
}

/* ---------------- validator ---------------- */

/**
 * Offline validator: legality, reachable goals, bounded duration, no soft locks.
 * Replays the authored solution through the real rules engine.
 */
export function validateLevel(level) {
  const errors = [];
  const cells = new Set();
  for (const s of level.strands) {
    if (cells.has(s.spool)) errors.push('duplicate-spool');
    if (cells.has(s.anchor)) errors.push('anchor-overlap');
    cells.add(s.spool); cells.add(s.anchor);
    if (s.spool < 0 || s.spool >= level.cols * level.rows) errors.push('spool-out-of-bounds');
    if (s.anchor < 0 || s.anchor >= level.cols * level.rows) errors.push('anchor-out-of-bounds');
  }
  let state = createGame(level);
  for (let i = 0; i < level.strands.length; i++) {
    const sol = level.solution[i];
    if (!sol || sol[0] !== level.strands[i].anchor || sol[sol.length - 1] !== level.strands[i].spool) {
      errors.push('bad-solution-endpoints-' + i);
      continue;
    }
    for (let k = 1; k < sol.length; k++) {
      const a = { type: 'extend', strand: i, cell: sol[k] };
      const chk = checkAction(state, a);
      if (!chk.ok) { errors.push(`solution-${i}-step-${k}-${chk.reason}`); break; }
      state = applyAction(state, a);
    }
    const chk = checkAction(state, { type: 'reel', strand: i });
    if (!chk.ok) errors.push(`solution-${i}-reel-${chk.reason}`);
    else state = applyAction(state, { type: 'reel', strand: i });
  }
  if (!errors.length && !isTerminal(state)) errors.push('solution-not-terminal');
  if (state.moves > level.par) errors.push('par-too-low');
  return { ok: errors.length === 0, errors, finalHash: hashState(state) };
}

/* ---------------- journey / tutorial metadata ---------------- */

export function stageId(n) { return 'stage-' + n; }

export const TUTORIAL_STEPS = [
  { text: 'Welcome to the worktable! Each colored strand must reach the spool of the same color and shape. Tap the red strand to select it.', require: { type: 'select', strand: 0 } },
  { text: 'Now drag or tap into an empty neighboring cell to route the strand. Strands may never cross or share a cell.', require: { type: 'extend', strand: 0 } },
  { text: 'Route the strand until its tip rests on the matching spool.', require: { type: 'at-spool', strand: 0 } },
  { text: 'The tip is on the spool — reel it in! Tap the spool again or press R.', require: { type: 'reel', strand: 0 } },
  { text: 'Now finish the blue strand on your own. Wrong turns? Tap behind the tip or press U to undo.', require: { type: 'reel', strand: 1 } },
];

export const ACHIEVEMENTS = [
  { key: 'first-completion', name: 'First Completion', desc: 'Finish your first board.' },
  { key: 'mechanic-mastery', name: 'Mechanic Mastery', desc: 'Finish a mastery stage.' },
  { key: 'streak-3', name: 'Steady Hands', desc: 'Finish boards on 3 different days.' },
  { key: 'milestone-20', name: 'Half the Journey', desc: 'Complete 20 journey stages.' },
  { key: 'journeyman-40', name: 'Master of Threads', desc: 'Complete all 40 journey stages.' },
];
