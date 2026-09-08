/**
 * Tangled Threads — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title → Play → mode select → Practice → practice-easy board → route
 *   every strand along empty cells onto its matching spool and reel it in
 *   (real clicks on the on-screen board buttons) → results ("Board
 *   complete!") with score breakdown + persisted progress. Also exercises
 *   Help, title-settings open/close, pause/resume, hint, and undo through
 *   the visible controls.
 * A second pass runs the load → practice → tap-a-few-strands flow on a
 *   mobile touch viewport.
 *
 * The game exposes no debug handle on window, so the test reads the
 * authored solution exactly the way the Hint button does: it dynamic-
 * imports the shipped `src/content.js` in the page and reads
 * `generateLevel(id).solution` (the accepted, validated solution class)
 * purely to know which visible cell to click next. Every board action is
 * a real click/tap of an on-screen `#dom-board` button, which dispatches
 * through the game's own pointer/mirror → handleCell/handleSpool path.
 * No game code is modified and no move is performed by the test.
 *
 * Serving: the repo ships `server.js` (the StarHermit authoritative
 * script declared by starhermit.txt) but the game is fully playable
 * offline — every screen and the whole round loop is local, and the
 * platform adapter degrades cleanly when `/api/*` is unreachable
 * (`syncServerTime` leaves the offset at 0, which keeps `serverNow()`
 * valid for the results screen). So, per the conventions of the sibling
 * titles (picture-logic/blockstead/balance-spire), this test embeds a
 * minimal node:http static server on an ephemeral port and answers
 * `/api/v1/time` with a real epoch so the results screen (which formats
 * `serverNow().toISOString()`) stays crash-free, and every other `/api/*`
 * probe with 200 `{}`. If the build ever truly requires the backend this
 * can be swapped for spawning `server.js`; today it is not needed.
 *
 * Run: npm run test:e2e  (or: node tests/e2e.mjs)
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/tangled-threads-e2e-${stage}-${vp}.png`;

// benign GPU/swiftshader noise (mirrors tools/production_game_audit.mjs)
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // No StarHermit backend here. Give /api/v1/time a real epoch so the
    // results screen (serverNow().toISOString()) stays valid; answer every
    // other /api probe with empty JSON (200) so the platform adapter
    // degrades to its documented offline path with zero console noise.
    if (p.startsWith('/api/')) {
      const body = p === '/api/v1/time'
        ? JSON.stringify({ epochMs: Date.now() })
        : '{}';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    const pathname = p === '/' ? '/index.html' : p;
    const file = path.normalize(path.join(ROOT, pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (name) => console.log(`ok - ${name}`);

// ---------- in-page read-only observation ----------
//
// The game ships no debug handle, so the test reads the authored solution
// the same way the Hint button does: dynamic-import the shipped content
// module and read generateLevel(id).solution (the validated solution
// class). This is observation only — every action below is a real click
// of a visible board/HUD button.
const readLevel = (page, levelId) => page.evaluate(async (id) => {
  const mod = await import('./src/content.js');
  const level = mod.generateLevel(id);
  return {
    cols: level.cols,
    rows: level.rows,
    par: level.par,
    strands: level.strands.map((s, i) => ({ anchor: s.anchor, spool: s.spool, solution: level.solution[i].slice() })),
  };
}, levelId);

const readProgress = (page) => page.evaluate(() => {
  const m = (document.getElementById('hud-progress')?.textContent || '').match(/(\d+)\/(\d+)/);
  return m ? { reeled: +m[1], total: +m[2] } : null;
});

const waitPlayActive = (page) =>
  page.waitForFunction(() => !document.getElementById('scr-board-mirror').hidden
    && (document.getElementById('hud-progress').textContent || '').includes('/'),
  null, { timeout: 15000 });

const cellBtn = (page, cell) => page.locator(`#dom-board [data-cell="${cell}"]`);

// Route one strand for real: select it via its anchor cell, extend along the
// authored solution onto its spool, then reel it in via the spool tap. Wait
// for the HUD "Reeled X/Y" to advance so each strand provably registered.
async function reelStrand(page, i, s, { tap } = {}) {
  const clickCell = async (cell) => {
    if (tap) {
      const bb = await cellBtn(page, cell).boundingBox();
      if (!bb || bb.width < 1 || bb.height < 1) throw new Error(`tap target cell ${cell} too small: ${JSON.stringify(bb)}`);
      await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
    } else {
      await cellBtn(page, cell).click();
    }
  };
  await clickCell(s.anchor);                       // tap the strand -> select it
  for (let k = 1; k < s.solution.length; k++) {
    await clickCell(s.solution[k]);                // extend, ending on the spool
  }
  const before = (await readProgress(page))?.reeled ?? 0;
  await clickCell(s.spool);                        // reel the strand onto its spool
  await page.waitForFunction(async (n) => {
    const m = (document.getElementById('hud-progress')?.textContent || '').match(/(\d+)\/(\d+)/);
    return !!m && +m[1] > n;
  }, before, { timeout: 4000 });
  const after = await readProgress(page);
  if (!after || after.reeled !== before + 1) throw new Error(`strand ${i} did not reel (Reeled ${before}->${JSON.stringify(after)})`);
}

async function startPractice(page, levelId) {
  await page.click('#btn-play');
  await page.waitForFunction(() => !document.getElementById('scr-modes').hidden);
  await page.locator('.mode-card[data-mode="practice"]').click();
  await page.waitForFunction(() => !document.getElementById('journey-list').hidden);
  const want = levelId.replace('-', ' ');
  await page.locator('#journey-list .mode-card').filter({ hasText: want }).click();
  await waitPlayActive(page);
}

// ---------- one full pass ----------
async function runPass(browser, name, ctxOpts, { full, tap }) {
  const errors = [];
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource|net::ERR/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    const u = r.url();
    if (r.status() >= 400 && !/\/api\/|\/favicon/.test(u)) errors.push(`http ${r.status()}: ${u}`);
  });

  try {
    // load + title
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#scr-title:not([hidden])', { timeout: 15000 });
    await page.screenshot({ path: SHOT('title', name) });
    ok(`${name}: title screen visible`);

    // Help screen (title → How to play → close)
    await page.click('#btn-title-help');
    await page.waitForFunction(() => !document.getElementById('scr-help').hidden);
    const ruleCards = await page.locator('#scr-help .rule-card').count();
    if (ruleCards < 5) throw new Error(`expected >=5 rule cards in help, got ${ruleCards}`);
    await page.click('#btn-help-close');
    await page.waitForFunction(() => document.getElementById('scr-help').hidden);
    ok(`${name}: help screen opens with ${ruleCards} rule cards and closes`);

    // Settings screen (title → settings → Back)
    await page.click('#btn-title-settings');
    await page.waitForFunction(() => !document.getElementById('scr-pause').hidden);
    const hasBack = (await page.textContent('#btn-resume')).trim();
    if (!/Back/i.test(hasBack)) throw new Error(`expected settings Back button, got "${hasBack}"`);
    await page.click('#btn-resume');
    await page.waitForFunction(() => document.getElementById('scr-pause').hidden);
    ok(`${name}: settings screen opens (Back) and closes`);

    // mode select → Practice → practice-easy
    const levelId = 'practice-easy';
    await startPractice(page, levelId);
    const lvl = await readLevel(page, levelId);
    if (lvl.strands.length !== 3) throw new Error(`expected 3 strands in practice-easy, got ${lvl.strands.length}`);
    await page.screenshot({ path: SHOT('play', name) });
    ok(`${name}: practice board active (${lvl.cols}×${lvl.rows}, ${lvl.strands.length} strands, par ${lvl.par})`);

    if (full) {
      // pause / resume via the visible buttons
      await page.click('#btn-pause');
      await page.waitForFunction(() => !document.getElementById('scr-pause').hidden);
      await page.screenshot({ path: SHOT('pause', name) });
      await page.click('#btn-resume');
      await page.waitForFunction(() => document.getElementById('scr-pause').hidden);
      await waitPlayActive(page);
      ok(`${name}: pause (❚❚ Pause) and resume work`);

      // hint: shows a routing hint through the visible Hint button
      await page.click('#btn-hint');
      await page.waitForFunction(() => {
        const bar = document.getElementById('hint-bar');
        const txt = document.getElementById('hint-text')?.textContent || '';
        return !bar.hidden && /Hint:/.test(txt);
      });
      const hintTxt = (await page.textContent('#hint-text')).trim();
      await page.screenshot({ path: SHOT('hint', name) });
      ok(`${name}: hint button shows a routing hint ("${hintTxt}")`);

      // draw a random strand fully, then Undo it, then redraw it — verifies
      // undo restores the previous board state through the visible button.
      const first = reelStrand(page, 0, lvl.strands[0], { tap });
      await first;
      const afterReel = await readProgress(page);
      if (afterReel.reeled !== 1) throw new Error(`expected 1/3 reeled after first strand, got ${JSON.stringify(afterReel)}`);
      await page.click('#btn-undo');
      await page.waitForFunction(() => {
        const m = (document.getElementById('hud-progress')?.textContent || '').match(/(\d+)\/(\d+)/);
        return !!m && +m[1] === 0;
      }, null, { timeout: 4000 });
      ok(`${name}: undo restores the board (Reeled 1/3 -> 0/3)`);
      await reelStrand(page, 0, lvl.strands[0], { tap }); // redraw strand 0
      ok(`${name}: strand 0 re-routed and reeled after undo`);

      // solve the remaining strands for real
      for (let i = 1; i < lvl.strands.length; i++) {
        await reelStrand(page, i, lvl.strands[i], { tap });
      }
      const prog = await readProgress(page);
      if (!prog || prog.reeled !== prog.total) throw new Error(`round not fully reeled: ${JSON.stringify(prog)}`);

      // results screen
      await page.waitForSelector('#scr-results:not([hidden])', { timeout: 8000 });
      const headline = (await page.textContent('#results-h')).trim();
      if (!/Board complete/i.test(headline)) throw new Error(`unexpected results headline: "${headline}"`);
      const rows = await page.locator('#scr-results table.score-rows tr').count();
      const total = Number((await page.textContent('#sc-total')).trim());
      if (!Number.isFinite(total) || total <= 0) throw new Error(`bad score total: ${total}`);
      await page.screenshot({ path: SHOT('results', name) });
      ok(`${name}: board solved on the real board — results shown ("${headline}", ${rows} score rows, total ${total})`);

      // progression persisted (localStorage tt-progress-v1)
      const pr = await page.evaluate(() => {
        const raw = localStorage.getItem('tt-progress-v1');
        return raw ? JSON.parse(raw).data : null;
      });
      if (!pr) throw new Error('progress not persisted to localStorage');
      if (!pr.achievements?.['first-completion']) throw new Error('first-completion achievement not granted');
      if (!(pr.bestScores?.['practice-easy'] > 0)) throw new Error('best score not recorded');
      ok(`${name}: progress persisted (best ${pr.bestScores['practice-easy']}, first-completion granted)`);

      // restart via results Retry → a fresh practice board
      await page.click('#btn-retry');
      await waitPlayActive(page);
      const rp = await readProgress(page);
      if (!rp || rp.reeled !== 0) throw new Error(`restart did not reset the board: ${JSON.stringify(rp)}`);
      ok(`${name}: Retry starts a fresh board (Reeled 0/${rp.total})`);
    } else {
      // mobile: route + reel two strands via touchscreen.tap, keep it short
      for (let i = 0; i < 2; i++) {
        await reelStrand(page, i, lvl.strands[i], { tap });
      }
      const prog = await readProgress(page);
      if (!prog || prog.reeled < 2) throw new Error(`mobile expected 2/3 reeled, got ${JSON.stringify(prog)}`);
      await page.screenshot({ path: SHOT('mobile-play', name) });
      ok(`${name}: started practice and reeled 2 strands via touchscreen.tap`);
    }
  } finally {
    await context.close();
  }

  if (errors.length) throw new Error(`${name} pass had page errors:\n  ${errors.join('\n  ')}`);
  console.log(`ok - ${name}: no page errors`);
}

// ---------- main ----------
let browser = null;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  console.log(`serving ${ROOT} at ${BASE}`);
  await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } }, { full: true });
  await runPass(browser, 'mobile',
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, { full: false, tap: true });
  console.log('\nE2E PASS — tangled-threads, desktop + mobile, no page errors');
} catch (e) {
  failures++;
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
if (failures) process.exit(1);
