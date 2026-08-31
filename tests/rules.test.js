import { describe, it, expect } from 'vitest';
import {
  createGame, checkAction, applyAction, legalActions, scoreState, hashState,
  serialize, deserialize, replay, mulberry32, seedFromString, compareResults, isTerminal,
} from '../src/rules.js';
import {
  generateLevel, validateLevel, isValidLevelId, dailySeedString, STAGE_COUNT, stageId,
} from '../src/content.js';
import { Session } from '../src/session.js';

/* ---------------- rules: legality ---------------- */

const tinyLevel = {
  id: 'test', version: 1, cols: 3, rows: 3, par: 7, moveLimit: null,
  strands: [
    { color: 0, spool: 2, anchor: 0 },
    { color: 1, spool: 3, anchor: 8 },
  ],
  solution: [[0, 1, 2], [8, 7, 6, 3]],
};

describe('rules engine', () => {
  it('creates a deterministic initial state', () => {
    const a = createGame(tinyLevel);
    const b = createGame(tinyLevel);
    expect(hashState(a)).toBe(hashState(b));
    expect(a.tick).toBe(0);
  });

  it('accepts legal extend and rejects illegal ones with reasons', () => {
    let s = createGame(tinyLevel);
    expect(checkAction(s, { type: 'extend', strand: 0, cell: 1 }).ok).toBe(true);
    expect(checkAction(s, { type: 'extend', strand: 0, cell: 5 }).reason).toBe('not-adjacent');
    expect(checkAction(s, { type: 'extend', strand: 0, cell: 99 }).reason).toBe('out-of-bounds');
    expect(checkAction(s, { type: 'extend', strand: 9, cell: 1 }).reason).toBe('no-such-strand');
    expect(checkAction(s, { type: 'extend', strand: 0, cell: 3 }).reason).toBe('wrong-spool');
    s = applyAction(s, { type: 'extend', strand: 0, cell: 1 });
    s = applyAction(s, { type: 'extend', strand: 1, cell: 7 });
    s = applyAction(s, { type: 'extend', strand: 1, cell: 4 });
    expect(checkAction(s, { type: 'extend', strand: 0, cell: 4 }).reason).toBe('cell-occupied');
    expect(checkAction(s, { type: 'extend', strand: 1, cell: 7 }).reason).toBe('crosses-self');
  });

  it('retract requires length > 1 and is not a move', () => {
    let s = createGame(tinyLevel);
    expect(checkAction(s, { type: 'retract', strand: 0 }).reason).toBe('too-short');
    s = applyAction(s, { type: 'extend', strand: 0, cell: 1 });
    const before = s.moves;
    s = applyAction(s, { type: 'retract', strand: 0 });
    expect(s.moves).toBe(before); // retract is free
    expect(s.strands[0].path).toEqual([0]);
  });

  it('reel requires head on own spool and completes the board', () => {
    let s = createGame(tinyLevel);
    expect(checkAction(s, { type: 'reel', strand: 0 }).reason).toBe('not-at-spool');
    s = applyAction(s, { type: 'extend', strand: 0, cell: 1 });
    s = applyAction(s, { type: 'extend', strand: 0, cell: 2 });
    expect(checkAction(s, { type: 'reel', strand: 0 }).ok).toBe(true);
    s = applyAction(s, { type: 'reel', strand: 0 });
    expect(s.strands[0].done).toBe(true);
    expect(isTerminal(s)).toBe(false);
    s = applyAction(s, { type: 'extend', strand: 1, cell: 7 });
    s = applyAction(s, { type: 'extend', strand: 1, cell: 6 });
    s = applyAction(s, { type: 'extend', strand: 1, cell: 3 });
    s = applyAction(s, { type: 'reel', strand: 1 });
    expect(isTerminal(s)).toBe(true);
    expect(s.terminal.reason).toBe('complete');
    expect(checkAction(s, { type: 'extend', strand: 0, cell: 0 }).reason).toBe('game-over');
  });

  it('tick increases monotonically', () => {
    let s = createGame(tinyLevel);
    s = applyAction(s, { type: 'extend', strand: 0, cell: 1 });
    s = applyAction(s, { type: 'retract', strand: 0 });
    expect(s.tick).toBe(2);
  });

  it('legalActions only yields legal actions', () => {
    const s = createGame(tinyLevel);
    for (const a of legalActions(s)) {
      expect(checkAction(s, a).ok).toBe(true);
    }
    expect(legalActions(s).length).toBeGreaterThan(0);
  });

  it('scoring breakdown is integer and bounded', () => {
    let s = createGame(tinyLevel);
    for (const c of [1, 2]) s = applyAction(s, { type: 'extend', strand: 0, cell: c });
    s = applyAction(s, { type: 'reel', strand: 0 });
    for (const c of [7, 6, 3]) s = applyAction(s, { type: 'extend', strand: 1, cell: c });
    s = applyAction(s, { type: 'reel', strand: 1 });
    const sc = s.terminal.score;
    expect(sc.completion).toBe(1000);
    expect(sc.efficiency).toBe(500); // at par
    expect(sc.independence).toBe(200);
    expect(sc.discipline).toBe(100);
    expect(sc.total).toBe(1800);
    for (const k of Object.keys(sc)) expect(Number.isInteger(sc[k])).toBe(true);
  });

  it('move limit terminates with move-limit reason', () => {
    const lvl = { ...tinyLevel, moveLimit: 1 };
    let s = createGame(lvl);
    s = applyAction(s, { type: 'extend', strand: 0, cell: 1 });
    expect(isTerminal(s)).toBe(true);
    expect(s.terminal.reason).toBe('move-limit');
    expect(s.terminal.score.completion).toBe(0);
  });

  it('serializes and migrates', () => {
    let s = createGame(tinyLevel);
    s = applyAction(s, { type: 'extend', strand: 0, cell: 1 });
    const back = deserialize(serialize(s));
    expect(hashState(back)).toBe(hashState(s));
    expect(() => deserialize({ version: 999 })).toThrow();
  });

  it('tie-break comparison follows the spec order', () => {
    const base = { score: { completion: 1000, total: 1500 }, invalid: 0, elapsedMs: 100, sessionId: 'a' };
    expect(compareResults(base, { ...base, score: { completion: 500, total: 900 } })).toBeLessThan(0);
    expect(compareResults(base, { ...base, invalid: 2 })).toBeLessThan(0);
    expect(compareResults(base, { ...base, elapsedMs: 200 })).toBeLessThan(0);
    expect(compareResults(base, { ...base, sessionId: 'b' })).toBeLessThan(0);
  });
});

