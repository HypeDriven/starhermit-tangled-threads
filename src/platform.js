// Tangled Threads — StarHermit platform adapter over window.StarHermit
// (starhermit-sdk.js): launch token + renewal, sign-in, nickname, the
// game:<slug> cloud-save slot, settings KV, controls, invite link and the
// read-only platform board. The client never calls the game's own server.js
// routes: standalone play (any host, loopback included) makes no network
// calls and uses the device clock.
// localStorage is always the offline cache: any failure falls back to local
// play with no console noise.

import { loadSettings, saveSettings, loadProgress, saveProgress, checksum } from './ui.js';

const CLOUD_DEBOUNCE_MS = 2000;
const SETTINGS_PUSH_MS = 800;
const BOARD_PAGE_SIZE = 10;

/** Preferences mirrored to the platform settings KV. */
export const PREF_KEYS = ['volumes', 'graphics', 'reducedMotion', 'highContrast', 'cvdPalette',
  'largeText', 'leftHanded', 'haptics', 'tutorialDone'];
/** Keyboard actions (KeyboardEvent.code) — mirrors control.* in starhermit.txt. */
export const DEFAULT_BINDINGS = {
  left: ['ArrowLeft'], right: ['ArrowRight'], up: ['ArrowUp'], down: ['ArrowDown'],
  select: ['Enter', 'Space'], reel: ['KeyR'], undo: ['KeyU'], hint: ['KeyH'],
  pause: ['Escape'], camera: ['KeyC'],
};

const SH = (typeof globalThis !== 'undefined' && globalThis.StarHermit) || null;
if (SH) SH.init();

/* ---------------- adapter state ---------------- */

const isHosted = () => !!(SH && SH.signedIn);
let nickname = null;
let syncStatus = isHosted() ? 'synced' : 'local'; // local|synced|saving|offline|error
let onIdentity = null;   // ({nickname, hosted})
let onSync = null;       // (status)
let onAuth = null;       // ({signedIn})
let pushedPrefs = {};
let prefTimer = null;
let cloudReady = false;  // set once the start-up cloud load has resolved

function emitIdentity() {
  if (typeof onIdentity === 'function') {
    try { onIdentity({ nickname, hosted: isHosted() }); } catch { /* listener guard */ }
  }
}

function setSync(status) {
  if (syncStatus === status) return;
  syncStatus = status;
  if (typeof onSync === 'function') {
    try { onSync(status); } catch { /* listener guard */ }
  }
}

if (SH) {
  SH.on('saved', (ok) => setSync(ok ? 'synced' : 'offline'));
  SH.on('auth', (a) => {
    if (!a.signedIn) { nickname = null; setSync('local'); }
    if (typeof onAuth === 'function') { try { onAuth(a); } catch { /* listener guard */ } }
    emitIdentity();
  });
}

/* ---------------- identity ---------------- */
// Profile nickname (fallback "Player <id>") — never /api/v1/me, never usernames.

async function fetchProfile(userId) {
  const p = SH ? await SH.profile(userId) : null;
  return p ? String(p.displayName).slice(0, 24) : 'Player ' + String(userId).slice(0, 6);
}

/* ---------------- cloud save ---------------- */
// ONE slot (game:<slug>): {v, data:{settings, progress}, check}. Remote wins
// on start; localStorage stays the offline cache underneath.

function cloudData() {
  return { settings: loadSettings(), progress: loadProgress() };
}

function queueCloudSave() {
  if (!isHosted()) return; // offline: localStorage is the only store
  // Boot writes (applySettings) run before the cloud load resolves; pushing
  // then would queue the stale local cache over a newer cloud save (and a
  // pagehide during the load would flush it). loadCloudSave pushes instead.
  if (!cloudReady) return;
  setSync('saving');
  const data = cloudData();
  SH.saveJSON({ v: 1, data, check: checksum(data) }, CLOUD_DEBOUNCE_MS);
}

// Returns true when a remote doc was adopted into the local cache.
async function loadCloudSave() {
  if (!isHosted()) return false;
  const doc = await SH.loadJSON().catch(() => null);
  cloudReady = true;
  if (!doc || typeof doc !== 'object' || !doc.data || doc.check !== checksum(doc.data)) {
    queueCloudSave(); // no save yet: seed the cloud slot from the local cache
    return false;
  }
  saveSettings(doc.data.settings);
  saveProgress(doc.data.progress);
  setSync('synced');
  return true;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.addEventListener) {
  const flush = () => { if (isHosted()) SH.flushSave(true); };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
}

/* ---------------- settings KV + controls ---------------- */

function pickPrefs(s) {
  const out = {};
  for (const k of PREF_KEYS) if (s && s[k] !== undefined) out[k] = s[k];
  return out;
}

// Platform-stored preferences, adopted into the local settings (platform wins).
async function loadPlatformSettings() {
  if (!isHosted()) return false;
  const remote = await SH.getSettings();
  const local = loadSettings();
  const patch = {};
  for (const k of PREF_KEYS) if (remote && remote[k] != null) patch[k] = remote[k];
  pushedPrefs = { ...pickPrefs(local), ...patch };
  if (!Object.keys(patch).length) return false;
  saveSettings({ ...local, ...patch });
  return true;
}

