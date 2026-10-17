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
import { platform, DEFAULT_BINDINGS } from './platform.js';
import { shText } from './sh-i18n.js';
import { PRESETS, CATEGORIES, presetTier, choosePreset } from './gfx.js';
import { gfxStrings } from './gfx-i18n.js';
import { t, locale, onLanguage, levelName } from './i18n.js';

const $ = ui.$;

let settings = migrateGraphics(ui.loadSettings());
let progress = ui.loadProgress();
let session = null;
let selection = -1;
let cursorCell = 0;           // keyboard cursor
let webglOk = true;
let tutorialStep = 0;
let timerInterval = 0;
let pendingMode = null;
let dragState = null;

/* ================= persistence (localStorage cache + cloud mirror) ================= */

function saveSettingsDoc(s) { ui.saveSettings(s); platform.queueCloudSave(); platform.pushSettings(s); }
function saveProgressDoc(p) { ui.saveProgress(p); platform.queueCloudSave(); }

/* ================= platform identity / sync status ================= */

const SYNC_LABELS = { synced: 'syncSynced', saving: 'syncSaving', offline: 'syncOffline', error: 'syncError' };

function titleProgressText() {
  const done = Object.keys(progress.stagesDone).length;
  return done > 0
    ? t('titleProgress', { done, total: STAGE_COUNT })
    : t('titleIntro');
}

/* Effective keyboard bindings (action -> KeyboardEvent.code[]). */
let bindings = Object.fromEntries(Object.entries(DEFAULT_BINDINGS).map(([k, v]) => [k, v.slice()]));
const isKey = (action, e) => (bindings[action] || []).includes(e.code);
function keyLabel(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return { Escape: 'Esc', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' }[code] || code;
}
function renderKeyHelp() {
  const el = $('help-keys');
  if (!el) return;
  const k = (a) => (bindings[a] || []).map((c) => '<kbd>' + keyLabel(c) + '</kbd>').join('/') || '—';
  el.innerHTML = t('keysHelp', {
    move: k('left') + k('right') + k('up') + k('down'), select: k('select'), reel: k('reel'), undo: k('undo'),
    hint: k('hint'), pause: k('pause'), camera: k('camera'),
  });
}

let toastTimer = 0;
function toast(msg, ms = 2600) {
  const el = $('sh-toast');
  el.textContent = msg;
  el.hidden = false;
  // Over a menu/results/pause screen the toast floats at the top and the
  // screen is padded by its height, so it never covers headings or buttons.
  document.documentElement.style.setProperty('--toast-h', el.offsetHeight + 8 + 'px');
  ui.announce(msg);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
    document.documentElement.style.setProperty('--toast-h', '0px');
  }, ms);
}

async function copyInvite() {
  const url = platform.inviteLink();
  if (!url) return;
  try { await navigator.clipboard.writeText(url); toast(shText('copied', {}, locale())); }
  catch { toast(shText('copyFail', { url }, locale()), 6000); }
}

function updatePlayerLine() {
  $('btn-signin').hidden = !platform.canSignIn();
  $('btn-invite').hidden = !platform.inviteLink();
  const el = $('player-line');
  if (!el) return;
  if (!platform.hosted) { el.hidden = true; return; }
  el.hidden = false;
  const label = SYNC_LABELS[platform.syncStatus] && t(SYNC_LABELS[platform.syncStatus]);
  el.textContent = label ? `${platform.nickname} · ${label}` : platform.nickname;
}

/* ================= settings apply ================= */

/** Older saves carried a 0/1/2 quality tier; map it onto the preset model once. */
function migrateGraphics(s) {
  if (!s.graphics || typeof s.graphics !== 'object') {
    s.graphics = { preset: s.quality === 0 ? 'low' : s.quality === 1 ? 'balanced' : 'auto' };
  }
  return s;
}

