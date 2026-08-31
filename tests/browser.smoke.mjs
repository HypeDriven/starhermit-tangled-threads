// CDP-driven browser smoke test: loads the game in headless Chrome,
// clicks Play, starts a stage, plays it to completion via dispatched actions,
// and asserts the results screen appears. Exits non-zero on failure.
const CDP_PORT = 19223;
const APP = process.env.APP_URL || 'http://127.0.0.1:18099/';
import { spawn } from 'node:child_process';

const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${CDP_PORT}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('chrome not reachable');
}

let idSeq = 0;
const pending = new Map();
let ws;
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++idSeq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaljs(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result?.value;
}

const consoleErrors = [];

async function main() {
  ws = new WebSocket(await getWsUrl());
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg.result); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(JSON.stringify(msg.params.exceptionDetails).slice(0, 300));
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') consoleErrors.push(msg.params.args?.map((a) => a.value).join(' '));
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: APP });
  await sleep(2500);

  const check = async (label, expr) => {
    const v = await evaljs(expr);
    if (!v) throw new Error('CHECK FAILED: ' + label + ' | console: ' + consoleErrors.join(' | '));
    console.log('ok:', label);
  };

  await check('title screen visible', `!document.getElementById('scr-title').hidden`);
  await check('webgl renderer created', `!!document.querySelector('#game-canvas')`);

  // Play -> mode select -> journey -> stage 1.
  await evaljs(`document.getElementById('btn-play').click()`);
  await check('mode select visible', `!document.getElementById('scr-modes').hidden`);
  await evaljs(`document.querySelector('.mode-card[data-mode="journey"]').click()`);
  await sleep(200);
  await evaljs(`[...document.querySelectorAll('#journey-list .mode-card')][0].click()`);
  await sleep(800);
  await check('HUD visible after start', `!document.getElementById('hud').hidden`);

  // Complete the board programmatically through the real UI path (DOM mirror clicks).
  const done = await evaljs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const mod = await import('./src/content.js');
    const level = mod.generateLevel('stage-1');
    for (let i = 0; i < level.strands.length; i++) {
      // select strand via its anchor cell button
      const anchor = level.strands[i].anchor;
      document.querySelector('#dom-board [data-cell="' + anchor + '"]').click();
      await sleep(30);
      for (const cell of level.solution[i].slice(1)) {
        document.querySelector('#dom-board [data-cell="' + cell + '"]').click();
        await sleep(30);
      }
      // reel via spool tap
      document.querySelector('#dom-board [data-cell="' + level.strands[i].spool + '"]').click();
      await sleep(30);
    }
    return !document.getElementById('scr-results').hidden;
  })()`);
  if (!done) throw new Error('results screen did not appear');
  console.log('ok: full board completed via DOM mirror, results shown');

  const total = await evaljs(`document.getElementById('sc-total').textContent`);
  console.log('ok: score total =', total);
  if (!Number(total) > 0) throw new Error('bad score total');

  // Keyboard: start a new stage and check cursor + pause/resume.
  await evaljs(`document.getElementById('btn-retry').click()`);
  await sleep(500);
  await evaljs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))`);
  await evaljs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await check('pause screen on Esc', `!document.getElementById('scr-pause').hidden`);
  await evaljs(`document.getElementById('btn-resume').click()`);
  await check('resume works', `document.getElementById('scr-pause').hidden`);

  // Help screen.
  await evaljs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await evaljs(`document.getElementById('btn-leave').click()`);
  await sleep(200);
  await evaljs(`document.getElementById('btn-title-help').click()`);
  await check('help screen has rule cards', `document.querySelectorAll('#scr-help .rule-card').length >= 5`);

  if (consoleErrors.length) throw new Error('console errors: ' + consoleErrors.join(' | '));
  console.log('BROWSER SMOKE TEST PASSED');
}

main().then(() => { chrome.kill(); process.exit(0); })
  .catch((e) => { console.error(e.message); chrome.kill(); process.exit(1); });
