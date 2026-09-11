// 二维码自检：用自写的**解码器**把 qr.mjs 生成的矩阵解回原文，验证编码正确。
//
// 为什么值得写：二维码生成器最容易"看起来像二维码但扫不出来"。
// 只验证 PNG 能生成毫无意义；能编码→解码还原原文，才说明 Reed-Solomon 纠错、
// 掩码、格式信息、模块布局这几处都对。本机没有扫码器，所以自己写一个。
//
// 覆盖：ASCII / 中文 UTF-8 / 长文本、8 个掩码、多个版本（1~10）。
// 用法： node tools/qr-selftest.mjs   （退出码 1 = 有失败）
import { qrMatrix, versionTable } from './qr.mjs';

// ---------------------------------------------------------------- GF(256)

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// 与 qr.mjs 同一张表（纠错等级 M）。测试里独立抄一份，这样编码器改坏了能被发现。
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

// 规范里各版本的总码字数（用于交叉校验上面的表）
const TOTAL_CODEWORDS = {
  1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196, 8: 242, 9: 292, 10: 346,
};
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

// ---------------------------------------------------------------- RS 解码（Berlekamp-Massey + Forney）

function syndromes(cw, ecLen) {
  const s = new Array(ecLen).fill(0);
  for (let i = 0; i < ecLen; i++) {
    let acc = 0;
    for (const c of cw) acc = mul(acc, EXP[i]) ^ c;
    s[i] = acc;
  }
  return s;
}

function rsCorrect(cw, ecLen) {
  const s = syndromes(cw, ecLen);
  if (s.every((v) => v === 0)) return cw.slice();

  // Berlekamp-Massey
  let errLoc = [1];
  let oldLoc = [1];
  for (let i = 0; i < ecLen; i++) {
    oldLoc.push(0);
    let delta = s[i];
    for (let j = 1; j < errLoc.length; j++) delta ^= mul(errLoc[errLoc.length - 1 - j], s[i - j]);
    if (delta !== 0) {
      const shifted = oldLoc.map((v) => mul(v, delta));
      if (shifted.length > errLoc.length) {
        const newLoc = shifted.map((v, k) => v ^ (errLoc[k] ?? 0));
        oldLoc = errLoc.map((v) => mul(v, 1 / delta));
        errLoc = newLoc;
      } else {
        for (let k = 0; k < shifted.length; k++) errLoc[errLoc.length - 1 - k] ^= shifted[shifted.length - 1 - k];
      }
    }
  }

  // 求根（钱搜索）
  const deg = errLoc.length - 1;
  const positions = [];
  for (let i = 0; i < cw.length; i++) {
    // 评估 errLoc 在 EXP[-(cw.length-1-i)]
    const xInv = EXP[(255 - ((cw.length - 1 - i) % 255)) % 255];
    let acc = 0;
    for (let k = 0; k <= deg; k++) acc = mul(acc, xInv) ^ errLoc[deg - k];
    if (acc === 0) positions.push(i);
  }
  if (positions.length !== deg) return null; // 纠不了

  // Forney：错误值
  for (const pos of positions) {
    const xInv = EXP[(255 - ((cw.length - 1 - pos) % 255)) % 255];
    // Omega(x) = S(x) * Lambda(x) mod x^ecLen
    const omega = new Array(ecLen).fill(0);
    for (let i = 0; i < ecLen; i++) {
      let acc = 0;
      for (let k = 0; k <= Math.min(i, deg); k++) acc ^= mul(errLoc[k], s[i - k]);
      omega[i] = acc;
    }
    // Lambda'(x)
    const der = [];
    for (let k = 1; k <= deg; k++) if (k % 2 === 1) der.push(errLoc[deg - k]);
    let num = 0;
    for (let k = 0; k < der.length; k++) num = mul(num, xInv) ^ der[k];
    if (num === 0) return null;
    // Omega(xInv)
    let om = 0;
    for (let k = 0; k < omega.length; k++) om = mul(om, xInv) ^ omega[k];
    const mag = mul(om, 1 / num);
    cw[pos] ^= mag;
  }
  return syndromes(cw, ecLen).every((v) => v === 0) ? cw : null;
}

// ---------------------------------------------------------------- 矩阵 -> 码字

function isFunction(r, c, size, version) {
  if (r === 6 || c === 6) return true;
  if (r <= 8 && c <= 8) return true;
  if (r <= 8 && c >= size - 8) return true;
  if (r >= size - 8 && c <= 8) return true;
  for (const ar of ALIGN[version]) {
    for (const ac of ALIGN[version]) {
      if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 9) || (ar >= size - 9 && ac <= 8)) continue;
      if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true;
    }
  }
  return false;
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

/** 从格式信息里读掩码号（直接读，不做 BCH 纠错——自家生成的不会有错） */
function readMask(m, size) {
  let bits = 0;
  for (let i = 0; i <= 5; i++) bits |= m[8][i] << i;
  bits |= m[8][7] << 6;
  bits |= m[8][8] << 7;
  bits |= m[7][8] << 8;
  for (let i = 9; i <= 14; i++) bits |= m[14 - i][8] << i;
  const unmasked = bits ^ 0b101010000010010;
  return (unmasked >>> 10) & 0b111;
}

function readCodewords(m, version) {
  const size = m.length;
  const mask = readMask(m, size);
  const bits = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (isFunction(row, c, size, version)) continue;
        let v = m[row][c];
        if (MASKS[mask](row, c)) v ^= 1;
        bits.push(v);
      }
    }
    upward = !upward;
  }
  const cw = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
    cw.push(b);
  }
  return cw;
}

