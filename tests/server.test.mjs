import { describe, it, expect, beforeAll, afterAll } from './expect.mjs';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';

let proc;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;

beforeAll(async () => {
  port = await new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  proc = spawn('node', ['server.cjs'], {
    env: { ...process.env, PORT: String(port), TT_DATA_DIR: `/tmp/tt-test-data-${process.pid}` },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base() + '/api/v1/time'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

afterAll(() => { proc?.kill(); });

describe('server smoke', () => {
  it('serves index.html and local assets', async () => {
    const idx = await fetch(base() + '/');
    expect(idx.status).toBe(200);
    const html = await idx.text();
    expect(html).toContain('Tangled Threads');
    expect(html).toContain('starhermit');
    for (const p of ['/native/main.ts', '/src/rules.js', '/src/content.js', '/src/session.js', '/starhermit.txt', '/starhermit-files.json']) {
      const r = await fetch(base() + p);
      expect(r.status, p).toBe(200);
    }
  });

  it('returns platform time and daily seed', async () => {
    const t = await (await fetch(base() + '/api/v1/time')).json();
    expect(Math.abs(t.epochMs - Date.now())).toBeLessThan(60000);
    const d = await (await fetch(base() + '/api/v1/daily')).json();
    expect(d.seed).toMatch(/^daily-\d{4}-\d{2}-\d{2}$/);
    expect(d.ranked).toBe(true);
  });

  it('validates score submissions through authoritative replay', async () => {
    const { generateLevel } = await import('../src/content.js');
    const { replay, createGame, hashState } = await import('../src/rules.js');
    const level = generateLevel('stage-1');
    const commands = [];
    let n = 0;
    for (let i = 0; i < level.strands.length; i++) {
      for (const cell of level.solution[i].slice(1)) commands.push({ id: 'c' + (++n), type: 'extend', strand: i, cell });
      commands.push({ id: 'c' + (++n), type: 'reel', strand: i });
    }
    const r = replay(level, commands);
    const env = {
      schemaVersion: 1, contentVersion: level.version, levelId: level.id, seed: level.id,
      sessionId: 'vitest-session-1', initialHash: hashState(createGame(level)),
      timestampOffset: 0, commands, stateHashes: [hashState(createGame(level)), ...r.hashes],
      elapsedMs: 5000, assists: { hints: 0 }, result: r.state.terminal, finalHash: r.hashes[r.hashes.length - 1],
    };
    const res = await fetch(base() + '/api/v1/score', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(body.rank).toBeGreaterThanOrEqual(1);

    // Idempotent resubmission.
    const res2 = await fetch(base() + '/api/v1/score', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env),
    });
    expect(res2.status).toBe(200);

    // Tampered commands are rejected.
    const bad = { ...env, sessionId: 'vitest-cheat', commands: env.commands.slice(0, -1) };
    const rb = await fetch(base() + '/api/v1/score', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad),
    });
    expect(rb.status).toBe(422);

    // Practice is unranked.
    const rp = await fetch(base() + '/api/v1/score', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...env, levelId: 'practice-easy', sessionId: 'vitest-p' }),
    });
    expect(rp.status).toBe(422);
  });

  it('leaderboard reflects submissions', async () => {
    const r = await fetch(base() + '/api/v1/leaderboard?level=stage-1');
    const body = await r.json();
    expect(body.entries.some((e) => e.sessionId === 'vitest-session-1')).toBe(true);
  });

  it('achievements are idempotent', async () => {
    const post = () => fetch(base() + '/api/v1/achievements', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys: ['first-completion'] }),
    });
    const a = await (await post()).json();
    expect(a.delivered).toContain('first-completion');
    const b = await (await post()).json();
    expect(b.delivered).toEqual([]);
    expect(b.total).toBeGreaterThanOrEqual(1);
  });

  it('rejects malformed API input with structured errors', async () => {
    const r = await fetch(base() + '/api/v1/score', { method: 'POST', body: 'not json' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBeDefined();
    const r2 = await fetch(base() + '/api/v1/nope');
    expect(r2.status).toBe(404);
  });
});
