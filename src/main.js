// Tangled Threads — bootstrap, lifecycle, input, and glue between
// rules (simulation), render (Three.js), ui (DOM), audio, and platform.

import { checkAction } from './rules.js';
import {
  generateLevel, validateLevel, STAGE_COUNT, TUTORIAL_STEPS, ACHIEVEMENTS, stageId, dailySeedString,
} from './content.js';
import { Session } from './session.js';
import * as render from './render.js';
import * as audio from './audio.js';
import * as ui from './ui.js';

const $ = ui.$;

let settings = ui.loadSettings();
let progress = ui.loadProgress();
let session = null;
let selection = -1;
let cursorCell = 0;           // keyboard cursor
let webglOk = true;
let tutorialStep = 0;
let timerInterval = 0;
let pendingMode = null;
let dragState = null;

/* ================= settings apply ================= */

function applySettings() {
  document.body.classList.toggle('high-contrast', settings.highContrast);
  document.body.classList.toggle('text-large', settings.largeText);
  document.body.classList.toggle('left-handed', settings.leftHanded);
  render.setQuality(settings.quality);
  render.setReducedMotion(settings.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches);
  render.setCvdPalette(settings.cvdPalette);
  for (const bus of ['music', 'effects', 'ambience', 'voice']) audio.setBusVolume(bus, settings.volumes[bus]);
  // Reflect into controls.
  $('vol-music').value = Math.round(settings.volumes.music * 100);
  $('vol-effects').value = Math.round(settings.volumes.effects * 100);
  $('vol-ambience').value = Math.round(settings.volumes.ambience * 100);
  $('vol-voice').value = Math.round(settings.volumes.voice * 100);
  $('sel-quality').value = String(settings.quality);
  $('chk-motion').checked = settings.reducedMotion;
  $('chk-contrast').checked = settings.highContrast;
  $('chk-cvd').checked = settings.cvdPalette;
  $('chk-text').checked = settings.largeText;
  $('chk-left').checked = settings.leftHanded;
  $('chk-haptics').checked = settings.haptics;
  // Palette/quality changes rebuild the scene, so the live board must be re-synced.
  if (session) {
    render.syncState(session.state, selection);
    ui.renderDomBoard($('dom-board'), session.state, mirrorOpts(), onMirrorCell);
  }
  ui.saveSettings(settings);
}

function bindSettings() {
  const vol = (id, bus) => $(id).addEventListener('input', (e) => {
    settings.volumes[bus] = e.target.value / 100;
    audio.setBusVolume(bus, settings.volumes[bus]);
    ui.saveSettings(settings);
  });
  vol('vol-music', 'music'); vol('vol-effects', 'effects'); vol('vol-ambience', 'ambience'); vol('vol-voice', 'voice');
  $('sel-quality').addEventListener('change', (e) => { settings.quality = +e.target.value; applySettings(); });
  $('chk-motion').addEventListener('change', (e) => { settings.reducedMotion = e.target.checked; applySettings(); });
  $('chk-contrast').addEventListener('change', (e) => { settings.highContrast = e.target.checked; applySettings(); });
  $('chk-cvd').addEventListener('change', (e) => { settings.cvdPalette = e.target.checked; applySettings(); });
  $('chk-text').addEventListener('change', (e) => { settings.largeText = e.target.checked; applySettings(); });
  $('chk-left').addEventListener('change', (e) => { settings.leftHanded = e.target.checked; applySettings(); });
  $('chk-haptics').addEventListener('change', (e) => { settings.haptics = e.target.checked; applySettings(); });
  $('btn-replay-tut').addEventListener('click', () => { startLevel('tutorial'); });
}

/* ================= screens ================= */

function showTitle() {
  session = null;
  ui.showOnly('scr-title');
  $('hud').hidden = true; $('hint-bar').hidden = true; $('action-tray').hidden = true;
  const done = Object.keys(progress.stagesDone).length;
  $('title-progress').textContent = done > 0
    ? `Journey progress: ${done}/${STAGE_COUNT} stages complete.`
    : 'A cozy routing puzzle on a fiber-art worktable.';
  $('btn-play').focus();
}

