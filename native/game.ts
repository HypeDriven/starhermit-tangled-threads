// The browser build's pure game modules (shared with the node tests), typed
// for this client: the rules (src/rules.js: strands, legality, scoring,
// replay), the content (src/content.js: themes, palettes, the generator for
// every level id, the validator, the lesson steps, achievements), the
// session (src/session.js: validated commands, undo, hints, snapshots) and
// the save model (src/save.js).
import * as rules from "../src/rules.js";
import * as content from "../src/content.js";
import * as sessionMod from "../src/session.js";
import * as saveMod from "../src/save.js";

export interface StrandDef { color: number; spool: number; anchor: number }
export interface LevelDef {
  version: number; id: string; name: string; mode: string; difficulty: number; mastery: boolean;
  cols: number; rows: number; theme: number; par: number; moveLimit: number | null;
  strands: StrandDef[]; solution: number[][];
}
export interface Strand { id: number; color: number; spool: number; anchor: number; path: number[]; done: boolean }
export interface Score { completion: number; efficiency: number; independence: number; discipline: number; total: number }
export interface State {
  version: number; seed: string; cols: number; rows: number; par: number; moveLimit: number | null;
  tick: number; moves: number; invalid: number; hints: number; strands: Strand[];
  terminal: { reason: string; score: Score } | null;
}
export interface Action { type: "extend" | "retract" | "reel"; strand: number; cell?: number }
export interface Theme { name: string; bg: number; table: number; boardA: number; boardB: number; cloth: number }
export interface Snapshot { version: number; levelId: string; sessionId: string; mode: string; log: unknown[]; state: string; elapsedMs: number; savedAt: number }
export interface Session {
  level: LevelDef; state: State; phase: string; mode: string; ranked: boolean; sessionId: string; log: unknown[];
  elapsedMs: number;
  setPhase(phase: string, reason: string): void;
  now(): number;
  dispatch(cmd: { type: string; strand: number; cell?: number }): { ok: boolean; reason?: string; terminal?: State["terminal"]; duplicate?: boolean };
  undo(): { ok: boolean; reason?: string };
  hint(): { ok: boolean; reason?: string; action?: Action };
  snapshot(): Snapshot;
}
export interface Progress {
  version: number; stagesDone: Record<string, number>; dailiesDone: Record<string, number>; challengesDone: Record<string, number>;
  achievements: Record<string, number>; daysPlayed: Record<string, boolean>; bestScores: Record<string, number>;
}
export interface SaveDoc { v: 1; progress: Progress; tutorialDone: boolean }
export interface Options { cvdPalette: boolean; leftHanded: boolean }

interface RulesApi { checkAction(s: State, a: Action): { ok: boolean; reason?: string } }
interface ContentApi {
  STRAND_COLORS: number[]; STRAND_COLORS_CVD: number[]; THEMES: Theme[]; STAGE_COUNT: number;
  TUTORIAL_STEPS: { text: string; require: { type: string; strand: number } }[];
  ACHIEVEMENTS: { key: string; name: string; desc: string }[];
  generateLevel(id: string): LevelDef; validateLevel(l: LevelDef): { ok: boolean; errors: string[] };
  dailySeedString(d: Date): string; stageId(n: number): string;
}
interface SaveApi {
  emptySave(): SaveDoc; normalize(raw: unknown): SaveDoc; mergeSave(remote: unknown, local: unknown): SaveDoc; sameSave(a: unknown, b: unknown): boolean;
  readForeign(text: string): { save: SaveDoc; options: Partial<Options> } | null;
  DEFAULT_OPTIONS: Options; OPTION_KEYS: (keyof Options)[]; BROWSER_KEYS: string[];
  pickOptions(raw: unknown): Partial<Options>; readLegacySettings(kv: Record<string, unknown>): { options: Partial<Options>; tutorialDone: boolean };
}
interface SessionCtor {
  new (levelId: string, opts?: { sessionId?: string; mode?: string }): Session;
  restore(snap: Snapshot): Session;
}

export const Rules = rules as unknown as RulesApi;
export const Content = content as unknown as ContentApi;
export const SaveModel = saveMod as unknown as SaveApi;
export const SessionClass = (sessionMod as unknown as { Session: SessionCtor }).Session;
