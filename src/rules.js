// Tangled Threads — pure deterministic rules engine.
// No rendering, no I/O. All state transitions go through applyAction().

export const SCHEMA_VERSION = 1;

/* ---------------- seeded random streams ---------------- */

export function seedFromString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t, (t >>> 7) * 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- geometry helpers ---------------- */

export function cellRow(state, cell) { return Math.floor(cell / state.cols); }
export function cellCol(state, cell) { return cell % state.cols; }

export function isAdjacent(state, a, b) {
  const ra = cellRow(state, a), ca = cellCol(state, a);
  const rb = cellRow(state, b), cb = cellCol(state, b);
  return (ra === rb && Math.abs(ca - cb) === 1) || (ca === cb && Math.abs(ra - rb) === 1);
}

function occupiedBy(state, cell) {
  for (const s of state.strands) {
    if (s.path.includes(cell)) return s.id;
  }
  return -1;
}

function spoolOwner(state, cell) {
  for (const s of state.strands) {
    if (!s.done && s.spool === cell) return s.id;
  }
  return -1;
}

/* ---------------- state construction ---------------- */

/**
 * level: { id, cols, rows, par, moveLimit?, strands: [{color, spool, anchor}] }
 */
export function createGame(level) {
  return {
    version: SCHEMA_VERSION,
    seed: level.id,
    cols: level.cols,
    rows: level.rows,
    par: level.par,
    moveLimit: level.moveLimit ?? null,
    tick: 0,
    moves: 0,
    invalid: 0,
    hints: 0,
    strands: level.strands.map((s, i) => ({
      id: i,
      color: s.color,
      spool: s.spool,
      anchor: s.anchor,
      path: [s.anchor],
      done: false,
    })),
    terminal: null,
  };
}

/* ---------------- legality ---------------- */

/**
 * checkAction(state, action) -> { ok: true } | { ok: false, reason: string }
 * Reasons are stable machine-readable strings used by tests, UI, and server.
 */
export function checkAction(state, action) {
  if (state.terminal) return { ok: false, reason: 'game-over' };
  const s = state.strands[action.strand];
  if (!s) return { ok: false, reason: 'no-such-strand' };

  if (action.type === 'extend') {
    if (s.done) return { ok: false, reason: 'strand-done' };
    const cell = action.cell;
    if (!Number.isInteger(cell) || cell < 0 || cell >= state.cols * state.rows) return { ok: false, reason: 'out-of-bounds' };
    const head = s.path[s.path.length - 1];
    if (!isAdjacent(state, head, cell)) return { ok: false, reason: 'not-adjacent' };
    const occ = occupiedBy(state, cell);
    if (occ !== -1) return { ok: false, reason: occ === s.id ? 'crosses-self' : 'cell-occupied' };
    const so = spoolOwner(state, cell);
    if (so !== -1 && so !== s.id) return { ok: false, reason: 'wrong-spool' };
    return { ok: true };
  }

  if (action.type === 'retract') {
    if (s.done) return { ok: false, reason: 'strand-done' };
    if (s.path.length <= 1) return { ok: false, reason: 'too-short' };
    return { ok: true };
  }

  if (action.type === 'reel') {
    if (s.done) return { ok: false, reason: 'strand-done' };
    const head = s.path[s.path.length - 1];
    if (head !== s.spool) return { ok: false, reason: 'not-at-spool' };
    return { ok: true };
  }

  return { ok: false, reason: 'unknown-action' };
}

export function isLegal(state, action) { return checkAction(state, action).ok; }

/** All currently legal actions — the same API hints and tutorials use. */
export function legalActions(state) {
  const out = [];
  if (state.terminal) return out;
  for (const s of state.strands) {
    if (s.done) continue;
    const head = s.path[s.path.length - 1];
    const r = cellRow(state, head), c = cellCol(state, head);
    const nbrs = [];
    if (r > 0) nbrs.push(head - state.cols);
    if (r < state.rows - 1) nbrs.push(head + state.cols);
    if (c > 0) nbrs.push(head - 1);
    if (c < state.cols - 1) nbrs.push(head + 1);
    for (const cell of nbrs) {
      const a = { type: 'extend', strand: s.id, cell };
      if (checkAction(state, a).ok) out.push(a);
    }
    if (checkAction(state, { type: 'retract', strand: s.id }).ok) out.push({ type: 'retract', strand: s.id });
    if (checkAction(state, { type: 'reel', strand: s.id }).ok) out.push({ type: 'reel', strand: s.id });
  }
  return out;
}