function showModes() {
  ui.showOnly('scr-modes');
  $('mode-detail').hidden = true;
  $('journey-list').hidden = true;
}

function selectMode(mode) {
  pendingMode = mode;
  const detail = $('mode-detail');
  detail.hidden = false;
  const list = $('journey-list');
  list.hidden = true;
  const info = {
    learn: ['Learn', 'One guided lesson board. ~2 min · 1 player · assists allowed · not ranked.'],
    journey: ['Journey', 'Pick a stage below. ~2–5 min each · 1 player · undo allowed · globally ranked.'],
    daily: ['Daily challenge', 'One shared seed for everyone this UTC day. ~3 min · 1 player · no undo · globally ranked.'],
    practice: ['Practice', 'Easy, medium, or hard board from a fresh seed. No rating effect.'],
    challenge: ['Challenge', '12 boards with tight move limits. ~3 min · globally ranked.'],
  }[mode];
  $('mode-detail-name').textContent = info[0];
  $('mode-detail-info').textContent = info[1];
  if (mode === 'journey' || mode === 'challenge' || mode === 'practice') {
    list.hidden = false;
    list.innerHTML = '';
    const ids = [];
    if (mode === 'journey') for (let n = 1; n <= STAGE_COUNT; n++) ids.push(stageId(n));
    if (mode === 'challenge') for (let n = 1; n <= 12; n++) ids.push('challenge-' + n);
    if (mode === 'practice') ids.push('practice-easy', 'practice-medium', 'practice-hard');
    for (const id of ids) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mode-card';
      const doneMap = mode === 'journey' ? progress.stagesDone : mode === 'challenge' ? progress.challengesDone : {};
      const best = doneMap[id];
      b.innerHTML = `<strong>${id.replace('-', ' ')}</strong><small>${best != null ? 'Best: ' + best : mode === 'practice' ? 'Fresh board' : 'Not completed'}</small>`;
      b.addEventListener('click', () => { audio.sfx.uiClick(); startLevel(id); });
      list.appendChild(b);
    }
    $('btn-mode-start').hidden = true;
  } else {
    $('btn-mode-start').hidden = false;
  }
  $('btn-mode-start').textContent = 'Start';
}

/* ================= session lifecycle ================= */

function startLevel(levelId) {
  const level = generateLevel(levelId);
  const v = validateLevel(level);
  if (!v.ok) {
    ui.announceError('This content failed validation and was excluded: ' + v.errors.join(','));
    return;
  }
  session = new Session(levelId);
  selection = -1;
  cursorCell = session.state.strands[0]?.anchor ?? 0;
  tutorialStep = 0;
  render.buildLevel(level);
  render.syncState(session.state, selection);
  session.setPhase('active', 'player-start');
  ui.showOnly('scr-board-mirror');
  $('hud').hidden = false; $('action-tray').hidden = false;
  $('hint-bar').hidden = levelId !== 'tutorial';
  ui.renderDomBoard($('dom-board'), session.state, mirrorOpts(), onMirrorCell);
  updateHud();
  updateTutorialText();
  ui.announce(`${level.name}. Route each strand to its matching spool without crossings.`);
  ui.saveSnapshot(session.snapshot());
  clearInterval(timerInterval);
  timerInterval = setInterval(updateHud, 1000);
  audio.sfx.uiClick();
}

function pauseGame(reason) {
  if (!session || session.phase !== 'active') return;
  session.setPhase('paused', reason);
  ui.saveSnapshot(session.snapshot());
  ui.showOnly('scr-pause', 'scr-board-mirror');
  $('btn-resume').focus();
  ui.announce('Paused.');
}

function resumeGame() {
  if (!session) return;
  session.setPhase('active', 'resume');
  ui.showOnly('scr-board-mirror');
  ui.announce('Resumed.');
}

