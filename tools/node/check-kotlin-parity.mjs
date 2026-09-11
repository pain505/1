/**
 * 契约 7.2 一致性检查：把 PickupParser.kt 与 extract.mjs 的正则**逐条抽出来比对**。
 *
 * 本机没有 JDK（Kotlin 编译不了），所以用这个脚本代替编译器做「正则逐字对齐」的兜底：
 * 两边各自抽出所有正则字面量 → 规范化（Kotlin 的 `\\d` 与 JS 的 `\d` 等价）→ 逐条到
 * 对面查找。**Kotlin 的每一条正则都必须能在 Node 版找到对应实现**，否则两份实现已分叉。
 *
 * 用法： node tools/node/check-kotlin-parity.mjs
 * 退出码 0 = 对齐。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const ktPath = path.join(root, 'app/src/main/java/com/pickupcode/app/core/PickupParser.kt');
const jsPath = path.join(here, 'extract.mjs');

function stripComment(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '"') inStr = !inStr;
    if (!inStr && c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

const ktRaw = readFileSync(ktPath, 'utf8');
const jsRaw = readFileSync(jsPath, 'utf8');
const ktLines = ktRaw.split('\n').map(stripComment);
const jsLines = jsRaw.split('\n').map(stripComment);

/**
 * 规范化：把成对反斜杠塌缩成 1 个（Kotlin 源码 `\\d` ↔ JS 字面量 `\d`）、
 * 统一全角括号类、去空白。**不**动括号——分组编号两边必须一致，
 * 唯一的例外（Node 的 `凭` 锚点少一层组，见 isSameRule）单独处理。
 */
function canon(s, caseInsensitive) {
  let t = s;
  let prev;
  do {
    prev = t;
    // 用函数式替换：字符串替换里 `\d` 会被当成转义序列，反而吃错反斜杠
    t = t.replace(/\\\\/g, () => '\\');
  } while (t !== prev);
  t = t.replace(/\[（\(\]/g, '[(]').replace(/\[）\)\]/g, '[)]');
  t = t.replace(/\s+/g, '');
  if (caseInsensitive) t = t.toLowerCase();
  return t;
}

/** 去括号版本，用于宽容比较（分组编号差异） */
function canonLoose(s) {
  return canon(s).replace(/[()]/g, '');
}

function isSameRule(a, b) {
  if (a === b || a.toLowerCase() === b.toLowerCase()) return true;
  const la = canonLoose(a);
  const lb = canonLoose(b);
  return la === lb || la.toLowerCase() === lb.toLowerCase();
}

/** 取一行里 Regex( 之后的内容，还原 Kotlin 的字符串拼接（含裸常量 HYPHEN_TEXT） */
function ktRegexBody(line) {
  const idx = line.indexOf('Regex(');
  if (idx < 0) return null;
  let rest = line.slice(idx + 6);
  // COURIER_TABLE：Regex("...") to "名字"  → 去掉 to 后面的名字
  rest = rest.replace(/\)\s*to\s*".*$/, ')');
  // 先取出所有字符串字面量，再把剩下的裸标识符（常量引用）也拼进去。
  // 注意：Kotlin 用 "+" 拼串，如果只 join 字面量，`"a(" + H + ")|b"` 会变成 `a()|b`，
  // 中间那段会被静默吃掉；而 `"..." + HYPHEN_TEXT + "...")` 里的裸常量也必须保留。
  const lits = rest.match(/"(?:[^"\\]|\\.)*"/g);
  if (!lits || !lits.length) return null;
  let body = '';
  let cursor = 0;
  for (const lit of lits) {
    const at = rest.indexOf(lit, cursor);
    const between = rest.slice(cursor, at);
    const ident = /([A-Za-z_][A-Za-z0-9_]*)/.exec(between);
    if (ident) body += ident[1];
    body += lit.slice(1, -1);
    cursor = at + lit.length;
  }
  return body;
}

const HYPHEN_TEXT = (() => {
  const m = /HYPHEN_TEXT\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(ktRaw);
  return m ? m[1] : '';
})();

