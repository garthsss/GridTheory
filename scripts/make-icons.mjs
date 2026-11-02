// Draws the app icons (the 2×2 grid mark) as PNGs, with no image dependencies. Output goes to public/icons.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BACKGROUND = [20, 23, 27];
const ACCENT = [244, 183, 64];
const TILE = [50, 56, 65];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, check]);
}

/** `inset` is the margin as a fraction of the icon. Maskable icons need a wide margin, because platforms crop them. */
function draw(size, inset) {
  const start = Math.round(size * inset);
  const end = size - start;
  const middle = Math.round(size / 2);
  const gap = Math.max(1, Math.round(size * 0.012));
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    for (let x = 0; x < size; x++) {
      let color = BACKGROUND;
      if (x >= start && x < end && y >= start && y < end && Math.abs(x - middle) >= gap && Math.abs(y - middle) >= gap) {
        color = (x < middle) === (y < middle) ? ACCENT : TILE;
      }
      raw.set(color, row + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = new URL('../public/icons/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('icon-192.png', out), draw(192, 0.16));
writeFileSync(new URL('icon-512.png', out), draw(512, 0.16));
writeFileSync(new URL('maskable-512.png', out), draw(512, 0.26));
writeFileSync(new URL('apple-touch-icon.png', out), draw(180, 0.16));