/* ---------------- determinism / replay ---------------- */

describe('determinism and replay', () => {
  it('seeded random streams are reproducible', () => {
    const a = mulberry32(seedFromString('x'));
    const b = mulberry32(seedFromString('x'));
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it('same version + seed + commands produce identical hashes (property test)', () => {
    for (const id of ['stage-1', 'stage-17', 'stage-40', 'challenge-3', dailySeedString()]) {
      const level = generateLevel(id);
      const commands = [];
      let n = 0;
      for (let i = 0; i < level.strands.length; i++) {
        for (const cell of level.solution[i].slice(1)) commands.push({ id: 'c' + (++n), type: 'extend', strand: i, cell });
        commands.push({ id: 'c' + (++n), type: 'reel', strand: i });
      }
      const r1 = replay(level, commands);
      const r2 = replay(level, commands);
      expect(r1.error).toBeUndefined();
      expect(r1.hashes).toEqual(r2.hashes);
      expect(hashState(r1.state)).toBe(hashState(r2.state));
      expect(isTerminal(r1.state)).toBe(true);
    }
  });

  it('replay rejects duplicates idempotently and reports bad commands', () => {
    const level = generateLevel('stage-1');
    const c1 = { id: 'x', type: 'extend', strand: 0, cell: level.solution[0][1] };
    const r = replay(level, [c1, c1]);
    expect(r.applied).toBe(1);
    const bad = replay(level, [{ id: 'y', type: 'extend', strand: 0, cell: 999 }]);
    expect(bad.error).toBe('out-of-bounds');
  });

  it('fuzz: malformed commands never hang or corrupt', () => {
    const level = generateLevel('stage-2');
    const rng = mulberry32(1234);
    for (let i = 0; i < 500; i++) {
      const cmd = {
        id: 'f' + i,
        type: ['extend', 'retract', 'reel', 'bogus'][Math.floor(rng() * 4)],
        strand: Math.floor(rng() * 8) - 1,
        cell: Math.floor(rng() * 50) - 5,
      };
      const r = replay(level, [cmd]);
      expect(Number.isNaN(hashState(r.state))).toBe(false);
    }
  });
});

/* ---------------- content ---------------- */

describe('content generation and validation', () => {
  it('level ids validate', () => {
    expect(isValidLevelId('tutorial')).toBe(true);
    expect(isValidLevelId('stage-40')).toBe(true);
    expect(isValidLevelId('stage-41')).toBe(false);
    expect(isValidLevelId(dailySeedString())).toBe(true);
    expect(isValidLevelId('practice-hard')).toBe(true);
    expect(isValidLevelId('challenge-12')).toBe(true);
    expect(isValidLevelId('nope')).toBe(false);
  });

  it('every stage, challenge, practice and tutorial passes the offline validator', () => {
    const ids = ['tutorial', 'practice-easy', 'practice-medium', 'practice-hard'];
    for (let n = 1; n <= STAGE_COUNT; n++) ids.push(stageId(n));
    for (let n = 1; n <= 12; n++) ids.push('challenge-' + n);
    for (const id of ids) {
      const level = generateLevel(id);
      const v = validateLevel(level);
      expect(v.errors, id).toEqual([]);
      expect(v.ok, id).toBe(true);
    }
  });

  it('generation is deterministic per id', () => {
    expect(generateLevel('stage-7')).toEqual(generateLevel('stage-7'));
  });

  it('daily seed format is stable per UTC day', () => {
    expect(dailySeedString(new Date(Date.UTC(2026, 0, 5)))).toBe('daily-2026-01-05');
  });
});

/* ---------------- session ---------------- */

describe('session', () => {
  it('dispatches validated commands and tracks undo/hint', () => {
    const s = new Session('stage-1');
    s.setPhase('active', 'test');
    expect(s.dispatch({ type: 'extend', strand: 0, cell: 999 }).ok).toBe(false);
    expect(s.state.invalid).toBe(1);
    const cell = s.level.solution[0][1];
    expect(s.dispatch({ type: 'extend', strand: 0, cell }).ok).toBe(true);
    expect(s.undo().ok).toBe(true);
    expect(s.state.strands[0].path.length).toBe(1);
    const h = s.hint();
    expect(h.ok).toBe(true);
    expect(h.action.type).toBe('extend');
    expect(s.state.hints).toBe(1);
  });

  it('rejects commands while paused', () => {
    const s = new Session('stage-1');
    s.setPhase('active', 'test');
    s.setPhase('paused', 'test');
    expect(s.dispatch({ type: 'extend', strand: 0, cell: 0 }).reason).toBe('not-active');
  });

  it('snapshot restore reconstructs the exact state', () => {
    const s = new Session('stage-3');
    s.setPhase('active', 'test');
    for (const cell of s.level.solution[0].slice(1)) s.dispatch({ type: 'extend', strand: 0, cell });
    const snap = s.snapshot();
    const r = Session.restore(snap);
    expect(hashState(r.state)).toBe(hashState(s.state));
    expect(r.phase).toBe('reconnecting');
  });

  it('completes a full stage end-to-end and produces a replay envelope', () => {
    const s = new Session('stage-5');
    s.setPhase('active', 'test');
    for (let i = 0; i < s.level.strands.length; i++) {
      for (const cell of s.level.solution[i].slice(1)) {
        expect(s.dispatch({ type: 'extend', strand: i, cell }).ok).toBe(true);
      }
      expect(s.dispatch({ type: 'reel', strand: i }).ok).toBe(true);
    }
    expect(s.phase).toBe('results');
    const env = s.replayEnvelope();
    expect(env.result.reason).toBe('complete');
    expect(env.stateHashes.length).toBe(env.commands.length + 1);
    expect(env.finalHash).toBe(env.stateHashes[env.stateHashes.length - 1]);
  });
});
