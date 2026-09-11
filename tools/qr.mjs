// 零依赖二维码 PNG 生成器（byte 模式，纠错等级 M，版本 1~10 自动选）。
// 不引任何 npm 包 —— 本机网络只有 Node 能出去，装包反而更麻烦。
//
// 用法（模块）： qrPng(text, { scale }) -> Buffer(PNG)
//      （命令行）： node tools/qr.mjs "文本" out.png [scale]
//
// 实现要点：GF(256) 上的 Reed-Solomon 纠错 + 标准掩码评分 + 手写 PNG 编码（zlib 由 node:zlib 提供）。
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

// ---------------------------------------------------------------- GF(256) 与 RS 纠错

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // 本原多项式 x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** 生成 degree 次的 RS 生成多项式 */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], 1);
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** 对 data 计算 degree 个纠错码字 */
function rsEncode(data, degree) {
  const gen = rsGenerator(degree);
  const res = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < degree; i++) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

// ---------------------------------------------------------------- 版本参数表（纠错 M）

// 纠错等级 M 的分块表（ISO/IEC 18004 表 9，数值对过 pyqrcode/tables.py）
//
// 格式：{ g1: 组1块数, d1: 组1每块数据码字, g2: 组2块数, d2: 组2每块数据码字, ec: 每块纠错码字数 }
// 注意：**组2每块比组1多 1 个数据码字** —— 一开始我把所有版本都写成单组，
// 导致 v7 起总容量算错、长内容报"超出 10 版"。这是 QR 规范里最容易写错的地方。
// 参考: https://www.thonky.com/qr-code-tutorial/error-correction-table
const VERSION_M = {
  1: { g1: 1, d1: 16, g2: 0, d2: 0, ec: 10 },
  2: { g1: 1, d1: 28, g2: 0, d2: 0, ec: 16 },
  3: { g1: 1, d1: 44, g2: 0, d2: 0, ec: 26 },
  4: { g1: 2, d1: 32, g2: 0, d2: 0, ec: 18 },
  5: { g1: 2, d1: 43, g2: 0, d2: 0, ec: 24 },
  6: { g1: 4, d1: 27, g2: 0, d2: 0, ec: 16 },
  7: { g1: 4, d1: 31, g2: 0, d2: 0, ec: 18 },
  8: { g1: 2, d1: 38, g2: 2, d2: 39, ec: 22 },
  9: { g1: 3, d1: 36, g2: 2, d2: 37, ec: 22 },
  10: { g1: 4, d1: 43, g2: 1, d2: 44, ec: 26 },
};

/** 该版本的数据码字总数 */
function dataCodewords(v) {
  const i = VERSION_M[v];
  return i.g1 * i.d1 + i.g2 * i.d2;
}

/** 该版本 + 纠错码字后的总码字数（应等于规范里的总码字数） */
function totalCodewords(v) {
  const i = VERSION_M[v];
  return (i.g1 + i.g2) * i.ec + dataCodewords(v);
}

// 各版本的对齐图案中心坐标
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

// ---------------------------------------------------------------- 位流

class BitBuffer {
  constructor() { this.bits = []; }
  put(value, len) { for (let i = len - 1; i >= 0; i--) this.bits.push((value >>> i) & 1); }
  get length() { return this.bits.length; }
  toBytes() {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
    return out;
  }
}

// ---------------------------------------------------------------- 主编码

function chooseVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    // 模式指示符 4 位 + 字符计数（v1~9 为 8 位，v10 为 16 位）
    const ccBits = v >= 10 ? 16 : 8;
    const need = 4 + ccBits + byteLen * 8;
    if (need <= dataCodewords(v) * 8) return v;
  }
  throw new Error(`内容太长，超出 10 版（${byteLen} 字节）`);
}