function finishRound() {
  clearInterval(timerInterval);
  const t = session.state.terminal;
  const score = t.score;
  $('results-h').textContent = t.reason === 'complete' ? 'Board complete!' : 'Out of moves';
  $('results-sub').textContent = `${session.level.name} · ${session.state.moves} moves (par ${session.level.par}) · ${session.state.hints} hints · ${(session.now() / 1000).toFixed(0)}s`;
  $('sc-completion').textContent = score.completion;
  $('sc-efficiency').textContent = score.efficiency;
  $('sc-independence').textContent = score.independence;
  $('sc-discipline').textContent = score.discipline;
  $('sc-total').textContent = score.total;
  ui.showOnly('scr-results');
  $('hud').hidden = true; $('action-tray').hidden = true; $('hint-bar').hidden = true;

  // Progression & achievements (idempotent).
  const unlocked = [];
  const grant = (key) => { if (!progress.achievements[key]) { progress.achievements[key] = Date.now(); unlocked.push(key); } };
  const today = ui.serverNow().toISOString().slice(0, 10);
  progress.daysPlayed[today] = true;
  if (t.reason === 'complete') {
    grant('first-completion');
    const id = session.level.id;
    if (progress.bestScores[id] == null || score.total > progress.bestScores[id]) progress.bestScores[id] = score.total;
    if (session.level.mode === 'journey') {
      progress.stagesDone[id] = Math.max(progress.stagesDone[id] ?? 0, score.total);
      if (session.level.mastery) grant('mechanic-mastery');
      if (Object.keys(progress.stagesDone).length >= 20) grant('milestone-20');
      if (Object.keys(progress.stagesDone).length >= STAGE_COUNT) grant('journeyman-40');
    }
    if (session.level.mode === 'challenge') progress.challengesDone[id] = Math.max(progress.challengesDone[id] ?? 0, score.total);
    if (session.level.mode === 'daily') progress.dailiesDone[id] = score.total;
    if (Object.keys(progress.daysPlayed).length >= 3) grant('streak-3');
  }
  ui.saveProgress(progress);
  $('results-achievements').textContent = unlocked.length
    ? 'Achievement unlocked: ' + unlocked.map((k) => ACHIEVEMENTS.find((a) => a.key === k)?.name || k).join(', ')
    : '';
  if (unlocked.length) ui.postAchievements(unlocked);

  // Ranked submission with replay envelope; server re-validates deterministically.
  $('results-compare').textContent = '';
  if (session.ranked && t.reason === 'complete') {
    ui.submitScore(session.replayEnvelope()).then((r) => {
      $('results-compare').textContent = r.ok
        ? `Global rank #${r.rank} of ${r.entries} on this board.`
        : r.error === 'offline' ? 'Offline — score kept locally.' : `Score not ranked (${r.error}).`;
    });
  }
  if (t.reason === 'complete') { audio.sfx.complete(); } else { audio.sfx.fail(); }
  ui.announce($('results-h').textContent + ' Total score ' + score.total);
  ui.clearSnapshot();
  session.setPhase('progression', 'results-shown');
  $('btn-next').focus();
}

/* ================= HUD / tutorial ================= */

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function updateHud() {
  if (!session) return;
  const st = session.state;
  const done = st.strands.filter((s) => s.done).length;
  $('hud-objective').textContent = session.level.name;
  $('hud-progress').textContent = `Reeled ${done}/${st.strands.length}`;
  $('hud-moves').textContent = st.moveLimit != null ? `Moves ${st.moves}/${st.moveLimit}` : `Moves ${st.moves} (par ${st.par})`;
  $('hud-timer').textContent = fmtTime(session.now());
  audio.setMusicIntensity(done / st.strands.length);
}

function updateTutorialText() {
  if (!session || session.level.id !== 'tutorial') return;
  const step = TUTORIAL_STEPS[tutorialStep];
  $('hint-bar').hidden = !step;
  if (step) $('hint-text').textContent = `Lesson ${tutorialStep + 1}/${TUTORIAL_STEPS.length}: ${step.text}`;
}

