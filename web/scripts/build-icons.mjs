/**
 * アプリアイコンを生成する。
 *
 *   node scripts/build-icons.mjs
 *
 * 出力（いずれも app/ 直下。Next.js App Router がこの命名を拾って
 * <link rel="icon"> を自動で出す）:
 *
 *   icon.svg        主。拡大縮小に強い
 *   favicon.ico     SVG ファビコンに対応しないブラウザ向け（16/32/48px）
 *   apple-icon.png  iOS のホーム画面用（180px）
 *
 * 図案はエニグマのローター（アルファベット環＋指標）。
 * SVG とラスタで図がずれないよう、寸法をこの 1 ファイルに集約して
 * ベクタとビットマップの両方をここから書き出す。
 *
 * ラスタライズのためだけに依存を増やしたくないので、図形が円と多角形
 * だけであることを利用して解析的に塗り、Node 標準の zlib で PNG を組む。
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// --- 寸法（SVG の viewBox と同じ 64 単位系） -------------------------------

const SIZE = 64;
const CENTER = 32;

/** 台座。HUD パネルと同じく左上・右下を斜めに落とす */
const PLATE_CUT = 14;
const PLATE_BORDER = 1.6;

const RING_RADIUS = 16.5;
const RING_HALF_WIDTH = 2.2;

/** アルファベット環の刻み。エニグマのローターに合わせて 26 本 */
const TICKS = 26;
const TICK_INNER = 19.5;
const TICK_OUTER = 22.8;
const TICK_HALF_WIDTH = 0.85;

/** 真上の指標。内側を向いた三角形 */
const MARKER_TIP = 23.8;
const MARKER_BASE = 27.6;
const MARKER_HALF_WIDTH = 2.8;

const INNER_RING_RADIUS = 9;
const INNER_RING_HALF_WIDTH = 0.7;
const HUB_RADIUS = 4.6;

const CYAN = [0x22, 0xe0, 0xff];
const CYAN_HI = [0x7d, 0xf4, 0xff];
const PLATE_TOP = [0x0d, 0x24, 0x34];
const PLATE_BOTTOM = [0x04, 0x09, 0x0f];

const PLATE_PATH = `M${PLATE_CUT} 0 H${SIZE} V${SIZE - PLATE_CUT} L${SIZE - PLATE_CUT} ${SIZE} H0 V${PLATE_CUT} Z`;

// --- SVG -------------------------------------------------------------------

/** 小数の桁を落とす。末尾のゼロは残さない */
function round(value) {
  return Number(value.toFixed(2));
}