function buildCodewords(bytes, version) {
  const info = VERSION_M[version];
  const totalData = dataCodewords(version);
  const ccBits = version >= 10 ? 16 : 8;
  const bb = new BitBuffer();
  bb.put(0b0100, 4);            // byte 模式
  bb.put(bytes.length, ccBits);
  for (const b of bytes) bb.put(b, 8);

  const capacityBits = totalData * 8;
  // 结束符
  bb.put(0, Math.min(4, capacityBits - bb.length));
  // 补齐到字节边界
  while (bb.length % 8 !== 0) bb.put(0, 1);

  const data = Array.from(bb.toBytes());
  // 交替填充 0xEC / 0x11
  const pads = [0xec, 0x11];
  let pi = 0;
  while (data.length < totalData) data.push(pads[pi++ % 2]);

  // 分块：组1 是 g1 块、每块 d1 个数据码字；组2 是 g2 块、每块 d2 个
  const blockSizes = [];
  for (let i = 0; i < info.g1; i++) blockSizes.push(info.d1);
  for (let i = 0; i < info.g2; i++) blockSizes.push(info.d2);

  const dataBlocks = [];
  const ecBlocks = [];
  let off = 0;
  for (const size of blockSizes) {
    const blk = data.slice(off, off + size);
    off += size;
    dataBlocks.push(blk);
    ecBlocks.push(rsEncode(blk, info.ec));
  }

  // 交错
  const out = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) for (const blk of dataBlocks) if (i < blk.length) out.push(blk[i]);
  for (let i = 0; i < info.ec; i++) for (const blk of ecBlocks) out.push(blk[i]);

  // 剩余位（remainder bits）在画矩阵时按 0 处理，这里不用补
  return out;
}

// ---------------------------------------------------------------- 矩阵

function newMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(null));
}

function placeFinder(m, r, c) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const dark = inRing && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      m[rr][cc] = dark ? 1 : 0;
    }
  }
}

function placeAlign(m, version) {
  const centers = ALIGN[version];
  for (const r of centers) {
    for (const c of centers) {
      // 跳过与定位图案重叠的位置
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= m.length - 9) || (r >= m.length - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          m[r + dr][c + dc] = dark ? 1 : 0;
        }
      }
    }
  }
}

function placeTiming(m) {
  for (let i = 8; i < m.length - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    if (m[6][i] === null) m[6][i] = v;
    if (m[i][6] === null) m[i][6] = v;
  }
}

function reserveFormat(m) {
  // 格式信息区域先占位（稍后填真值）
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = 0;
    if (m[i][8] === null) m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][m.length - 1 - i] === null) m[8][m.length - 1 - i] = 0;
    if (m[m.length - 1 - i][8] === null) m[m.length - 1 - i][8] = 0;
  }
  m[m.length - 8][8] = 1; // 固定的暗模块
}

function placeData(m, codewords) {
  const size = m.length;
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  const nextBit = () => (bitIdx < totalBits ? (codewords[bitIdx >> 3] >>> (7 - (bitIdx++ & 7))) & 1 : 0);

  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // 跳过竖直定时图案列
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (m[row][c] === null) m[row][c] = nextBit();
      }
    }
    upward = !upward;
  }
}

function applyMask(m, fn) {
  const size = m.length;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (isFunctionModule(r, c, size)) continue;
      if (fn(r, c)) m[r][c] ^= 1;
    }
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function isFunctionModule(r, c, size) {
  if (r === 6 || c === 6) return true;                       // 定时图案
  if (r <= 8 && c <= 8) return true;                          // 左上定位 + 格式信息
  if (r <= 8 && c >= size - 8) return true;                   // 右上
  if (r >= size - 8 && c <= 8) return true;                   // 左下
  // 对齐图案
  return false;
}

function isFunctionModuleFull(r, c, size, version) {
  if (r === 6 || c === 6) return true;
  if (r <= 8 && c <= 8) return true;
  if (r <= 8 && c >= size - 8) return true;
  if (r >= size - 8 && c <= 8) return true;
  const centers = ALIGN[version];
  for (const ar of centers) {
    for (const ac of centers) {
      if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 9) || (ar >= size - 9 && ac <= 8)) continue;
      if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true;
    }
  }
  return false;
}

