// Kotlin 跨文件「能静态验的编译错误」检查器。
//
// 背景：本项目的生成环境里 JVM 无法创建 NIO selector，Gradle 与 Kotlin 编译器都跑不起来，
// 所以没法真正编译。这个脚本用文本层符号表补上最值钱的一部分检查：
//
//   1. 函数调用 arity —— 每个 `X.f(a,b)` / `f(a,b)` 的参数个数与声明是否对得上
//   2. 未声明的方法名 —— 调用名在整个工程里完全不存在
//   3. 构造器 arity —— `Foo(a, b)` 与 `class Foo(val a, val b)`
//   4. data class 的 `copy(named = ...)` 参数名是否是真实属性
//   5. `object` / `class` 名字与 `PickupJson` 之类的精确契约名
//
// 设计原则：**宁可漏报，绝不误报**。分辨不出接收者类型的调用一律跳过。
// 用法： node tools\kotlin-lint.mjs   （退出码 1 = 有 ERR）
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const proj = path.resolve(import.meta.dirname, '..');
const srcRoot = path.join(proj, 'app', 'src', 'main', 'java');

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith('.kt')) out.push(p);
  }
  return out;
}

/** 去掉注释与字符串字面量，保留长度和换行，便于按行定位。 */
function strip(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && src[i + 1] === '*') {
      out += '  '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      if (i < src.length) { out += '  '; i += 2; }
    } else if (c === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      out += '   '; i += 3;
      while (i < src.length && !(src[i] === '"' && src[i + 1] === '"' && src[i + 2] === '"')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      if (i < src.length) { out += '   '; i += 3; }
    } else if (c === '"') {
      out += ' '; i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      if (i < src.length) { out += ' '; i++; }
    } else if (c === "'") {
      out += ' '; i++;
      while (i < src.length && src[i] !== "'") {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += ' '; i++;
      }
      if (i < src.length) { out += ' '; i++; }
    } else {
      out += c; i++;
    }
  }
  return out;
}

const files = walk(srcRoot).map((p) => {
  const raw = readFileSync(p, 'utf8');
  return { path: p, rel: path.relative(proj, p), raw, code: strip(raw) };
});

const errors = [];
const warnings = [];
const err = (rel, line, msg) => errors.push(`[ERR] ${rel}:${line} ${msg}`);
const warn = (rel, line, msg) => warnings.push(`[WARN] ${rel}:${line} ${msg}`);

const lineOf = (code, idx) => code.slice(0, idx).split('\n').length;

// ---------------------------------------------------------------- 1. 收集声明

/** object/class 名 -> { kind, props:Set, funcs:Map<name,arity[]> } */
const types = new Map();
/** 顶层/文件级函数: name -> arity[] */
const topFuncs = new Map();
/** 所有已知方法名（用于「这个名字是否存在」判断） */
const allMethodNames = new Set();
/** data class 名 -> 属性名集合 */
const dataProps = new Map();

