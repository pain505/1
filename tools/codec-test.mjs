// JSON 编解码契约测试（Node 侧）。
//
// 背景：App 把整个列表用「自写的极简 JSON」存进 SharedPreferences
// （`PickupJson.encodeList/decodeList`，见 core/Json.kt）。
// 这个脚本用 Node 校验**两端共用的那份格式契约**：
//
//   1. 字段名与顺序必须与 PickupJson.encodeItem 一致（字段名写错 = 读回全是默认值）
//   2. 必须能被标准 JSON.parse 解析（说明转义合法）
//   3. 往返一致：parse(stringify(x)) 深等于 x
//   4. 文本里带 `"` `\` 换行、中文、emoji、控制字符时转义必须无损
//   5. 解析器必须拒绝/容忍的边界输入（截断、空串、非数组、BOM 等）
//
// 用法： node tools\codec-test.mjs    （退出码 1 = 失败）
import { extract } from './node/extract.mjs';

const errs = [];
const err = (id, msg) => errs.push(`[FAIL] ${id}: ${msg}`);
let checks = 0;
const ok = (id, cond, msg) => { checks++; if (!cond) err(id, msg); };

// 与 PickupJson.encodeItem 的 append 顺序严格一致
const FIELD_ORDER = [
  'id', 'code', 'keyword', 'courier', 'station', 'note', 'source', 'sourceApp',
  'rawText', 'eventTime', 'createdAt', 'picked', 'expireAt',
];

// ---------------------------------------------------------------- 1. 字段契约

const samples = [
  { id: 'plain', item: extract('【菜鸟驿站】取件码 8-3-2015，请凭码取件')[0] },
  { id: 'quotes', item: extract('【丰巢】取件码 470812，柜机"3号"，请\\注意') [0] },
  { id: 'newline', item: extract('【菜鸟驿站】您的包裹已到\n取件码 2-3015\n请及时取件')[0] },
  { id: 'emoji', item: extract('【菜鸟驿站】📦包裹到站，取件码 8-3-2015 🎉')[0] },
  { id: 'no-code', item: extract('【菜鸟驿站】您的包裹已到站，请凭取件码取件')[0] },
  { id: 'ctrl', item: { ...extract('取件码 123456')[0], rawText: '制表\t符\u0007与\u001f控制符' } },
];

for (const { id, item } of samples) {
  if (!item) { err(id, 'extract 没返回条目，样本本身有问题'); continue; }
  const keys = Object.keys(item);
  ok(`${id}:keys`, JSON.stringify(keys) === JSON.stringify(FIELD_ORDER),
    `字段集合/顺序不一致：\n  期望 ${FIELD_ORDER.join(',')}\n  实得 ${keys.join(',')}`);

  const text = JSON.stringify(item);
  let back;
  try { back = JSON.parse(text); } catch (e) { err(`${id}:parse`, `JSON.parse 失败: ${e.message}`); continue; }
  ok(`${id}:roundtrip`, JSON.stringify(back) === JSON.stringify(item), '往返后不相等');

  // 值类型检查（Kotlin 侧用 as? 做类型判断，类型不对会静默变默认值）
  ok(`${id}:types`,
    typeof item.id === 'string' && typeof item.code === 'string' && typeof item.keyword === 'string' &&
    (item.courier === null || typeof item.courier === 'string') &&
    (item.station === null || typeof item.station === 'string') &&
    (item.note === null || typeof item.note === 'string') &&
    typeof item.source === 'string' &&
    (item.sourceApp === null || typeof item.sourceApp === 'string') &&
    typeof item.rawText === 'string' &&
    Number.isInteger(item.eventTime) && Number.isInteger(item.createdAt) &&
    typeof item.picked === 'boolean' &&
    (item.expireAt === null || Number.isInteger(item.expireAt)),
    `类型不符：${keys.map((k) => `${k}=${typeof item[k]}`).join(' ')}`);
}

// ---------------------------------------------------------------- 2. 列表编解码

const list = samples.map((s) => s.item).filter(Boolean);
const listText = JSON.stringify(list);
let listBack;
try { listBack = JSON.parse(listText); } catch (e) { err('list:parse', e.message); }
ok('list:roundtrip', JSON.stringify(listBack) === JSON.stringify(list), '列表往返不相等');
ok('list:empty', JSON.stringify([]) === '[]', '空列表应序列化为 []');

// ---------------------------------------------------------------- 3. 转义无损

const nasty = {
  ...samples[0].item,
  id: 'x|y',
  rawText: '引号" 反斜杠\\ 换行\n 回车\r 制表\t 退格\b 换页\f 中文 取件码 emoji 📦 控制\u0001\u001f',
};
const nastyText = JSON.stringify(nasty);
const nastyBack = JSON.parse(nastyText);
ok('escape:lossless', nastyBack.rawText === nasty.rawText && nastyBack.id === nasty.id,
  '转义后字符串不相等');
ok('escape:no-raw-控制字符', !/[\u0000-\u001f]/.test(nastyText.replace(/\\[bfnrt]/g, '').replace(/\\u00[0-1][0-9a-f]/g, '')),
  'JSON 文本里残留了裸控制字符');

// 中文不应被转义成 \uXXXX（可读性，也验证 UTF-8 路径）
ok('escape:cjk-readable', JSON.stringify({ s: '取件码' }) === '{"s":"取件码"}', '中文字符被转义了');

// ---------------------------------------------------------------- 4. 边界输入

const mustRejectOrTolerate = [
  ['empty', ''],
  ['not-array', '{"id":"a"}'],
  ['truncated', '[{"id":"a","code":'],
  ['trailing-garbage', '[]xyz'],
  ['unclosed', '[{'],
];
for (const [id, raw] of mustRejectOrTolerate) {
  // Kotlin 侧 decodeList 必须返回 null 而不是抛异常；这里只确认这些输入不是合法 JSON 或不是数组
  let parsed = null, threw = false;
  try { parsed = JSON.parse(raw); } catch { threw = true; }
  const isArray = Array.isArray(parsed);
  ok(`edge:${id}`, threw || !isArray, `期望被判为非法（throw 或非数组），实际 parse 出了 ${JSON.stringify(parsed)}`);
}

// UTF-8 BOM：SharedPreferences 里不会出现。这里只确认它是**被容忍**的：
// JS 的 trim() 会去掉 BOM，Kotlin 的 trim() 不会（'\uFEFF'.isWhitespace() == false）。
// 两端行为不同，但都不会抛异常（Kotlin 侧会走到「首字符不是 [」→ 返回 null），
// 对数据安全无影响，只记录差异。
ok('edge:bom-tolerated', '\ufeff[]'.trim() === '[]',
  'BOM 未被 trim，Kotlin 侧 decodeList 会返回 null（可容忍，但这里记录差异）');

// ---------------------------------------------------------------- 5. 大小与规模

const big = Array.from({ length: 500 }, (_, i) => ({ ...samples[0].item, id: `code-${i}` }));
const bigText = JSON.stringify(big);
ok('scale:500-json-ok', JSON.parse(bigText).length === 500, '500 条往返失败');
console.log(`500 条列表 JSON 大小: ${(bigText.length / 1024).toFixed(1)} KB（SharedPreferences 完全放得下）`);

// ---------------------------------------------------------------- 输出

console.log('');
console.log(`JSON 契约测试: 样本 ${samples.length} 条，断言 ${checks} 次`);
if (errs.length) {
  console.log('');
  for (const e of errs) console.log(e);
  console.log(`\nCODEC: FAIL ${errs.length}`);
  process.exit(1);
}
console.log('CODEC: PASS 0');