/** 反交错 + RS 纠错 + 解析 byte 模式 */
function decodeMatrix(matrix) {
  const size = matrix.length;
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 10) throw new Error(`未知版本 size=${size}`);
  const info = VERSION_M[version];
  const sizes = [];
  for (let i = 0; i < info.g1; i++) sizes.push(info.d1);
  for (let i = 0; i < info.g2; i++) sizes.push(info.d2);
  const totalBlocks = sizes.length;
  const totalData = sizes.reduce((a, b) => a + b, 0);

  const all = readCodewords(matrix, version);
  if (all.length < totalData + totalBlocks * info.ec) {
    throw new Error(`码字数不足：${all.length}`);
  }
  // 反交错
  const blocks = sizes.map((s) => new Array(s).fill(0));
  const ecBlocks = sizes.map(() => new Array(info.ec).fill(0));
  let idx = 0;
  const maxLen = Math.max(...sizes);
  for (let i = 0; i < maxLen; i++) for (let b = 0; b < totalBlocks; b++) if (i < sizes[b]) blocks[b][i] = all[idx++];
  for (let i = 0; i < info.ec; i++) for (let b = 0; b < totalBlocks; b++) ecBlocks[b][i] = all[idx++];

  const data = [];
  for (let b = 0; b < totalBlocks; b++) {
    const corrected = rsCorrect([...blocks[b], ...ecBlocks[b]], info.ec);
    if (!corrected) throw new Error(`第 ${b} 块 RS 纠错失败`);
    data.push(...corrected.slice(0, sizes[b]));
  }

  // 位流 -> byte 模式
  const bits = [];
  for (const b of data) for (let k = 7; k >= 0; k--) bits.push((b >>> k) & 1);
  let p = 0;
  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bits[p++]; return v; };
  const mode = take(4);
  if (mode !== 0b0100) throw new Error(`模式不是 byte：${mode}`);
  const ccBits = version >= 10 ? 16 : 8;
  const len = take(ccBits);
  const bytes = [];
  for (let i = 0; i < len; i++) bytes.push(take(8));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// ---------------------------------------------------------------- 跑测试

const cases = [
  'http://192.0.2.10:8080/pickup-code-debug.apk',
  'http://127.0.0.1:8080/a',
  'https://example.com/very/long/path/to/some/file/that/forces/a/bigger/qr/version/app-debug.apk?x=1',
  '取件码管家 — 扫码下载 APK',
  'A',
  'x'.repeat(150),
  '中文测试：丰巢取件码 470812，菜鸟驿站 8-3-2015',
];

let pass = 0, fail = 0;
console.log('二维码编码→解码闭环自检');
console.log('');

// 表一致性：分块表算出的总码字数必须等于规范给的总码字数
console.log('  版本表交叉校验（分块表 vs 规范总码字数）');
{
  const table = versionTable();
  let tableOk = true;
  for (let v = 1; v <= 10; v++) {
    const i = table[v];
    const total = (i.g1 + i.g2) * i.ec + i.g1 * i.d1 + i.g2 * i.d2;
    const expect = TOTAL_CODEWORDS[v];
    if (total !== expect) { tableOk = false; console.log(`    FAIL v${v}: 算出 ${total}，规范 ${expect}`); }
  }
  // 还要确认 qr.mjs 与 selftest 两张表一致
  for (let v = 1; v <= 10; v++) {
    const a = table[v], b = VERSION_M[v];
    if (a.g1 !== b.g1 || a.d1 !== b.d1 || a.g2 !== b.g2 || a.d2 !== b.d2 || a.ec !== b.ec) {
      tableOk = false; console.log(`    FAIL v${v}: qr.mjs 与 selftest 的表不一致`);
    }
  }
  if (tableOk) { pass++; console.log('    PASS  10 个版本全部匹配'); }
  else fail++;
}
console.log('');
for (const text of cases) {
  try {
    const { matrix, version, mask } = qrMatrix(text);
    const back = decodeMatrix(matrix);
    const ok = back === text;
    if (ok) { pass++; console.log(`  PASS  v${String(version).padEnd(2)} mask${mask}  len=${String(text.length).padEnd(4)} ${JSON.stringify(text.slice(0, 42))}`); }
    else { fail++; console.log(`  FAIL  v${version} mask${mask}  期望 ${JSON.stringify(text.slice(0, 30))} 实得 ${JSON.stringify(back.slice(0, 30))}`); }
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${JSON.stringify(text.slice(0, 30))} -> ${e.message}`);
  }
}

// 结构检查：三个定位图案的角点必须是暗模块
console.log('');
const { matrix, size } = qrMatrix('http://192.0.2.10:8080/pickup-code-debug.apk');
const corners = [[0, 0], [0, size - 7], [size - 7, 0]];
let structOk = true;
for (const [r, c] of corners) {
  if (matrix[r][c] !== 1 || matrix[r + 1][c + 1] !== 0 || matrix[r + 3][c + 3] !== 1) structOk = false;
}
if (structOk) { pass++; console.log(`  PASS  三个定位图案结构正确 (size=${size})`); }
else { fail++; console.log('  FAIL  定位图案结构异常'); }

console.log('');
console.log(`QR SELF-TEST: PASS ${pass}  FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);

