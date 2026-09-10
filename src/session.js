// Tangled Threads — session: phases, validated commands, undo, hints, replay log, snapshots.

import {
  createGame, checkAction, applyAction, recordInvalid, recordHint,
  hashState, serialize, deserialize, replay, legalActions,
} from './rules.js';
import { generateLevel, isValidLevelId } from './content.js';

export const PHASES = ['boot', 'title', 'profile-ready', 'mode-select', 'preparing', 'countdown', 'active', 'paused', 'reconnecting', 'resolving', 'results', 'progression'];

let commandSeq = 0;
export function nextCommandId(sessionId) {
  return sessionId + '-' + (++commandSeq);
}

export function randomSessionId() {
  return 's' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * A Session owns one level attempt. The only way to mutate rules state is
 * dispatch(), which validates through the rules engine.
 */
export class Session {
  constructor(levelId, opts = {}) {
    if (!isValidLevelId(levelId)) throw new Error('bad level id');
    this.level = generateLevel(levelId);
    this.state = createGame(this.level);
    this.phase = 'preparing';
    this.phaseReason = 'new-session';
    this.sessionId = opts.sessionId || randomSessionId();
    this.log = [];            // applied commands: {id, type, strand, cell?}
    this.hashes = [hashState(this.state)];
    this.undone = [];         // undone commands for redo-free simple undo
    this.startedAt = null;
    this.elapsedMs = 0;
    this._resumeAt = null;
    this.mode = opts.mode || this.level.mode;
    this.ranked = this.mode === 'daily' || this.mode === 'journey' || this.mode === 'challenge';
    this.assists = { hints: 0 };
  }

  setPhase(phase, reason) {
    if (!PHASES.includes(phase)) throw new Error('bad phase: ' + phase);
    this.phase = phase;
    this.phaseReason = reason;
    if (phase === 'active' && !this.startedAt) { this.startedAt = Date.now(); this._resumeAt = this.startedAt; }
    if (phase === 'active' && this._resumeAt == null) this._resumeAt = Date.now();
    if (phase !== 'active' && this._resumeAt != null) {
      this.elapsedMs += Date.now() - this._resumeAt;
      this._resumeAt = null;
    }
  }

  now() {
    return this.elapsedMs + (this._resumeAt != null ? Date.now() - this._resumeAt : 0);
  }

  /** Dispatch a gameplay command. Returns { ok, reason?, events? }. */
  dispatch(cmd) {
    if (this.phase !== 'active') return { ok: false, reason: 'not-active' };
    const action = { type: cmd.type, strand: cmd.strand, cell: cmd.cell };
    const chk = checkAction(this.state, action);
    if (!chk.ok) {
      this.state = recordInvalid(this.state);
      return { ok: false, reason: chk.reason };
    }
    const id = cmd.id || nextCommandId(this.sessionId);
    if (this.log.some((c) => c.id === id)) return { ok: true, duplicate: true }; // idempotent
    this.state = applyAction(this.state, action);
    const entry = { id, type: cmd.type, strand: cmd.strand };
    if (cmd.type === 'extend') entry.cell = cmd.cell;
    this.log.push(entry);
    this.undone = [];
    this.hashes.push(hashState(this.state));
    if (this.state.terminal) {
      this.setPhase('results', this.state.terminal.reason);
    }
    return { ok: true, terminal: this.state.terminal || undefined };
  }

  /** Undo the last applied command (practice/learn/journey; not daily ranked). */
  undo() {
    if (this.phase !== 'active') return { ok: false, reason: 'not-active' };
    if (this.mode === 'daily') return { ok: false, reason: 'no-undo' };
    if (!this.log.length) return { ok: false, reason: 'nothing-to-undo' };
    const keep = this.log.slice(0, -1);
    const r = replay(this.level, keep);
    if (r.error) return { ok: false, reason: 'replay-mismatch' };
    this.undone.push(this.log[this.log.length - 1]);
    this.log = keep;
    this.state = r.state;
    this.hashes = [hashState(createGame(this.level)), ...r.hashes];
    return { ok: true };
  }

  /** Hint from the authored solution, via the same legality API as play. */
  hint() {
    if (this.phase !== 'active') return { ok: false, reason: 'not-active' };
    for (let i = 0; i < this.level.strands.length; i++) {
      const s = this.state.strands[i];
      if (s.done) continue;
      const sol = this.level.solution[i];
      // Longest prefix of current path matching the solution.
      let k = 0;
      while (k < s.path.length && k < sol.length && s.path[k] === sol[k]) k++;
      let action = null;
      if (k < s.path.length) {
        action = { type: 'retract', strand: i }; // off-solution: pull back
      } else if (k < sol.length) {
        action = { type: 'extend', strand: i, cell: sol[k] };
      } else {
        action = { type: 'reel', strand: i };
      }
      if (checkAction(this.state, action).ok) {
        this.state = recordHint(this.state);
        this.assists.hints++;
        return { ok: true, action };
      }
    }
    // Fallback: any legal action.
    const any = legalActions(this.state)[0];
    if (any) {
      this.state = recordHint(this.state);
      this.assists.hints++;
      return { ok: true, action: any };
    }
    return { ok: false, reason: 'no-hint' };
  }

  /** Durable snapshot for reconnect / crash recovery. */
  snapshot() {
    return {
      version: 1,
      levelId: this.level.id,
      sessionId: this.sessionId,
      mode: this.mode,
      log: this.log,
      state: serialize(this.state),
      elapsedMs: this.now(),
      savedAt: Date.now(),
    };
  }

  static restore(snap) {
    const sess = new Session(snap.levelId, { sessionId: snap.sessionId, mode: snap.mode });
    const r = replay(sess.level, snap.log);
    if (r.error || serialize(r.state) !== serialize(deserialize(snap.state))) {
      // Cached client state is untrusted: fall back to the replayed truth.
      sess.state = r.state;
    } else {
      sess.state = deserialize(snap.state);
    }
    sess.log = snap.log.slice();
    sess.hashes = [hashState(createGame(sess.level)), ...r.hashes];
    sess.elapsedMs = snap.elapsedMs || 0;
    sess.phase = 'reconnecting';
    sess.phaseReason = 'restored-snapshot';
    return sess;
  }

  /** Replay envelope per spec §5. */
  replayEnvelope() {
    return {
      schemaVersion: 1,
      contentVersion: this.level.version,
      levelId: this.level.id,
      seed: this.level.id,
      sessionId: this.sessionId,
      initialHash: this.hashes[0],
      timestampOffset: this.startedAt || 0,
      commands: this.log,
      stateHashes: this.hashes,
      elapsedMs: this.now(),
      assists: this.assists,
      result: this.state.terminal
        ? { reason: this.state.terminal.reason, score: this.state.terminal.score, invalid: this.state.invalid }
        : null,
      finalHash: hashState(this.state),
    };
  }
}
