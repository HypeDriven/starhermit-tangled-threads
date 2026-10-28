// Plays the web package in Chrome on the machine's GPU (~/games/tools/
// gpu-chrome.mjs; GPU_ADAPTER=software for headless SwiftShader), the loader
// index.html that `npm run package` writes, at a desktop viewport, a phone
// (DPR 3) and a phone held sideways (DPR 3): on the desktop Journey stage 1
// is won with the mouse on the 3D board (clicks select and reel, drags
// route), a pause by Escape, and stage 2 by mouse on the board mirror's
// cells; on the phone the Learn board by finger on the mirror and Journey
// stage 1 by finger swipes on the board; sideways Practice (easy) by finger
// on the mirror. Widgets are found through the page's accessibility mirror
// of the engine's UI; board points are the cells' centres measured natively
// (render.ts cellScreen) for these viewports. Screenshots of each step go to
// --shots. Fails on console errors or warnings, the runtime's error screen,
// or a view that does not finish.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { generateLevel } from '../src/content.js';
import { createGame, applyAction } from '../src/rules.js';
import { cellLabel } from './gen-plays.mjs';
const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const views = [
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
];
/** Stage 1's cells on the board (CSS px) per view: [[x, y] of each solution cell]. */
const STAGE1 = {
  desktop: [[[575, 227], [572, 335], [569, 454], [711, 454], [853, 454]], [[863, 584], [714, 584], [566, 584], [417, 584]], [[445, 227], [437, 335], [427, 454]]],
  phone: [[[163, 356], [162, 409], [161, 466], [229, 466], [296, 466]], [[300, 527], [230, 527], [160, 527], [90, 527]], [[100, 356], [97, 409], [94, 466]]],
};

const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
let failed = false;
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const cdp = v.hasTouch ? await ctx.newCDPSession(page) : null;
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    const platformRoute = /\/api\//.test(m.location()?.url ?? '');
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text()) && !platformRoute) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
  await page.waitForTimeout(4000);
  const shot = async (name) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${name}.png`) }); } };
  const find = (name) => page.getByRole('button', { name, exact: true }).or(page.getByRole('checkbox', { name, exact: true })).or(page.getByText(name, { exact: true })).first();
  /** A tap / click at window coordinates (CSS px). */
  const tapAt = async (x, y) => {
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  /** A press on a widget (or a table target): the mouse on the desktop, a finger on the phones. */
  const press = async (name) => {
    const el = find(name);
    await el.waitFor({ timeout: 15000 });
    const b = await el.boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  let reached = false;
  const results = async () => { await page.getByText('Board complete!', { exact: true }).first().waitFor({ timeout: 60000 }); await page.waitForTimeout(600); };
  const inRound = async () => { await page.getByText(/^Reeled 0\//).first().waitFor({ timeout: 60000 }); await page.waitForTimeout(2500); };
  const openMode = async (re) => { await press('Play'); await page.waitForTimeout(500); const b = page.getByRole('button', { name: re }).first(); await b.waitFor({ timeout: 15000 }); const bb = await b.boundingBox(); await tapAt(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.waitForTimeout(500); };
  const pickLevel = async (re) => { const b = page.getByRole('button', { name: re }).first(); await b.waitFor({ timeout: 15000 }); await b.scrollIntoViewIfNeeded().catch(() => {}); const bb = await b.boundingBox(); await tapAt(bb.x + bb.width / 2, bb.y + bb.height / 2); };
  /** A straight drag (mouse) or swipe (finger) in `steps` moves. */
  const dragTo = async ([x1, y1], [x2, y2], steps = 12) => {
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1, id: 1 }] });
      for (let i = 1; i <= steps; i++) { await page.waitForTimeout(30); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps, id: 1 }] }); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await page.mouse.move(x1, y1); await page.mouse.down();
      for (let i = 1; i <= steps; i++) { await page.waitForTimeout(30); await page.mouse.move(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps); }
      await page.mouse.up();
    }
    await page.waitForTimeout(400);
  };
  /** Stage 1 on the 3D board: select the anchor, drag along the solution's straight legs, press the spool to reel. */
  const boardStage1 = async (pts) => {
    const legs = [[[0, 2], [2, 4]], [[0, 3]], [[0, 2]]];
    for (let i = 0; i < 3; i++) {
      await tapAt(...pts[i][0]); await page.waitForTimeout(300);
      for (const [a, b] of legs[i]) await dragTo(pts[i][a], pts[i][b]);
      await tapAt(...pts[i][pts[i].length - 1]); await page.waitForTimeout(500);
    }
  };
  /** A level by presses on the board mirror's cells (named as ui.js named them). */
  const mirrorLevel = async (id) => {
    const lv = generateLevel(id);
    let st = createGame(lv);
    for (let i = 0; i < lv.solution.length; i++) {
      const sol = lv.solution[i];
      await press(cellLabel(st, sol[0]));
      for (let k = 1; k < sol.length; k++) { await press(cellLabel(st, sol[k])); st = applyAction(st, { type: 'extend', strand: i, cell: sol[k] }); }
      await press(cellLabel(st, sol[sol.length - 1])); st = applyAction(st, { type: 'reel', strand: i });
    }
  };
  try {
    await shot('title');
    if (v.name === 'desktop') {
      await openMode(/^Journey\./);
      await pickLevel(/^Stage 1,/);
      await inRound();
      await shot('stage-1');
      await boardStage1(STAGE1.desktop);
      await results();
      await shot('stage-1-results');
      await press('Next');
      await inRound();
      await page.keyboard.press('Escape');
      await find('Resume').waitFor({ timeout: 15000 });
      await page.waitForTimeout(500);
      await shot('pause');
      await press('Resume');
      await page.waitForTimeout(500);
      await mirrorLevel('stage-2');
      await results();
      await shot('stage-2-results');
    } else if (v.name === 'phone') {
      await openMode(/^Learn\./);
      await press('Start');
      await inRound();
      await shot('learn');
      await mirrorLevel('tutorial');
      await results();
      await shot('learn-results');
      await press('Home');
      await page.waitForTimeout(800);
      await openMode(/^Journey\./);
      await pickLevel(/^Stage 1,/);
      await inRound();
      await shot('stage-1');
      await boardStage1(STAGE1.phone);
      await results();
      await shot('stage-1-results');
    } else {
      await openMode(/^Practice\./);
      await pickLevel(/^Practice \(easy\),/);
      await inRound();
      await shot('practice');
      await mirrorLevel('practice-easy');
      await results();
      await shot('practice-results');
    }
    reached = true;
  } catch (e) { problems.push(`play: ${String(e.message || e).split('\n')[0]}`); await shot('failed'); }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state === 'running' && problems.length === 0 && reached;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'} played=${reached}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);
