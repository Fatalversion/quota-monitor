/**
 * Placeholder app icons, generated rather than committed as opaque binaries.
 *
 * The mark is deliberately plain: a rounded square in the widget's green with
 * a light vertical bar in it, which is roughly what the collapsed strip looks
 * like on screen. Run `node generate-icons.mjs` from this directory to
 * regenerate every size after changing COLORS or GEOMETRY.
 *
 * No dependencies. PNG is written by hand (zlib comes from node:zlib), the ICO
 * is a classic 32bpp BGRA DIB container, the ICNS wraps the PNGs.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const COLORS = {
  /** Rounded square, in the widget's accent orange (--accent in panel.css). */
  square: [0xe8, 0x76, 0x3c, 0xff],
  /** The bars, in the widget's text cream (--text). */
  bar: [0xf7, 0xf4, 0xef, 0xff],
};

/*
 * THE MARK: two upright bars at different fills inside a rounded square.
 *
 * It is the collapsed rail, which is what this app actually looks like on
 * screen, and it says the one thing the app is for: two quotas, one of them
 * nearly gone. It is also our OWN artwork - see TRADEMARKS.md. A provider's
 * logo could never be the app icon, since using a vendor mark as your own
 * identity is the line every one of their policies draws.
 *
 * TWO bars, not three, and this is the whole design constraint. The tray icon
 * renders at 16px, where a third bar would be 2px wide with 1.6px gutters and
 * would smear into a smudge. At two, each bar is ~3px with a 2.2px gutter and
 * survives. Everything else here is chosen to keep that true: the fractions
 * below are what they are because 16 times them lands on something drawable.
 */
const GEOMETRY = {
  /** Corner radius as a fraction of the icon edge. */
  radius: 0.22,
  /** Inset of the square inside the canvas, as a fraction. */
  margin: 0.06,
  /**
   * Both bars sit on the same floor and differ only in height, so the mark
   * reads as a comparison rather than as decoration. All fractions of the edge.
   */
  bars: [
    { x: 0.25, w: 0.18, y: 0.46, h: 0.3, r: 0.09 },
    { x: 0.57, w: 0.18, y: 0.2, h: 0.56, r: 0.09 },
  ],
};

/** 4x4 supersampling. Enough to keep the corners from looking chewed. */
const SAMPLES = 4;

/** Is one sample point inside a rounded rectangle? */
function insideRoundedRect(px, py, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  if (px < x || px > x + w || py < y || py > y + h) return 0;
  const dx = Math.max(x + radius - px, 0, px - (x + w - radius));
  const dy = Math.max(y + radius - py, 0, py - (y + h - radius));
  if (dx === 0 || dy === 0) return 1;
  return dx * dx + dy * dy <= radius * radius ? 1 : 0;
}

function coverage(px, py, size, rect) {
  let hits = 0;
  for (let sy = 0; sy < SAMPLES; sy += 1) {
    for (let sx = 0; sx < SAMPLES; sx += 1) {
      const x = px + (sx + 0.5) / SAMPLES;
      const y = py + (sy + 0.5) / SAMPLES;
      hits += insideRoundedRect(
        x,
        y,
        rect.x * size,
        rect.y * size,
        rect.w * size,
        rect.h * size,
        rect.r * size,
      );
    }
  }
  return hits / (SAMPLES * SAMPLES);
}

/** Composite one colour over the buffer at byte offset i, straight alpha. */
function over(dst, i, src, alpha) {
  const a = (src[3] / 255) * alpha;
  if (a <= 0) return;
  const da = dst[i + 3] / 255;
  const out = a + da * (1 - a);
  if (out <= 0) return;
  for (let c = 0; c < 3; c += 1) {
    dst[i + c] = Math.round((src[c] * a + dst[i + c] * da * (1 - a)) / out);
  }
  dst[i + 3] = Math.round(out * 255);
}

/** RGBA pixel buffer for one square icon size. */
function renderRgba(size) {
  const buf = new Uint8Array(size * size * 4);
  const m = GEOMETRY.margin;
  const square = { x: m, y: m, w: 1 - 2 * m, h: 1 - 2 * m, r: GEOMETRY.radius };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      over(buf, i, COLORS.square, coverage(x, y, size, square));
      for (const bar of GEOMETRY.bars) {
        over(buf, i, COLORS.bar, coverage(x, y, size, bar));
      }
    }
  }
  return buf;
}

/* ----------------------------------------------------------------- PNG -- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  const pixels = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ----------------------------------------------------------------- ICO -- */

/**
 * Uncompressed 32bpp BGRA entries rather than embedded PNGs: the Windows
 * resource compiler has handled this form since forever, and the whole file is
 * still well under a megabyte.
 */
function encodeIco(images) {
  const entries = [];
  const bodies = [];
  let offset = 6 + images.length * 16;

  for (const { size, rgba } of images) {
    const xorStride = size * 4;
    const andStride = Math.ceil(size / 32) * 4;
    const body = Buffer.alloc(40 + xorStride * size + andStride * size);
    body.writeUInt32LE(40, 0);
    body.writeInt32LE(size, 4);
    body.writeInt32LE(size * 2, 8); // XOR bitmap and AND mask stacked
    body.writeUInt16LE(1, 12);
    body.writeUInt16LE(32, 14);
    body.writeUInt32LE(0, 16); // BI_RGB
    body.writeUInt32LE(xorStride * size + andStride * size, 20);

    for (let y = 0; y < size; y += 1) {
      const src = (size - 1 - y) * xorStride; // DIB rows run bottom-up
      const dst = 40 + y * xorStride;
      for (let x = 0; x < size; x += 1) {
        body[dst + x * 4 + 0] = rgba[src + x * 4 + 2];
        body[dst + x * 4 + 1] = rgba[src + x * 4 + 1];
        body[dst + x * 4 + 2] = rgba[src + x * 4 + 0];
        body[dst + x * 4 + 3] = rgba[src + x * 4 + 3];
      }
    }
    // The AND mask stays all-zero: the alpha channel already carries the shape.

    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(body.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += body.length;

    entries.push(entry);
    bodies.push(body);
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  return Buffer.concat([header, ...entries, ...bodies]);
}

/* ---------------------------------------------------------------- ICNS -- */

function encodeIcns(pngs) {
  const parts = [];
  for (const [type, png] of pngs) {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    parts.push(head, png);
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/* ---------------------------------------------------------------- main -- */

const SIZES = [16, 32, 48, 64, 128, 256, 512];
const rendered = new Map(SIZES.map((size) => [size, renderRgba(size)]));
const png = (size) => encodePng(size, rendered.get(size));

const written = [];
function write(name, data) {
  writeFileSync(join(HERE, name), data);
  written.push(`${name} (${data.length} bytes)`);
}

write('32x32.png', png(32));
write('128x128.png', png(128));
write('128x128@2x.png', png(256));
write('icon.png', png(512));
write(
  'icon.ico',
  encodeIco(SIZES.filter((s) => s <= 256).map((size) => ({ size, rgba: rendered.get(size) }))),
);
write(
  'icon.icns',
  encodeIcns([
    ['ic11', png(32)],
    ['ic12', png(64)],
    ['ic07', png(128)],
    ['ic08', png(256)],
    ['ic09', png(512)],
  ]),
);

console.log(written.join('\n'));