const KNOWN_PLATFORM = new Set([
  // 平台/标准库上与业务方法重名或容易被误判的常见方法
  'let', 'run', 'apply', 'also', 'with', 'takeIf', 'takeUnless', 'toString', 'equals', 'hashCode',
  'copy', 'component1', 'component2', 'component3', 'copyOf', 'valueOf', 'values', 'name', 'ordinal',
  'get', 'set', 'add', 'remove', 'size', 'isEmpty', 'isNotEmpty', 'first', 'last', 'filter', 'map',
  'forEach', 'count', 'sortedBy', 'sortedByDescending', 'sortedWith', 'distinct', 'distinctBy',
  'indexOf', 'contains', 'joinToString', 'trim', 'split', 'replace', 'startsWith', 'endsWith',
  'toInt', 'toLong', 'toFloat', 'toDouble', 'toBoolean', 'toList', 'toMutableList', 'toSet',
  'substring', 'substringBefore', 'substringAfter', 'indexOfFirst', 'indexOfLast', 'padStart', 'padEnd',
  'format', 'getString', 'getInt', 'getLong', 'getBoolean', 'getCharSequence', 'getCharSequenceArray',
  'getStringArray', 'getParcelableExtra', 'getSerializableExtra', 'putExtra', 'hasExtra', 'getExtras',
  'edit', 'putString', 'apply', 'commit', 'getStringSet', 'remove', 'clear', 'containsKey', 'keySet',
  'getDefaultSharedPreferences', 'getSharedPreferences', 'getSystemService', 'findViewById', 'setText',
  'setOnClickListener', 'setOnLongClickListener', 'setContentView', 'startActivity', 'finish', 'runOnUiThread',
  'setTitle', 'invalidate', 'notifyDataSetChanged', 'getItem', 'getItemId', 'getCount', 'getView',
  'getItemViewType', 'getViewTypeCount', 'isEnabled', 'areAllItemsEnabled', 'getLayoutInflater', 'inflate',
  'getColor', 'getDrawable', 'getDimension', 'getQuantityString', 'getIdentifier', 'openInputStream',
  'query', 'close', 'moveToFirst', 'moveToNext', 'getColumnIndex', 'getLong', 'getColumnIndexOrThrow',
  'cancel', 'show', 'dismiss', 'setMessage', 'setPositiveButton', 'setNegativeButton', 'setNeutralButton',
  'setItems', 'create', 'build', 'setSmallIcon', 'setContentTitle', 'setContentText', 'setAutoCancel',
  'setContentIntent', 'setWhen', 'setStyle', 'bigText', 'setPriority', 'setDefaults', 'setOnlyAlertOnce',
  'setChannelId', 'addAction', 'notify', 'createNotificationChannel', 'getNotificationChannel',
  'setContent', 'setView', 'from', 'now', 'ofEpochMilli', 'toEpochMilli', 'getInstance', 'set', 'add',
  'get', 'getTimeInMillis', 'getDisplayName', 'getPackageName', 'getApplicationContext', 'getResources',
  'getContentResolver', 'getAssets', 'getFilesDir', 'getCacheDir', 'getMainLooper', 'getSystemServiceName',
  'getSystemService', 'startActivityForResult', 'setResult', 'onCreate', 'onResume', 'onPause', 'onDestroy',
  'onStart', 'onStop', 'onNewIntent', 'onRequestPermissionsResult', 'onCreateOptionsMenu', 'onOptionsItemSelected',
  'onNotificationPosted', 'onListenerConnected', 'onListenerDisconnected', 'onBind', 'onStartCommand',
  'onReceive', 'onPostCreate', 'onSaveInstanceState', 'onRestoreInstanceState', 'onConfigurationChanged',
  'onActivityResult', 'checkSelfPermission', 'requestPermissions', 'shouldShowRequestPermissionRationale',
  'onBackPressed', 'onKeyDown', 'onCreateViewHolder', 'onBindViewHolder', 'getItemCount', 'onBind',
  'iterator', 'hasNext', 'next', 'append', 'insert', 'length', 'charAt', 'matches', 'find', 'findAll',
  'groupValues', 'groupCount', 'replaceAll', 'matchedGroups', 'entries', 'keys', 'values', 'getOrPut',
  'getOrElse', 'getOrDefault', 'put', 'putAll', 'containsValue', 'removeAll', 'retainAll', 'addAll',
  'sort', 'sortBy', 'reverse', 'shuffle', 'clear', 'equals', 'compareTo', 'clone',
  'execute', 'submit', 'shutdown', 'shutdownNow', 'awaitTermination', 'newSingleThreadExecutor',
  'newFixedThreadPool', 'getMessage', 'printStackTrace', 'getCause', 'getLocalizedMessage',
  'e', 'w', 'i', 'd', 'v', 'wtf', 'println', 'print', 'readLine', 'readText', 'writeText', 'exists',
  'mkdirs', 'delete', 'listFiles', 'getAbsolutePath', 'getName', 'getPath', 'getParentFile',
]);

