// Tangled Threads — the engine client's save model. Pure (no storage, no
// platform) so the engine client (native/platform.ts) and the node tests
// share it.
//
// The engine save (starhermit:storage `saves`, schema 1) is
//   { v: 1, progress: { version, stagesDone, dailiesDone, challengesDone,
//     achievements, daysPlayed, bestScores }, tutorialDone }
// — the progression the browser build kept in localStorage (tt-progress-v1)
// and, with its settings, mirrored to the cloud slot game:<slug> through the
// JS SDK's saveJSON as { v: 1, data: { settings, progress }, check }. Two
// saves merge as the browser build merged on its saveconflict (platform.js
// mergeProgress: best score per board, union of days, earliest unlock per
// achievement). readForeign() reads that old cloud slot's text.

const obj = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});

/** ui.js checksum (djb2 of the JSON, base 36). */
export function checksum(data) {
  const s = JSON.stringify(data);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function emptyProgress() {
  return { version: 1, stagesDone: {}, dailiesDone: {}, challengesDone: {}, achievements: {}, daysPlayed: {}, bestScores: {} };
}
export function emptySave() { return { v: 1, progress: emptyProgress(), tutorialDone: false }; }

function numMap(m) {
  const out = {};
  for (const [k, v] of Object.entries(obj(m))) { const n = Number(v); if (Number.isFinite(n)) out[k] = n; }
  return out;
}
function maxMap(a, b) {
  const out = { ...numMap(a) };
  for (const [k, n] of Object.entries(numMap(b))) out[k] = k in out ? Math.max(out[k], n) : n;
  return out;
}

/** A progression from anything (missing or broken fields from the empty one). */
export function normalizeProgress(raw) {
  const p = obj(raw);
  const days = {};
  for (const [k, v] of Object.entries(obj(p.daysPlayed))) if (v) days[k] = true;
  return {
    version: Math.max(1, Number(p.version) || 1),
    stagesDone: numMap(p.stagesDone), dailiesDone: numMap(p.dailiesDone), challengesDone: numMap(p.challengesDone),
    achievements: numMap(p.achievements), daysPlayed: days, bestScores: numMap(p.bestScores),
  };
}

/** platform.js mergeProgress: best score per board, union of days, earliest unlock per achievement. */
export function mergeProgress(a, b) {
  a = normalizeProgress(a); b = normalizeProgress(b);
  const achievements = { ...a.achievements };
  for (const [k, v] of Object.entries(b.achievements)) achievements[k] = achievements[k] ? Math.min(achievements[k], v) : v;
  return {
    version: Math.max(a.version, b.version),
    stagesDone: maxMap(a.stagesDone, b.stagesDone),
    dailiesDone: maxMap(a.dailiesDone, b.dailiesDone),
    challengesDone: maxMap(a.challengesDone, b.challengesDone),
    achievements,
    daysPlayed: { ...a.daysPlayed, ...b.daysPlayed },
    bestScores: maxMap(a.bestScores, b.bestScores),
  };
}

/** A save document from anything. */
export function normalize(raw) {
  const d = obj(raw);
  return { v: 1, progress: normalizeProgress(d.progress), tutorialDone: !!d.tutorialDone };
}

/** Merge two saves (this device's and another device's / the old cloud slot's). */
export function mergeSave(remote, local) {
  const r = normalize(remote), l = normalize(local);
  return { v: 1, progress: mergeProgress(r.progress, l.progress), tutorialDone: r.tutorialDone || l.tutorialDone };
}

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
/** Same content, whatever the key order. */
export function sameSave(a, b) { return stable(normalize(a)) === stable(normalize(b)); }

/**
 * The browser build's cloud slot text ({ v, data: { settings, progress },
 * check }, the checksum over data): { save, options } — the save from its
 * progress and settings.tutorialDone, the game's own options from its
 * settings — or null when it is not one (a broken checksum is refused, as
 * platform.js validDoc did).
 */
export function readForeign(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== 'object' || !doc.data || doc.check !== checksum(doc.data)) return null;
    const settings = obj(doc.data.settings);
    return {
      save: normalize({ progress: doc.data.progress, tutorialDone: settings.tutorialDone }),
      options: pickOptions(settings),
    };
  } catch { return null; }
}

/**
 * The game's own options (engine `settings`, synced with the account): the
 * colour-vision-safe palette and the left-handed tray. The browser build's
 * other preferences (volumes, graphics, reduced motion, high contrast,
 * larger text, haptics) are the runtime's Options now.
 */
export const DEFAULT_OPTIONS = { cvdPalette: false, leftHanded: false };
export const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);
/** platform.js PREF_KEYS: the browser build's settings KV keys. */
export const BROWSER_KEYS = ['volumes', 'graphics', 'reducedMotion', 'highContrast', 'cvdPalette', 'largeText', 'leftHanded', 'haptics', 'tutorialDone'];

/** Valid option values from anything. */
export function pickOptions(raw) {
  const r = obj(raw), out = {};
  if (typeof r.cvdPalette === 'boolean') out.cvdPalette = r.cvdPalette;
  if (typeof r.leftHanded === 'boolean') out.leftHanded = r.leftHanded;
  return out;
}

/** The browser build's settings KV (key → value) as { options, tutorialDone }. */
export function readLegacySettings(kv) {
  const k = obj(kv);
  return { options: pickOptions(k), tutorialDone: k.tutorialDone === true };
}
