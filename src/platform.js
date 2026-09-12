// Tangled Threads — StarHermit platform adapter (hosted API, offline-tolerant).
// Hosted mode activates iff a launch token was read from the URL fragment;
// every REST call then sends Authorization: Bearer and the token is re-minted
// every 45 min. The game's own server.js (local dev backend) keeps its
// replay-validated score/daily/achievement routes; on the hosted platform the
// leaderboard is read-only and progress mirrors to the platform cloud slot.
// localStorage is always the offline cache: any failure falls back to local
// play with no console noise.

import { loadSettings, saveSettings, loadProgress, saveProgress, checksum } from './ui.js';

const PROBE_TIMEOUT_MS = 2000;
const REQUEST_TIMEOUT_MS = 8000;
const REFRESH_INTERVAL_MS = 45 * 60 * 1000; // token lives 60 min — renew ahead of expiry
const REFRESH_RETRY_MS = 60 * 1000;
const CLOUD_DEBOUNCE_MS = 2000;
const BOARD_PAGE_SIZE = 10;
const CLOUD_ENTRY_NAME = 'save.json';
const BACKEND_MARKER = 'tangled-threads'; // own server.js stamps /api/v1/time

/* ---------------- launch token: fragment #game_token=<jwt>, read once ---------------- */

function readLaunchToken() {
  if (typeof window === 'undefined' || !window.location) return null;
  const { location } = window;
  if (location.hash) {
    const params = new URLSearchParams(location.hash.slice(1));
    const token = params.get('game_token');
    if (token) {
      // Strip only the token, preserving any other fragment params.
      params.delete('game_token');
      const rest = params.toString();
      try {
        history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));
      } catch { /* stripping is best-effort */ }
      return token;
    }
  }
  // Query-param fallbacks exist only for local dev.
  const params = new URLSearchParams(location.search);
  return params.get('game_token') || params.get('token') || params.get('launch') || params.get('launch_token');
}

// base64url-decode the payload; signature verification is the platform's job.
function decodeJwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

/* ---------------- minimal ZIP writer/reader (stored entries only) ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}

export function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}

export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

/* ---------------- adapter state ---------------- */

let token = readLaunchToken();
let claims = token ? decodeJwtPayload(token) : null;
let sub = claims && typeof claims.sub === 'string' ? claims.sub : null;
let slug = claims && typeof claims.game_scope === 'string' ? claims.game_scope : null;
const hosted = !!(token && sub && slug);
if (!hosted) { token = null; claims = null; sub = null; slug = null; }

let backend = false;       // the game's own server.js answered (local dev)
let timeOffsetMs = 0;      // serverNow - clientNow, round-trip adjusted
let leaderboardId = null;  // platform leaderboard (read-only), when published
let nickname = hosted ? 'Player ' + sub.slice(0, 8) : null;
const profileCache = new Map(); // userId -> nickname
let syncStatus = hosted ? 'synced' : 'local'; // local|synced|saving|offline|error
let refreshTimer = null;
let cloudTimer = null;
let cloudDirty = false;
let cloudReady = false;    // first cloud load attempted — flushes wait for it
let lastCloudSig = null;
let onIdentity = null;   // ({nickname, hosted})
let onSync = null;       // (status)

function emitIdentity() {
  if (typeof onIdentity === 'function') {
    try { onIdentity({ nickname, hosted }); } catch { /* listener guard */ }
  }
}

function setSync(status) {
  if (syncStatus === status) return;
  syncStatus = status;
  if (typeof onSync === 'function') {
    try { onSync(status); } catch { /* listener guard */ }
  }
}

async function request(path, { method = 'GET', body, timeout = REQUEST_TIMEOUT_MS, binary = false, keepalive = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const headers = {};
    if (body) headers['content-type'] = 'application/json';
    if (token) headers.authorization = 'Bearer ' + token;
    const res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      keepalive,
      credentials: 'same-origin',
    });
    if (binary) {
      if (res.status === 404) throw Object.assign(new Error('not-found'), { notFound: true });
      if (!res.ok) throw new Error('http-' + res.status);
      return new Uint8Array(await res.arrayBuffer());
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || 'http-' + res.status);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- identity ---------------- */
// Nickname via the profile route — never /api/v1/me (403 for launch tokens),
// never usernames. Fallback: "Player " + id8.

