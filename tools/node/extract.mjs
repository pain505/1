/**
 * 取件码解析核心 — Node 镜像实现（离线验证用）
 *
 * CONTRACT.md 第 3 节（v2）的逐条实现，必须与
 * app/src/main/java/com/pickupcode/app/core/PickupParser.kt 行为一致：
 * 正则字面量、判断顺序、窗口大小、黑名单、权重表 全部一一对应。
 *
 * 契约内部矛盾的取舍（最终回复里说明）：
 *   1. §3.2 权重表把「提货码」同时列在 100 与 90 两行 → 取重复关键词的最大权重，=100。
 *   2. §3.3「±20 字符窗口」与 §3.5「同一文本最多 6 个」冲突（6 个码排不下 20 字），
 *      取码时按 6 个码的实际跨度放宽窗口，最终仍由 §3.5 截断到 6。
 *   3. §3.7 station 的 `品牌[（(]名字[）)]` 在真实文案里品牌与括号之间常夹设施类型
 *      （「丰巢快递柜(中兴路店)」「顺丰驿站(高新四路店)」），补一条允许 0~6 字间隔的
 *      变体；原始字面量仍然优先。
 *
 * 导出：extract / normalize / detectCourier / toHalfWidth / findCodes / KEYWORD_WEIGHTS
 */

// ---------------------------------------------------------------------------
// 关键词权重表（契约 3.2）
// ---------------------------------------------------------------------------
export const KEYWORD_WEIGHTS = new Map([
  // 100 档
  ['取件码', 100],
  ['取货码', 100],
  ['提货码', 100], // 契约表格中重复出现（100 / 90），取最大值 100
  ['取货号', 100],
  ['取件号', 100],
  ['取件编码', 100],
  ['取包裹码', 100],
  // 90 档
  ['取件密码', 90],
  ['开门码', 90],
  ['开柜码', 90],
  // 80 档
  ['包裹码', 80],
  ['快件码', 80],
  // 50 档（带附加条件，见 3.2）
  ['验证码', 50],
]);

/** 验证码只有在同文出现这些词之一时才算取件关键词（契约 3.2） */
const VERIFY_HINTS = /快递柜|驿站|取件|包裹/;

/** 全部关键词，按长度倒序（3.2「命中最长者优先」） */
const ALL_KEYWORDS = [...KEYWORD_WEIGHTS.keys()].sort((a, b) => b.length - a.length);

/** 网点词：4~5 位码规则（3.3-5）与补充规则需要 */
const SITE_WORDS = /快递柜|驿站|超市|代收点|菜鸟|丰巢|速递易|自提柜|智能柜|门卫|物业|便利店/;

/** 3.4 保留号 */
const RESERVED_NUMBERS = new Set([
  '11183', '11185', '95554', '95338', '4001', '10086', '10010', '10000', '12305', '95311',
]);

/** 3.4.4 强取件特征（出现即可豁免 3.4.3 消息级黑名单） */
const STRONG_FEATURES = /取件码|取货码|提货码|取件号|凭码|货架号|柜号|驿站|快递柜|丰巢|菜鸟|兔喜|妈妈驿站/;

/** 3.4.3 消息级黑名单 */
const BLACKLIST_GENERIC = /余额|话费|流量|积分|账单|消费|扣费|充值|还款|信用卡|贷款|中奖|领取优惠券|点击链接|退订|外卖|已送达|送达时间|骑手|点餐/;
const BLACKLIST_VERIFY = /验证码/;
const BLACKLIST_CARRIER = /955\d{2}|10086|10010|10000|106\d{8}/;

/** 3.4.2 货架号类正向前缀（优先于 3.4.1 的「号」排除） */
const SHELF_PREFIX = /货架号|货架|柜号|柜子号|箱号|编号|格口/;

/** 3.5 cluster 分隔符 */
const CLUSTER_SEP = /[,，、;；\s]+/;

/** 3.2 关键词 / 3.4.4 特征 / 动作词 —— 3.4.5 兜底评分用 */
const ACTION_WORDS = /领取|取出|凭|取件|取货|及时|尽快|速取|出示/;