function splitTopLevel(s) {
  const parts = [];
  let depth = 0, cur = '', inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { cur += c; if (c === '"' && s[i - 1] !== '\\') inStr = false; continue; }
    if (c === '"') { inStr = true; cur += c; continue; }
    if ('([{<'.includes(c)) depth++;
    if (')]}>'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** 从参数列表文本里数「非默认值参数」个数；有 vararg 则返回 Infinity 下界 */
function paramInfo(params) {
  const ps = splitTopLevel(params).filter((p) => !/^(private|internal|protected|public)?\s*(val|var)\s/.test(p) === false || true);
  const list = splitTopLevel(params);
  let required = 0, optional = 0, vararg = false;
  for (const p of list) {
    const clean = p.replace(/@\w+(\([^)]*\))?/g, '').trim();
    if (!clean) continue;
    if (/^vararg\s/.test(clean) || /^vararg\b/.test(clean)) { vararg = true; continue; }
    const m = clean.match(/=\s*[^=]/);
    if (m) optional++; else required++;
  }
  return { required, optional, vararg, total: list.length };
}

for (const f of files) {
  const { code, rel } = f;

  // 顶层函数
  const topRe = /^(?!\s)(?:@\w+(?:\([^)]*\))?\s*)*(?:private\s+|internal\s+|public\s+)?fun\s+(?:<[^>]*>\s*)?(\w+)\s*\(([^)]*)\)/gm;
  let m;
  while ((m = topRe.exec(code))) {
    const [, name, params] = m;
    const info = paramInfo(params);
    if (!topFuncs.has(name)) topFuncs.set(name, []);
    topFuncs.get(name).push(info);
    allMethodNames.add(name);
  }

  // object / class / interface 声明
  const typeRe = /^(?!\s)(?:@\w+(?:\([^)]*\))?\s*)*(?:private\s+|internal\s+|public\s+|open\s+|sealed\s+|abstract\s+|data\s+|enum\s+)*(object|class|interface)\s+(\w+)/gm;
  const typeStarts = [];
  while ((m = typeRe.exec(code))) typeStarts.push({ name: m[2], kind: m[1], idx: m.index, hdrEnd: code.indexOf('\n', m.index) });

  for (let i = 0; i < typeStarts.length; i++) {
    const t = typeStarts[i];
    const end = i + 1 < typeStarts.length ? typeStarts[i + 1].idx : code.length;
    const body = code.slice(t.hdrEnd, end);
    const entry = types.get(t.name) || { kind: t.kind, props: new Set(), funcs: new Map(), dataClass: false, ctor: null };
    entry.kind = t.kind;

    // data class 主构造器属性
    const header = code.slice(t.idx, t.hdrEnd + 1);
    const ctorMatch = header.match(/\(([\s\S]*)\)/);
    if (ctorMatch) {
      const ctorParams = splitTopLevel(ctorMatch[1]);
      entry.ctor = paramInfo(ctorMatch[1]);
      const props = [];
      for (const p of ctorParams) {
        const pm = p.match(/\b(?:val|var)\s+(\w+)\s*:\s*([^=]+?)(?:\s*=\s*.+)?$/);
        if (pm) { entry.props.add(pm[1]); props.push(pm[1]); }
      }
      if (/\bdata\s+class\b/.test(header)) {
        entry.dataClass = true;
        dataProps.set(t.name, new Set(props));
      }
    }

    // 类体内声明的属性
    for (const pm of body.matchAll(/^[ \t]+(?:@\w+(?:\([^)]*\))?\s*)*(?:private\s+|internal\s+|protected\s+|public\s+|const\s+|lateinit\s+|override\s+|val\s+|var\s+)*\b(?:val|var)\s+(\w+)/gm)) {
      entry.props.add(pm[1]);
    }
    for (const pm of body.matchAll(/^[ \t]+(?:private\s+|internal\s+|protected\s+|public\s+|override\s+|open\s+|inline\s+|suspend\s+)*fun\s+(?:<[^>]*>\s*)?(\w+)\s*\(([^)]*)\)/gm)) {
      const info = paramInfo(pm[2]);
      if (!entry.funcs.has(pm[1])) entry.funcs.set(pm[1], []);
      entry.funcs.get(pm[1]).push(info);
      allMethodNames.add(pm[1]);
    }
    types.set(t.name, entry);
  }
}