async function fetchProfile(userId) {
  if (profileCache.has(userId)) return profileCache.get(userId);
  let name = null;
  if (hosted) {
    try {
      const p = await request(`/api/v1/users/${encodeURIComponent(userId)}/profile`, { timeout: PROBE_TIMEOUT_MS });
      if (p && typeof p.nickname === 'string' && p.nickname.trim()) {
        name = p.nickname.trim().slice(0, 24);
      }
    } catch { /* keep fallback */ }
  }
  if (!name) name = 'Player ' + String(userId).slice(0, 8);
  profileCache.set(userId, name);
  return name;
}

/* ---------------- token refresh ---------------- */
// Scoped launch tokens re-mint against the game record; failures retry ~60 s.

function scheduleRefresh(ms) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshToken, ms);
}

async function refreshToken() {
  if (!hosted) return;
  try {
    const data = await request(`/api/v1/games/${encodeURIComponent(slug)}/launch-token`, { method: 'POST', body: {} });
    if (data && typeof data.token === 'string' && data.token) {
      token = data.token;
      scheduleRefresh(REFRESH_INTERVAL_MS);
      return;
    }
    throw new Error('no-token');
  } catch {
    scheduleRefresh(REFRESH_RETRY_MS);
  }
}

/* ---------------- cloud save ---------------- */
// ONE slot: {settings, progress} as a stored zip + base64. Remote wins on
// conflict; localStorage stays the offline cache underneath.

function cloudData() {
  return { settings: loadSettings(), progress: loadProgress() };
}

function cloudSig() {
  try { return checksum(cloudData()); } catch { return null; }
}

function queueCloudSave() {
  if (!hosted) return; // offline: localStorage is the only store
  cloudDirty = true;
  setSync('saving');
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(flushCloudSave, CLOUD_DEBOUNCE_MS);
}