const MAX_CODES_PER_TEXT = 6; // 契约 3.5

// ---------------------------------------------------------------------------
// 3.1 全角转半角
// ---------------------------------------------------------------------------

/** 字符级归一：U+FF01..U+FF5E 减 0xFEE0；U+3000 -> 空格。 */
export function toHalfWidth(s) {
  if (!s) return '';
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0xff01 && c <= 0xff5e) out += String.fromCodePoint(c - 0xfee0);
    else if (c === 0x3000) out += ' ';
    else out += ch;
  }
  return out;
}

/** 契约 3 的 normalize：先去空白 / 全角转半角 / 小写，再去 () （） 空格 连字符与点 */
export function normalize(s) {
  if (s === null || s === undefined) return '';
  return toHalfWidth(String(s))
    .replace(/\s+/g, '')
    .toLowerCase()
    .replace(/[()（）\s\-.]/g, '');
}

/**
 * 清掉短信正文外层被自动加上的引号。
 *
 * 背景：Android 短信 App（如 Google Messages）对以 `【` 开头的正文会自动加英文双引号，
 * 存进收件箱的内容就变成 `"【菜鸟驿站】…取件码 8-3-2015…"`。
 * 实测在模拟器上确认过：不清掉的话，「查看原文」「复制原文」都会带引号，看起来像乱码。
 *
 * 只清**成对**的首尾引号，且首尾必须是同一种引号，避免误伤正文里正常出现的引号。
 * 与 Kotlin 版 PickupParser.stripWrappingQuotes 逐字对应。
 */
export function stripWrappingQuotes(s) {
  let t = (s === null || s === undefined ? '' : String(s)).trim();
  const pairs = [
    ['"', '"'],
    ['\u201C', '\u201D'], // “ ”
    ['\u300C', '\u300D'], // 「 」
    ["'", "'"],
  ];
  let changed = true;
  while (changed && t.length >= 2) {
    changed = false;
    for (const [open, close] of pairs) {
      if (t[0] === open && t[t.length - 1] === close) {
        t = t.slice(1, -1).trim();
        changed = true;
      }
    }
  }
  return t;
}

// ---------------------------------------------------------------------------
// 3.3.0 码形定义（所有取值规则共用）
// ---------------------------------------------------------------------------

/** 连字符码形（2~4 段）：8-3-2015 / H-01485 / D4-7048 / 5-5-9-13 / 2-3-05025 / 109-6-4006 */
const HYPHEN_TEXT = '[A-Za-z0-9]{1,6}(?:-[A-Za-z0-9]{1,6}){1,3}';

/** 扫描用的 token 正则：先试连字符码形，再退到字母数字码形。
 *  整条用 `(?<![0-9A-Za-z-])...` 锁住左边界——否则 `5-5-9-13` 会先退化成 `5-5-9` 被吃掉。 */
const TOKEN_RE = new RegExp(`(?<![0-9A-Za-z-])(${HYPHEN_TEXT})|(?<![0-9A-Za-z])([A-Za-z]?\\d{3,9})`, 'g');

/**
 * 逐段校验连字符码形（契约 3.3.0 + 3.4.1）。
 * 契约的字面量 `[A-Za-z]?\d{1,6}` 只做形状匹配，会把裸日期 `2024-06-15` 吃进来，
 * 所以这里加一条**日期形状排除**（不改码形定义，只做形状校验）：
 * 首段是 4 位数字、其后跟着 1~2 位段 → 判为日期。
 * 真实码形 8-3-2015 / H-01485 / D4-7048 / 5-5-9-13 / 2-3-05025 / 109-6-4006 / 0614-056 全部通过。
 */
export function isHyphenCode(token) {
  if (!token.includes('-')) return false;
  const parts = token.split('-');
  if (parts.length < 2 || parts.length > 4) return false;
  if (!parts.every((p) => /^[A-Za-z0-9]{1,6}$/.test(p))) return false;
  // 日期形状：2024-06-15 / 2024-6-1（+1 段扩展到 4 段的日期时间）
  if (parts.length === 3 && /^\d{4}$/.test(parts[0]) && /^\d{1,2}$/.test(parts[1]) && /^\d{1,2}$/.test(parts[2])) {
    return false;
  }
  return true;
}

