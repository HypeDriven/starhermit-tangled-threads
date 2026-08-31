// Tangled Threads — DOM shell: screens, settings, progression, platform adapter,
// accessibility mirror. UI state is fully separate from simulation state.

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

/**
 * Renders an interactive grid of buttons mirroring the board state.
 * onCell(cell) is called when a cell button is activated.
 */
export function renderDomBoard(container, state, theme, onCell) {
  container.innerHTML = '';
  container.style.gridTemplateColumns = `repeat(${state.cols}, 44px)`;
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
    if (info?.spool !== undefined && info.spool !== null && cellInfo.get(cell)?.spool !== undefined && info.tip === undefined) {
      b.textContent = '◉';
      b.style.borderColor = '#' + state.strands[info.spool].color.toString(16).padStart(6, '0');
      b.setAttribute('aria-label', `Spool for strand ${info.spool + 1}, row ${r + 1} column ${c + 1}`);
    } else if (info) {
      b.textContent = info.tip ? '●' : '—';
      b.style.background = '#' + state.strands[info.strand].color.toString(16).padStart(6, '0');
      b.setAttribute('aria-label', `Strand ${info.strand + 1} ${info.tip ? 'tip' : info.anchor ? 'anchor' : 'body'}, row ${r + 1} column ${c + 1}`);
    } else {
      b.setAttribute('aria-label', `Empty cell, row ${r + 1} column ${c + 1}`);
    }
    b.addEventListener('click', () => onCell(cell));
    container.appendChild(b);
  }
}
