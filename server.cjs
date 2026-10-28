// Tangled Threads — authoritative server script (StarHermit: server=server.js).
// Serves the static distribution and provides same-origin /api routes:
//   GET  /api/v1/time          platform time for countdown/daily sync
//   GET  /api/v1/daily         today's UTC daily seed + ruleset version
//   GET  /api/v1/leaderboard   global board for a level (?level=...)
//   POST /api/v1/score         replay-validated score submission
//   POST /api/v1/achievements  idempotent achievement delivery
// No external dependencies; runs with plain Node.js >= 18.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = process.env.TT_DATA_DIR || path.join(ROOT, 'data');
const PORT = process.env.PORT || 8080;
const MAX_BODY = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.opus': 'audio/ogg',
};

/* ---------------- tiny persistent stores ---------------- */

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch { return fallback; }
}
function saveJson(file, data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data));
  } catch { /* read-only filesystem: run in memory */ }
}

let leaderboard = loadJson('leaderboard.json', { entries: [] });
let achievements = loadJson('achievements.json', { unlocked: {} });
let excludedDailies = loadJson('excluded.json', { days: [] });

/* ---------------- rate limiting (per IP, fixed window) ---------------- */

const rateBuckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now - b.start > 60000) { b = { start: now, count: 0 }; rateBuckets.set(ip, b); }
  b.count++;
  // Drop expired buckets so a long-lived process does not grow one entry per IP.
  if (rateBuckets.size > 4096) {
    for (const [k, v] of rateBuckets) if (now - v.start > 60000) rateBuckets.delete(k);
  }
  return b.count > 120;
}

/* ---------------- rules engine (shared with the client) ---------------- */

let rulesPromise = null;
let contentPromise = null;
function loadRules() {
  if (!rulesPromise) rulesPromise = import(pathToFileUrl('./src/rules.js'));
  return rulesPromise;
}
function loadContent() {
  if (!contentPromise) contentPromise = import(pathToFileUrl('./src/content.js'));
  return contentPromise;
}
function pathToFileUrl(p) {
  const abs = path.resolve(ROOT, p).replace(/\\/g, '/');
  return 'file://' + (abs.startsWith('/') ? '' : '/') + abs;
}

/* ---------------- helpers ---------------- */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function dailySeedString(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `daily-${y}-${m}-${d}`;
}

/* ---------------- API ---------------- */

