// Tangled Threads on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (src/rules.js), content
// (src/content.js) and session (src/session.js: validated commands, undo,
// hints, snapshots) are the browser build's, unchanged; this module is what
// src/main.js did around them — the screen flow (title → modes → a board ⇄
// pause → results, help and settings from the title), starting every mode
// (Learn, Journey, Daily, Practice, Challenge), selecting, routing (taps,
// drags, the board mirror, the keyboard cursor and pads), pulling back,
// reeling, undo, hints, the lesson steps, the results with achievements and
// the score post, restoring an interrupted round, and the lifecycle (a hidden
// window pauses the round and saves it, as visibilitychange did). Screens
// are drawn by screens.ts (starhermit:ui), the board by render.ts
// (starhermit:scene).
import { clipboard, frame, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences } from "starhermit:engine";
import { onAction, onPointerButton, onPointerMove, onTouch, primaryPointer, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import { Content, Rules, SessionClass, type Session } from "./game.ts";
import * as audio from "./audio.ts";
import { S, T, levelName } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

export type Overlay = "title" | "modes" | "pause" | "results" | "help" | null;
export interface Results {
  reason: string; moves: number; hints: number; secs: string; unlocked: string[];
  lb: { key: string; vars?: Record<string, string | number> } | null; compare: boolean;
}

export const app = {
  overlay: "title" as Overlay,
  openedFrame: 0,
  focusNext: null as string | null,
  session: null as Session | null,
  selection: -1,
  cursorCell: 0,
  tutorialStep: 0,
  pendingMode: null as string | null,
  /** The hint bar's message (a function so it re-renders in a new language), null when hidden. */
  hintText: null as (() => string) | null,
  /** The pause panel opened from the title (Settings): its Resume reads Back. */
  settingsFromTitle: false,
  helpReturn: "title" as "title" | "pause",
  results: null as Results | null,
  toasts: [] as { text: string; until: number }[],
};
export const fresh = (): boolean => frame().frame !== app.openedFrame;
const now = (): number => frame().time;

// ------------------------------------------------------------------ helpers
const spoken: string[] = [];
let spokenAssertive = false;
/** ui.announce / announceError: one announcement a frame, joined. */
export function announce(text: string, assertive = false): void {
  if (!text) return;
  spoken.push(text);
  spokenAssertive ||= assertive;
}
function flushAnnouncements(): void {
  if (!spoken.length) return;
  const text = spoken.splice(0).join(" ").slice(0, 500);
  try { ui.announce(text, { politeness: spokenAssertive ? "assertive" : "polite" }); } catch { /* busy */ }
  spokenAssertive = false;
}
export function toast(text: string, secs = 2.6): void {
  app.toasts.push({ text, until: now() + secs });
  if (app.toasts.length > 3) app.toasts.shift();
  announce(text);
}
const pending: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built (state changes mid-build would break later widgets). */
export function later(fn: () => void): void { pending.push(fn); }
export const playing = (): boolean => !!app.session && app.session.phase === "active" && app.overlay === null;
function haptic(ms: number): void { try { vibrate(ms); } catch { /* none */ } }

// ------------------------------------------------------------------ overlays
export function open(o: Overlay, focus: string | null = null): void {
  app.overlay = o;
  app.openedFrame = frame().frame;
  app.focusNext = focus ?? (primaryPointer() === "coarse" ? null : firstFocus(o));
  ui.setFocus(null);
}
function firstFocus(o: Overlay): string | null {
  switch (o) {
    case "title": return "btn-play";
    case "modes": return "mode-learn";
    case "pause": return "btn-resume";
    case "results": return "btn-next";
    case "help": return "btn-help-close";
    default: return null;
  }
}
/** The title backdrop: practice-medium mid-solve (main.js showTitleBackdrop). */
function showTitleBackdrop(): void {
  try {
    const lvl = Content.generateLevel("practice-medium");
    const n = lvl.strands.length;
    const strands = lvl.strands.map((s, i) => ({
      id: i, color: s.color, spool: s.spool, anchor: s.anchor, done: false,
      path: i < n - 1 ? lvl.solution[i]!.slice(0, Math.max(2, lvl.solution[i]!.length - 1)) : [s.anchor],
    }));
    render.showShowcase(lvl, { strands });
  } catch { /* decoration only */ }
}
export function showTitle(): void {
  app.session = null;
  app.selection = -1;
  app.hintText = null;
  app.results = null;
  app.settingsFromTitle = false;
  showTitleBackdrop();
  open("title");
}
export function showModes(): void { app.pendingMode = null; open("modes"); }
export function selectMode(mode: string): void { app.pendingMode = mode; app.focusNext = null; }
export function showHelp(from: "title" | "pause"): void { app.helpReturn = from; open("help"); }
export function closeHelp(): void {
  if (app.helpReturn === "pause" && app.session) open("pause");
  else showTitle();
}
export function showSettings(): void { app.settingsFromTitle = true; open("pause"); }

// ------------------------------------------------------------------ session lifecycle
export function startDaily(): void { startLevel(Content.dailySeedString(platform.now())); }
export function startLevel(levelId: string): void {
  let level: ReturnType<typeof Content.generateLevel>;
  try { level = Content.generateLevel(levelId); }
  catch (e) {
    // a few Daily dates have no board (content.js gives up after 64 salts; kept as the browser build had it)
    toast(T("validationFailed", { errors: e instanceof Error ? e.message : String(e) }), 5);
    return;
  }
  const v = Content.validateLevel(level);
  if (!v.ok) { announce(T("validationFailed", { errors: v.errors.join(",") }), true); return; }
  const s = new SessionClass(levelId);
  app.session = s;
  app.selection = -1;
  app.cursorCell = s.state.strands[0]?.anchor ?? 0;
  app.tutorialStep = 0;
  app.results = null;
  app.settingsFromTitle = false;
  app.hintText = null;
  render.clearFx();
  render.buildLevel(level);
  render.syncState(s.state, app.selection);
  s.setPhase("active", "player-start");
  app.overlay = null;
  app.openedFrame = frame().frame;
  ui.setFocus(null);
  updateTutorialText();
  announce(T("levelStart", { name: levelName(level.id) }));
  platform.saveSnapshot(s.snapshot());
  audio.play("uiClick");
}
export function pauseGame(reason: string): void {
  const s = app.session;
  if (!s || s.phase !== "active") return;
  s.setPhase("paused", reason);
  platform.saveSnapshot(s.snapshot());
  open("pause");
  announce(T("announcePaused"));
}
export function resumeGame(): void {
  if (app.settingsFromTitle || !app.session) { showTitle(); return; }
  app.session.setPhase("active", "resume");
  app.overlay = null;
  app.openedFrame = frame().frame;
  ui.setFocus(null);
  announce(T("announceResumed"));
}
export function restart(): void { if (app.session) startLevel(app.session.level.id); }
export function leaveRound(): void { platform.clearSnapshot(); showTitle(); }
export function nextLevel(): void {
  const s = app.session;
  if (!s) { showTitle(); return; }
  const m = /^stage-(\d+)$/.exec(s.level.id);
  if (m && +m[1]! < Content.STAGE_COUNT) startLevel(Content.stageId(+m[1]! + 1));
  else showTitle();
}

const ACH_KEYS: Record<string, string> = { "first-completion": "achFirst", "mechanic-mastery": "achMastery", "streak-3": "achStreak", "milestone-20": "achHalf", "journeyman-40": "achMaster" };
export function achievementName(key: string): string { return ACH_KEYS[key] ? T(ACH_KEYS[key]!) : (Content.ACHIEVEMENTS.find((a) => a.key === key)?.name ?? key); }

/** main.js finishRound: progress, achievements, the score post, the results. */
function finishRound(): void {
  const s = app.session!;
  const term = s.state.terminal!;
  const score = term.score;
  const r: Results = { reason: term.reason, moves: s.state.moves, hints: s.state.hints, secs: (s.now() / 1000).toFixed(0), unlocked: [], lb: null, compare: false };
  app.results = r;
  const progress = platform.progress();
  const grant = (key: string): void => { if (!progress.achievements[key]) { progress.achievements[key] = Date.now(); r.unlocked.push(key); } };
  const today = platform.now().toISOString().slice(0, 10);
  progress.daysPlayed[today] = true;
  if (term.reason === "complete") {
    grant("first-completion");
    const id = s.level.id;
    if (progress.bestScores[id] == null || score.total > progress.bestScores[id]!) progress.bestScores[id] = score.total;
    if (s.level.mode === "journey") {
      progress.stagesDone[id] = Math.max(progress.stagesDone[id] ?? 0, score.total);
      if (s.level.mastery) grant("mechanic-mastery");
      if (Object.keys(progress.stagesDone).length >= 20) grant("milestone-20");
      if (Object.keys(progress.stagesDone).length >= Content.STAGE_COUNT) grant("journeyman-40");
    }
    if (s.level.mode === "challenge") progress.challengesDone[id] = Math.max(progress.challengesDone[id] ?? 0, score.total);
    if (s.level.mode === "daily") progress.dailiesDone[id] = score.total;
    if (Object.keys(progress.daysPlayed).length >= 3) grant("streak-3");
  }
  platform.persist();
  // Ranked rounds: signed in, the total posts to the platform high-score board and the rank line shows;
  // signed out, the comparison line says the score stays local.
  if (s.ranked && platform.signedIn()) {
    r.lb = { key: "lbPosting" };
    void platform.postScore(Math.max(0, Math.round(score.total))).then((p) => {
      r.lb = !p.posted ? { key: "lbNotPosted" } : p.rank ? { key: "lbRank", vars: { rank: p.rank } } : { key: "lbPosted" };
    });
  } else if (s.ranked && term.reason === "complete") r.compare = true;
  audio.play(term.reason === "complete" ? "complete" : "fail");
  platform.clearSnapshot();
  s.setPhase("progression", "results-shown");
  open("results");
  announce(T("totalScore", { headline: resultsHeadline(), total: score.total }), true);
}
export function resultsHeadline(): string { return app.results?.reason === "complete" ? T("boardComplete") : T("outOfMoves"); }

// ------------------------------------------------------------------ tutorial
function updateTutorialText(): void {
  const s = app.session;
  if (!s || s.level.id !== "tutorial") return;
  const step = Content.TUTORIAL_STEPS[app.tutorialStep];
  const n = app.tutorialStep + 1, total = Content.TUTORIAL_STEPS.length;
  app.hintText = step ? () => T("lesson", { n, total, text: T("tut" + n) }) : null;
}
function tutorialCheck(eventType: string, strand: number): void {
  const s = app.session;
  if (!s || s.level.id !== "tutorial") return;
  const step = Content.TUTORIAL_STEPS[app.tutorialStep];
  if (!step) return;
  const r = step.require;
  let hit = false;
  if (r.type === "select" && eventType === "select" && strand === r.strand) hit = true;
  if (r.type === "extend" && eventType === "extend" && strand === r.strand) hit = true;
  if (r.type === "reel" && eventType === "reel" && strand === r.strand) hit = true;
  if (r.type === "at-spool" && eventType === "extend") {
    const st = s.state.strands[r.strand]!;
    hit = st.path[st.path.length - 1] === st.spool;
  }
  if (hit) {
    app.tutorialStep++;
    if (app.tutorialStep >= Content.TUTORIAL_STEPS.length) platform.setTutorialDone();
    updateTutorialText();
  }
}

// ------------------------------------------------------------------ gameplay actions
function syncAll(): void {
  const s = app.session!;
  render.syncState(s.state, app.selection);
  audio.setMusicIntensity(s.state.strands.filter((x) => x.done).length / s.state.strands.length);
  // a completed action clears the last error/hint; the tutorial keeps its lesson
  if (s.level.id === "tutorial") updateTutorialText();
  else app.hintText = null;
  platform.saveSnapshot(s.snapshot());
}
const ERR: Record<string, string> = {
  "not-adjacent": "errNotAdjacent", "cell-occupied": "errCellOccupied", "crosses-self": "errCrossesSelf", "wrong-spool": "errWrongSpool",
  "not-at-spool": "errNotAtSpool", "strand-done": "errStrandDone", "too-short": "errTooShort", "game-over": "errGameOver",
  "not-active": "errNotActive", "no-undo": "errNoUndo", "nothing-to-undo": "errNothingToUndo",
};
function explain(reason: string | undefined): void {
  const key = ERR[reason ?? ""] ?? "errDefault";
  announce(T(key), true);
  app.hintText = () => T(key);
  audio.play("invalid");
  render.shake(0.08);
}
function tryExtend(strand: number, cell: number): boolean {
  const s = app.session!;
  const res = s.dispatch({ type: "extend", strand, cell });
  if (!res.ok) { explain(res.reason); return false; }
  audio.play("extend");
  haptic(12);
  tutorialCheck("extend", strand);
  syncAll();
  if (res.terminal) finishRound();
  return true;
}
export function tryReel(strand: number): boolean {
  const s = app.session!;
  const res = s.dispatch({ type: "reel", strand });
  if (!res.ok) { explain(res.reason); return false; }
  audio.play("reel");
  haptic(70);
  const def = s.level.strands[strand]!;
  render.burstAt(render.cellToWorld(s.level, def.spool), def.color);
  render.shake(0.04);
  announce(T("strandReeled", { n: strand + 1 }));
  tutorialCheck("reel", strand);
  app.selection = -1;
  syncAll();
  if (res.terminal) finishRound();
  return true;
}
function tryRetract(strand: number): boolean {
  const res = app.session!.dispatch({ type: "retract", strand });
  if (!res.ok) { explain(res.reason); return false; }
  audio.play("retract");
  syncAll();
  return true;
}
export function reelSelected(): void { if (app.selection >= 0) tryReel(app.selection); else explain("not-at-spool"); }
export function doUndo(): void {
  const s = app.session;
  if (!s) return;
  const res = s.undo();
  if (!res.ok) { explain(res.reason); return; }
  audio.play("retract");
  syncAll();
  announce(T("undone"));
}
const COLOR_KEYS = ["colorRed", "colorBlue", "colorGreen", "colorYellow", "colorPurple", "colorOrange"];
export function doHint(): void {
  const s = app.session;
  if (!s) return;
  const res = s.hint();
  if (!res.ok || !res.action) { explain(res.reason); return; }
  const a = res.action;
  const colorKey = COLOR_KEYS[s.state.strands[a.strand]!.color];
  const color = (): string => (colorKey ? T(colorKey) : T("strandN", { n: a.strand + 1 }));
  let msg: () => string;
  if (a.type === "extend") {
    const row = Math.floor(a.cell! / s.state.cols) + 1, col = (a.cell! % s.state.cols) + 1;
    msg = () => T("hintExtend", { color: color(), row, col });
  } else if (a.type === "retract") msg = () => T("hintRetract", { color: color() });
  else msg = () => T("hintReel", { color: color() });
  syncAll();
  app.hintText = msg;
  announce(msg());
  audio.play("select");
}
function selectStrand(i: number): void {
  const s = app.session!;
  if (s.state.strands[i]?.done) { explain("strand-done"); return; }
  app.selection = i;
  audio.play("select");
  tutorialCheck("select", i);
  syncAll();
  announce(T("strandSelected", { n: i + 1 }));
}
function handleCell(cell: number): void {
  const s = app.session;
  if (!s || s.phase !== "active") return;
  const occ = s.state.strands.findIndex((x) => !x.done && x.path.includes(cell));
  if (app.selection >= 0) {
    const st = s.state.strands[app.selection]!;
    if (st.path[st.path.length - 2] === cell) { tryRetract(app.selection); return; }
    // reaching for another strand switches selection; it is not a rules foul
    if (occ >= 0 && occ !== app.selection) { selectStrand(occ); return; }
    if (occ === app.selection) { announce(T("tapBehind")); return; }
    tryExtend(app.selection, cell);
    return;
  }
  if (occ >= 0) selectStrand(occ);
}
function handleSpool(strand: number): void {
  const s = app.session;
  if (!s || s.phase !== "active") return;
  const st = s.state.strands[strand]!;
  if (st.done) { explain("strand-done"); return; }
  const head = st.path[st.path.length - 1];
  if (head === st.spool) { tryReel(strand); return; }
  if (app.selection === strand && Rules.checkAction(s.state, { type: "extend", strand, cell: st.spool }).ok) { tryExtend(strand, st.spool); return; }
  if (app.selection !== strand) { selectStrand(strand); announce(T("spoolSelected", { n: strand + 1 })); }
  else explain("not-at-spool");
}
/** A board-mirror cell (or the keyboard cursor's) activated: main.js onMirrorCell. */
export function onMirrorCell(cell: number): void {
  const s = app.session;
  if (!s || s.phase !== "active") return;
  const spoolIdx = s.state.strands.findIndex((x) => !x.done && x.spool === cell);
  if (spoolIdx >= 0) { handleSpool(spoolIdx); return; }
  handleCell(cell);
  app.cursorCell = cell;
}
function moveCursor(dc: number, dr: number): void {
  const s = app.session;
  if (!s) return;
  const cols = s.state.cols, rows = s.state.rows;
  let r = Math.floor(app.cursorCell / cols), c = app.cursorCell % cols;
  c = (c + dc + cols) % cols;
  r = (r + dr + rows) % rows;
  app.cursorCell = r * cols + c;
  const occ = s.state.strands.findIndex((x) => !x.done && x.path.includes(app.cursorCell));
  const spool = s.state.strands.findIndex((x) => !x.done && x.spool === app.cursorCell);
  announce(T("cursorAt", { row: r + 1, col: c + 1 }) + (occ >= 0 ? T("cursorStrand", { n: occ + 1 }) : "") + (spool >= 0 ? T("cursorSpool", { n: spool + 1 }) : ""));
}

// ------------------------------------------------------------------ keys and pads (main.js onKeyDown)
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  const a = e.action;
  if (a === "pause") {
    if (!fresh()) return;
    if (app.overlay === "help") later(closeHelp);
    else if (app.overlay === "pause") later(resumeGame);
    else if (app.overlay === "modes") later(showTitle);
    else if (playing()) later(() => pauseGame("esc"));
    return;
  }
  if (!playing()) return;
  // Enter / Space on a focused tray button or mirror cell is that widget's
  if (a === "select" && ui.focused() !== null) return;
  switch (a) {
    case "left": ui.setFocus(null); later(() => moveCursor(-1, 0)); break;
    case "right": ui.setFocus(null); later(() => moveCursor(1, 0)); break;
    case "up": ui.setFocus(null); later(() => moveCursor(0, -1)); break;
    case "down": ui.setFocus(null); later(() => moveCursor(0, 1)); break;
    case "select": later(() => onMirrorCell(app.cursorCell)); break;
    case "reel": later(reelSelected); break;
    case "undo": later(doUndo); break;
    case "hint": later(doHint); break;
    case "camera": render.reframe(); announce(T("cameraReset")); break;
  }
});