function tutorialCheck(eventType, strand) {
  if (!session || session.level.id !== 'tutorial') return;
  const step = TUTORIAL_STEPS[tutorialStep];
  if (!step) return;
  const r = step.require;
  let hit = false;
  if (r.type === 'select' && eventType === 'select' && strand === r.strand) hit = true;
  if (r.type === 'extend' && eventType === 'extend' && strand === r.strand) hit = true;
  if (r.type === 'reel' && eventType === 'reel' && strand === r.strand) hit = true;
  if (r.type === 'at-spool' && eventType === 'extend') {
    const s = session.state.strands[r.strand];
    hit = s.path[s.path.length - 1] === s.spool;
  }
  if (hit) {
    tutorialStep++;
    if (tutorialStep >= TUTORIAL_STEPS.length) {
      settings.tutorialDone = true;
      ui.saveSettings(settings);
    }
    updateTutorialText();
  }
}

/* ================= gameplay actions ================= */

function mirrorOpts() {
  return { selection, cursor: cursorCell, cvd: settings.cvdPalette };
}

function syncAll() {
  render.syncState(session.state, selection);
  ui.renderDomBoard($('dom-board'), session.state, mirrorOpts(), onMirrorCell);
  updateHud();
  // A completed action clears the last error/hint; the tutorial keeps its lesson.
  if (session.level.id === 'tutorial') updateTutorialText();
  else $('hint-bar').hidden = true;
  ui.saveSnapshot(session.snapshot());
}

function explain(reason) {
  const msgs = {
    'not-adjacent': 'Cells must touch edge-to-edge.',
    'cell-occupied': 'Another strand occupies that cell — crossings are not allowed.',
    'crosses-self': 'A strand cannot cross itself.',
    'wrong-spool': 'That spool belongs to a different strand.',
    'not-at-spool': 'The tip must rest on its matching spool before reeling.',
    'strand-done': 'That strand is already reeled in.',
    'too-short': 'Nothing to pull back.',
    'game-over': 'This round is over.',
    'not-active': 'The round is not active.',
    'no-undo': 'Undo is not available in the daily challenge.',
    'nothing-to-undo': 'Nothing to undo yet.',
  };
  const msg = msgs[reason] || 'That action is not legal.';
  ui.announceError(msg);
  $('hint-bar').hidden = false;
  $('hint-text').textContent = msg;
  audio.sfx.invalid();
  render.shake(0.08);
}

function tryExtend(strand, cell) {
  const res = session.dispatch({ type: 'extend', strand, cell });
  if (!res.ok) { explain(res.reason); return false; }
  audio.sfx.extend();
  ui.vibrate(settings);
  tutorialCheck('extend', strand);
  syncAll();
  if (res.terminal) finishRound();
  return true;
}

function tryReel(strand) {
  const res = session.dispatch({ type: 'reel', strand });
  if (!res.ok) { explain(res.reason); return false; }
  audio.sfx.reel();
  ui.vibrate(settings, [20, 30, 20]);
  const s = session.level.strands[strand];
  render.burstAt(render.cellToWorld(session.level, s.spool), s.color);
  render.shake(0.04);
  ui.announce(`Strand ${strand + 1} reeled in.`);
  tutorialCheck('reel', strand);
  selection = -1;
  syncAll();
  if (res.terminal) finishRound();
  return true;
}

function tryRetract(strand) {
  const res = session.dispatch({ type: 'retract', strand });
  if (!res.ok) { explain(res.reason); return false; }
  audio.sfx.retract();
  syncAll();
  return true;
}

function doUndo() {
  if (!session) return;
  const res = session.undo();
  if (!res.ok) { explain(res.reason); return; }
  audio.sfx.retract();
  syncAll();
  ui.announce('Undone.');
}