/** Debounced PATCH of changed preference keys. */
function pushSettings(s) {
  if (!isHosted()) return;
  clearTimeout(prefTimer);
  prefTimer = setTimeout(() => {
    const prefs = pickPrefs(s), diff = {};
    for (const k of PREF_KEYS) {
      if (JSON.stringify(prefs[k]) !== JSON.stringify(pushedPrefs[k])) diff[k] = prefs[k] ?? null;
    }
    if (!Object.keys(diff).length) return;
    Object.assign(pushedPrefs, diff);
    SH.patchSettings(diff);
  }, SETTINGS_PUSH_MS);
}

/** Effective bindings; platform overrides win when signed in. */
async function loadBindings() {
  if (!isHosted()) return Object.fromEntries(Object.entries(DEFAULT_BINDINGS).map(([k, v]) => [k, v.slice()]));
  return SH.loadBindings(DEFAULT_BINDINGS);
}

/* ---------------- init ---------------- */

async function initPlatform() {
  const result = { hosted: isHosted(), remoteLoaded: false };

  if (isHosted()) {
    nickname = 'Player ' + String(SH.userId).slice(0, 6);
    fetchProfile(SH.userId).then((name) => { nickname = name; emitIdentity(); });
    result.remoteLoaded = await loadCloudSave();
    if (await loadPlatformSettings()) result.remoteLoaded = true;
  }
  return result;
}

/* ---------------- time ---------------- */

export function serverNow() { return new Date(); }

/* ---------------- leaderboards ---------------- */
// Read-only per the platform contract: clients never submit scores to a
// platform leaderboard. Personal bests live in progress and cloud-save with it.

async function fetchPlatformBoard() {
  if (!isHosted()) return null;
  const r = await SH.leaderboard(null, { pageSize: BOARD_PAGE_SIZE });
  if (!r || !r.board) return null;
  const rows = (r.items || []).map((e) => ({ e, score: Number(e && (e.score != null ? e.score : e.value)) }))
    .sort((a, b) => (Number.isFinite(b.score) ? b.score : 0) - (Number.isFinite(a.score) ? a.score : 0));
  return Promise.all(rows.map(async ({ e, score }, i) => ({
    name: e.userId != null ? await fetchProfile(String(e.userId)) : null,
    score: Number.isFinite(score) ? score : 0,
    rank: e.rank || i + 1,
    me: e.userId != null && e.userId === SH.userId,
  })));
}

/* ---------------- ranked result line ---------------- */
// Hosted play reads the platform leaderboard; otherwise the score stays local.

export async function compareResult(localBest) {
  if (isHosted()) {
    const board = await fetchPlatformBoard();
    if (board === null) {
      return 'Globally ranked boards are unavailable on this host — score kept locally.';
    }
    if (!board.length) return 'Platform leaderboard has no entries yet — your score is kept locally.';
    const top = board[0];
    const best = localBest != null ? ` Your best on this board: ${localBest}.` : '';
    return `Platform leaderboard (read-only): #1 ${top.name} · ${top.score}.${best}`;
  }
  return 'Offline — score kept locally.';
}

/** Post a finished ranked round's total to the platform `high-score` board
 *  (score-script.js) via StarHermit.submitScores. Resolves {posted, rank} —
 *  the player's rank on that board, or null. Signed out: no request. */
export async function postHighScore(total) {
  if (!isHosted()) return { posted: false, rank: null };
  try {
    const keys = await SH.submitScores({ 'high-score': total });
    if (!keys || keys.indexOf('high-score') < 0) return { posted: false, rank: null };
    try {
      const r = await SH.leaderboard('high-score', { pageSize: 100 });
      const me = ((r && r.items) || []).find((i) => i.userId === SH.userId);
      return { posted: true, rank: me ? me.rank : null };
    } catch { return { posted: true, rank: null }; }
  } catch { return { posted: false, rank: null }; }
}

/* ---------------- public surface ---------------- */

export const platform = {
  get hosted() { return isHosted(); },
  get nickname() { return nickname; },
  get syncStatus() { return syncStatus; },
  get onIdentity() { return onIdentity; },
  set onIdentity(cb) { onIdentity = cb; },
  get onSync() { return onSync; },
  set onSync(cb) { onSync = cb; },
  get onAuth() { return onAuth; },
  set onAuth(cb) { onAuth = cb; },
  init: initPlatform,
  serverNow,
  compareResult,
  postHighScore,
  queueCloudSave,
  flushCloudSave: () => (isHosted() ? SH.flushSave(true) : Promise.resolve(false)),
  pushSettings,
  loadBindings,
  canSignIn: () => !!(SH && SH.canSignIn()),
  signIn: () => !!(SH && SH.signIn()),
  inviteLink: () => (isHosted() ? SH.inviteLink() : null),
};