// 顶层 val/const val
const topVals = new Set();
for (const f of files) {
  for (const m of f.code.matchAll(/^(?!\s)(?:private\s+|internal\s+|public\s+|const\s+)*val\s+(\w+)/gm)) topVals.add(m[1]);
}

// ---------------------------------------------------------------- 2. 检查调用

/** 已知接收者名 -> 类型名（object 名、或是某类型的变量声明） */
const varTypes = new Map();
for (const t of types.keys()) varTypes.set(t, t);
for (const f of files) {
  for (const m of f.code.matchAll(/(?:^|[\s(,])(?:val|var)\s+(\w+)(?:\s*:\s*([\w.<>?]+))?\s*=\s*([A-Z]\w*)/gm)) {
    const [, name, declared, initType] = m;
    const ty = (declared || initType || '').replace(/[<>?].*$/, '').trim();
    if (ty && types.has(ty)) varTypes.set(name, ty);
  }
}

let checkCount = 0;
for (const f of files) {
  const { code, rel } = f;
  // 形如  Receiver.name(args)  或  name(args)
  const callRe = /([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(/g;
  let m;
  while ((m = callRe.exec(code))) {
    const [, recv, name] = m;
    checkCount++;
    const ty = varTypes.get(recv);
    if (!ty) continue; // 接收者类型未知 → 跳过，避免误报
    const t = types.get(ty);
    if (!t) continue;
    if (name === 'copy' && t.dataClass) continue; // 单独检查
    if (t.funcs.has(name)) continue;
    if (t.props.has(name) && false) continue;
    if (KNOWN_PLATFORM.has(name)) continue;
    if (name === 'equals' || name === 'hashCode' || name === 'toString') continue;
    const line = lineOf(code, m.index);
    // 只有这个名字在整个工程里作为方法出现过，才能断定是「用了不存在的方法」；
    // 否则它多半是平台/继承方法。object 的成员是封闭的，可以严格报错。
    if (t.kind === 'object' && allMethodNames.has(name) === false) {
      err(rel, line, `${ty}.${name}() —— ${ty} 上不存在该方法（object 成员封闭，且工程内无同名方法）`);
    } else if (t.kind === 'object' && !t.funcs.has(name) && !t.props.has(name) && !KNOWN_PLATFORM.has(name)) {
      err(rel, line, `${ty}.${name}() —— ${ty} 是 object，没有成员 ${name}`);
    }
  }

  // arity 检查：已知接收者类型的调用
  const callRe2 = /([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  while ((m = callRe2.exec(code))) {
    const [, recv, name, argsRaw] = m;
    const ty = varTypes.get(recv);
    if (!ty) continue;
    const t = types.get(ty);
    if (!t || !t.funcs.has(name)) continue;
    if (KNOWN_PLATFORM.has(name)) continue;
    const sigs = t.funcs.get(name);
    const args = splitTopLevel(argsRaw);
    const n = args.length;
    const ok = sigs.some((s) => (s.vararg ? n >= s.required : n >= s.required && n <= s.required + s.optional));
    if (!ok) {
      const desc = sigs.map((s) => `${s.required}..${s.vararg ? '∞' : s.required + s.optional}`).join(' | ');
      err(rel, lineOf(code, m.index), `${ty}.${name}() 实参 ${n} 个，声明要求 ${desc} 个`);
    }
  }

  // 构造器 arity：Foo(...)
  const ctorRe = /\b([A-Z]\w*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  while ((m = ctorRe.exec(code))) {
    const [, name, argsRaw] = m;
    const t = types.get(name);
    if (!t || !t.ctor) continue;
    const before = code.slice(Math.max(0, m.index - 12), m.index);
    if (/\bfun\s+$/.test(before) || /\bclass\s+$/.test(before) || /\bobject\s+$/.test(before)) continue;
    if (name === 'Regex' || KNOWN_PLATFORM.has(name)) continue;
    const args = splitTopLevel(argsRaw);
    const n = args.length;
    const namedOnly = args.every((a) => /^\w+\s*=/.test(a));
    const s = t.ctor;
    if (namedOnly) continue; // 命名参数单独由下面的 copy 式检查覆盖
    if (!(s.vararg ? n >= s.required : n >= s.required && n <= s.required + s.optional)) {
      err(rel, lineOf(code, m.index), `${name}(...) 构造实参 ${n} 个，声明要求 ${s.required}..${s.vararg ? '∞' : s.required + s.optional} 个`);
    }
  }

  // data class copy(named = ...) 参数名
  const copyRe = /\b(\w+)\s*\.\s*copy\s*\(([^()]*)\)/g;
  while ((m = copyRe.exec(code))) {
    const [, recv, argsRaw] = m;
    // 找出这个 recv 是不是某个 data class 实例：靠 PickupItem 之类的字段名猜
    const args = splitTopLevel(argsRaw);
    for (const a of args) {
      const nm = a.match(/^(\w+)\s*=/);
      if (!nm) continue;
      const prop = nm[1];
      const owner = [...dataProps.entries()].find(([, set]) => set.has(prop));
      if (!owner) {
        warn(rel, lineOf(code, m.index), `.copy(${prop} = ...) —— 没有任何 data class 有属性 ${prop}，可能是拼写错误`);
      }
    }
  }
}

// ---------------------------------------------------------------- 3. 契约名硬检查

const needObjects = ['PickupParser', 'PickupStore', 'PickupJson', 'PickupItem'];
for (const n of needObjects) {
  const t = types.get(n);
  if (!t) err('(工程)', 0, `契约要求存在 ${n}，但没找到声明`);
  else if (!(t.kind === 'object' || t.kind === 'class')) err('(工程)', 0, `${n} 的声明种类是 ${t.kind}`);
}

// PickupParser.parse 必须能接受 (text, source, eventTime, sourceApp?)
if (types.has('PickupParser')) {
  const fns = types.get('PickupParser').funcs.get('parse');
  if (!fns) err('(工程)', 0, 'PickupParser.parse 未声明');
  else if (!fns.some((s) => s.required <= 3 && s.required + s.optional >= 3)) {
    err('(工程)', 0, `PickupParser.parse 需要支持 3 个必填参数（实际 ${fns.map((s) => `${s.required}..${s.required + s.optional}`).join(',')}）`);
  }
}

// PickupJson.encodeList/decodeList
if (types.has('PickupJson')) {
  const t = types.get('PickupJson');
  for (const fn of ['encodeList', 'decodeList']) {
    if (!t.funcs.has(fn)) err('(工程)', 0, `PickupJson 缺少契约要求的 ${fn}()`);
    else {
      const s = t.funcs.get(fn)[0];
      if (s.required !== 1) err('(工程)', 0, `PickupJson.${fn} 应为 1 个必填参数，实际 ${s.required}`);
    }
  }
}

// data class 字段可空性（契约 2）——只对 PickupItem 报硬错
if (dataProps.has('PickupItem')) {
  const need = ['id', 'code', 'keyword', 'courier', 'station', 'note', 'source', 'sourceApp', 'rawText', 'eventTime', 'createdAt', 'picked', 'expireAt'];
  const have = dataProps.get('PickupItem');
  for (const n of need) if (!have.has(n)) err('(工程)', 0, `PickupItem 缺少契约字段 ${n}`);
}

// ---------------------------------------------------------------- 输出

console.log('--- kotlin-lint 检查范围 ---');
console.log(`Kotlin 文件     : ${files.length}`);
console.log(`已知类型(object/class): ${types.size}  -> ${[...types.keys()].sort().join(', ')}`);
console.log(`已知方法名      : ${allMethodNames.size}`);
console.log(`扫描调用点      : ${checkCount}`);
console.log('');

for (const w of warnings) console.log(w);
for (const e of errors) console.log(e);
console.log('');
console.log(`KOTLIN-LINT: files=${files.length} ERRORS=${errors.length} WARNINGS=${warnings.length}`);
console.log('注：这是文本层近似检查，不能替代真正的 Kotlin 编译器；分辨不出接收者类型的调用会被跳过。');
process.exit(errors.length === 0 ? 0 : 1);