/** 掩码惩罚评分（ISO/IEC 18004 §8.8.2） */
function maskPenalty(m) {
  const size = m.length;
  let score = 0;
  // 规则 1：连续同色
  for (let r = 0; r < size; r++) {
    for (const line of [m[r], m.map((row) => row[r])]) {
      let run = 1;
      for (let i = 1; i < size; i++) {
        if (line[i] === line[i - 1]) { run++; continue; }
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }
  // 规则 2：2x2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }
  // 规则 3：1:1:3:1:1 图案
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (line, i, pat) => pat.every((p, k) => line[i + k] === p);
  for (let r = 0; r < size; r++) {
    const row = m[r];
    const col = m.map((x) => x[r]);
    for (let i = 0; i + 11 <= size; i++) {
      if (matches(row, i, pat1) || matches(row, i, pat2)) score += 40;
      if (matches(col, i, pat1) || matches(col, i, pat2)) score += 40;
    }
  }
  // 规则 4：暗模块比例
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/** 格式信息（纠错等级 + 掩码），BCH(15,5) */
function formatBits(ecLevel, mask) {
  const ecBits = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 }[ecLevel];
  const data = (ecBits << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0b10100110111 << (i - 10);
  return ((data << 10) | rem) ^ 0b101010000010010;
}

function placeFormat(m, ecLevel, mask) {
  const size = m.length;
  const bits = formatBits(ecLevel, mask);
  const bit = (i) => (bits >>> i) & 1;
  // 左上
  for (let i = 0; i <= 5; i++) m[8][i] = bit(i);
  m[8][7] = bit(6);
  m[8][8] = bit(7);
  m[7][8] = bit(8);
  for (let i = 9; i <= 14; i++) m[14 - i][8] = bit(i);
  // 右上 / 左下
  for (let i = 0; i <= 7; i++) m[8][size - 1 - i] = bit(i);
  for (let i = 8; i <= 14; i++) m[size - 15 + i][8] = bit(i);
  m[size - 8][8] = 1;
}

function buildMatrix(text) {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const size = version * 4 + 17;
  const codewords = buildCodewords(bytes, version);

  const base = newMatrix(size);
  placeFinder(base, 0, 0);
  placeFinder(base, 0, size - 7);
  placeFinder(base, size - 7, 0);
  placeAlign(base, version);
  placeTiming(base);
  reserveFormat(base);
  placeData(base, codewords);

  // 选最优掩码
  let best = null;
  let bestScore = Infinity;
  let bestMask = 0;
  for (let mask = 0; mask < 8; mask++) {
    const m = base.map((row) => row.slice());
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (isFunctionModuleFull(r, c, size, version)) continue;
        if (MASKS[mask](r, c)) m[r][c] ^= 1;
      }
    }
    placeFormat(m, 'M', mask);
    const score = maskPenalty(m);
    if (score < bestScore) { bestScore = score; best = m; bestMask = mask; }
  }
  return { matrix: best, version, mask: bestMask, size };
}

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/** 把二维码矩阵渲染成灰度 PNG（黑白，带 quiet zone） */
export function qrPng(text, { scale = 8, quiet = 4 } = {}) {
  const { matrix, size } = buildMatrix(text);
  const dim = (size + quiet * 2) * scale;

  // 每行：filter byte 0 + 灰度像素
  const raw = Buffer.alloc((dim + 1) * dim, 0xff);
  for (let y = 0; y < dim; y++) {
    const rowStart = y * (dim + 1);
    raw[rowStart] = 0;
    const my = Math.floor(y / scale) - quiet;
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const dark = my >= 0 && mx >= 0 && my < size && mx < size && matrix[my][mx] === 1;
      raw[rowStart + 1 + x] = dark ? 0x00 : 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0);
  ihdr.writeUInt32BE(dim, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 0;   // color type: grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 供测试用：返回矩阵（0/1） */
export function qrMatrix(text) {
  return buildMatrix(text);
}

/** 供测试用：导出纠错等级 M 的分块表，便于交叉校验 */
export function versionTable() {
  return VERSION_M;
}

// ---------------------------------------------------------------- CLI

if (process.argv[1] && process.argv[1].endsWith('qr.mjs')) {
  const text = process.argv[2];
  const out = process.argv[3] || 'qr.png';
  const scale = Number(process.argv[4] || 8);
  if (!text) { console.error('用法: node tools/qr.mjs "文本" out.png [scale]'); process.exit(2); }
  const png = qrPng(text, { scale });
  writeFileSync(out, png);
  console.log(`已生成 ${out}  (${png.length} bytes, 内容 ${text.length} 字符)`);
}