function applySettings() {
  document.body.classList.toggle('high-contrast', settings.highContrast);
  document.body.classList.toggle('text-large', settings.largeText);
  document.body.classList.toggle('left-handed', settings.leftHanded);
  render.setGraphics(settings.graphics);
  render.setReducedMotion(settings.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches);
  render.setCvdPalette(settings.cvdPalette);
  for (const bus of ['music', 'effects', 'ambience', 'voice']) audio.setBusVolume(bus, settings.volumes[bus]);
  // Reflect into controls.
  $('vol-music').value = Math.round(settings.volumes.music * 100);
  $('vol-effects').value = Math.round(settings.volumes.effects * 100);
  $('vol-ambience').value = Math.round(settings.volumes.ambience * 100);
  $('vol-voice').value = Math.round(settings.volumes.voice * 100);
  renderGfxPanel();
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
  saveSettingsDoc(settings);
}

function bindSettings() {
  const vol = (id, bus) => $(id).addEventListener('input', (e) => {
    settings.volumes[bus] = e.target.value / 100;
    audio.setBusVolume(bus, settings.volumes[bus]);
    saveSettingsDoc(settings);
  });
  vol('vol-music', 'music'); vol('vol-effects', 'effects'); vol('vol-ambience', 'ambience'); vol('vol-voice', 'voice');
  bindGfxPanel();
  $('chk-motion').addEventListener('change', (e) => { settings.reducedMotion = e.target.checked; applySettings(); });
  $('chk-contrast').addEventListener('change', (e) => { settings.highContrast = e.target.checked; applySettings(); });
  $('chk-cvd').addEventListener('change', (e) => { settings.cvdPalette = e.target.checked; applySettings(); });
  $('chk-text').addEventListener('change', (e) => { settings.largeText = e.target.checked; applySettings(); });
  $('chk-left').addEventListener('change', (e) => { settings.leftHanded = e.target.checked; applySettings(); });
  $('chk-haptics').addEventListener('change', (e) => { settings.haptics = e.target.checked; applySettings(); });
  $('btn-replay-tut').addEventListener('click', () => { startLevel('tutorial'); });
}

/* ================= Graphics settings tab ================= */

let GT = gfxStrings(locale());

function setSettingsTab(which) {
  for (const b of document.querySelectorAll('[data-settings-tab]')) {
    const on = b.dataset.settingsTab === which;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  $('settings-block').hidden = which !== 'general';
  $('gfx-block').hidden = which !== 'graphics';
  if (which === 'graphics') renderGfxPanel();
}

function optionEl(value, label) {
  const o = document.createElement('option');
  o.value = value; o.textContent = label;
  return o;
}

/** Builds the static parts of the Graphics tab (labels, category rows) once. */
function buildGfxPanel() {
  const cats = $('gfx-cats');
  cats.innerHTML = '';
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    const row = document.createElement('div');
    row.className = 'setting-row gfx-row';
    const label = document.createElement('label');
    label.htmlFor = 'gfx-' + cat;
    const sel = document.createElement('select');
    sel.id = 'gfx-' + cat;
    sel.dataset.gfx = cat;
    sel.append(optionEl('preset', ''));
    for (const tier of tiers) sel.append(optionEl(tier, ''));
    row.append(label, sel);
    cats.append(row);
  }
  relabelGfxPanel();
}

/** Graphics tab labels in the current language (rows keep their listeners). */
function relabelGfxPanel() {
  GT = gfxStrings(locale());
  $('tab-general').textContent = GT.tabGeneral;
  $('tab-graphics').textContent = GT.tabGraphics;
  $('gfx-l-quality').textContent = GT.quality;
  $('gfx-l-scale').textContent = GT.renderScale;
  $('gfx-l-adaptive').textContent = GT.adaptive;
  $('gfx-l-fps').textContent = GT.showFps;
  $('gfx-post-note').textContent = GT.postFailed;
  for (const cat of Object.keys(CATEGORIES)) {
    const sel = $('gfx-' + cat);
    sel.labels[0].textContent = GT.cat[cat];
    for (const o of sel.options) if (o.value !== 'preset') o.textContent = GT.tier[o.value];
  }
}

