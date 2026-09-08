// Tangled Threads — DOM shell: screens, settings, progression, platform adapter,
// accessibility mirror. UI state is fully separate from simulation state.

import { STRAND_COLORS, STRAND_COLORS_CVD } from './content.js';

/* ---------------- settings (versioned, checksummed, local) ---------------- */

const SETTINGS_KEY = 'tt-settings-v1';
const PROGRESS_KEY = 'tt-progress-v1';
const SNAPSHOT_KEY = 'tt-session-v1';

export const defaultSettings = {
  version: 1,
  volumes: { music: 0.5, effects: 0.8, ambience: 0.4, voice: 0.8 },
  quality: 2,
  reducedMotion: false,
  highContrast: false,
  cvdPalette: false,
  largeText: false,
  leftHanded: false,
  haptics: true,
  tutorialDone: false,
};

function checksum(obj) {
  const s = JSON.stringify(obj);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function loadDoc(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return structuredClone(fallback);
    const doc = JSON.parse(raw);
    if (doc.check !== checksum(doc.data)) return structuredClone(fallback);
    return { ...structuredClone(fallback), ...doc.data };
  } catch { return structuredClone(fallback); }
}

function saveDoc(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ v: 1, data, check: checksum(data) })); } catch {}
}

export function loadSettings() { return loadDoc(SETTINGS_KEY, defaultSettings); }
export function saveSettings(s) { saveDoc(SETTINGS_KEY, s); }

/* ---------------- progression ---------------- */

export const defaultProgress = {
  version: 1,
  stagesDone: {},        // stage-N -> best total
  dailiesDone: {},       // daily-... -> total
  challengesDone: {},
  achievements: {},      // key -> timestamp
  daysPlayed: {},        // yyyy-mm-dd -> true
  bestScores: {},        // levelId -> total
};

export function loadProgress() { return loadDoc(PROGRESS_KEY, defaultProgress); }
export function saveProgress(p) { saveDoc(PROGRESS_KEY, p); }

export function saveSnapshot(snap) {
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap)); } catch {}
}
export function loadSnapshot() {
  try { const raw = localStorage.getItem(SNAPSHOT_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function clearSnapshot() { try { localStorage.removeItem(SNAPSHOT_KEY); } catch {} }

/* ---------------- platform adapter (hosted API, offline-tolerant) ---------------- */

let timeOffsetMs = 0;

export async function syncServerTime() {
  try {
    const t0 = Date.now();
    const res = await fetch('/api/v1/time');
    const t1 = Date.now();
    if (!res.ok) return { ok: false };
    const body = await res.json();
    timeOffsetMs = body.epochMs - Math.round((t0 + t1) / 2);
    return { ok: true, offsetMs: timeOffsetMs };
  } catch { return { ok: false }; }
}

export function serverNow() { return new Date(Date.now() + timeOffsetMs); }

export async function fetchDailyInfo() {
  try {
    const res = await fetch('/api/v1/daily');
    if (!res.ok) return { ok: false };
    return { ok: true, ...(await res.json()) };
  } catch { return { ok: false }; }
}

export async function submitScore(envelope) {
  try {
    const res = await fetch('/api/v1/score', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error || 'submit-failed' };
    return { ok: true, ...body };
  } catch { return { ok: false, error: 'offline' }; }
}

export async function fetchLeaderboard(levelId) {
  try {
    const res = await fetch('/api/v1/leaderboard?level=' + encodeURIComponent(levelId));
    if (!res.ok) return { ok: false };
    return { ok: true, ...(await res.json()) };
  } catch { return { ok: false }; }
}

export async function postAchievements(keys) {
  try {
    const res = await fetch('/api/v1/achievements', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys }),
    });
    return { ok: res.ok };
  } catch { return { ok: false }; }
}

/* ---------------- DOM helpers ---------------- */

export function $(id) { return document.getElementById(id); }

export function announce(msg) { $('sr-announcer').textContent = msg; }
export function announceError(msg) { $('sr-errors').textContent = msg; }