/** 字母数字码形 + 纯数字码形：A88123 / 72778 / 207406 / 480979 / 0614 */
function isPlainCode(token) {
  if (!/^[A-Za-z]?\d{3,9}$/.test(token)) return false;
  return token.replace(/[^0-9]/g, '').length <= 9;
}

// ---------------------------------------------------------------------------
// 3.4 / 3.4.1 / 3.4.2 取值与位置形态
// ---------------------------------------------------------------------------

/** 与关键词的距离：返回 [start,end] 区间内第一次出现的距离，找不到返回 Infinity */
function distanceTo(full, index, end, words) {
  let best = Infinity;
  for (const w of words) {
    let from = 0;
    for (;;) {
      const i = full.indexOf(w, from);
      if (i < 0) break;
      const d = i + w.length <= index ? index - (i + w.length) : i - end;
      if (d < best) best = d;
      from = i + 1;
    }
  }
  return best;
}

/** 3.4.2：token 是否紧跟货架号类正向前缀 */
function afterShelfPrefix(full, start) {
  const before = full.slice(Math.max(0, start - 10), start);
  const m = new RegExp(`(?:${SHELF_PREFIX.source})[：:]*$`).exec(before);
  return Boolean(m);
}

/** 3.4 单个候选值是否该丢弃（含 3.4.1 位置形态排除） */
export function isRejectedValue(value, start, full) {
  const end = start + value.length;
  const digits = value.replace(/[^0-9]/g, '');
  const len = digits.length;

  // 3.4 落在手机号形态里（含掩码号 138****5678）
  // 注意：这里必须用**字面量**正则。matchAll/exec 会改写全局正则的 lastIndex，
  // 如果把它缓存到模块级常量，下一次调用就会从上次的位置开始扫，静默漏判。
  for (const m of full.matchAll(/1[3-9]\d{9}/g)) {
    if (start >= m.index && end <= m.index + m[0].length) return true;
  }
  for (const m of full.matchAll(/1[3-9]\d[*xX]{2,}\d{2,4}/g)) {
    if (start >= m.index && end <= m.index + m[0].length) return true;
  }
  // 候选值前面 0~2 字符处就是 1[3-9]
  if (/1[3-9]$/.test(full.slice(Math.max(0, start - 2), start))) return true;
  // 与左右紧邻的数字拼起来是 11 位以上 → 是手机号/长单号的一部分
  let runStart = start;
  while (runStart > 0 && /\d/.test(full[runStart - 1])) runStart--;
  let runEnd = end;
  while (runEnd < full.length && /\d/.test(full[runEnd])) runEnd++;
  if (runEnd - runStart >= 11 && /[\d*]/.test(full.slice(runStart, runStart + 1))) return true;

  // 3.4 是 20\d{2} 且后面紧跟 年|月|日
  if (/^20\d{2}$/.test(digits) && /^[年月日]/.test(full.slice(end, end + 1))) return true;

  // 3.4 前后 3 字符内含敏感词（货架号/编号 这类正向前缀豁免）
  const around = full.slice(Math.max(0, start - 3), end + 3);
  if (/元|分钟|小时|天|kg|克|电话|手机|订单|运单|编号/.test(around)) {
    if (!afterShelfPrefix(full, start)) return true;
  }

  // 3.4 4 位且以 19|20 开头（年份）
  if (len === 4 && /^(19|20)/.test(digits)) return true;

  // 3.4 保留号
  if (RESERVED_NUMBERS.has(digits)) return true;

  // 3.4 / 3.4.1 与 运单号/订单号/快递单号/快件号 距离 ≤ 6 字符
  if (distanceTo(full, start, end, ['运单号', '订单号', '快递单号', '快件号']) <= 6) return true;

  // 3.4 太长，是单号不是取件码
  if (/^\d{11,}$/.test(digits)) return true;

  // 3.4.1 token 下一个字符是 `号`（`货架号5-5-9-13` 之类正向前缀已豁免）
  if (full[end] === '号') return true;

  // 3.4.1 token 前一个字符是 `*`（掩码手机号尾段）
  if (full[start - 1] === '*') return true;

  // 3.4.1 token 后面紧跟 `:` 且形如 \d{1,2}（时间 12:30）
  if (full[end] === ':' && /^\d{1,2}$/.test(digits)) return true;

  // 3.4.1 窗口（±8 字）内含 `尾号`  → 丢
  const win8 = full.slice(Math.max(0, start - 8), end + 8);
  if (/尾号/.test(win8)) return true;

  // 3.4.1 格口/区号形态：`A区123格`、`B区56格` 里的数字是格口号不是取件码
  if (/[格区]/.test(full[end] ?? '')) return true;
  if (/[格区]/.test(full[start - 1] ?? '')) return true;

  return false;
}