/** Reflects saved + resolved graphics state into the tab's controls and summary. */
function renderGfxPanel() {
  if (!$('gfx-shadows')) buildGfxPanel();
  const g = settings.graphics || {};
  const info = render.graphicsInfo(GT.summary);
  const r = info.resolved;
  const q = $('sel-quality');
  q.innerHTML = '';
  q.append(optionEl('auto', GT.auto.replace('{tier}', GT.preset[info.detected])));
  for (const p of PRESETS) q.append(optionEl(p, GT.preset[p]));
  q.value = PRESETS.includes(g.preset) ? g.preset : 'auto';
  const pct = Math.round((Number(g.render_scale) || 1) * 100);
  $('gfx-scale').value = pct;
  $('gfx-scale-val').textContent = pct + '%';
  for (const cat of Object.keys(CATEGORIES)) {
    const sel = $('gfx-' + cat);
    sel.options[0].textContent = GT.fromPreset.replace('{tier}', GT.tier[presetTier(r.preset, cat)]);
    sel.value = CATEGORIES[cat].includes(g[cat]) ? g[cat] : 'preset';
  }
  $('gfx-adaptive').checked = g.adaptive !== false;
  $('gfx-fps').checked = !!g.show_fps;
  $('gfx-summary').textContent = [info.gpu || GT.unknownGpu, info.summary].join(' · ');
  $('gfx-post-note').hidden = !info.postFailed;
}

function commitGfx(next) {
  settings.graphics = next;
  render.setGraphics(settings.graphics);
  saveSettingsDoc(settings);
  renderGfxPanel();
  // Detail changes rebuild the scene: keep the live board in step.
  if (session) render.syncState(session.state, selection);
  // The drawing buffer is resized on the next frame; refresh the WxH summary then.
  requestAnimationFrame(() => requestAnimationFrame(renderGfxPanel));
}

function bindGfxPanel() {
  if (!$('gfx-shadows')) buildGfxPanel();
  document.querySelectorAll('[data-settings-tab]').forEach((b) => {
    b.addEventListener('click', () => setSettingsTab(b.dataset.settingsTab));
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const next = b.dataset.settingsTab === 'general' ? 'graphics' : 'general';
      setSettingsTab(next);
      $(next === 'general' ? 'tab-general' : 'tab-graphics').focus();
    });
  });
  // Choosing a preset clears per-effect overrides.
  $('sel-quality').addEventListener('change', (e) => commitGfx(choosePreset(settings.graphics, e.target.value)));
  $('gfx-scale').addEventListener('input', (e) => { $('gfx-scale-val').textContent = e.target.value + '%'; });
  $('gfx-scale').addEventListener('change', (e) => commitGfx({ ...settings.graphics, render_scale: e.target.value / 100 }));
  for (const cat of Object.keys(CATEGORIES)) {
    $('gfx-' + cat).addEventListener('change', (e) => {
      const next = { ...settings.graphics };
      if (e.target.value === 'preset') delete next[cat]; else next[cat] = e.target.value;
      commitGfx(next);
    });
  }
  $('gfx-adaptive').addEventListener('change', (e) => commitGfx({ ...settings.graphics, adaptive: e.target.checked }));
  $('gfx-fps').addEventListener('change', (e) => commitGfx({ ...settings.graphics, show_fps: e.target.checked }));
}

/* ================= screens ================= */

/** Decorative board mid-solve behind the title menu. */
function showTitleBackdrop() {
  if (!webglOk) return;
  try {
    const lvl = generateLevel('practice-medium');
    const n = lvl.strands.length;
    const state = {
      strands: lvl.strands.map((s, i) => ({
        ...s, done: false,
        path: i < n - 1 ? lvl.solution[i].slice(0, Math.max(2, lvl.solution[i].length - 1)) : [s.anchor],
      })),
    };
    render.showShowcase(lvl, state);
  } catch { /* the backdrop is decoration only */ }
}