// ------------------------------------------------------------------ pointer and touch on the board (main.js onPointer*)
const TAP_MAX_DIST = 10;
type PEv = { kind: "down" | "move" | "up"; x: number; y: number; ui: boolean };
const pointerQueue: PEv[] = [];
let drag: { x: number; y: number; moved: boolean } | null = null;
let lastTouch = -1e9;
onTouch((e) => {
  lastTouch = now();
  if (e.control || !e.primary) return;
  if (e.phase === "start") { audio.start(); pointerQueue.push({ kind: "down", x: e.x, y: e.y, ui: ui.pointerCaptured() }); }
  else if (e.phase === "move") pointerQueue.push({ kind: "move", x: e.x, y: e.y, ui: false });
  else pointerQueue.push({ kind: "up", x: e.x, y: e.y, ui: false });
});
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  if (e.pressed) audio.start();
  pointerQueue.push({ kind: e.pressed ? "down" : "up", x: e.x, y: e.y, ui: e.pressed && ui.pointerCaptured() });
});
onPointerMove((x, y) => { if (now() - lastTouch >= 0.6) pointerQueue.push({ kind: "move", x, y, ui: false }); });
function pointerInput(wasPlaying: boolean): void {
  const list = pointerQueue.splice(0);
  for (const p of list) {
    if (!wasPlaying || !playing()) { drag = null; continue; }
    const s = app.session!;
    if (p.kind === "down") {
      drag = null;
      if (p.ui) continue;
      const hit = render.pick(p.x, p.y);
      drag = { x: p.x, y: p.y, moved: false };
      ui.setFocus(null);
      if (hit && hit.kind === "strand") {
        // tapping an already-selected strand's body behind the tip pulls it back
        if (app.selection !== hit.strand) selectStrand(hit.strand);
        else if (hit.cell !== undefined) handleCell(hit.cell);
      } else if (hit && hit.kind === "spool") { handleSpool(hit.strand); drag = null; }
      else if (hit && hit.kind === "cell") handleCell(hit.cell);
    } else if (p.kind === "move") {
      if (!drag) {
        // hover preview of the legal target
        if (app.selection >= 0) {
          const hit = render.pick(p.x, p.y);
          if (hit && hit.cell !== undefined) {
            const chk = Rules.checkAction(s.state, { type: "extend", strand: app.selection, cell: hit.cell });
            render.showGhost(render.cellToWorld(s.level, hit.cell), s.state.strands[app.selection]!.color, chk.ok);
          } else render.showGhost(null, 0, false);
        }
        continue;
      }
      if (Math.hypot(p.x - drag.x, p.y - drag.y) / frame().scale > TAP_MAX_DIST) drag.moved = true;
      if (drag.moved && app.selection >= 0) {
        const hit = render.pick(p.x, p.y);
        if (hit && hit.cell !== undefined) {
          const st = s.state.strands[app.selection]!;
          if (hit.cell === st.path[st.path.length - 2]) tryRetract(app.selection);
          else if (Rules.checkAction(s.state, { type: "extend", strand: app.selection, cell: hit.cell }).ok) tryExtend(app.selection, hit.cell);
        }
      }
    } else drag = null;
  }
}