/** 扫描全文所有码形候选，返回 [{value, index, end}]（不做拒绝判定） */
export function scanCandidates(full) {
  const out = [];
  let lastEnd = -1;
  // TOKEN_RE 是模块级全局正则：matchAll 会把 lastIndex 留在末尾，
  // 复用同一个对象会让第二次扫描从上次结束处开始（静默漏码）。这里每轮重置。
  TOKEN_RE.lastIndex = 0;
  for (const m of full.matchAll(TOKEN_RE)) {
    const hyphen = m[1];
    const plain = m[2];
    // 两条分支共用同一个捕获组号 2（分组编号由整个正则决定），
    // 所以用 null 判定而不是 undefined。
    const value = hyphen !== null && hyphen !== undefined ? hyphen : plain;
    if (value === null || value === undefined) continue;
    if (m.index < lastEnd) continue; // 连字符码形优先，避免重叠重复
    if (hyphen !== null && hyphen !== undefined) {
      if (!isHyphenCode(value)) continue;
    } else if (!isPlainCode(value)) {
      continue;
    }
    out.push({ value, index: m.index, end: m.index + value.length });
    lastEnd = m.index + value.length;
  }
  return out;
}

/** 合并两个候选（3.4 硬黑名单） */
function keepCandidate(full, cand) {
  return !isRejectedValue(cand.value, cand.index, full);
}

// ---------------------------------------------------------------------------
// 3.3 / 3.3.1 / 3.5 抓取
// ---------------------------------------------------------------------------

/** cluster 里两个 token 之间是否只隔了分隔符/空白（3.5 的 `[,，、;；\s]+`） */
function gapIsSeparatorOnly(full, gapStart, gapEnd) {
  if (gapEnd <= gapStart) return true;
  if (gapEnd - gapStart > 4) return false;
  const gap = full.slice(gapStart, gapEnd);
  if (/\d/.test(gap)) return false;
  return CLUSTER_SEP.test(gap) && /^[,，、;；\s]+$/.test(gap);
}

/**
 * 关键词锚点：以关键词命中处为锚收集一条 cluster。
 * 关键词**后面**的码优先（3.3 的规则都是「关键词后」）；只有后面一个都没有时，
 * 才回头看紧贴关键词左侧的 token（避免把「A区123格，取件码 470812」的 123 当成码）。
 * 返回 [{value, index, end}]，已过 3.4/3.4.1 判定。
 */