function showTitle() {
  session = null;
  showTitleBackdrop();
  ui.showOnly('scr-title');
  $('hud').hidden = true; $('hint-bar').hidden = true; $('action-tray').hidden = true;
  $('title-progress').textContent = titleProgressText();
  $('btn-play').focus({ preventScroll: true });
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
    learn: ['modeLearn', 'infoLearn'],
    journey: ['modeJourney', 'infoJourney'],
    daily: ['nameDaily', 'infoDaily'],
    practice: ['modePractice', 'infoPractice'],
    challenge: ['modeChallenge', 'infoChallenge'],
  }[mode];
  $('mode-detail-name').textContent = t(info[0]);
  $('mode-detail-info').textContent = t(info[1]);
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
      b.dataset.level = id;
      const strong = document.createElement('strong');
      strong.textContent = levelName(id);
      const small = document.createElement('small');
      small.textContent = best != null ? t('best', { n: best }) : mode === 'practice' ? t('freshBoard') : t('notCompleted');
      b.append(strong, small);
      b.addEventListener('click', () => { audio.sfx.uiClick(); startLevel(id); });
      list.appendChild(b);
    }
    $('btn-mode-start').hidden = true;
  } else {
    $('btn-mode-start').hidden = false;
  }
}

/* ================= session lifecycle ================= */

// The daily seed is derived from the device clock alone.
async function startDaily() {
  startLevel(dailySeedString(platform.serverNow()));
}