function doHint() {
  if (!session) return;
  const res = session.hint();
  if (!res.ok) { explain(res.reason); return; }
  const a = res.action;
  const names = ['red', 'blue', 'green', 'yellow', 'purple', 'orange'];
  const name = names[session.state.strands[a.strand].color] || `strand ${a.strand + 1}`;
  let msg;
  if (a.type === 'extend') {
    const r = Math.floor(a.cell / session.state.cols) + 1, c = (a.cell % session.state.cols) + 1;
    msg = `Hint: extend the ${name} strand to row ${r}, column ${c}.`;
  } else if (a.type === 'retract') msg = `Hint: pull the ${name} strand back one cell.`;
  else msg = `Hint: reel in the ${name} strand.`;
  syncAll();
  $('hint-bar').hidden = false;
  $('hint-text').textContent = msg;
  ui.announce(msg);
  audio.sfx.select();
}

function selectStrand(i) {
  if (session.state.strands[i]?.done) { explain('strand-done'); return; }
  selection = i;
  audio.sfx.select();
  tutorialCheck('select', i);
  syncAll();
  ui.announce(`Strand ${i + 1} selected.`);
}

/* ================= input: pointer ================= */

const TAP_MAX_DIST = 10, TAP_MAX_MS = 350;

function onPointerDown(e) {
  if (!session || session.phase !== 'active' || !webglOk) return;
  const hit = render.pick(e.clientX, e.clientY);
  dragState = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, moved: false };
  const canvas = $('game-canvas');
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  if (hit && hit.kind === 'strand') {
    // Tapping an already-selected strand's body behind the tip pulls it back.
    if (selection !== hit.strand) selectStrand(hit.strand);
    else if (hit.cell !== undefined) handleCell(hit.cell);
  } else if (hit && hit.kind === 'spool') {
    handleSpool(hit.strand);
    dragState = null;
  } else if (hit && hit.kind === 'cell') {
    handleCell(hit.cell);
  }
}

function onPointerMove(e) {
  if (!session || session.phase !== 'active' || !webglOk) return;
  if (!dragState) {
    // Hover preview of legal target.
    if (selection >= 0) {
      const hit = render.pick(e.clientX, e.clientY);
      if (hit && hit.cell !== undefined) {
        const chk = checkAction(session.state, { type: 'extend', strand: selection, cell: hit.cell });
        render.showGhost(render.cellToWorld(session.level, hit.cell), session.state.strands[selection].color, chk.ok);
      } else render.showGhost(null, 0, false);
    }
    return;
  }
  const dist = Math.hypot(e.clientX - dragState.x, e.clientY - dragState.y);
  if (dist > TAP_MAX_DIST) dragState.moved = true;
  if (dragState.moved && selection >= 0) {
    const hit = render.pick(e.clientX, e.clientY);
    if (hit && hit.cell !== undefined) {
      const st = session.state.strands[selection];
      const prev = st.path[st.path.length - 2];
      if (hit.cell === prev) tryRetract(selection);
      else if (checkAction(session.state, { type: 'extend', strand: selection, cell: hit.cell }).ok) tryExtend(selection, hit.cell);
    }
  }
}

function onPointerUp(e) {
  if (dragState && !dragState.moved && performance.now() - dragState.t < TAP_MAX_MS) {
    // Tap already handled on pointerdown.
  }
  dragState = null;
}

function handleCell(cell) {
  if (!session || session.phase !== 'active') return;
  const occ = session.state.strands.findIndex((s) => !s.done && s.path.includes(cell));
  if (selection >= 0) {
    const st = session.state.strands[selection];
    if (st.path[st.path.length - 2] === cell) { tryRetract(selection); return; }
    // Reaching for another strand switches selection; it is not a rules foul,
    // so it must not cost discipline points.
    if (occ >= 0 && occ !== selection) { selectStrand(occ); return; }
    if (occ === selection) { ui.announce('Tap the cell just behind the tip to pull back.'); return; }
    tryExtend(selection, cell);
    return;
  }
  if (occ >= 0) selectStrand(occ);
}

