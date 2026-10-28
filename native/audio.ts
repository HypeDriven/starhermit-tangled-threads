// Sound, as the browser build's src/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event, each event picking
// one of its clips with audio.js's seeded random stream; the quiet ambience
// (sines at 82 and 123.5 Hz, gain 0.05 swayed ±0.02 by a slow LFO); and the
// adaptive music stem (sparse pentatonic plucks, denser and quicker as more
// strands are reeled). The ambience is rendered once into a 14-second clip
// that loops without a seam (both tones and the LFO — 1/14 Hz for the old
// 0.07 — complete whole cycles in it; a slice a frame, from a sine table) and
// plays on the music bus — the runtime has no ambience bus — at the old
// ambience-to-music ratio (0.4 / 0.5). The six pluck notes are rendered into
// clips the same way and started on the old timer. The synthesized
// fallbacks audio.js played while a sample decoded are not ported (a live
// synthesis graph makes clip loads fail on the web runtime): a clip still
// loading is silent. The runtime's Options own the volumes and the mute
// (the old voice/cue bus carried nothing). Clips load once the mixer runs
// (natively at once, in a browser after the first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
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
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wanted = false;
let suspended = false;

/** audio.js startAudio: ask for the clips, the ambience and the music (they start once the mixer runs). */
export function start(): void { wanted = true; }

export function play(ev: Sfx): void {
  if (suspended) return;
  const names = SAMPLES[ev]!;
  const name = names[Math.floor(rand() * names.length)]!;
  const clip = clips.get(name);
  if (!clip) return;
  try { playClip(clip, { bus: ev === "uiClick" ? "interface" : "effects" }); } catch { clips.delete(name); if (!queue.includes(name)) queue.push(name); }
}

// -- synthesis into clips ----------------------------------------------------------------------
const RATE = 22050;
const SINE_N = 4096;
const SINE = new Float32Array(SINE_N + 1);
for (let i = 0; i <= SINE_N; i++) SINE[i] = Math.sin((2 * Math.PI * i) / SINE_N);
/** sin(2π·phase), phase in cycles. */
function sin1(phase: number): number {
  const p = (phase - Math.floor(phase)) * SINE_N, i = p | 0, f = p - i;
  return SINE[i]! + (SINE[i + 1]! - SINE[i]!) * f;
}
const AMB_N = RATE * 14;
const amb = new Float32Array(AMB_N);
let ambPos = 0;
function renderAmbience(count: number): boolean {
  const end = Math.min(AMB_N, ambPos + count);
  for (; ambPos < end; ambPos++) {
    const t = ambPos / RATE;
    const gain = 0.05 + 0.02 * sin1(t / 14);
    amb[ambPos] = (sin1(82 * t) + sin1(123.5 * t)) * gain;
  }
  return ambPos >= AMB_N;
}
/** audio.js startMusic's scale and tone('music', f, 0.5, 0.06, 'sine'): gain 0.06 falling exponentially to 0.0001 over 0.5 s. */
const SCALE = [262, 294, 330, 392, 440, 523];
const NOTE_N = Math.round(RATE * 0.52);
function renderNote(f: number): Float32Array {
  const out = new Float32Array(NOTE_N);
  const k = Math.log(0.0001 / 0.06) / 0.5;
  for (let i = 0; i < NOTE_N; i++) {
    const t = i / RATE;
    out[i] = sin1(f * t) * 0.06 * Math.exp(k * Math.min(t, 0.5)) * (t > 0.5 ? Math.max(0, 1 - (t - 0.5) / 0.02) : 1);
  }
  return out;
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

/** Each frame: the clips once the mixer runs (one at a time), then the ambience and the music. */
export function update(dt: number): void {
  if (!wanted || context.state !== "running") return;
  if (!queue.length && !clips.size && !loading) for (const list of Object.values(SAMPLES)) for (const n of list) queue.push(n);
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => {
        console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`);
        loading = false;
      });
    }
    return;
  }
  if (loading) return;
  if (!ambClip) {
    if (!renderAmbience(20000)) return;
    try { ambClip = createClip([amb], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); ambPos = 0; }
    return;
  }
  if (!ambVoice) {
    try { ambVoice = playClip(ambClip, { bus: "music", gain: suspended ? 0 : AMB_GAIN, loop: true }); } catch { ambVoice = null; }
    return;
  }
  if (notes.length < SCALE.length) {
    try { notes.push(createClip([renderNote(SCALE[notes.length]!)], RATE)); } catch (e) { console.warn(`audio: ${String(e)}`); }
    return;
  }
  // audio.js startMusic's tick: every 1400 − 500·intensity ms, a pluck with probability 0.35 + 0.4·intensity
  musicIn -= dt * 1000;
  if (musicIn > 0) return;
  musicIn = 1400 - intensity * 500;
  if (!suspended && rand() < 0.35 + intensity * 0.4) {
    try { playClip(notes[Math.floor(rand() * notes.length)]!, { bus: "music" }); } catch { /* busy */ }
  }
}