function codesFromKeywordHit(full, hitStart, hitEnd, cands) {
  const winStart = Math.max(0, hitStart - 20);
  const limit = Math.min(full.length, hitStart + 60);

  const after = [];
  let prevEnd = null;
  for (const c of cands) {
    if (c.index < hitEnd || c.index >= limit) continue;
    if (prevEnd === null) {
      // 关键词后的第一个码：必须紧邻（0~3 个非数字字符，正是 3.3-3）
      if (c.index - hitEnd > 3) continue;
    } else if (!gapIsSeparatorOnly(full, prevEnd, c.index)) {
      // 后续的码：只允许分隔符/空白相连（3.5 的 cluster 切分）
      continue;
    }
    after.push(c);
    prevEnd = c.end;
    if (after.length >= MAX_CODES_PER_TEXT) return after;
  }
  if (after.length) return after;

  const before = [];
  for (const c of cands) {
    if (c.end > hitStart || c.index < winStart) continue;
    if (hitStart - c.end > 2) continue; // 只接受紧贴关键词左侧的
    before.push(c);
    if (before.length >= MAX_CODES_PER_TEXT) break;
  }
  return before;
}

/** 3.3.1 `凭` 锚点 */
function codesFromAnchor(full, cands) {
  const out = [];
  const anchors = [
    // 请凭取件码 / 凭取件码 / 请凭码：最高优先
    /请?凭(?:取件码|取货码|取件号|包裹码|快件码|提货码|码)([^0-9A-Za-z]{0,3})([A-Za-z0-9-]{3,40})/g,
    // 请凭 <码形>（来取|取件|领取|到）
    /请凭[^0-9A-Za-z]{0,3}([A-Za-z0-9-]{3,40})/g,
    // 凭 <码形>（到|来取|领取|取件）
    /凭[^0-9A-Za-z]{0,3}([A-Za-z0-9-]{3,40})/g,
  ];
  for (const re of anchors) {
    for (const m of full.matchAll(re)) {
      const raw = m[m.length - 1];
      const rawStart = m.index + m[0].lastIndexOf(raw);
      if (!raw) continue;
      let offset = 0;
      for (const seg of raw.split(CLUSTER_SEP)) {
        const at = rawStart + offset;
        offset += seg.length + 1; // 分隔符长度按 1 估（仅用于定位，够用）
        if (!seg) continue;
        if (!isHyphenCode(seg) && !isPlainCode(seg)) continue;
        const cand = { value: seg, index: at, end: at + seg.length };
        if (!keepCandidate(full, cand)) continue;
        out.push(cand);
      }
    }
  }
  return out;
}

/** 3.4.3 消息级黑名单（3.4.4 强特征豁免） */
function isBlacklistedMessage(full) {
  if (STRONG_FEATURES.test(full)) return false;
  if (BLACKLIST_VERIFY.test(full) && !/取件/.test(full)) return true;
  if (BLACKLIST_GENERIC.test(full)) return true;
  if (BLACKLIST_CARRIER.test(full)) return true;
  return false;
}

/** 3.4.5 兜底评分 */
function fallbackScored(full, cands) {
  const scored = [];
  for (const c of cands) {
    if (!keepCandidate(full, c)) continue;
    const window = full.slice(Math.max(0, c.index - 30), Math.min(full.length, c.end + 30));
    let score = 0;
    if ([...ALL_KEYWORDS].some((kw) => window.includes(kw))) score += 2;
    if (ACTION_WORDS.test(window)) score += 2;
    if (c.value.includes('-')) score += 1;
    if (/^\d{6,9}$/.test(c.value)) score += 1;
    if (STRONG_FEATURES.test(window)) score += 1;
    if (score >= 3) scored.push({ cand: c, score });
  }
  scored.sort((a, b) => b.score - a.score || a.cand.index - b.cand.index);
  return scored.slice(0, MAX_CODES_PER_TEXT).map((s) => s.cand);
}

/**
 * 契约 3.3 + 3.3.1 + 3.4.5：返回全部取到的码（保序、去重前）。
 * @returns {{code: string, keywordHit: number|null}[]}
 */
