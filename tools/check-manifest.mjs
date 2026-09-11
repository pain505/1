#!/usr/bin/env node
// 取件码管家 — 无 JDK 环境下的静态自检
//
// 目的：在还没装好 JDK/SDK、无法真正编译之前，先用最朴素的方式抓出
//       「资源引用错、类名对不上、包名与目录不一致、括号不配平、混进第三方 import」
//       这一类必然会编译失败的问题。
//
// 用法：
//   node tools/check-manifest.mjs            # 检查当前仓库
//   node tools/check-manifest.mjs <项目根目录>
//
// 输出格式：
//   [ERR] 相对路径:行号 描述
//   [WARN] 相对路径:行号 描述
//   CHECKED n files, ERRORS x, WARNINGS y
// 退出码：ERRORS > 0 → 1，否则 0。
//
// 说明：括号配平是**粗略检查**（只计数，不解析语法）。字符串/注释/字符字面量里的
//       括号已经被剔除，但 Kotlin 原始字符串 """...""" 内部仍可能出现 ${...} 嵌套，
//       极端写法可能造成误报/漏报，仅作参考信号，不作结论。

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PROJECT_ROOT = path.resolve(process.argv[2] || path.join(process.cwd()));
const JAVA_ROOT = path.join(PROJECT_ROOT, 'app', 'src', 'main', 'java');
const RES_ROOT = path.join(PROJECT_ROOT, 'app', 'src', 'main', 'res');
const MANIFEST = path.join(PROJECT_ROOT, 'app', 'src', 'main', 'AndroidManifest.xml');

const errors = [];
const warnings = [];
let fileCount = 0;

const rel = (p) => path.relative(PROJECT_ROOT, p).split(path.sep).join('/');

/** 记录一条问题；line 为 0 表示文件级（无行号）。 */
function err(file, line, msg) {
  errors.push(line > 0 ? `[ERR] ${rel(file)}:${line} ${msg}` : `[ERR] ${rel(file)} ${msg}`);
}
function warn(file, line, msg) {
  warnings.push(line > 0 ? `[WARN] ${rel(file)}:${line} ${msg}` : `[WARN] ${rel(file)} ${msg}`);
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function walk(dir, filter, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, filter, out);
    else if (e.isFile() && filter(full)) out.push(full);
  }
  return out;
}

/**
 * 去掉注释与字符串字面量，保留换行结构以便行号对齐。
 * 处理：// 行注释、块注释、普通字符串 "..."、字符字面量 '...'、原始字符串 """..."""。
 * 返回与原文等长的字符串，被剔除的字符替换成空格（换行保留）。
 */
function stripCommentsAndStrings(src) {
  const n = src.length;
  const out = new Array(n);
  let i = 0;
  const isNL = (c) => c === '\n';
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // 行注释
    if (c === '/' && c2 === '/') {
      while (i < n && !isNL(src[i])) out[i++] = ' ';
      continue;
    }
    // 块注释
    if (c === '/' && c2 === '*') {
      out[i++] = ' ';
      out[i++] = ' ';
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out[i] = isNL(src[i]) ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out[i++] = ' ';
        out[i++] = ' ';
      }
      continue;
    }
    // 原始字符串 """
    if (c === '"' && c2 === '"' && src[i + 2] === '"') {
      out[i++] = ' ';
      out[i++] = ' ';
      out[i++] = ' ';
      while (i < n && !(src[i] === '"' && src[i + 1] === '"' && src[i + 2] === '"')) {
        out[i] = isNL(src[i]) ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out[i++] = ' ';
        out[i++] = ' ';
        out[i++] = ' ';
      }
      continue;
    }
    // 普通字符串
    if (c === '"') {
      out[i++] = ' ';
      while (i < n) {
        const d = src[i];
        if (d === '\\') {
          out[i] = ' ';
          i++;
          if (i < n) {
            out[i] = isNL(src[i]) ? '\n' : ' ';
            i++;
          }
          continue;
        }
        if (d === '"') {
          out[i++] = ' ';
          break;
        }
        if (isNL(d)) break; // 未闭合的字符串：不吞掉换行
        out[i++] = ' ';
      }
      continue;
    }
    // 字符字面量
    if (c === "'") {
      out[i++] = ' ';
      while (i < n) {
        const d = src[i];
        if (d === '\\') {
          out[i] = ' ';
          i++;
          if (i < n) {
            out[i] = isNL(src[i]) ? '\n' : ' ';
            i++;
          }
          continue;
        }
        if (d === "'") {
          out[i++] = ' ';
          break;
        }
        if (isNL(d)) break;
        out[i++] = ' ';
      }
      continue;
    }
    out[i] = c;
    i++;
  }
  return out.join('');
}