function handleSpool(strand) {
  if (!session || session.phase !== 'active') return;
  const st = session.state.strands[strand];
  if (st.done) { explain('strand-done'); return; }
  const head = st.path[st.path.length - 1];
  if (head === st.spool) { tryReel(strand); return; }
  if (selection === strand && checkAction(session.state, { type: 'extend', strand, cell: st.spool }).ok) {
    tryExtend(strand, st.spool);
    return;
  }
  if (selection !== strand) { selectStrand(strand); ui.announce(`Strand ${strand + 1} selected. Route it onto its spool, then tap again to reel.`); }
  else explain('not-at-spool');
}

function onMirrorCell(cell) {
  if (!session || session.phase !== 'active') return;
  const spoolIdx = session.state.strands.findIndex((s) => !s.done && s.spool === cell);
  if (spoolIdx >= 0) { handleSpool(spoolIdx); return; }
  handleCell(cell);
  cursorCell = cell;
}

/* ================= input: keyboard ================= */

function moveCursor(dc, dr) {
  if (!session) return;
  const cols = session.state.cols, rows = session.state.rows;
  let r = Math.floor(cursorCell / cols), c = cursorCell % cols;
  c = (c + dc + cols) % cols;
  r = (r + dr + rows) % rows;
  cursorCell = r * cols + c;
  ui.setDomCursor($('dom-board'), cursorCell);
  const occ = session.state.strands.findIndex((s) => !s.done && s.path.includes(cursorCell));
  const spool = session.state.strands.findIndex((s) => !s.done && s.spool === cursorCell);
  ui.announce(`Row ${r + 1} column ${c + 1}` + (occ >= 0 ? `, strand ${occ + 1}` : '') + (spool >= 0 ? `, spool ${spool + 1}` : ''));
}

function onKeyDown(e) {
  if (e.key === 'Escape') {
    if (!$('scr-help').hidden) { $('btn-help-close').click(); return; }
    if (!$('scr-pause').hidden) { $('btn-resume').click(); return; }
    if (session && session.phase === 'active') pauseGame('esc');
    return;
  }
  if (!session || session.phase !== 'active') return;
  switch (e.key) {
    case 'ArrowLeft': e.preventDefault(); moveCursor(-1, 0); break;
    case 'ArrowRight': e.preventDefault(); moveCursor(1, 0); break;
    case 'ArrowUp': e.preventDefault(); moveCursor(0, -1); break;
    case 'ArrowDown': e.preventDefault(); moveCursor(0, 1); break;
    case 'Enter': case ' ': e.preventDefault(); onMirrorCell(cursorCell); break;
    case 'r': case 'R': if (selection >= 0) tryReel(selection); else explain('not-at-spool'); break;
    case 'u': case 'U': doUndo(); break;
    case 'h': case 'H': doHint(); break;
    case 'c': case 'C': render.resize(); ui.announce('Camera reset.'); break;
  }
}

/* ================= lifecycle ================= */

function onVisibility() {
  const hidden = document.hidden;
  render.setHidden(hidden);
  if (hidden) {
    if (session && session.phase === 'active') { session.setPhase('paused', 'backgrounded'); ui.saveSnapshot(session.snapshot()); ui.showOnly('scr-pause', 'scr-board-mirror'); }
    audio.suspendAudio();
  } else {
    audio.resumeAudio();
  }
}

/** Keeps the HUD clear of the (wrap-dependent) compatibility banner. */
function measureCompatBanner() {
  document.documentElement.style.setProperty('--compat-h', $('compat-msg').offsetHeight + 'px');
}