/* ---------------- transitions ---------------- */

/** applyAction: pure; throws on illegal action. Returns a new state object. */
export function applyAction(state, action) {
  const chk = checkAction(state, action);
  if (!chk.ok) throw new Error('illegal action: ' + chk.reason);
  const next = {
    ...state,
    tick: state.tick + 1,
    moves: action.type === 'retract' ? state.moves : state.moves + 1,
    strands: state.strands.map((s) => ({ ...s, path: s.path.slice() })),
  };
  const s = next.strands[action.strand];
  if (action.type === 'extend') {
    s.path.push(action.cell);
  } else if (action.type === 'retract') {
    s.path.pop();
  } else if (action.type === 'reel') {
    s.done = true;
  }
  if (next.strands.every((t) => t.done)) {
    next.terminal = { reason: 'complete', score: scoreState(next) };
  } else if (next.moveLimit != null && next.moves >= next.moveLimit) {
    next.terminal = { reason: 'move-limit', score: scoreState(next) };
  }
  return next;
}

/** Record a rejected action attempt (counts toward tie-breaks). */
export function recordInvalid(state) {
  return { ...state, invalid: state.invalid + 1 };
}

export function recordHint(state) {
  return { ...state, hints: state.hints + 1 };
}

export function isTerminal(state) { return state.terminal !== null; }

/* ---------------- scoring ---------------- */

/**
 * Score breakdown, all integers:
 *  completion: 0..1000 proportional to reeled strands (1000 only when all reeled)
 *  efficiency: 0..500, 500 at par, -25 per extra move over par
 *  independence: 0..200, -50 per hint used
 *  discipline: 0..100, -10 per invalid action
 *  total = sum
 */
export function scoreState(state) {
  const n = state.strands.length;
  const done = state.strands.filter((s) => s.done).length;
  const completion = Math.round((1000 * done) / n);
  const efficiency = Math.max(0, 500 - 25 * Math.max(0, state.moves - state.par));
  const independence = Math.max(0, 200 - 50 * state.hints);
  const discipline = Math.max(0, 100 - 10 * state.invalid);
  return { completion, efficiency, independence, discipline, total: completion + efficiency + independence + discipline };
}

/** Tie-break comparison: returns negative if a beats b. */
export function compareResults(a, b) {
  if (b.score.completion !== a.score.completion) return b.score.completion - a.score.completion;
  if (b.score.total !== a.score.total) return b.score.total - a.score.total;
  if (a.invalid !== b.invalid) return a.invalid - b.invalid;
  if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
  return String(a.sessionId).localeCompare(String(b.sessionId));
}

/* ---------------- hashing / serialization ---------------- */

export function hashState(state) {
  let h = 2166136261 >>> 0;
  const push = (n) => { h ^= (n | 0) >>> 0; h = Math.imul(h, 16777619); };
  push(state.version); push(state.tick); push(state.moves); push(state.invalid); push(state.hints);
  push(state.cols); push(state.rows);
  for (const s of state.strands) {
    push(s.id + 1); push(s.color + 1); push(s.spool + 1); push(s.anchor + 1);
    push(s.done ? 1 : 0); push(s.path.length);
    for (const c of s.path) push(c + 1);
  }
  push(state.terminal ? 7919 : 0);
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function serialize(state) { return JSON.stringify(state); }

export function deserialize(json) {
  const state = typeof json === 'string' ? JSON.parse(json) : json;
  if (state.version > SCHEMA_VERSION) throw new Error('unsupported state version: ' + state.version);
  return state;
}

/* ---------------- replay ---------------- */

/**
 * Replay an ordered command log against a fresh game.
 * commands: [{ id, type, strand, cell? }] — ids must be unique (idempotent dedupe).
 * Returns { state, hashes, applied } where hashes[i] is the state hash after command i.
 */
export function replay(level, commands) {
  let state = createGame(level);
  const hashes = [];
  const seen = new Set();
  let applied = 0;
  for (const cmd of commands) {
    if (seen.has(cmd.id)) continue; // duplicate commands rejected idempotently
    seen.add(cmd.id);
    const chk = checkAction(state, cmd);
    if (!chk.ok) return { state, hashes, applied, error: chk.reason, failedCommand: cmd.id };
    state = applyAction(state, cmd);
    applied++;
    hashes.push(hashState(state));
  }
  return { state, hashes, applied };
}
