/**
 * Generates build/icon.png (256×256 app icon) programmatically — no binary
 * assets in source control. Minimal PNG encoder (RGBA, zlib IDAT).
 * Design: charcoal rounded square, cyan EQ-bar mark — matches the UI theme.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const S = 256;
const img = Buffer.alloc(S * S * 4);

const lerp = (a, b, t) => a + (b - a) * t;

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    // rounded-rect mask
    const r = 56;
    const cx = Math.max(r, Math.min(S - r, x));
    const cy = Math.max(r, Math.min(S - r, y));
    const inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= r && x < S - r) || (y >= r && y < S - r);
    const corner =
      (x < r && y < r && (x - r) ** 2 + (y - r) ** 2 > r * r) ||
      (x >= S - r && y < r && (x - (S - r)) ** 2 + (y - r) ** 2 > r * r) ||
      (x < r && y >= S - r && (x - r) ** 2 + (y - (S - r)) ** 2 > r * r) ||
      (x >= S - r && y >= S - r && (x - (S - r)) ** 2 + (y - (S - r)) ** 2 > r * r);
    if (corner || !inside) {
      img[i + 3] = 0;
      continue;
    }
    // diagonal gradient: deep teal → cyan
    const t = (x / S) * 0.55 + (y / S) * 0.45;
    let R = lerp(0x0b, 0x22, t);
    let G = lerp(0x3a, 0xd3, t);
    let B = lerp(0x4d, 0xee, t);

    // EQ bars mark (three vertical rounded bars, separated clearly)
    const bars = [
      { x0: 66, w: 22, top: 118, bot: 180 },
      { x0: 117, w: 22, top: 72, bot: 180 },
      { x0: 168, w: 22, top: 96, bot: 180 }
    ];
    for (const b of bars) {
      const bx = Math.max(b.x0, Math.min(b.x0 + b.w, x));
      const by = Math.max(b.top, Math.min(b.bot, y));
      const d2 = (x - bx) ** 2 + (y - by) ** 2;
      const inBar =
        (x >= b.x0 && x < b.x0 + b.w && y >= b.top && y < b.bot) ||
        d2 <= 64; // rounded caps r=8
      if (inBar) {
        R = 0xec;
        G = 0xfe;
        B = 0xff;
      }
    }
    img[i] = R | 0;
    img[i + 1] = G | 0;
    img[i + 2] = B | 0;
    img[i + 3] = 255;
  }
}

mkdirSync(path.resolve('build'), { recursive: true });
writeFileSync(path.resolve('build/icon.png'), writePng(S, S, img));
console.log('build/icon.png generated (256x256)');
