// platform.test.js — the StarHermit adapter (src/platform.js) over
// starhermit-sdk.js with a stubbed fetch and launch hash: token read,
// nickname, cloud-save path game:<slug> round-trip, settings patch,
// controls, and no network standalone.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SDK = require('../starhermit-sdk.js');
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `x.${b64url({ sub: 'u-12345678', game_scope: 'threads-test', exp: Math.floor(Date.now() / 1000) + 3600 })}.y`;

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

async function setup(hash, hostname = 'threads-test.starhermit.com') {
  const calls = [], store = new Map();
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body, auth: init.headers?.Authorization });
    const path = url.split('?')[0];
    const json = (o) => new Response(JSON.stringify(o));
    if (path.endsWith('/profile')) return json({ nickname: 'Weaver' });
    if (path.includes('/cloud-saves/')) {
      if (init.method === 'PUT') { store.set(path, JSON.parse(init.body).dataBase64); return new Response(null, { status: 204 }); }
      return store.has(path) ? new Response(Buffer.from(store.get(path), 'base64')) : new Response(null, { status: 404 });
    }
    if (path.endsWith('/settings')) return init.method === 'PATCH' ? new Response(null, { status: 204 }) : json({ settings: { highContrast: true } });
    if (path.endsWith('/controls')) return json({ actions: [{ action: 'reel', codes: ['KeyE'] }] });
    return new Response(null, { status: 404 });
  };
  const location = { hash, search: '', pathname: '/', hostname };
  const win = { location, history: { state: null, replaceState: (_s, _t, u) => { location.hash = u.includes('#') ? u.slice(u.indexOf('#')) : ''; } } };
  globalThis.location = location;
  globalThis.localStorage = memStorage();
  globalThis.fetch = (...a) => fetch(...a);
  globalThis.StarHermit = SDK.create({ window: win, fetch });
  vi.resetModules();
  const mod = await import('../src/platform.js');
  const ui = await import('../src/ui.js');
  return { calls, sh: globalThis.StarHermit, location, mod, ui };
}

describe('StarHermit adapter', () => {
  beforeEach(() => { if (globalThis.StarHermit) globalThis.StarHermit.signOut(); });

  it('reads the launch token, strips it and resolves the nickname', async () => {
    const { mod, sh, location } = await setup('#game_token=' + JWT);
    expect(mod.platform.hosted).toBe(true);
    expect(sh.slug).toBe('threads-test');
    expect(location.hash).toBe('');
    await mod.platform.init();
    await new Promise((r) => setTimeout(r, 10));
    expect(mod.platform.nickname).toBe('Weaver');
  });

  it('round-trips the cloud save through game:<slug> and adopts platform settings', async () => {
    const { mod, sh, calls, ui } = await setup('#game_token=' + JWT);
    const r = await mod.platform.init();
    expect(r.remoteLoaded).toBe(true); // platform settings adopted
    expect(ui.loadSettings().highContrast).toBe(true);
    ui.saveProgress({ ...ui.loadProgress(), stagesDone: { 'stage-1': 900 } });
    mod.platform.queueCloudSave();
    await mod.platform.flushCloudSave();
    const put = calls.filter((c) => c.method === 'PUT').pop();
    expect(put.url.endsWith('/api/v1/me/cloud-saves/' + encodeURIComponent('game:threads-test'))).toBe(true);
    expect(put.auth).toBe('Bearer ' + JWT);
    const doc = await sh.loadJSON();
    expect(doc.data.progress.stagesDone['stage-1']).toBe(900);
  });

  it('PATCHes changed preferences and applies control overrides', async () => {
    const { mod, calls, ui } = await setup('#game_token=' + JWT);
    await mod.platform.init();
    mod.platform.pushSettings({ ...ui.loadSettings(), largeText: true });
    await new Promise((r) => setTimeout(r, 900));
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch.url.endsWith('/api/v1/games/threads-test/settings')).toBe(true);
    expect(JSON.parse(patch.body)).toEqual({ settings: { largeText: true } });
    const b = await mod.platform.loadBindings();
    expect(b.reel).toEqual(['KeyE']);
    expect(b.undo).toEqual(['KeyU']);
    expect(mod.platform.inviteLink()).toMatch(/game-invite\/u-12345678\/threads-test$/);
  });

  it('makes no network calls standalone', async () => {
    const { mod, calls } = await setup('', 'example.com');
    const r = await mod.platform.init();
    expect(r.hosted).toBe(false);
    expect(mod.platform.canSignIn()).toBe(false);
    expect(mod.platform.inviteLink()).toBe(null);
    mod.platform.queueCloudSave();
    mod.platform.pushSettings({});
    expect((await mod.platform.loadBindings()).undo).toEqual(['KeyU']);
    await new Promise((r) => setTimeout(r, 900));
    expect(calls.length).toBe(0);
  });

  it('offers sign-in on the platform host without a token', async () => {
    const { mod, calls } = await setup('');
    expect(mod.platform.canSignIn()).toBe(true);
    expect(calls.length).toBe(0);
  });
});