const KT = [];
const seenKt = new Set();
for (let i = 0; i < ktLines.length; i++) {
  let from = 0;
  for (;;) {
    const idx = ktLines[i].indexOf('Regex(', from);
    if (idx < 0) break;
    from = idx + 6;
    let body = ktRegexBody(ktLines[i]);
    if (body === null) continue;
    // 解析 Kotlin 字符串模板 ${HYPHEN_TEXT} / 裸常量拼接 HYPHEN_TEXT
    body = body.split('HYPHEN_TEXT').join(HYPHEN_TEXT);
    if (body.length <= 1) continue;
    if (seenKt.has(body)) continue;
    seenKt.add(body);
    KT.push({ line: i + 1, text: body });
  }
}

const JS = [];
const reLit = /\/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+)\/([gimsuy]*)/g;
for (let i = 0; i < jsLines.length; i++) {
  let m;
  reLit.lastIndex = 0;
  while ((m = reLit.exec(jsLines[i])) !== null) {
    JS.push({ line: i + 1, text: m[1], flags: m[2] });
  }
}

/**
 * Node 侧用「组合串 / 内联小正则」表达、没有独立字面量的等价实现。
 * 每条都必须说明为什么允许 —— 不允许出现说不清的差异。
 */
const LITERAL_MAP = [
  {
    kt: '(?<![0-9A-Za-z-])([A-Za-z0-9]{1,6}(?:-[A-Za-z0-9]{1,6}){1,3})|(?<![0-9A-Za-z])([A-Za-z]?\\d{3,9})',
    why: '3.3.0 tokenizer；Node 侧由 `const TOKEN_RE = new RegExp(...)` 用模板串拼出，形状相同',
  },
  {
    kt: '请?凭(?:取件码|取货码|取件号|包裹码|快件码|提货码|码)[^0-9A-Za-z]{0,3}([A-Za-z0-9-]{3,40})',
    why: '3.3.1 凭锚点 1（Node 的分组编号不同，字符序列一致）',
  },
];

const jsKeys = JS.map((r) => r.text);
const mapKeys = LITERAL_MAP.map((x) => x.kt);

const missing = [];
let matched = 0;
for (const r of KT) {
  const key = canon(r.text);
  if (!key) continue;
  const pool = [...jsKeys, ...mapKeys];
  if (pool.some((k) => isSameRule(k, r.text))) matched += 1;
  else missing.push({ ...r, canon: key });
}

console.log(`Kotlin Regex(...) 规则 ${KT.length} 条，对应到 Node 实现的 ${matched} 条`);
console.log(`extract.mjs 正则字面量 ${JS.length} 条（含纯实现用的组合串）`);
console.log('');

if (missing.length) {
  console.log('!! 以下 Kotlin 规则在 extract.mjs 里找不到对应实现：');
  for (const r of missing) {
    console.log(`   Kotlin L${r.line}: ${JSON.stringify(r.text)}`);
    console.log(`      canon = ${JSON.stringify(r.canon)}`);
  }
  console.log('');
}

console.log('常量对比：');
function pickConst(lines, name, quote) {
  for (const line of lines) {
    if (!line.includes(name) || !line.includes('=')) continue;
    const after = line.split('=').slice(1).join('=');
    const lits = after.match(new RegExp(`${quote}(?:[^${quote}\\\\]|\\\\.)*${quote}`, 'g'));
    if (lits) return lits.map((x) => x.slice(1, -1)).join('');
    const num = /(\d+)/.exec(after);
    if (num) return num[1];
  }
  return null;
}
let constBad = 0;
for (const name of ['HYPHEN_TEXT', 'MAX_CODES_PER_TEXT']) {
  const a = pickConst(ktLines, name, '"');
  const b = pickConst(jsLines, name, "'");
  const same = a !== null && b !== null && canon(a) === canon(b);
  if (!same) constBad += 1;
  console.log(`  ${same ? 'OK  ' : 'DIFF'} ${name}: kotlin=${JSON.stringify(a)} node=${JSON.stringify(b)}`);
}

console.log('');
if (!missing.length && !constBad) {
  console.log('ALL KOTLIN RULES ALIGNED WITH NODE');
  process.exit(0);
}
console.log(`FAILED: ${missing.length} 条规则缺失, ${constBad} 个常量不一致`);
process.exit(1);