function lineOfIndex(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

// ---------------------------------------------------------------------------
// 资源索引
// ---------------------------------------------------------------------------

const resIndex = {
  layout: new Set(),
  drawable: new Set(),
  menu: new Set(),
  xml: new Set(),
  string: new Set(),
  id: new Set(),
  color: new Set(),
  style: new Set(),
  array: new Set(),
  dimen: new Set(),
  valuesFiles: [],
};

const hasResRoot = existsSync(RES_ROOT);

if (hasResRoot) {
  const resFiles = walk(RES_ROOT, () => true);
  for (const f of resFiles) {
    const relParts = path.relative(RES_ROOT, f).split(path.sep);
    if (relParts.length < 2) continue;
    const dirName = relParts[0];
    const base = path.basename(f);
    const ext = path.extname(base).toLowerCase();
    const stem = base.slice(0, base.length - ext.length);

    if (dirName === 'values' || dirName.startsWith('values-')) {
      if (ext === '.xml') resIndex.valuesFiles.push(f);
      continue;
    }
    // drawable / drawable-hdpi / mipmap-* / layout / menu / xml / anim
    const family = dirName.split('-')[0];
    if (family === 'drawable' || family === 'mipmap') resIndex.drawable.add(stem);
    else if (family === 'layout') resIndex.layout.add(stem);
    else if (family === 'menu') resIndex.menu.add(stem);
    else if (family === 'xml') resIndex.xml.add(stem);
  }

  // values/*.xml 里的 string / id / color / style / dimen / array
  for (const vf of resIndex.valuesFiles) {
    let text = '';
    try {
      text = readFileSync(vf, 'utf8');
    } catch {
      continue;
    }
    const collect = (tag, set) => {
      const re = new RegExp(`<${tag}\\b[^>]*?\\bname\\s*=\\s*"([^"]+)"`, 'g');
      let m;
      while ((m = re.exec(text)) !== null) set.add(m[1]);
    };
    collect('string', resIndex.string);
    collect('color', resIndex.color);
    collect('style', resIndex.style);
    collect('dimen', resIndex.dimen);
    collect('integer', resIndex.dimen);
    collect('bool', resIndex.dimen);
    collect('string-array', resIndex.array);
    collect('integer-array', resIndex.array);
  }
}

// @+id/xxx 定义遍布所有 res/**.xml
if (hasResRoot) {
  for (const f of walk(RES_ROOT, (p) => p.toLowerCase().endsWith('.xml'))) {
    let text = '';
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const re = /@\+id\/([A-Za-z_][A-Za-z0-9_]*)/g;
    let m;
    while ((m = re.exec(text)) !== null) resIndex.id.add(m[1]);
  }
}

// ---------------------------------------------------------------------------
// 能力表：R.<type>.<name> → 应存在的资源
// ---------------------------------------------------------------------------

const RES_TYPES = {
  layout: { kind: 'layout', hint: 'app/src/main/res/layout/<name>.xml' },
  drawable: { kind: 'drawable', hint: 'app/src/main/res/drawable*/<name>.(xml|png|jpg|webp)' },
  mipmap: { kind: 'drawable', hint: 'app/src/main/res/mipmap*/<name>.(xml|png)' },
  menu: { kind: 'menu', hint: 'app/src/main/res/menu/<name>.xml' },
  xml: { kind: 'xml', hint: 'app/src/main/res/xml/<name>.xml' },
  string: { kind: 'string', hint: 'app/src/main/res/values/strings.xml 里 <string name="<name>">' },
  id: { kind: 'id', hint: '布局里 @+id/<name>' },
  color: { kind: 'color', hint: 'app/src/main/res/values/colors.xml 里 <color name="<name>">' },
  style: { kind: 'style', hint: 'app/src/main/res/values/themes.xml 里 <style name="<name>">' },
  dimen: { kind: 'dimen', hint: 'values 里 <dimen name="<name>">' },
  array: { kind: 'array', hint: 'values 里 <string-array name="<name>">' },
};

function resourceExists(kind, name) {
  switch (kind) {
    case 'layout':
      return resIndex.layout.has(name);
    case 'drawable':
      return resIndex.drawable.has(name);
    case 'menu':
      return resIndex.menu.has(name);
    case 'xml':
      return resIndex.xml.has(name);
    case 'string':
      return resIndex.string.has(name);
    case 'id':
      return resIndex.id.has(name);
    case 'color':
      return resIndex.color.has(name);
    case 'style':
      return resIndex.style.has(name);
    case 'dimen':
      return resIndex.dimen.has(name);
    case 'array':
      return resIndex.array.has(name);
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// 1~5) 扫描所有 .kt
// ---------------------------------------------------------------------------

const ktFiles = existsSync(JAVA_ROOT)
  ? walk(JAVA_ROOT, (p) => p.toLowerCase().endsWith('.kt')).sort()
  : [];

if (!existsSync(JAVA_ROOT)) {
  warn(JAVA_ROOT, 0, 'app/src/main/java 不存在（源码尚未生成？跳过 Kotlin 检查）');
}

let rRefCount = 0;
let importedFromForbidden = 0;
const classFilePaths = new Set(); // "com.pickupcode.app.ui.MainActivity" -> file
const declaredPackages = [];
const packageDirs = new Set();

for (const file of ktFiles) {
  fileCount++;
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch (e) {
    err(file, 0, `无法读取：${e.message}`);
    continue;
  }
  const stripped = stripCommentsAndStrings(src);
  const lines = src.split(/\r\n|\n|\r/);
  const strippedLines = stripped.split(/\r\n|\n|\r/);

  // --- BOM / 编码 ---
  if (src.charCodeAt(0) === 0xfeff) {
    warn(file, 1, '文件带 UTF-8 BOM，Gradle/Kotlin 编译通常可以处理，但建议去掉');
  }

  // --- package 声明与目录一致性 ---
  const pkgMatch = /^[ \t]*package\s+([A-Za-z_][A-Za-z0-9_.]*)/m.exec(stripped);
  if (!pkgMatch) {
    err(file, 1, '缺少 package 声明');
  } else {
    const pkg = pkgMatch[1];
    const pkgLine = lineOfIndex(stripped, pkgMatch.index);
    declaredPackages.push({ file, pkg, line: pkgLine });
    const dirOfFile = path.dirname(path.resolve(file));
    const expectDir = path.resolve(JAVA_ROOT, ...pkg.split('.'));
    packageDirs.add(`${expectDir}::${pkg}`);
    if (dirOfFile !== expectDir) {
      err(
        file,
        pkgLine,
        `package ${pkg} 与目录不一致；期望目录 ${rel(expectDir)}，实际 ${rel(dirOfFile)}`,
      );
    }
    // --- 记录顶层类名 → 文件，供 manifest 校验 ---
    const classRe = /^[ \t]*(?:@\w+(?:\([^)]*\))?[ \t]*)*(?:public\s+|internal\s+|private\s+|open\s+|abstract\s+|final\s+|sealed\s+|data\s+|enum\s+|annotation\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
    let cm;
    let foundAny = false;
    while ((cm = classRe.exec(stripped)) !== null) {
      foundAny = true;
      classFilePaths.add(`${pkg}.${cm[1]}`);
    }
    // object / interface 也可以作为 manifest 组件（少见但合法）
    const objRe = /^[ \t]*(?:@\w+(?:\([^)]*\))?[ \t]*)*(?:public\s+|internal\s+|private\s+)*object\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
    while ((cm = objRe.exec(stripped)) !== null) {
      foundAny = true;
      classFilePaths.add(`${pkg}.${cm[1]}`);
    }
    if (!foundAny) {
      warn(file, pkgLine, '未在文件中找到顶层 class/object 声明（若为纯顶层函数可忽略）');
    }
  }

  // --- 禁用 import ---
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*import\s+(?:static\s+)?([A-Za-z_][A-Za-z0-9_.]*)/.exec(strippedLines[i] ?? '');
    if (!m) continue;
    const fq = m[1];
    if (/^androidx\./.test(fq) || /^com\.google\./.test(fq) || /^kotlinx\./.test(fq)) {
      err(file, i + 1, `禁止的第三方 import：${fq}（契约要求零第三方依赖）`);
      importedFromForbidden++;
    }
  }

  // --- core/ 包禁止 import android.* ---
  if (/[\\/]core[\\/][^\\/]*\.kt$/.test(file)) {
    const re = /^\s*import\s+android\./gm;
    let am;
    while ((am = re.exec(stripped)) !== null) {
      err(file, lineOfIndex(stripped, am.index), 'core/ 下的文件为纯 Kotlin，禁止 import android.*');
    }
  }

  // --- R.<type>.<name> 引用 ---
  // 在 stripped（注释与字符串已剔除）上扫描，避免把字符串/注释里的 "R.string.x" 当成真引用。
  const rRe = /\bR\.([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let rm;
  while ((rm = rRe.exec(stripped)) !== null) {
    const type = rm[1];
    const name = rm[2];
    // 跳过 android.R.*（前面紧跟 android. 的仍会被 \bR\. 匹配到，需显式判断）
    const before = stripped.slice(Math.max(0, rm.index - 12), rm.index);
    if (/android\.$/.test(before)) continue;
    const line = lineOfIndex(stripped, rm.index);
    const spec = RES_TYPES[type];
    if (!spec) {
      warn(file, line, `引用了未检查的资源类型 R.${type}.${name}（脚本未覆盖该类型）`);
      continue;
    }
    rRefCount++;
    if (!resourceExists(spec.kind, name)) {
      err(file, line, `R.${type}.${name} 在 res 中不存在；应提供 ${spec.hint.replace(/<name>/g, name)}`);
    }
  }

  // --- 括号配平（粗略） ---
  const pairs = [
    ['{', '}'],
    ['(', ')'],
  ];
  for (const [open, close] of pairs) {
    let depth = 0;
    let minDepth = 0;
    let firstNegLine = 0;
    for (let i = 0; i < stripped.length; i++) {
      const ch = stripped[i];
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth < minDepth) {
          minDepth = depth;
          if (!firstNegLine) firstNegLine = lineOfIndex(stripped, i);
        }
      }
    }
    if (depth !== 0 || minDepth < 0) {
      const where = firstNegLine || lines.length;
      err(
        file,
        where,
        `括号粗略检查不配平：'${open}''${close}' 净差 ${depth}${minDepth < 0 ? `（第 ${firstNegLine} 行出现多余的 '${close}'）` : ''}。注：本检查为朴素计数，字符串/注释已剔除，仍可能有误报`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 2) AndroidManifest.xml 中的类名
// ---------------------------------------------------------------------------

let manifestChecked = 0;
const manifestClasses = [];
if (!existsSync(MANIFEST)) {
  warn(MANIFEST, 0, 'AndroidManifest.xml 不存在（尚未生成？跳过）');
} else {
  const mtext = readFileSync(MANIFEST, 'utf8');
  const mlines = mtext.split(/\r\n|\n|\r/);
  const nameRe = /android:name\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = nameRe.exec(mtext)) !== null) {
    const value = m[1].trim();
    const line = lineOfIndex(mtext, m.index);
    // 只看类名形态：以 . 开头，或形如 com.foo.Bar（含点且首字母大写的最后一段）
    if (!value.startsWith('.') && !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(value)) {
      continue; // 权限名、action 名等
    }
    if (/^android\.(permission|intent|hardware|software|settings)\./.test(value)) continue;
    let fq;
    if (value.startsWith('.')) {
      // 相对包名：用 manifest 的 package 属性（AGP 8 起通常没有 package，回退到 namespace）
      const pkgAttr = /<manifest[^>]*\bpackage\s*=\s*"([^"]+)"/.exec(mtext);
      const base = pkgAttr ? pkgAttr[1] : 'com.pickupcode.app';
      fq = base + value;
    } else {
      fq = value;
    }
    if (!/^(android|java|kotlin|androidx)\b/.test(fq)) {
      manifestClasses.push({ fq, line, value });
    }
  }

  for (const { fq, line, value } of manifestClasses) {
    manifestChecked++;
    if (classFilePaths.has(fq)) continue;
    const guess = path.join(JAVA_ROOT, ...fq.split('.')) + '.kt';
    if (existsSync(guess)) continue;
    // 也可能类名与文件名不同：退化为「同包目录下是否存在声明该类的文件」
    const pkgDir = path.join(JAVA_ROOT, ...fq.split('.').slice(0, -1));
    const simple = fq.split('.').pop();
    const found = walk(pkgDir, (p) => p.endsWith('.kt')).some((p) => {
      try {
        return new RegExp(`\\b(?:class|object|interface)\\s+${simple}\\b`).test(readFileSync(p, 'utf8'));
      } catch {
        return false;
      }
    });
    if (!found) {
      err(MANIFEST, line, `android:name="${value}" → ${fq} 找不到对应 .kt（期望 ${rel(guess)}）`);
    }
  }
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const notes = [];
if (!hasResRoot) notes.push('res 目录不存在，资源引用无法校验（源码尚未生成时属正常）');

for (const line of errors) console.log(line);
for (const line of warnings) console.log(line);

console.log('');
console.log('--- 检查范围 ---');
console.log(`Kotlin 文件        : ${fileCount}`);
console.log(`R.* 资源引用       : ${rRefCount}`);
console.log(`Manifest 组件类    : ${manifestChecked}`);
console.log(`资源索引           : layout=${resIndex.layout.size} drawable/mipmap=${resIndex.drawable.size} menu=${resIndex.menu.size} xml=${resIndex.xml.size} string=${resIndex.string.size} id=${resIndex.id.size} color=${resIndex.color.size} style=${resIndex.style.size}`);
console.log(`禁用 import 命中   : ${importedFromForbidden}`);
console.log('注：括号检查为朴素计数（注释/字符串已剔除），可能出现误报，请人工确认。');
for (const n of notes) console.log(`注：${n}`);
console.log('');
console.log(`CHECKED ${fileCount} files, ERRORS ${errors.length}, WARNINGS ${warnings.length}`);

process.exit(errors.length > 0 ? 1 : 0);
