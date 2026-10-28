// Bakes the browser build's procedural textures (src/render.js textures():
// wood grain, fine wood, wood bump, felt, yarn plies, wound thread, the soft
// dot) into assets/tex/*.png at each texture budget the presets use (128,
// 256, 512 px for the wood; felt ½, yarn and thread ¼, at least 16 px), with
// render.js's noise and formulas unchanged. Per-pixel painting is far too
// slow in the engine's interpreter, so the game loads these instead.
// The bump maps were the same values as the colour maps (felt, yarn, thread),
// so one file serves both; the wood's bump has its own stronger grain.
//   node tools/bake-textures.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'tex');
mkdirSync(out, { recursive: true });

// ---- render.js, verbatim
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function makeNoise(seed, nx, ny = nx) {
  const r = rng(seed); const g = new Float32Array(nx * ny).map(() => r());
  const at = (x, y) => g[((y % ny + ny) % ny) * nx + ((x % nx + nx) % nx)];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return (at(xi, yi) * (1 - u) + at(xi + 1, yi) * u) * (1 - v) + (at(xi, yi + 1) * (1 - u) + at(xi + 1, yi + 1) * u) * v;
  };
}
const n1 = makeNoise(11, 4, 8), n2 = makeNoise(29, 16, 64);
const woodVal = (x, y, amt) => {
  const u = x / 256, v = y / 256;
  const warp = n1(u * 4, v * 8) * 1.5;
  const ring = 0.5 + 0.5 * Math.sin((v * 16 + warp) * Math.PI * 2);
  const fibre = n2(u * 16, v * 64) - 0.5;
  return 1 - amt * (0.55 * Math.pow(ring, 4) + 0.45 * (0.5 + fibre));
};
const f1 = makeNoise(5, 64), f2 = makeNoise(7, 16);
const feltVal = (x, y) => 0.86 + 0.1 * f1(x / 2, y / 2) + 0.06 * f2(x / 8, y / 8);
const yarnVal = (x, y) => { const s = 0.5 + 0.5 * Math.sin(((x / 64) * 2 + (y / 64) * 3) * Math.PI * 2); return 0.72 + 0.28 * Math.pow(s, 0.7); };
const threadVal = (x, y) => 0.78 + 0.22 * Math.pow(0.5 + 0.5 * Math.sin((y / 64 * 18 + x / 64 * 0.5) * Math.PI * 2), 0.6);

// ---- PNG
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(name, w, h, fn, alpha = false) {
  const ch = alpha ? 4 : 3, raw = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * ch + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const px = fn(x, y), o = y * (w * ch + 1) + 1 + x * ch;
      for (let k = 0; k < ch; k++) raw[o + k] = Math.max(0, Math.min(255, Math.round(px[k] * 255)));
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  writeFileSync(join(out, name + '.png'), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
}

for (const n of [128, 256, 512]) {
  const k = n / 256, px = (w) => Math.max(16, Math.round(w * k));
  const W = px(256), sw = (fn) => (x, y) => fn(x * 256 / W, y * 256 / W);
  png(`wood-${n}`, W, W, sw((x, y) => { const v = woodVal(x, y, 0.22); return [v, v * 0.98, v * 0.95]; }));
  png(`wood-fine-${n}`, W, W, sw((x, y) => { const v = woodVal(x, y, 0.12); return [v, v * 0.985, v * 0.965]; }));
  png(`wood-bump-${n}`, W, W, sw((x, y) => { const v = woodVal(x, y, 0.5); return [v, v, v]; }));
  const F = px(128), sf = (fn) => (x, y) => fn(x * 128 / F, y * 128 / F);
  png(`felt-${n}`, F, F, sf((x, y) => { const v = feltVal(x, y); return [v, v, v]; }));
  const Y = px(64), sy = (fn) => (x, y) => fn(x * 64 / Y, y * 64 / Y);
  png(`yarn-${n}`, Y, Y, sy((x, y) => { const v = yarnVal(x, y); return [v, v, v]; }));
  png(`thread-${n}`, Y, Y, sy((x, y) => { const v = threadVal(x, y); return [v, v, v]; }));
}
// The motes' soft dot: render.js used it as map and alphaMap (colour k, alpha k).
png('dot', 32, 32, (x, y) => { const d = Math.hypot(x - 15.5, y - 15.5) / 16; const k = Math.max(0, 1 - d) ** 2; return [k, k, k, k]; }, true);
console.log('baked', out);