// ------------------------------------------------------------------ account
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function invite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(S("copied")); } catch { toast(S("copyFail", { url: link }), 6); }
}

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
/** main.js boot: restore an interrupted round from its snapshot, else the title. */
function restoreOrTitle(): void {
  const snap = platform.loadSnapshot();
  if (snap && snap.levelId) {
    try {
      const s = SessionClass.restore(snap);
      app.session = s;
      render.buildLevel(s.level);
      render.syncState(s.state, -1);
      s.setPhase("active", "reconnect");
      app.cursorCell = s.state.strands[0]?.anchor ?? 0;
      app.overlay = null;
      app.openedFrame = frame().frame;
      announce(T("welcomeBack"));
      app.hintText = () => T("roundRestored");
      return;
    } catch { platform.clearSnapshot(); }
  }
  showTitle();
}
onStart(() => {
  initStyles();
  platform.initPlatform();
  audio.start();
  render.setReducedMotion(preferences().reducedMotion);
  render.setCvdPalette(platform.options.cvdPalette);
  applyLook();
  render.setActive(true);
  restoreOrTitle();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onOptionsChange(() => render.setCvdPalette(platform.options.cvdPalette));
platform.onProgressMerged(() => undefined);
onSessionEnded(() => toast(S("signedOut"), 4));
onSuspend(() => {
  // a hidden window pauses the round and saves it (main.js onVisibility)
  const s = app.session;
  if (s && s.phase === "active") pauseGame("backgrounded");
  audio.setSuspended(true);
  platform.flush();
});
onResume(() => audio.setSuspended(false));

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyTokens(ui.preferences().highContrast);
  audio.update(dt);
  const t = now();
  app.toasts = app.toasts.filter((x) => x.until >= t);
});
onRender(() => {
  const wasPlaying = playing();
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  pointerInput(wasPlaying);
  const f = frame();
  render.update(frameDt, f.width, f.height);
  flushAnnouncements();
});
