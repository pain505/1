// 把生成的二维码 PNG 解回文本 —— 端到端确认「手机上扫出来的确实是这个地址」。
//
// qr-selftest.mjs 验证的是矩阵层（编码器 ↔ 解码器）；这个脚本多跨一层：
// 从**真实的 PNG 文件**里读像素、还原模块、再解码。
// 这样能覆盖 PNG 编码（行过滤、灰度、缩放）与矩阵之间的边界。
//
// 用法： node tools/qr-verify.mjs apk-qr.png
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- 极简 PNG 解码（只支持本生成器的输出格式）

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行扫描');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 0) throw new Error(`只支持 8 位灰度，实得 depth=${bitDepth} color=${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));

  // 还原扫描线（本生成器只用 filter 0）
  const stride = w;
  const px = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    if (f !== 0) throw new Error(`第 ${y} 行 filter=${f}，本解码器只处理 filter 0`);
    raw.copy(px, y * w, y * (stride + 1) + 1, y * (stride + 1) + 1 + w);
  }
  return { w, h, px };
}

/** 从像素图还原出模块矩阵：采样每个模块中心 */
function pngToMatrix(png) {
  const { w, h, px } = png;
  if (w !== h) throw new Error('不是正方形');
  const dark = (x, y) => px[y * w + x] < 128;

  // 1) 左上角第一个黑像素
  let firstY = -1, firstX = -1;
  outer:
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (dark(x, y)) { firstY = y; firstX = x; break outer; }
    }
  }
  if (firstY < 0) throw new Error('整张图都是白的（PNG 解码有问题？）');
  const quietPx = Math.min(firstY, firstX);

  // 2) 左上角定位图案的外圈是 7 个模块宽的黑方块。
  //    沿第一行黑色横向扫描，连续黑像素的宽度 = 7 * scale（quiet 是白的，不会干扰）。
  let run = 0;
  for (let x = firstX; x < w && dark(x, firstY); x++) run++;
  if (run % 7 !== 0) throw new Error(`定位图案宽度 ${run}px 不是 7 的整数倍，推导不出缩放比例`);
  const scale = run / 7;

  // 3) 模块数由画布边长反推，并要求是 21 + 4k
  const inner = h - 2 * quietPx;
  if (inner % scale !== 0) throw new Error(`去掉 quiet zone 后 ${inner}px 不是 ${scale} 的整数倍`);
  const moduleCount = inner / scale;
  if (!Number.isInteger(moduleCount) || moduleCount < 21 || moduleCount > 57 || (moduleCount - 17) % 4 !== 0) {
    throw new Error(`模块数 ${moduleCount} 不合法`);
  }

  const m = [];
  for (let r = 0; r < moduleCount; r++) {
    const row = [];
    for (let c = 0; c < moduleCount; c++) {
      const y = Math.floor(quietPx + (r + 0.5) * scale);
      const x = Math.floor(quietPx + (c + 0.5) * scale);
      row.push(px[y * w + x] < 128 ? 1 : 0);
    }
    m.push(row);
  }
  return { matrix: m, scale, quiet: quietPx, moduleCount };
}

// ---------------------------------------------------------------- 复用 selftest 里的解码器

const src = readFileSync(new URL('./qr-selftest.mjs', import.meta.url), 'utf8');
// 直接把解码相关函数从 selftest 里取出来执行（避免复制两份解码器导致漂移）
const blockStart = src.indexOf('// ---------------------------------------------------------------- GF(256)');
const blockEnd = src.indexOf('// ---------------------------------------------------------------- 跑测试');
const decoderCode = src
  .slice(blockStart, blockEnd)
  .replace(/^import .*$/gm, '')
  .concat('\nexport { decodeMatrix, VERSION_M, TOTAL_CODEWORDS };\n');
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(decoderCode).toString('base64');
const { decodeMatrix, TOTAL_CODEWORDS } = await import(dataUrl);

// ---------------------------------------------------------------- 跑

const file = process.argv[2] || 'apk-qr.png';
const png = decodePng(readFileSync(file));
console.log(`PNG: ${file}  ${png.w}x${png.h} 灰度`);
const { matrix, scale, quiet, moduleCount } = pngToMatrix(png);
console.log(`模块数 ${moduleCount}（版本 ${(moduleCount - 17) / 4}），quiet=${quiet}，每模块 ${scale}px`);

const text = decodeMatrix(matrix);
console.log('');
console.log(`解码结果: ${text}`);
console.log('');

// 期望值：serve-apk.mjs 用的局域网地址
const expect = /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/pickup-code-debug\.apk$/;
if (expect.test(text)) {
  console.log('PASS  二维码内容是可用的 APK 下载地址');
  process.exit(0);
}
console.log('FAIL  二维码内容不是预期的下载地址格式');
process.exit(1);