const SCREENS = ['scr-title', 'scr-modes', 'scr-pause', 'scr-results', 'scr-help', 'scr-board-mirror'];

export function showOnly(...ids) {
  for (const s of SCREENS) $(s).hidden = !ids.includes(s);
}

export function vibrate(settings, pattern = 12) {
  if (settings.haptics && navigator.vibrate) { try { navigator.vibrate(pattern); } catch {} }
}

/* ---------------- DOM board mirror (accessibility + WebGL fallback) ---------------- */

/** strand.color is a palette index, not an RGB value. */
export function strandHex(colorIdx, cvd = false) {
  const palette = cvd ? STRAND_COLORS_CVD : STRAND_COLORS;
  return '#' + palette[colorIdx % palette.length].toString(16).padStart(6, '0');
}

/** Readable label colour for a filled cell (sRGB relative luminance). */
function inkOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.4 ? '#1a1310' : '#ffffff';
}

/** Moves the keyboard-cursor highlight without rebuilding the grid. */
export function setDomCursor(container, cell) {
  for (const b of container.children) {
    const on = +b.dataset.cell === cell;
    b.classList.toggle('cursor', on);
    if (on) b.setAttribute('aria-current', 'location'); else b.removeAttribute('aria-current');
  }
}

/**
 * Renders an interactive grid of buttons mirroring the board state.
 * opts: { selection, cursor, cvd }. onCell(cell) fires when a cell is activated.
 */
export function renderDomBoard(container, state, opts, onCell) {
  const { selection = -1, cursor = -1, cvd = false } = opts || {};
  // Rebuilding the grid must not drop the keyboard user's place.
  const focused = document.activeElement;
  const refocus = focused && container.contains(focused) ? focused.dataset.cell : null;
  container.innerHTML = '';
  container.style.setProperty('--cols', state.cols);
  const cellInfo = new Map();
  state.strands.forEach((s, i) => {
    s.path.forEach((cell, k) => cellInfo.set(cell, { strand: i, tip: k === s.path.length - 1, anchor: k === 0, done: s.done }));
    if (!s.done) cellInfo.set(s.spool, { ...(cellInfo.get(s.spool) || {}), spool: i });
  });
  for (let cell = 0; cell < state.cols * state.rows; cell++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.cell = cell;
    const info = cellInfo.get(cell);
    const r = Math.floor(cell / state.cols), c = cell % state.cols;
    const where = `row ${r + 1} column ${c + 1}`;
    if (info && info.strand !== undefined) {
      const hex = strandHex(state.strands[info.strand].color, cvd);
      b.textContent = info.tip ? (info.spool !== undefined ? '◉' : '●') : '—';
      b.style.background = hex;
      b.style.color = inkOn(hex);
      b.style.borderColor = hex;
      if (info.done) b.style.opacity = '.45';
      const part = info.tip ? 'tip' : info.anchor ? 'anchor' : 'body';
      b.setAttribute('aria-label',
        `Strand ${info.strand + 1} ${part}${info.done ? ', reeled in' : ''}${info.spool !== undefined ? ', on its spool' : ''}, ${where}`);
      if (info.strand === selection) b.classList.add('sel');
    } else if (info && info.spool !== undefined) {
      const hex = strandHex(state.strands[info.spool].color, cvd);
      b.textContent = '◉';
      b.style.borderColor = hex;
      b.style.color = hex;
      b.setAttribute('aria-label', `Empty spool for strand ${info.spool + 1}, ${where}`);
      if (info.spool === selection) b.classList.add('sel');
    } else {
      b.setAttribute('aria-label', `Empty cell, ${where}`);
    }
    if (cell === cursor) { b.classList.add('cursor'); b.setAttribute('aria-current', 'location'); }
    b.addEventListener('click', () => onCell(cell));
    container.appendChild(b);
  }
  if (refocus != null) container.querySelector(`[data-cell="${refocus}"]`)?.focus();
}
