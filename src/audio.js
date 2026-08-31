// Tangled Threads — WebAudio: buses (music/effects/ambience/voice), event mapping,
// seeded pitch variants, focus/background behavior. All synthesis is original.

import { mulberry32, seedFromString } from './rules.js';

let ctx = null;
const buses = {}; // name -> GainNode -> master
let master = null;
let started = false;
let ambienceNodes = null;
let musicTimer = null;
const volumes = { music: 0.5, effects: 0.8, ambience: 0.4, voice: 0.8 };
const rand = mulberry32(seedFromString('tt-audio-v1'));

function ensure() {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  } catch { return null; }
  master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);
  for (const name of Object.keys(volumes)) {
    const g = ctx.createGain();
    g.gain.value = volumes[name];
    g.connect(master);
    buses[name] = g;
  }
  return ctx;
}

export function startAudio() {
  const c = ensure();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  if (!started) {
    started = true;
    startAmbience();
    startMusic();
  }
  requestManifest();
}

/* Authored sample one-shots (sfx/manifest.json). Fetched/decoded lazily after the
   user-gesture unlock in startAudio(); each event prefers a mapped sample and falls
   back to the procedural synthesis below while loading or on failure.
   `event` in the manifest is the sfx method name (e.g. "select" -> sfx.select). */
const sampleEvents = new Map(); // event -> [basename, ...]
const sampleBuffers = new Map(); // basename -> AudioBuffer
const sampleFailed = new Set(); // basename (fetch/decode failed)
const sampleLoading = new Map(); // basename -> Promise
let manifestRequested = false;

function requestManifest() {
  if (manifestRequested || !ctx) return;
  manifestRequested = true;
  fetch('sfx/manifest.json')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('sfx manifest'))))
    .then((list) => {
      if (!Array.isArray(list)) return;
      for (const item of list) {
        if (!item || typeof item.name !== 'string' || typeof item.event !== 'string') continue;
        if (!sampleEvents.has(item.event)) sampleEvents.set(item.event, []);
        sampleEvents.get(item.event).push(item.name);
      }
    })
    .catch(() => {});
}

function loadSample(name) {
  if (sampleBuffers.has(name) || sampleFailed.has(name)) return;
  if (sampleLoading.has(name)) return;
  const p = fetch(`sfx/${name}.opus`)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('sfx fetch'))))
    .then((ab) => ctx.decodeAudioData(ab))
    .then((buf) => { sampleBuffers.set(name, buf); })
    .catch(() => { sampleFailed.add(name); })
    .finally(() => { sampleLoading.delete(name); });
  sampleLoading.set(name, p);
}

// Plays a mapped sample through the effects bus; returns false when no decoded
// sample is ready yet, so the caller can run its procedural fallback.
function playEventSample(event) {
  if (!ctx || !started) return false;
  const names = sampleEvents.get(event);
  if (!names || !names.length) return false;
  const name = names[Math.floor(rand() * names.length)];
  const buf = sampleBuffers.get(name);
  if (!buf) { loadSample(name); return false; }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(buses.effects || master);
  src.start();
  return true;
}

export function suspendAudio() {
  if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
}

export function resumeAudio() {
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}

export function setBusVolume(bus, v) {
  volumes[bus] = Math.max(0, Math.min(1, v));
  if (buses[bus]) buses[bus].gain.value = volumes[bus];
}

export function getBusVolume(bus) { return volumes[bus] ?? 0.5; }

function tone(bus, freq, dur, gain, type = 'sine', slideTo = null) {
  const c = ensure();
  if (!c || !started) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, c.currentTime);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, c.currentTime + dur);
  g.gain.setValueAtTime(gain, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
  osc.connect(g); g.connect(buses[bus] || master);
  osc.start(); osc.stop(c.currentTime + dur + 0.02);
}

// Seeded pitch variant so replays sound identical.
function vary(freq) { return freq * (1 + (rand() - 0.5) * 0.06); }

/* Event hierarchy: input ack < legal move < goal < round completion. */
export const sfx = {
  select: () => { if (playEventSample('select')) return; tone('effects', vary(660), 0.07, 0.18, 'sine'); },
  deselect: () => { if (playEventSample('deselect')) return; tone('effects', vary(440), 0.06, 0.12, 'sine'); },
  extend: () => { if (playEventSample('extend')) return; tone('effects', vary(520), 0.09, 0.22, 'triangle', 580); },
  retract: () => { if (playEventSample('retract')) return; tone('effects', vary(390), 0.08, 0.16, 'triangle', 330); },
  invalid: () => { if (playEventSample('invalid')) return; tone('effects', 150, 0.14, 0.22, 'square'); },
  reel: () => {
    if (playEventSample('reel')) return;
    tone('effects', vary(660), 0.12, 0.24, 'sine', 990); setTimeout(() => tone('effects', 990, 0.14, 0.2, 'sine', 1320), 90);
  },
  complete: () => {
    if (playEventSample('complete')) return;
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => setTimeout(() => tone('music', f, 0.3, 0.25, 'sine'), i * 120));
  },
  fail: () => { if (playEventSample('fail')) return; tone('music', 330, 0.3, 0.2, 'sine', 220); },
  uiClick: () => { if (playEventSample('uiClick')) return; tone('effects', 500, 0.05, 0.12, 'sine'); },
};

/* Quiet ambience: two detuned low oscillators through a slow LFO. */
function startAmbience() {
  const c = ctx;
  if (!c || ambienceNodes) return;
  const o1 = c.createOscillator(); o1.type = 'sine'; o1.frequency.value = 82;
  const o2 = c.createOscillator(); o2.type = 'sine'; o2.frequency.value = 123.5;
  const g = c.createGain(); g.gain.value = 0.05;
  const lfo = c.createOscillator(); lfo.frequency.value = 0.07;
  const lfoG = c.createGain(); lfoG.gain.value = 0.02;
  lfo.connect(lfoG); lfoG.connect(g.gain);
  o1.connect(g); o2.connect(g); g.connect(buses.ambience);
  o1.start(); o2.start(); lfo.start();
  ambienceNodes = { o1, o2, g, lfo };
}

/* Adaptive music stem: sparse pentatonic plucks, denser near completion. */
let musicIntensity = 0; // 0..1 set by gameplay progress
export function setMusicIntensity(v) { musicIntensity = Math.max(0, Math.min(1, v)); }

function startMusic() {
  if (musicTimer) return;
  const scale = [262, 294, 330, 392, 440, 523];
  const tick = () => {
    if (started && ctx && ctx.state === 'running' && rand() < 0.35 + musicIntensity * 0.4) {
      tone('music', scale[Math.floor(rand() * scale.length)], 0.5, 0.06, 'sine');
    }
    musicTimer = setTimeout(tick, 1400 - musicIntensity * 500);
  };
  tick();
}