export function findCodes(full, hits) {
  const cands = scanCandidates(full);

  // 主路径 1：关键词锚点（每个命中各自成 cluster，3.5 要求「各自独立扫」）
  const collected = [];
  const seen = new Set();
  const push = (code, hitStart) => {
    const n = normalize(code);
    if (!n || seen.has(n)) return;
    seen.add(n);
    collected.push({ code, hitStart });
  };
  for (const h of hits) {
    for (const c of codesFromKeywordHit(full, h.start, h.end, cands)) {
      push(c.value, h.start);
      if (collected.length >= MAX_CODES_PER_TEXT) return collected;
    }
  }

  // 主路径 2：`凭` 锚点
  for (const c of codesFromAnchor(full, cands)) {
    push(c.value, null);
    if (collected.length >= MAX_CODES_PER_TEXT) return collected;
  }
  if (collected.length) return collected;

  // 兜底 3.4.5
  for (const c of fallbackScored(full, cands)) {
    push(c.value, null);
    if (collected.length >= MAX_CODES_PER_TEXT) break;
  }
  return collected;
}

/** 找出全部关键词命中；验证码需满足附加条件。返回 [{keyword, weight, start, end}] */
export function findKeywordHits(full) {
  const hits = [];
  const verifyAllowed = VERIFY_HINTS.test(full);
  for (const kw of ALL_KEYWORDS) {
    if (kw === '验证码' && !verifyAllowed) continue;
    let from = 0;
    for (;;) {
      const i = full.indexOf(kw, from);
      if (i < 0) break;
      hits.push({ keyword: kw, weight: KEYWORD_WEIGHTS.get(kw), start: i, end: i + kw.length });
      from = i + 1;
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const out = [];
  for (const h of hits) {
    if (out.some((o) => h.start < o.end && o.start < h.end)) continue; // 重叠只留最长
    out.push(h);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3.7 快递公司 / 网点 / 过期时间 / 备注
// ---------------------------------------------------------------------------

const COURIER_TABLE = [
  [/丰巢|蜂巢/, '丰巢'],
  [/菜鸟驿站|菜鸟/, '菜鸟驿站'],
  [/速递易|中邮速递/, '速递易'],
  [/京东|京喜/, '京东'],
  [/顺丰|丰巢速运/, '顺丰'],
  [/中通/, '中通'],
  [/圆通/, '圆通'],
  [/申通/, '申通'],
  [/韵达/, '韵达'],
  // 「中邮驿站」是邮政旗下的驿站品牌，归到邮政
  [/邮政|EMS|中邮/, '邮政'],
  [/极兔/, '极兔'],
  [/德邦/, '德邦'],
];

/** 契约 3.7 detectCourier：按顺序匹配，命中即返回 */
export function detectCourier(text) {
  const full = toHalfWidth(text || '');
  for (const [re, name] of COURIER_TABLE) {
    if (re.test(full)) return name;
  }
  return null;
}

/** 网点名清理：去掉首尾标点/空白，并裁掉括号后的尾巴（如「中邮驿站(南苑小区店),凭」） */
function trimPunct(s) {
  let t = (s || '').replace(/^[，,。、；;：:\s]+/, '').replace(/[，,。、；;：:\s]+$/, '');
  if (t.includes(')')) t = t.slice(0, t.indexOf(')'));
  else if (t.includes('(')) t = t.slice(0, t.indexOf('('));
  t = t.replace(/[，,。、；;：:\s]+$/, '');
  return t || null;
}

function extractStation(full) {
  // 契约 3.7 原文：网点名优先取「品牌(网点名)」的第 2 组
  const m1 = /(菜鸟驿站|丰巢|速递易|京东|顺丰)[(]([^)]{2,20})[)]/.exec(full);
  if (m1) return trimPunct(m1[2]);
  // 补充：真实文案里品牌与括号之间常夹设施类型，如「丰巢快递柜(中兴路店)」
  const m1b = /(菜鸟驿站|丰巢|速递易|京东|顺丰)[^)，,。；;]{0,6}?[(]([^)]{2,20})[)]/.exec(full);
  if (m1b) return trimPunct(m1b[2]);
  // 补充：品牌表之外的驿站（中邮驿站 / 邻里驿站 / 妈妈驿站 …）同样带括号网点名
  const m1c = /(?:快递超市|驿站|代收点|自提柜|快递柜|便利店|门卫|物业)[(]([^)]{2,20})[)]/.exec(full);
  if (m1c) return trimPunct(m1c[1]);
  const m2 = /到(.{2,20}?)取件/.exec(full);
  if (m2) return trimPunct(m2[1]);
  const m3 = /请到(.{2,20}?)领取/.exec(full);
  if (m3) return trimPunct(m3[1]);
  return null;
}