function buildSvg() {
  const x = round(CENTER - TICK_HALF_WIDTH);
  const y = round(CENTER - TICK_OUTER);
  const width = round(TICK_HALF_WIDTH * 2);
  const height = round(TICK_OUTER - TICK_INNER);
  const ticks = Array.from({ length: TICKS }, (_, i) => {
    const angle = round((i * 360) / TICKS);
    return `    <rect x="${x}" y="${y}" width="${width}" height="${height}" transform="rotate(${angle} ${CENTER} ${CENTER})" />`;
  }).join("\n");

  const marker = [
    `${CENTER} ${round(CENTER - MARKER_TIP)}`,
    `${round(CENTER + MARKER_HALF_WIDTH)} ${round(CENTER - MARKER_BASE)}`,
    `${round(CENTER - MARKER_HALF_WIDTH)} ${round(CENTER - MARKER_BASE)}`,
  ].join(", ");

  // 台座の枠線は viewBox の外へはみ出さないよう内側へ寄せる
  const inset = PLATE_BORDER / 2;
  const cut = round(PLATE_CUT + inset * Math.SQRT2);
  const far = round(SIZE - inset);
  const farCut = round(SIZE - PLATE_CUT - inset * Math.SQRT2);
  const framePath = `M${cut} ${inset} H${far} V${farCut} L${farCut} ${far} H${inset} V${cut} Z`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" role="img" aria-label="ENIGMA">
  <title>ENIGMA</title>
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0d2434" />
      <stop offset="1" stop-color="#04090f" />
    </linearGradient>
    <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0.38" stop-color="#22e0ff" stop-opacity="0" />
      <stop offset="0.56" stop-color="#22e0ff" stop-opacity="0.26" />
      <stop offset="0.82" stop-color="#22e0ff" stop-opacity="0" />
    </radialGradient>
  </defs>

  <path d="${PLATE_PATH}" fill="url(#plate)" />
  <path d="${framePath}" fill="none" stroke="#22e0ff" stroke-opacity="0.34" stroke-width="${PLATE_BORDER}" />
  <circle cx="${CENTER}" cy="${CENTER}" r="${CENTER}" fill="url(#halo)" />

  <g fill="#22e0ff" fill-opacity="0.85">
${ticks}
  </g>
  <polygon points="${marker}" fill="#7df4ff" />

  <circle cx="${CENTER}" cy="${CENTER}" r="${RING_RADIUS}" fill="none" stroke="#22e0ff" stroke-width="${RING_HALF_WIDTH * 2}" />
  <circle cx="${CENTER}" cy="${CENTER}" r="${INNER_RING_RADIUS}" fill="none" stroke="#22e0ff" stroke-opacity="0.5" stroke-width="${INNER_RING_HALF_WIDTH * 2}" />
  <circle cx="${CENTER}" cy="${CENTER}" r="${HUB_RADIUS}" fill="#7df4ff" />
</svg>
`;
}

// --- ラスタライズ ----------------------------------------------------------

const SUPERSAMPLE = 4;
const TRANSPARENT = { color: [0, 0, 0], alpha: 0 };

/** src を dst の上に載せる（source-over）。 */
function over(dst, src) {
  const alpha = src.alpha + dst.alpha * (1 - src.alpha);
  if (alpha === 0) return TRANSPARENT;
  const color = src.color.map(
    (v, i) => (v * src.alpha + dst.color[i] * dst.alpha * (1 - src.alpha)) / alpha
  );
  return { color, alpha };
}

function mix(from, to, t) {
  return from.map((v, i) => v + (to[i] - v) * t);
}

/**
 * 台座の内側か。inset ぶん各辺を内へ寄せる。
 * 斜辺は 45 度なので、法線方向へ inset だけ動かすと切片は inset*√2 動く。
 */
function insidePlate(x, y, cut, inset) {
  const diagonal = inset * Math.SQRT2;
  return (
    x >= inset &&
    x <= SIZE - inset &&
    y >= inset &&
    y <= SIZE - inset &&
    x + y >= cut + diagonal &&
    x + y <= SIZE * 2 - cut - diagonal
  );
}

/** 座標 1 点の色。cut=0 なら角を落とさない（iOS 用の全面塗り）。 */
function shade(x, y, cut) {
  if (!insidePlate(x, y, cut, 0)) return TRANSPARENT;

  const dx = x - CENTER;
  const dy = CENTER - y;
  const radius = Math.hypot(dx, dy);

  let pixel = { color: mix(PLATE_TOP, PLATE_BOTTOM, y / SIZE), alpha: 1 };

  if (
    insidePlate(x, y, cut, PLATE_BORDER * 0.75) &&
    !insidePlate(x, y, cut, PLATE_BORDER * 1.75)
  ) {
    pixel = over(pixel, { color: CYAN, alpha: 0.34 });
  }

  const halo = Math.exp(-((radius - RING_RADIUS) ** 2) / (2 * 5.5 ** 2)) * 0.24;
  pixel = over(pixel, { color: CYAN, alpha: halo });

  // 刻みは真上を 0 番として等間隔。最寄りの刻みの軸に座標を移して矩形判定する
  const fromTop = Math.atan2(dx, dy);
  const pitch = (Math.PI * 2) / TICKS;
  const offAxis = fromTop - Math.round(fromTop / pitch) * pitch;
  if (
    Math.abs(radius * Math.sin(offAxis)) <= TICK_HALF_WIDTH &&
    radius * Math.cos(offAxis) >= TICK_INNER &&
    radius * Math.cos(offAxis) <= TICK_OUTER
  ) {
    pixel = over(pixel, { color: CYAN, alpha: 0.85 });
  }

  // 指標は真上だけ。外側ほど広がる三角形
  const spread = (dy - MARKER_TIP) / (MARKER_BASE - MARKER_TIP);
  if (dy >= MARKER_TIP && dy <= MARKER_BASE && Math.abs(dx) <= MARKER_HALF_WIDTH * spread) {
    pixel = over(pixel, { color: CYAN_HI, alpha: 1 });
  }

  if (Math.abs(radius - RING_RADIUS) <= RING_HALF_WIDTH) {
    pixel = over(pixel, { color: CYAN, alpha: 1 });
  }

  if (Math.abs(radius - INNER_RING_RADIUS) <= INNER_RING_HALF_WIDTH) {
    pixel = over(pixel, { color: CYAN, alpha: 0.5 });
  }

  if (radius <= HUB_RADIUS) {
    pixel = over(pixel, { color: CYAN_HI, alpha: 1 });
  }

  return pixel;
}

/** size×size の RGBA バイト列を作る。 */
function render(size, cut) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  const subpixel = SIZE / (size * SUPERSAMPLE);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px * SUPERSAMPLE + sx + 0.5) * subpixel;
          const y = (py * SUPERSAMPLE + sy + 0.5) * subpixel;
          const sample = shade(x, y, cut);
          red += sample.color[0] * sample.alpha;
          green += sample.color[1] * sample.alpha;
          blue += sample.color[2] * sample.alpha;
          alpha += sample.alpha;
        }
      }

      // 色は乗算済みアルファで足しているので、書き出す前に割り戻す
      const offset = (py * size + px) * 4;
      pixels[offset] = alpha === 0 ? 0 : Math.round(Math.min(255, red / alpha));
      pixels[offset + 1] = alpha === 0 ? 0 : Math.round(Math.min(255, green / alpha));
      pixels[offset + 2] = alpha === 0 ? 0 : Math.round(Math.min(255, blue / alpha));
      pixels[offset + 3] = Math.round((alpha / samples) * 255);
    }
  }

  return pixels;
}

// --- PNG / ICO -------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  // 10..12（compression / filter / interlace）はいずれも 0 のまま

  // PNG の生データは各行の先頭にフィルタ種別が 1 バイト入る。0 = None
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0;
    pixels.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** ICO は PNG をそのまま格納できる。ヘッダ 6 バイト＋1 枚 16 バイトの目録を被せる。 */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = アイコン
  header.writeUInt16LE(entries.length, 4);

  let offset = header.length + entries.length * 16;
  const directory = entries.map((entry) => {
    const record = Buffer.alloc(16);
    record[0] = entry.size >= 256 ? 0 : entry.size; // 幅
    record[1] = entry.size >= 256 ? 0 : entry.size; // 高さ
    record[4] = 1; // color planes
    record.writeUInt16LE(32, 6); // bits per pixel
    record.writeUInt32LE(entry.png.length, 8);
    record.writeUInt32LE(offset, 12);
    offset += entry.png.length;
    return record;
  });

  return Buffer.concat([header, ...directory, ...entries.map((entry) => entry.png)]);
}

// --- 書き出し --------------------------------------------------------------

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "app");

writeFileSync(join(appDir, "icon.svg"), buildSvg());

writeFileSync(
  join(appDir, "favicon.ico"),
  encodeIco([16, 32, 48].map((size) => ({ size, png: encodePng(size, render(size, PLATE_CUT)) })))
);

// iOS は角を自前で丸めるので、台座は正方形いっぱいに塗る
writeFileSync(join(appDir, "apple-icon.png"), encodePng(180, render(180, 0)));

console.log("app/icon.svg, app/favicon.ico, app/apple-icon.png を書き出しました");