async function handleApi(req, res, url) {
  if (url.pathname === '/api/v1/time' && req.method === 'GET') {
    return sendJson(res, 200, { epochMs: Date.now(), iso: new Date().toISOString(), server: 'tangled-threads' });
  }

  if (url.pathname === '/api/v1/daily' && req.method === 'GET') {
    const seed = dailySeedString(new Date());
    const excluded = excludedDailies.days.includes(seed);
    return sendJson(res, 200, { seed, contentVersion: 1, excluded, ranked: !excluded });
  }

  if (url.pathname === '/api/v1/leaderboard' && req.method === 'GET') {
    const level = url.searchParams.get('level') || '';
    const entries = leaderboard.entries
      .filter((e) => e.levelId === level)
      .sort((a, b) => b.score - a.score || a.elapsedMs - b.elapsedMs || String(a.sessionId).localeCompare(String(b.sessionId)))
      .slice(0, 100)
      .map(({ rank: _r, ...e }) => e);
    return sendJson(res, 200, { levelId: level, entries });
  }

  if (url.pathname === '/api/v1/score' && req.method === 'POST') {
    let env;
    try { env = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'bad-json' }); }
    const rules = await loadRules();
    const content = await loadContent();

    // Structural validation.
    if (!env || typeof env !== 'object') return sendJson(res, 400, { error: 'bad-envelope' });
    const { levelId, commands, sessionId, stateHashes } = env;
    if (typeof levelId !== 'string' || !content.isValidLevelId(levelId)) return sendJson(res, 400, { error: 'bad-level' });
    if (!Array.isArray(commands) || commands.length > 4096) return sendJson(res, 400, { error: 'bad-commands' });
    if (typeof sessionId !== 'string' || sessionId.length > 64) return sendJson(res, 400, { error: 'bad-session' });

    // Practice is unranked by design.
    if (levelId.startsWith('practice-') || levelId === 'tutorial') {
      return sendJson(res, 422, { error: 'unranked-mode' });
    }
    // Excluded dailies are marked, not silently replaced.
    if (levelId.startsWith('daily-') && excludedDailies.days.includes(levelId)) {
      return sendJson(res, 422, { error: 'daily-excluded-from-ranking' });
    }

    // Authoritative replay validation.
    const level = content.generateLevel(levelId);
    const result = rules.replay(level, commands);
    if (result.error) return sendJson(res, 422, { error: 'replay-failed:' + result.error });
    if (!result.state.terminal) return sendJson(res, 422, { error: 'not-terminal' });
    if (result.state.terminal.reason !== 'complete') return sendJson(res, 422, { error: 'not-complete' });

    // Client-reported hashes, when present, must match authoritative ones.
    if (Array.isArray(stateHashes)) {
      const authoritative = [rules.hashState(rules.createGame(level)), ...result.hashes];
      if (stateHashes.length !== authoritative.length || stateHashes.some((h, i) => h !== authoritative[i])) {
        return sendJson(res, 422, { error: 'hash-mismatch' });
      }
    }

    const score = result.state.terminal.score.total;
    const elapsedMs = Math.max(0, Math.min(24 * 3600 * 1000, env.elapsedMs | 0));

    // Idempotent by session: a resubmission of the same session returns its standing rank.
    const existing = leaderboard.entries.find((e) => e.sessionId === sessionId && e.levelId === levelId);
    if (!existing) {
      leaderboard.entries.push({
        levelId, sessionId, score, elapsedMs,
        contentVersion: level.version, seed: levelId,
        assists: env.assists || { hints: result.state.hints },
        moves: result.state.moves, invalid: result.state.invalid,
        submittedAt: Date.now(),
      });
      saveJson('leaderboard.json', leaderboard);
    }
    const board = leaderboard.entries
      .filter((e) => e.levelId === levelId)
      .sort((a, b) => b.score - a.score || a.elapsedMs - b.elapsedMs || String(a.sessionId).localeCompare(String(b.sessionId)));
    const rank = board.findIndex((e) => e.sessionId === sessionId) + 1;
    return sendJson(res, 200, { accepted: true, score, rank, entries: board.length });
  }

  if (url.pathname === '/api/v1/achievements' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'bad-json' }); }
    const keys = Array.isArray(body?.keys) ? body.keys.filter((k) => typeof k === 'string' && /^[a-z0-9-]+$/.test(k)) : [];
    const delivered = [];
    for (const k of keys.slice(0, 32)) {
      if (!achievements.unlocked[k]) { // idempotent
        achievements.unlocked[k] = Date.now();
        delivered.push(k);
      }
    }
    saveJson('achievements.json', achievements);
    return sendJson(res, 200, { delivered, total: Object.keys(achievements.unlocked).length });
  }

  return sendJson(res, 404, { error: 'not-found' });
}

/* ---------------- static files ---------------- */

function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); return res.end('bad path'); }
  if (rel.split(/[\\/]/).some(part => part.startsWith('.'))) { res.writeHead(403); return res.end('forbidden'); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  // `startsWith(ROOT)` alone would also accept sibling directories whose name
  // merely begins with ROOT, so require a separator (or ROOT itself).
  const inRoot = file === ROOT || file.startsWith(ROOT + path.sep);
  if (!inRoot || file.includes(`${path.sep}data${path.sep}`) || file.includes(`${path.sep}.git${path.sep}`)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const immutable = rel.startsWith('/vendor/');
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------------- server ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = req.socket.remoteAddress || 'unknown';
  if (url.pathname.startsWith('/api/')) {
    if (rateLimited(ip)) return sendJson(res, 429, { error: 'rate-limited' });
    try {
      return await handleApi(req, res, url);
    } catch (e) {
      return sendJson(res, 500, { error: 'internal' });
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, url);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Tangled Threads server listening on http://localhost:${PORT}`);
  });
}

module.exports = { server };