function extractExpireAt(full, eventTime) {
  const m1 = /(\d{1,3})\s*小时内取件/.exec(full) || /(\d{1,3})小时内/.exec(full);
  if (m1) return eventTime + Number(m1[1]) * 3600000;
  const m2 = /(\d{1,2})月(\d{1,2})日\s*(\d{1,2})?[:：]?(\d{2})?前?/.exec(full);
  if (m2) {
    const now = new Date(eventTime);
    const hh = m2[3] === undefined || m2[3] === '' ? 23 : Number(m2[3]);
    const mi = m2[4] === undefined || m2[4] === '' ? 59 : Number(m2[4]);
    return new Date(now.getFullYear(), Number(m2[1]) - 1, Number(m2[2]), hh, mi, 59, 0).getTime();
  }
  return null;
}

function extractNote(full) {
  const cands = [];
  const re = /(请)?(\d{1,3})小时内取件|请及时取件|超时(将)?(退回|收费)/g;
  for (const m of full.matchAll(re)) {
    let start = m.index;
    while (start > 0 && !/[，,。；;！!？?\n]/.test(full[start - 1])) start--;
    cands.push(full.slice(start, m.index + m[0].length));
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.length - a.length);
  return cands[0].slice(0, 40);
}

/** 分组用位置：station > courier > 未识别网点 */
function locationKey(station, courier) {
  return station || courier || '未识别网点';
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 解析一条文本。
 * @param {string} text 原始文案
 * @param {string} source "sms" | "notification" | "import" | "manual"
 * @param {number} eventTime 短信/通知时间戳（毫秒）
 * @param {string|null} sourceApp 通知来源包名
 * @returns {object[]} PickupItem 形状的对象数组
 */
export function extract(text, source = 'sms', eventTime = Date.now(), sourceApp = null) {
  // 短信正文可能被短信 App 包了一层引号，先清掉（rawText 也存干净的）
  const src = stripWrappingQuotes(text);
  const full = toHalfWidth(src);

  // 3.4.3 消息级黑名单
  if (isBlacklistedMessage(full)) return [];

  const hits = findKeywordHits(full);
  const codes = findCodes(full, hits);

  // 3.6 命中关键词但取不到码 -> 一个 code="" 的条目
  if (codes.length === 0) {
    if (hits.length === 0) return [];
    const highest = hits.reduce((a, b) => (b.weight > a.weight ? b : a), hits[0]);
    return [make('', highest.keyword, src, full, source, eventTime, sourceApp)];
  }

  // 3.8 权重最高的关键词；取码时锚定在哪个关键词就用哪个
  const highest = hits.length
    ? hits.reduce((a, b) => (b.weight > a.weight ? b : a), hits[0]).keyword
    : '';
  return codes.map((c) => {
    let keyword = highest;
    if (c.hitStart !== null) {
      const owners = hits.filter((h) => h.start <= c.hitStart && c.hitStart - h.end <= 60);
      if (owners.length) keyword = owners.reduce((a, b) => (b.weight > a.weight ? b : a)).keyword;
    }
    if (!keyword) keyword = highest || '取件码';
    return make(c.code, keyword, src, full, source, eventTime, sourceApp);
  });
}

function make(code, keyword, src, full, source, eventTime, sourceApp) {
  const courier = detectCourier(full);
  const station = extractStation(full);
  return {
    id: normalize(code) + '|' + normalize(locationKey(station, courier)),
    code,
    keyword,
    courier: courier ?? null,
    station: station ?? null,
    note: extractNote(full) ?? null,
    source,
    sourceApp: sourceApp ?? null,
    rawText: src.slice(0, 300),
    eventTime,
    createdAt: Date.now(),
    picked: false,
    expireAt: extractExpireAt(full, eventTime) ?? null,
  };
}

export default extract;