function startLevel(levelId) {
  const level = generateLevel(levelId);
  const v = validateLevel(level);
  if (!v.ok) {
    ui.announceError(t('validationFailed', { errors: v.errors.join(',') }));
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
  ui.announce(t('levelStart', { name: levelName(level.id) }));
  ui.saveSnapshot(session.snapshot());
  clearInterval(timerInterval);
  timerInterval = setInterval(updateHud, 1000);
  audio.sfx.uiClick();
}

function pauseGame(reason) {
  if (!session || session.phase !== 'active') return;
  session.setPhase('paused', reason);
  ui.saveSnapshot(session.snapshot());
  ui.showOnly('scr-pause');
  $('btn-resume').focus({ preventScroll: true });
  ui.announce(t('announcePaused'));
}

function resumeGame() {
  if (!session) return;
  session.setPhase('active', 'resume');
  ui.showOnly('scr-board-mirror');
  ui.announce(t('announceResumed'));
}

function finishRound() {
  clearInterval(timerInterval);
  const term = session.state.terminal;
  const score = term.score;
  lastResults = { reason: term.reason, moves: session.state.moves, hints: session.state.hints, secs: (session.now() / 1000).toFixed(0), unlocked: [], lb: null, compare: null };
  renderResultsText();
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
  lastResults.unlocked = unlocked;
  const today = platform.serverNow().toISOString().slice(0, 10);
  progress.daysPlayed[today] = true;
  if (term.reason === 'complete') {
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
  saveProgressDoc(progress);
  renderResultsText();

  // Ranked rounds: signed in, the total posts to the platform high-score board
  // and the rank line shows; standalone the comparison line says it stays local.
  $('results-compare').textContent = '';
  const lb = $('results-lb');
  lb.hidden = true;
  if (session.ranked && platform.hosted) {
    const s = session;
    lb.hidden = false;
    lastResults.lb = { key: 'lbPosting' };
    renderResultsText();
    const res = lastResults;
    platform.postHighScore(Math.max(0, Math.round(score.total))).then((r) => {
      if (session !== s) return;
      res.lb = !r.posted ? { key: 'lbNotPosted' } : r.rank ? { key: 'lbRank', vars: { rank: r.rank } } : { key: 'lbPosted' };
      renderResultsText();
    });
  } else if (session.ranked && term.reason === 'complete') {
    const res = lastResults;
    platform.compareResult(progress.bestScores[session.level.id])
      .then((line) => { res.compare = line; renderResultsText(); });
  }
  if (term.reason === 'complete') { audio.sfx.complete(); } else { audio.sfx.fail(); }
  ui.announce(t('totalScore', { headline: $('results-h').textContent, total: score.total }));
  ui.clearSnapshot();
  session.setPhase('progression', 'results-shown');
  $('btn-next').focus({ preventScroll: true });
}

/** Results texts from lastResults in the current language (re-run on language change). */
let lastResults = null;
function renderResultsText() {
  if (!lastResults || !session) return;
  const r = lastResults;
  $('results-h').textContent = r.reason === 'complete' ? t('boardComplete') : t('outOfMoves');
  $('results-sub').textContent = t('resultsSub', { name: levelName(session.level.id), moves: r.moves, par: session.level.par, hints: r.hints, secs: r.secs });
  $('results-achievements').textContent = r.unlocked.length
    ? t('achievementUnlocked', { list: r.unlocked.map((k) => achievementName(k)).join(', ') })
    : '';
  if (r.lb) $('results-lb').textContent = shText(r.lb.key, r.lb.vars || {}, locale());
  $('results-compare').textContent = r.compare ? r.compare.map((p) => t(p.key, p.vars)).join('') : '';
}

const ACH_KEYS = { 'first-completion': 'achFirst', 'mechanic-mastery': 'achMastery', 'streak-3': 'achStreak', 'milestone-20': 'achHalf', 'journeyman-40': 'achMaster' };
function achievementName(key) { return ACH_KEYS[key] ? t(ACH_KEYS[key]) : (ACHIEVEMENTS.find((a) => a.key === key)?.name || key); }

/* ================= HUD / tutorial ================= */

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// Keep --hint-h in sync with the (possibly wrapped) hint bar so the action
// tray always sits above it instead of over the lesson text.
{
  const bar = $('hint-bar');
  const sync = () => {
    // visual px → layout px of the (equally zoomed) action tray
    const h = bar && !bar.hidden ? bar.getBoundingClientRect().height / ((window.UIScale && UIScale.value) || 1) : 0;
    document.documentElement.style.setProperty('--hint-h', `${Math.round(h)}px`);
  };
  if (bar) {
    if (typeof ResizeObserver === 'function') new ResizeObserver(sync).observe(bar);
    new MutationObserver(sync).observe(bar, { attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true, characterData: true });
  }
  window.addEventListener('resize', sync);
  sync();
}

function updateHud() {
  if (!session) return;
  const st = session.state;
  const done = st.strands.filter((s) => s.done).length;
  $('hud-objective').textContent = levelName(session.level.id);
  $('hud-progress').textContent = t('hudReeled', { done, total: st.strands.length });
  $('hud-moves').textContent = st.moveLimit != null ? t('hudMovesLimit', { moves: st.moves, limit: st.moveLimit }) : t('hudMovesPar', { moves: st.moves, par: st.par });
  $('hud-timer').textContent = fmtTime(session.now());
  audio.setMusicIntensity(done / st.strands.length);
}

function updateTutorialText() {
  if (!session || session.level.id !== 'tutorial') return;
  const step = TUTORIAL_STEPS[tutorialStep];
  $('hint-bar').hidden = !step;
  if (step) setHintText(() => t('lesson', { n: tutorialStep + 1, total: TUTORIAL_STEPS.length, text: t('tut' + (tutorialStep + 1)) }));
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
      saveSettingsDoc(settings);
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
    'not-adjacent': 'errNotAdjacent',
    'cell-occupied': 'errCellOccupied',
    'crosses-self': 'errCrossesSelf',
    'wrong-spool': 'errWrongSpool',
    'not-at-spool': 'errNotAtSpool',
    'strand-done': 'errStrandDone',
    'too-short': 'errTooShort',
    'game-over': 'errGameOver',
    'not-active': 'errNotActive',
    'no-undo': 'errNoUndo',
    'nothing-to-undo': 'errNothingToUndo',
  };
  const key = msgs[reason] || 'errDefault';
  ui.announceError(t(key));
  $('hint-bar').hidden = false;
  setHintText(() => t(key));
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
  ui.announce(t('strandReeled', { n: strand + 1 }));
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
  ui.announce(t('undone'));
}

function doHint() {
  if (!session) return;
  const res = session.hint();
  if (!res.ok) { explain(res.reason); return; }
  const a = res.action;
  const names = ['colorRed', 'colorBlue', 'colorGreen', 'colorYellow', 'colorPurple', 'colorOrange'];
  const colorKey = names[session.state.strands[a.strand].color];
  const color = () => (colorKey ? t(colorKey) : t('strandN', { n: a.strand + 1 }));
  let msg;
  if (a.type === 'extend') {
    const row = Math.floor(a.cell / session.state.cols) + 1, col = (a.cell % session.state.cols) + 1;
    msg = () => t('hintExtend', { color: color(), row, col });
  } else if (a.type === 'retract') msg = () => t('hintRetract', { color: color() });
  else msg = () => t('hintReel', { color: color() });
  syncAll();
  $('hint-bar').hidden = false;
  setHintText(msg);
  ui.announce(msg());
  audio.sfx.select();
}

function selectStrand(i) {
  if (session.state.strands[i]?.done) { explain('strand-done'); return; }
  selection = i;
  audio.sfx.select();
  tutorialCheck('select', i);
  syncAll();
  ui.announce(t('strandSelected', { n: i + 1 }));
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
    if (occ === selection) { ui.announce(t('tapBehind')); return; }
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
  if (selection !== strand) { selectStrand(strand); ui.announce(t('spoolSelected', { n: strand + 1 })); }
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
  ui.announce(t('cursorAt', { row: r + 1, col: c + 1 }) + (occ >= 0 ? t('cursorStrand', { n: occ + 1 }) : '') + (spool >= 0 ? t('cursorSpool', { n: spool + 1 }) : ''));
}

function onKeyDown(e) {
  if (isKey('pause', e)) {
    if (!$('scr-help').hidden) { $('btn-help-close').click(); return; }
    if (!$('scr-pause').hidden) { $('btn-resume').click(); return; }
    if (session && session.phase === 'active') pauseGame('esc');
    return;
  }
  if (!session || session.phase !== 'active') return;
  if (isKey('left', e)) { e.preventDefault(); moveCursor(-1, 0); }
  else if (isKey('right', e)) { e.preventDefault(); moveCursor(1, 0); }
  else if (isKey('up', e)) { e.preventDefault(); moveCursor(0, -1); }
  else if (isKey('down', e)) { e.preventDefault(); moveCursor(0, 1); }
  else if (isKey('select', e)) { e.preventDefault(); onMirrorCell(cursorCell); }
  else if (isKey('reel', e)) { if (selection >= 0) tryReel(selection); else explain('not-at-spool'); }
  else if (isKey('undo', e)) doUndo();
  else if (isKey('hint', e)) doHint();
  else if (isKey('camera', e)) { render.resize(); ui.announce(t('cameraReset')); }
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
    ui.announceError(t('webglUnavailable'));
  } else {
    $('mirror-caption').hidden = false;
    render.startLoop();
  }
  applySettings();
  bindSettings();

  // Buttons.
  $('btn-play').addEventListener('click', () => { audio.startAudio(); audio.sfx.uiClick(); showModes(); });
  $('btn-signin').addEventListener('click', () => platform.signIn());
  $('btn-invite').addEventListener('click', copyInvite);
  $('btn-title-help').addEventListener('click', () => { ui.showOnly('scr-help'); $('btn-help-close').focus({ preventScroll: true }); });
  $('btn-title-settings').addEventListener('click', () => { ui.showOnly('scr-pause'); $('btn-leave').hidden = true; $('btn-restart').hidden = true; resumeIsBack = true; labelResume(); $('btn-resume').focus({ preventScroll: true }); });
  document.querySelectorAll('.mode-card[data-mode]').forEach((b) => b.addEventListener('click', () => { audio.sfx.uiClick(); selectMode(b.dataset.mode); }));
  $('btn-mode-start').addEventListener('click', () => {
    if (pendingMode === 'learn') startLevel('tutorial');
    else if (pendingMode === 'daily') startDaily();
  });
  $('btn-mode-back').addEventListener('click', showModes);
  $('btn-help-close').addEventListener('click', () => {
    if (session && session.phase === 'active') ui.showOnly('scr-board-mirror');
    else if (session && session.phase === 'paused') ui.showOnly('scr-pause', 'scr-board-mirror');
    else showTitle();
  });
  $('btn-pause').addEventListener('click', () => pauseGame('button'));
  $('btn-resume').addEventListener('click', () => {
    $('btn-leave').hidden = false; $('btn-restart').hidden = false; resumeIsBack = false; labelResume();
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
  // Frame the board in the canvas the play HUD leaves free (re-fit when it changes).
  const chrome = [$('hud'), $('action-tray'), $('mirror-panel')];
  render.setFramingChrome(() => ($('hud').hidden ? null : chrome));
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => render.reframe());
    for (const el of chrome) ro.observe(el);
  }
  document.addEventListener('visibilitychange', onVisibility);
  // First gesture unlocks audio.
  window.addEventListener('pointerdown', () => audio.startAudio(), { once: true });

  // Platform: token profile, cloud save mirror, token refresh — all
  // offline-tolerant. A remote save wins over the local cache.
  platform.onIdentity = updatePlayerLine;
  platform.onSync = updatePlayerLine;
  platform.onAuth = (a) => { if (!a.signedIn) toast(shText('signedOut', {}, locale()), 4000); updatePlayerLine(); };
  // Another device saved first: platform.js merged both saves; adopt the merged progress.
  platform.onMerged = () => {
    progress = ui.loadProgress();
    if (!session) $('title-progress').textContent = titleProgressText();
  };
  onLanguage(relabel);
  relabel();
  updatePlayerLine();
  renderKeyHelp();
  platform.init().then(async (result) => {
    bindings = await platform.loadBindings();
    renderKeyHelp();
    updatePlayerLine();
    if (!result.remoteLoaded) return;
    settings = migrateGraphics(ui.loadSettings());
    progress = ui.loadProgress();
    applySettings();
    if (!session) {
      $('title-progress').textContent = titleProgressText();
      platform.queueCloudSave(); // reconcile the mirror with the adopted doc
    }
  });

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
      ui.announce(t('welcomeBack'));
      showTitleAfterRestoreNote();
      return;
    } catch { ui.clearSnapshot(); }
  }
  showTitle();
}