function boot() {
  const canvas = $('game-canvas');
  const r = render.initRender(canvas);
  webglOk = r.ok;
  document.body.classList.toggle('webgl-3d', r.ok);
  if (!r.ok) {
    // Notice only: the DOM mirror stays in place and becomes the playfield.
    document.body.classList.add('no-webgl');
    $('compat-msg').hidden = false;
    measureCompatBanner();
    window.addEventListener('resize', measureCompatBanner);
    ui.announceError('WebGL unavailable. Simplified board active.');
  } else {
    $('mirror-caption').hidden = false;
    render.startLoop();
  }
  applySettings();
  bindSettings();

  // Buttons.
  $('btn-play').addEventListener('click', () => { audio.startAudio(); audio.sfx.uiClick(); showModes(); });
  $('btn-title-help').addEventListener('click', () => { ui.showOnly('scr-help'); $('btn-help-close').focus(); });
  $('btn-title-settings').addEventListener('click', () => { ui.showOnly('scr-pause'); $('btn-leave').hidden = true; $('btn-restart').hidden = true; $('btn-resume').textContent = 'Back'; $('btn-resume').focus(); });
  document.querySelectorAll('.mode-card[data-mode]').forEach((b) => b.addEventListener('click', () => { audio.sfx.uiClick(); selectMode(b.dataset.mode); }));
  $('btn-mode-start').addEventListener('click', () => {
    if (pendingMode === 'learn') startLevel('tutorial');
    else if (pendingMode === 'daily') startLevel(dailySeedString(ui.serverNow()));
  });
  $('btn-mode-back').addEventListener('click', showModes);
  $('btn-help-close').addEventListener('click', () => {
    if (session && session.phase === 'active') ui.showOnly('scr-board-mirror');
    else if (session && session.phase === 'paused') ui.showOnly('scr-pause', 'scr-board-mirror');
    else showTitle();
  });
  $('btn-pause').addEventListener('click', () => pauseGame('button'));
  $('btn-resume').addEventListener('click', () => {
    $('btn-leave').hidden = false; $('btn-restart').hidden = false; $('btn-resume').textContent = 'Resume';
    if (session) resumeGame(); else showTitle();
  });
  $('btn-restart').addEventListener('click', () => startLevel(session.level.id));
  $('btn-leave').addEventListener('click', () => { clearInterval(timerInterval); ui.clearSnapshot(); showTitle(); });
  $('btn-reel').addEventListener('click', () => { if (selection >= 0) tryReel(selection); else explain('not-at-spool'); });
  $('btn-undo').addEventListener('click', doUndo);
  $('btn-hint').addEventListener('click', doHint);
  $('btn-retry').addEventListener('click', () => startLevel(session.level.id));
  $('btn-results-home').addEventListener('click', showTitle);
  $('btn-next').addEventListener('click', () => {
    const id = session.level.id;
    const m = /^stage-(\d+)$/.exec(id);
    if (m && +m[1] < STAGE_COUNT) startLevel(stageId(+m[1] + 1));
    else showTitle();
  });

  // Input.
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', () => { dragState = null; });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', () => render.resize());
  window.addEventListener('orientationchange', () => setTimeout(() => render.resize(), 60));
  document.addEventListener('visibilitychange', onVisibility);
  // First gesture unlocks audio.
  window.addEventListener('pointerdown', () => audio.startAudio(), { once: true });

  // Platform: time sync (offline tolerant), then title.
  ui.syncServerTime();

  // Reconnect: restore durable snapshot if present.
  const snap = ui.loadSnapshot();
  if (snap && snap.levelId) {
    try {
      session = Session.restore(snap);
      render.buildLevel(session.level);
      render.syncState(session.state, -1);
      session.setPhase('active', 'reconnect');
      ui.showOnly('scr-board-mirror');
      $('hud').hidden = false; $('action-tray').hidden = false;
      cursorCell = session.state.strands[0]?.anchor ?? 0;
      ui.renderDomBoard($('dom-board'), session.state, mirrorOpts(), onMirrorCell);
      updateHud();
      clearInterval(timerInterval);
      timerInterval = setInterval(updateHud, 1000);
      ui.announce('Welcome back — your round was restored from the last safe snapshot.');
      showTitleAfterRestoreNote();
      return;
    } catch { ui.clearSnapshot(); }
  }
  showTitle();
}

function showTitleAfterRestoreNote() {
  $('hint-bar').hidden = false;
  $('hint-text').textContent = 'Round restored. While you were away, the board was kept exactly as you left it.';
}

boot();
