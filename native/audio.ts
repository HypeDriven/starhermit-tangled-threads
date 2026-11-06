// Sound, as the browser build's src/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event, each event picking
// one of its clips (a SoundBank at random, never the same twice running); the quiet ambience
// (sines at 82 and 123.5 Hz, gain 0.05 swayed ±0.02 by a slow LFO); and the
// adaptive music stem (sparse pentatonic plucks, denser and quicker as more
// strands are reeled). The ambience is rendered once into a 14-second clip
// that loops without a seam (both tones and the LFO — 1/14 Hz for the old 0.07
// — complete whole cycles in it) and plays on the music bus — the runtime has no
// ambience bus — at the old ambience-to-music ratio (0.4 / 0.5). The six pluck
// notes are rendered into clips the same way (OfflineAudioContext) and started
// on the old timer. The synthesized fallbacks audio.js played while a sample
// decoded are not ported: a clip still loading is silent. The runtime's Options
// own the volumes and the mute (the old voice/cue bus carried nothing). Clips
// load and renders start at once; the beds wait for the first press and the
// mixer as before.
import { OfflineAudioContext, SoundBank, context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
import { mulberry32, seedFromString } from "../src/rules.js";

/** sfx/manifest.json: event → sample names. */
const SAMPLES: Record<string, string[]> = {
  select: ["strand-select", "strand-select-soft"],
  deselect: ["strand-release"],
  extend: ["thread-extend", "thread-extend-rasp"],
  retract: ["thread-retract", "thread-retract-soft"],
  invalid: ["invalid-move-knock"],
  reel: ["spool-reel", "spool-reel-quick"],
  complete: ["round-complete-chime"],
  fail: ["round-fail-thud"],
  uiClick: ["ui-click", "ui-click-soft"],
};
export type Sfx = "select" | "deselect" | "extend" | "retract" | "invalid" | "reel" | "complete" | "fail" | "uiClick";
const rand = (mulberry32 as (s: number) => () => number)((seedFromString as (s: string) => number)("tt-audio-v1"));
const banks = new Map<string, SoundBank>();
let wanted = false;
let suspended = false;

/** audio.js startAudio: ask for the clips, the ambience and the music (they start once the mixer runs). */
export function start(): void { wanted = true; }
/** Loads every clip and renders the ambience and the notes at once (onStart); a cue whose clips are still loading is skipped. */
export function loadSfx(): void {
  for (const [ev, names] of Object.entries(SAMPLES)) {
    void Promise.all(names.map((n) => loadClip(`sfx/${n}.opus`).catch((e: unknown) => { console.warn(`sfx ${n}: ${e instanceof Error ? e.message : String(e)}`); return null; }))).then((loaded) => {
      const list = loaded.filter((c) => c !== null);
      if (list.length) banks.set(ev, new SoundBank({ clips: list, bus: ev === "uiClick" ? "interface" : "effects" }));
    });
  }
  void renderSynthesis();
}

export function play(ev: Sfx): void {
  if (suspended) return;
  try { banks.get(ev)?.play(); } catch { /* the mixer is full this frame */ }
}

// -- synthesis into clips ----------------------------------------------------------------------
const RATE = 22050;
/** Sines at 82 and 123.5 Hz, gain 0.05 swayed ±0.02 by the 1/14 Hz LFO. */
async function renderAmbience(): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, RATE * 14, RATE);
  const g = off.createGain(); g.gain.value = 0.05;
  for (const f of [82, 123.5]) { const o = off.createOscillator(); o.frequency.value = f; o.connect(g); o.start(); }
  const lfo = off.createOscillator(); lfo.frequency.value = 1 / 14;
  const depth = off.createGain(); depth.gain.value = 0.02;
  lfo.connect(depth).connect(g.gain); lfo.start();
  g.connect(off.destination);
  return createClip(await off.startRendering());
}
/** audio.js startMusic's scale and tone('music', f, 0.5, 0.06, 'sine'): gain 0.06 falling exponentially to 0.0001 over 0.5 s. */
const SCALE = [262, 294, 330, 392, 440, 523];
async function renderNote(f: number): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(RATE * 0.52), RATE);
  const o = off.createOscillator(); o.frequency.value = f;
  const g = off.createGain();
  g.gain.setValueAtTime(0.06, 0); g.gain.exponentialRampToValueAtTime(0.0001, 0.5); g.gain.linearRampToValueAtTime(0, 0.52);
  o.connect(g).connect(off.destination); o.start();
  return createClip(await off.startRendering());
}
async function renderSynthesis(): Promise<void> {
  try {
    ambClip = await renderAmbience();
    for (const f of SCALE) notes.push(await renderNote(f));
  } catch (e) { console.warn(`audio: ${String(e)}`); }
}
const AMB_GAIN = 0.4 / 0.5;
let ambClip: AudioClip | null = null;
let ambVoice: Sound | null = null;
const notes: AudioClip[] = [];

/** A hidden window silences the game (audio.js suspendAudio). */
export function setSuspended(on: boolean): void {
  if (on === suspended) return;
  suspended = on;
  try { ambVoice?.fade(on ? 0 : AMB_GAIN, 0.2); } catch { /* gone */ }
}

let intensity = 0;
/** audio.js setMusicIntensity: 0…1, the share of strands reeled. */
export function setMusicIntensity(v: number): void { intensity = Math.max(0, Math.min(1, v)); }
let musicIn = 0;

/** Each frame: once the first press came and the mixer runs, the ambience and the music. */
export function update(dt: number): void {
  if (!wanted || context.state !== "running" || !ambClip) return;
  if (!ambVoice) {
    try { ambVoice = playClip(ambClip, { bus: "music", gain: suspended ? 0 : AMB_GAIN, loop: true }); } catch { ambVoice = null; }
    return;
  }
  if (notes.length < SCALE.length) return;
  // audio.js startMusic's tick: every 1400 − 500·intensity ms, a pluck with probability 0.35 + 0.4·intensity
  musicIn -= dt * 1000;
  if (musicIn > 0) return;
  musicIn = 1400 - intensity * 500;
  if (!suspended && rand() < 0.35 + intensity * 0.4) {
    try { playClip(notes[Math.floor(rand() * notes.length)]!, { bus: "music" }); } catch { /* busy */ }
  }
}