function showTitleAfterRestoreNote() {
  $('hint-bar').hidden = false;
  setHintText(() => t('roundRestored'));
}

/* ================= live language switching ================= */

// The hint bar's current message, kept as a function so it re-renders in a new language.
let hintText = null;
function setHintText(fn) { hintText = fn; $('hint-text').textContent = fn(); }

let resumeIsBack = false;
function labelResume() { $('btn-resume').textContent = resumeIsBack ? t('back') : t('resume'); }

/** Re-render every code-built text in the current language without touching the round. */
function relabel() {
  $('btn-signin').textContent = shText('signIn', {}, locale());
  $('btn-invite').textContent = shText('invite', {}, locale());
  labelResume();
  renderKeyHelp();
  updatePlayerLine();
  if (!$('scr-title').hidden) $('title-progress').textContent = titleProgressText();
  if (!$('mode-detail').hidden && pendingMode) selectMode(pendingMode);
  if ($('gfx-shadows')) { relabelGfxPanel(); renderGfxPanel(); }
  if (session) {
    updateHud();
    ui.renderDomBoard($('dom-board'), session.state, mirrorOpts(), onMirrorCell);
    if (!$('hint-bar').hidden && hintText) $('hint-text').textContent = hintText();
    if (!$('scr-results').hidden) renderResultsText();
  }
}

boot();