async function flushCloudSave() {
  clearTimeout(cloudTimer);
  if (!hosted || !cloudDirty || !cloudReady) return;
  const sig = cloudSig();
  if (sig != null && sig === lastCloudSig) {
    cloudDirty = false;
    setSync('synced');
    return;
  }
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(cloudData()));
    await request(`/api/v1/me/cloud-saves/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      body: { dataBase64: bytesToBase64(zipStore(CLOUD_ENTRY_NAME, bytes)) },
      keepalive: true,
    });
    lastCloudSig = sig;
    cloudDirty = false;
    setSync('synced');
  } catch {
    setSync('offline'); // retried on the next change or pagehide
  }
}

// Returns true when a remote doc was adopted into the local cache.
async function loadCloudSave() {
  cloudReady = true;
  if (!hosted) return false;
  try {
    const bytes = await request(`/api/v1/me/cloud-saves/${encodeURIComponent(slug)}`, { binary: true });
    const doc = JSON.parse(new TextDecoder().decode(unzipFirstEntry(bytes)));
    if (!doc || typeof doc !== 'object' || !doc.data || doc.check !== checksum(doc.data)) return false;
    saveSettings(doc.data.settings);
    saveProgress(doc.data.progress);
    lastCloudSig = checksum(doc.data);
    cloudDirty = false;
    setSync('synced');
    return true;
  } catch {
    // 404 = no save yet: seed the cloud slot from the local cache.
    cloudDirty = true;
    flushCloudSave();
    return false;
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const flush = () => { if (cloudDirty && cloudReady) flushCloudSave(); };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
}

/* ---------------- init ---------------- */

async function initPlatform() {
  const result = { hosted, backend: false, remoteLoaded: false };

  // Clock/backend probe, local mode only: on the hosted platform the game's
  // own routes do not exist, so nothing may fire there. The marker field
  // tells the platform-shaped time response apart from our own server.js.
  if (!hosted) {
    try {
      const t0 = Date.now();
      const data = await request('/api/v1/time', { timeout: PROBE_TIMEOUT_MS });
      const t1 = Date.now();
      if (data && typeof data.epochMs === 'number') {
        timeOffsetMs = data.epochMs - Math.round((t0 + t1) / 2);
      }
      backend = !!(data && data.server === BACKEND_MARKER);
    } catch { backend = false; }
  }
  result.backend = backend;

  if (hosted) {
    scheduleRefresh(REFRESH_INTERVAL_MS);
    fetchProfile(sub).then((name) => { nickname = name; emitIdentity(); });
    // Platform game record: leaderboard id for the read-only board line.
    try {
      const g = await request(`/api/v1/games/${encodeURIComponent(slug)}`, { timeout: PROBE_TIMEOUT_MS });
      if (g && (typeof g.leaderboardId === 'string' || typeof g.leaderboardId === 'number')) {
        leaderboardId = String(g.leaderboardId);
      }
    } catch { /* local records only */ }
    result.remoteLoaded = await loadCloudSave();
  }
  return result;
}

/* ---------------- time ---------------- */

export function serverNow() { return new Date(Date.now() + timeOffsetMs); }

/* ---------------- daily (own-backend only) ---------------- */

export async function fetchDailyInfo() {
  if (!backend) return { ok: false };
  try {
    const res = await request('/api/v1/daily');
    return { ok: true, ...res };
  } catch { return { ok: false }; }
}

/* ---------------- achievements ---------------- */
// Durable delivery exists only against the game's own server.js. On the
// hosted platform achievements stay local inside the cloud-saved progress doc.

export async function postAchievements(keys) {
  if (!backend) return { ok: false };
  try {
    await request('/api/v1/achievements', { method: 'POST', body: { keys } });
    return { ok: true };
  } catch { return { ok: false }; }
}

/* ---------------- leaderboards ---------------- */
// Read-only per the platform contract: clients never submit scores to a
// platform leaderboard. Personal bests live in progress and cloud-save with it.

async function fetchPlatformBoard() {
  if (!hosted || !leaderboardId) return null;
  try {
    const data = await request(
      `/api/v1/leaderboards/${encodeURIComponent(leaderboardId)}/entries?page=1&pageSize=${BOARD_PAGE_SIZE}`,
    );
    const list = Array.isArray(data && data.entries) ? data.entries : [];
    // Servers send rows best-first; sort defensively before labelling ranks.
    const rows = list.map((e) => ({ e, score: Number(e && (e.score != null ? e.score : e.value)) }))
      .sort((a, b) => (Number.isFinite(b.score) ? b.score : 0) - (Number.isFinite(a.score) ? a.score : 0));
    return await Promise.all(rows.map(async ({ e, score }, i) => {
      const userId = e && (e.userId ?? (e.user && e.user.id) ?? e.user_id ?? null);
      let name = null;
      if (userId != null) name = await fetchProfile(String(userId));
      return { name, score: Number.isFinite(score) ? score : 0, rank: (e && e.rank) || i + 1, me: userId != null && userId === sub };
    }));
  } catch {
    return null;
  }
}

/* ---------------- ranked result line ---------------- */
// Replay-validated submission exists only against the game's own server.js
// (authenticated its-backend, graceful fallback). Hosted play reads the
// platform leaderboard instead; anything else keeps the score local.

async function submitScore(envelope) {
  if (!backend) return { ok: false, error: 'unavailable' };
  try {
    const body = await request('/api/v1/score', { method: 'POST', body: envelope });
    return { ok: true, ...body };
  } catch (e) {
    const msg = (e && e.message) || 'submit-failed';
    const offline = !!(e && (e.name === 'AbortError' || /fetch|network/i.test(msg)));
    return { ok: false, error: offline ? 'offline' : msg };
  }
}

export async function compareResult(envelope, localBest) {
  if (backend) {
    const r = await submitScore(envelope);
    if (r.ok) return `Global rank #${r.rank} of ${r.entries} on this board.`;
    return r.error === 'offline' ? 'Offline — score kept locally.' : `Score not ranked (${r.error}).`;
  }
  if (hosted) {
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

/* ---------------- public surface ---------------- */

export const platform = {
  get hosted() { return hosted; },
  get backend() { return backend; },
  get nickname() { return nickname; },
  get syncStatus() { return syncStatus; },
  get onIdentity() { return onIdentity; },
  set onIdentity(cb) { onIdentity = cb; },
  get onSync() { return onSync; },
  set onSync(cb) { onSync = cb; },
  init: initPlatform,
  serverNow,
  compareResult,
  fetchDailyInfo,
  postAchievements,
  queueCloudSave,
};
