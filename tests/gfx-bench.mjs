// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts the hard practice board and keeps routing and reeling strands through the visible board
// buttons (the authored solution, read like the Hint button does), retrying from the results screen —
// strand tubes rebuild, reel sparks fly, the lamp shimmers and dust drifts the whole time.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };
const LEVEL = 'practice-hard';

export async function setPreset(page, preset) {
  await page.waitForSelector('#btn-title-settings:visible', { timeout: 20000 });
  await page.click('#btn-title-settings');
  await page.waitForFunction(() => !document.getElementById('scr-pause').hidden);
  await page.click('#tab-graphics');
  await page.waitForFunction(() => !document.getElementById('gfx-block').hidden);
  await page.selectOption('#sel-quality', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.click('#btn-resume');
  await page.waitForFunction(() => document.getElementById('scr-pause').hidden);
}

const readLevel = (page) => page.evaluate(async (id) => {
  const level = (await import('./src/content.js')).generateLevel(id);
  return level.strands.map((s, i) => ({ anchor: s.anchor, spool: s.spool, solution: level.solution[i].slice() }));
}, LEVEL);

const playing = (page) => page.evaluate(() => !document.getElementById('scr-board-mirror').hidden
  && (document.getElementById('hud-progress').textContent || '').includes('/'));

async function round(page, strands, alive) {
  const cell = (c) => page.locator(`#dom-board [data-cell="${c}"]`).click({ timeout: 3000 });
  for (const s of strands) {
    if (!alive()) return;
    await cell(s.anchor);
    for (let k = 1; k < s.solution.length && alive(); k++) { await cell(s.solution[k]); await page.waitForTimeout(60); }
    await cell(s.spool);
    await page.waitForTimeout(250);
  }
  await page.waitForSelector('#scr-results:not([hidden])', { timeout: 8000 });
  await page.waitForTimeout(400);
  await page.click('#btn-retry');
  await page.waitForFunction(() => !document.getElementById('scr-board-mirror').hidden, null, { timeout: 15000 });
}

export async function start(page) {
  await page.click('#btn-play');
  await page.waitForFunction(() => !document.getElementById('scr-modes').hidden);
  await page.locator('.mode-card[data-mode="practice"]').click();
  await page.waitForFunction(() => !document.getElementById('journey-list').hidden);
  await page.locator(`#journey-list .mode-card[data-level="${LEVEL}"]`).click();
  await page.waitForFunction(() => !document.getElementById('scr-board-mirror').hidden, null, { timeout: 15000 });
  const strands = await readLevel(page);
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try {
        if (await playing(page)) await round(page, strands, () => open);
        else await page.waitForTimeout(300);
      } catch (e) {
        if (!open) return;
        if (process.env.BENCH_DEBUG) console.error(e.message);
        await page.click('#btn-undo', { timeout: 1000 }).catch(() => {});
      }
    }
  })();
  await page.waitForTimeout(1500);
}
