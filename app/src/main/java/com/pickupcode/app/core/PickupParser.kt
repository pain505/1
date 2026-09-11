package com.pickupcode.app.core

/**
 * 取件码解析核心（见 CONTRACT.md 第 3 节）。
 *
 * **本文件必须与 tools/node/extract.mjs 行为一致**：正则字面量、判断顺序、
 * 窗口大小、黑名单、权重表一一对应。Node 版是唯一能离线跑语料的验证手段，
 * 所以这里每一处都与它逐行对齐（Kotlin 字符串里的 `\\d` 对应 JS 的 `\d`）。
 *
 * 本文件是**纯 Kotlin**，禁止 import android.*（core 包要能脱离 Android 单测）。
 */
object PickupParser {

    // -----------------------------------------------------------------------
    // 常量（与 extract.mjs 同名同义）
    // -----------------------------------------------------------------------

    /** 契约 3.2 关键词权重表（"提货码" 在契约里重复出现，取最大值 100） */
    private val KEYWORD_WEIGHTS: Map<String, Int> = linkedMapOf(
        "取件码" to 100,
        "取货码" to 100,
        "提货码" to 100,
        "取货号" to 100,
        "取件号" to 100,
        "取件编码" to 100,
        "取包裹码" to 100,
        "取件密码" to 90,
        "开门码" to 90,
        "开柜码" to 90,
        "包裹码" to 80,
        "快件码" to 80,
        "验证码" to 50
    )

    /** 关键词按长度倒序（3.2「命中最长者优先」） */
    private val ALL_KEYWORDS: List<String> = KEYWORD_WEIGHTS.keys.sortedByDescending { it.length }

    /** 验证码只有在同文出现这些词之一时才算取件关键词（3.2） */
    private val VERIFY_HINTS = Regex("快递柜|驿站|取件|包裹")

    /** 网点词：4~5 位码规则（3.3-5）需要 */
    private val SITE_WORDS = Regex("快递柜|驿站|超市|代收点|菜鸟|丰巢|速递易|自提柜|智能柜|门卫|物业|便利店")

    /** 3.4 保留号 */
    private val RESERVED_NUMBERS = setOf(
        "11183", "11185", "95554", "95338", "4001", "10086", "10010", "10000", "12305", "95311"
    )

    /** 3.4.4 强取件特征（出现即可豁免 3.4.3 消息级黑名单） */
    private val STRONG_FEATURES = Regex("取件码|取货码|提货码|取件号|凭码|货架号|柜号|驿站|快递柜|丰巢|菜鸟|兔喜|妈妈驿站")

    /** 3.4.3 消息级黑名单 */
    private val BLACKLIST_GENERIC = Regex("余额|话费|流量|积分|账单|消费|扣费|充值|还款|信用卡|贷款|中奖|领取优惠券|点击链接|退订|外卖|已送达|送达时间|骑手|点餐")
    private val BLACKLIST_VERIFY = Regex("验证码")
    private val BLACKLIST_CARRIER = Regex("955\\d{2}|10086|10010|10000|106\\d{8}")

    /** 3.4.2 货架号类正向前缀 */
    private val SHELF_PREFIX = Regex("货架号|货架|柜号|柜子号|箱号|编号|格口")

    /** 3.5 cluster 分隔符 */
    private val CLUSTER_SEP = Regex("[,，、;；\\s]+")

    /** 3.4 前后 3 字符内的敏感词（与 extract.mjs 的 /元|分钟|小时|天|kg|克|电话|手机|订单|运单|编号/ 逐字一致） */
    private val SENSITIVE_AROUND = Regex("元|分钟|小时|天|kg|克|电话|手机|订单|运单|编号")

    /** 3.2 关键词 / 3.4.4 特征 / 动作词 —— 3.4.5 兜底评分用 */
    private val ACTION_WORDS = Regex("领取|取出|凭|取件|取货|及时|尽快|速取|出示")

    /** 3.4.1 时间形态：token 后紧跟 `:` 且形如 \d{1,2}（12:30） */
    private val PURE_1_2_DIGITS = Regex("^\\d{1,2}$")

    /** 3.4 手机号形态 */
    private val PHONE_11 = Regex("1[3-9]\\d{9}")
    private val PHONE_MASKED = Regex("1[3-9]\\d[*xX]{2,}\\d{2,4}")
    private val PHONE_PREFIX_TAIL = Regex("1[3-9]$")

    /** 3.3.0 码形 */
    private const val HYPHEN_TEXT = "[A-Za-z0-9]{1,6}(?:-[A-Za-z0-9]{1,6}){1,3}"
    private val TOKEN_RE = Regex("(?<![0-9A-Za-z-])(" + HYPHEN_TEXT + ")|(?<![0-9A-Za-z])([A-Za-z]?\\d{3,9})")
    private val PLAIN_CODE_RE = Regex("^[A-Za-z]?\\d{3,9}$")
    private val HYPHEN_PART_RE = Regex("^[A-Za-z0-9]{1,6}$")
    private val FOUR_DIGITS = Regex("^\\d{4}$")
    private val ONE_TWO_DIGITS = Regex("^\\d{1,2}$")

    /** 3.3.1 `凭` 锚点 */
    private val ANCHOR_1 = Regex("请?凭(?:取件码|取货码|取件号|包裹码|快件码|提货码|码)[^0-9A-Za-z]{0,3}([A-Za-z0-9-]{3,40})")
    private val ANCHOR_2 = Regex("请凭[^0-9A-Za-z]{0,3}([A-Za-z0-9-]{3,40})")
    private val ANCHOR_3 = Regex("凭[^0-9A-Za-z]{0,3}([A-Za-z0-9-]{3,40})")

    /** 3.7 快递公司 */
    private val COURIER_TABLE: List<Pair<Regex, String>> = listOf(
        Regex("丰巢|蜂巢") to "丰巢",
        Regex("菜鸟驿站|菜鸟") to "菜鸟驿站",
        Regex("速递易|中邮速递") to "速递易",
        Regex("京东|京喜") to "京东",
        Regex("顺丰|丰巢速运") to "顺丰",
        Regex("中通") to "中通",
        Regex("圆通") to "圆通",
        Regex("申通") to "申通",
        Regex("韵达") to "韵达",
        Regex("邮政|EMS|中邮") to "邮政",
        Regex("极兔") to "极兔",
        Regex("德邦") to "德邦"
    )

    /** 契约 3.5 */
    private const val MAX_CODES_PER_TEXT = 6

    // -----------------------------------------------------------------------
    // 数据载体
    // -----------------------------------------------------------------------

    /** 关键词命中 */
    private data class KeywordHit(
        val keyword: String,
        val weight: Int,
        val start: Int,
        val end: Int
    )

    /** 码形候选 */
    private data class Candidate(val value: String, val index: Int, val end: Int)

    // -----------------------------------------------------------------------
    // 对外接口（契约第 3 节）
    // -----------------------------------------------------------------------

    /**
     * 解析一条文本，返回 PickupItem 列表。
     *
     * 空列表 = 不是取件通知；含 `code == ""` 的条目 = 命中关键词但取不到码（3.6）。
     */
    fun parse(
        text: String,
        source: String,
        eventTime: Long,
        sourceApp: String? = null
    ): List<PickupItem> {
        // 短信正文可能被短信 App 包了一层引号，先清掉（rawText 也存干净的）
        val cleaned = stripWrappingQuotes(text)
        val full = toHalfWidth(cleaned)

        // 3.4.3 消息级黑名单
        if (isBlacklistedMessage(full)) return emptyList()

        val hits = findKeywordHits(full)
        val codes = findCodes(full, hits)

        // 3.6 命中关键词但取不到码 -> 一个 code="" 的条目
        if (codes.isEmpty()) {
            if (hits.isEmpty()) return emptyList()
            val highest = highestHit(hits)
            return listOf(make("", highest.keyword, cleaned, full, source, eventTime, sourceApp))
        }

        // 3.8 权重最高的关键词；取码时锚定在哪个关键词就用哪个
        val highestKeyword = if (hits.isEmpty()) "" else highestHit(hits).keyword
        val out = ArrayList<PickupItem>(codes.size)
        for (c in codes) {
            var keyword = highestKeyword
            if (c.hitStart != null) {
                val owners = hits.filter { it.start <= c.hitStart && c.hitStart - it.end <= 60 }
                if (owners.isNotEmpty()) keyword = highestHit(owners).keyword
            }
            if (keyword.isEmpty()) keyword = highestKeyword.ifEmpty { "取件码" }
            out.add(make(c.code, keyword, cleaned, full, source, eventTime, sourceApp))
        }
        return out
    }

    /**
     * 契约 3 的 normalize：先全角转半角、去空白、小写，再去 () （） 空格 连字符与点。
     */
    fun normalize(s: String): String {
        val half = toHalfWidth(s).replace(Regex("\\s+"), "")
        return half.lowercase().replace(Regex("[()（）\\s\\-.]"), "")
    }

    /**
     * 清掉短信正文外层被自动加上的引号。
     *
     * 背景：Android 短信 App（如 Google Messages）对以 `【` 开头的正文会自动加英文双引号，
     * 存进收件箱的内容就变成 `"【菜鸟驿站】…取件码 8-3-2015…"`。
     * 实测在模拟器上确认过：不清掉的话，App 里「查看原文」和「复制原文」都会带引号，
     * 分享导入时同理，看起来像乱码。
     *
     * 只清**成对**的首尾引号，且要求首尾同一种引号，避免误伤正文里正常出现的引号。
     */
    fun stripWrappingQuotes(s: String): String {
        var t = s.trim()
        val pairs = listOf(
            '"' to '"',
            '\u201C' to '\u201D', // “ ”
            '\u300C' to '\u300D', // 「 」
            '\'' to '\'',
        )
        var changed = true
        while (changed && t.length >= 2) {
            changed = false
            for ((open, close) in pairs) {
                if (t.first() == open && t.last() == close) {
                    t = t.substring(1, t.length - 1).trim()
                    changed = true
                }
            }
        }
        return t
    }

    /** 契约 3.7 detectCourier：按顺序匹配，命中即返回 */
    fun detectCourier(text: String): String? {
        val full = toHalfWidth(text)
        for ((re, name) in COURIER_TABLE) {
            if (re.containsMatchIn(full)) return name
        }
        return null
    }

    // -----------------------------------------------------------------------
    // 3.1 全角转半角
    // -----------------------------------------------------------------------

    /** 字符级归一：U+FF01..U+FF5E 减 0xFEE0；U+3000 → 空格。 */
    fun toHalfWidth(s: String): String {
        val sb = StringBuilder(s.length)
        var i = 0
        while (i < s.length) {
            val cp = s.codePointAt(i)
            when {
                cp in 0xFF01..0xFF5E -> sb.append((cp - 0xFEE0).toChar())
                cp == 0x3000 -> sb.append(' ')
                else -> sb.appendCodePoint(cp)
            }
            i += Character.charCount(cp)
        }
        return sb.toString()
    }

    // -----------------------------------------------------------------------
    // 3.3.0 码形
    // -----------------------------------------------------------------------

    /**
     * 连字符码形校验（契约 3.3.0 + 3.4.1）。
     * 契约字面量只做形状匹配，会把裸日期 `2024-06-15` 吃进来，所以这里加一条
     * 日期形状排除：首段 4 位数字 + 其后 1~2 位段 → 判为日期。
     */
    fun isHyphenCode(token: String): Boolean {
        if (!token.contains('-')) return false
        val parts = token.split('-')
        if (parts.size < 2 || parts.size > 4) return false
        if (!parts.all { HYPHEN_PART_RE.matches(it) }) return false
        if (parts.size == 3 &&
            FOUR_DIGITS.matches(parts[0]) &&
            ONE_TWO_DIGITS.matches(parts[1]) &&
            ONE_TWO_DIGITS.matches(parts[2])
        ) {
            return false
        }
        return true
    }

    /** 字母数字码形 + 纯数字码形：A88123 / 72778 / 207406 / 480979 / 0614 */
    private fun isPlainCode(token: String): Boolean = PLAIN_CODE_RE.matches(token)

    /** 扫描全文所有码形候选（不做拒绝判定） */
    private fun scanCandidates(full: String): List<Candidate> {
        val out = ArrayList<Candidate>()
        var lastEnd = -1
        for (m in TOKEN_RE.findAll(full)) {
            val hyphen = m.groups[1]?.value
            val plain = m.groups[2]?.value
            val value = hyphen ?: plain ?: continue
            if (m.range.first < lastEnd) continue // 连字符码形优先，避免重叠重复
            if (hyphen != null) {
                if (!isHyphenCode(value)) continue
            } else if (!isPlainCode(value)) {
                continue
            }
            out.add(Candidate(value, m.range.first, m.range.first + value.length))
            lastEnd = m.range.first + value.length
        }
        return out
    }

    // -----------------------------------------------------------------------
    // 3.4 / 3.4.1 / 3.4.2 取值
    // -----------------------------------------------------------------------

    /** 与关键词的距离：取 `words` 里最近的词与 [start,end] 的距离，找不到返回 [Int.MAX_VALUE] */
    private fun distanceTo(full: String, start: Int, end: Int, words: List<String>): Int {
        var best = Int.MAX_VALUE
        for (w in words) {
            var from = 0
            while (true) {
                val i = full.indexOf(w, from)
                if (i < 0) break
                val d = if (i + w.length <= start) start - (i + w.length) else i - end
                if (d < best) best = d
                from = i + 1
            }
        }
        return best
    }

    /** 3.4.2：token 是否紧跟货架号类正向前缀 */
    private fun afterShelfPrefix(full: String, start: Int): Boolean {
        val from = if (start - 10 > 0) start - 10 else 0
        val before = full.substring(from, start)
        for (m in SHELF_PREFIX.findAll(before)) {
            var i = m.range.last + 1
            while (i < before.length && (before[i] == '：' || before[i] == ':')) i++
            if (i == before.length) return true
        }
        return false
    }

    /** 3.4 单个候选值是否该丢弃（含 3.4.1 位置形态排除） */
    fun isRejectedValue(value: String, start: Int, full: String): Boolean {
        val end = start + value.length
        val digits = value.filter { it.isDigit() }
        val len = digits.length

        // 3.4 落在手机号形态里（含掩码号 138****5678）
        for (m in PHONE_11.findAll(full)) {
            if (start >= m.range.first && end <= m.range.last + 1) return true
        }
        for (m in PHONE_MASKED.findAll(full)) {
            if (start >= m.range.first && end <= m.range.last + 1) return true
        }
        // 候选值前面 0~2 字符处就是 1[3-9]
        val beforeTwo = full.substring(if (start - 2 > 0) start - 2 else 0, start)
        if (PHONE_PREFIX_TAIL.containsMatchIn(beforeTwo)) return true
        // 与左右紧邻的数字拼起来是 11 位以上 → 是手机号/长单号的一部分
        // （与 extract.mjs 的 runStart/runEnd 逐行对应）
        var runStart = start
        while (runStart > 0 && full[runStart - 1].isDigit()) runStart--
        var runEnd = end
        while (runEnd < full.length && full[runEnd].isDigit()) runEnd++
        if (runEnd - runStart >= 11 &&
            runStart < full.length &&
            (full[runStart].isDigit() || full[runStart] == '*')
        ) {
            return true
        }

        // 3.4 是 20\d{2} 且后面紧跟 年|月|日
        if (Regex("^20\\d{2}$").matches(digits) &&
            end < full.length && "年月日".indexOf(full[end]) >= 0
        ) {
            return true
        }

        // 3.4 前后 3 字符内含敏感词（货架号/编号 这类正向前缀豁免）
        val around = full.substring(if (start - 3 > 0) start - 3 else 0, minOf(full.length, end + 3))
        if (SENSITIVE_AROUND.containsMatchIn(around) && !afterShelfPrefix(full, start)) return true

        // 3.4 4 位且以 19|20 开头（年份）。注意括号：`&&` 优先级高于 `||`，不加括号会写错
        if (len == 4 && (digits.startsWith("19") || digits.startsWith("20"))) return true

        // 3.4 保留号
        if (RESERVED_NUMBERS.contains(digits)) return true

        // 3.4 / 3.4.1 与 运单号/订单号/快递单号/快件号 距离 ≤ 6 字符
        if (distanceTo(full, start, end, listOf("运单号", "订单号", "快递单号", "快件号")) <= 6) return true

        // 3.4 太长，是单号不是取件码
        if (Regex("^\\d{11,}$").matches(digits)) return true

        // 3.4.1 token 下一个字符是 `号`（货架号类正向前缀已豁免）
        if (end < full.length && full[end] == '号') return true

        // 3.4.1 token 前一个字符是 `*`（掩码手机号尾段）
        if (start > 0 && full[start - 1] == '*') return true

        // 3.4.1 token 后面紧跟 `:` 且形如 \d{1,2}（时间 12:30）
        // 注意：这里**只**认冒号形态，与 extract.mjs 逐字对齐。
        // 不要扩大成「点/时」之类的词，否则 `A区123格` 之后若出现「时」会误杀。
        if (end < full.length && full[end] == ':' && PURE_1_2_DIGITS.matches(digits)) return true

        // 3.4.1 窗口（±8 字）内含 `尾号`
        val win8 = full.substring(if (start - 8 > 0) start - 8 else 0, minOf(full.length, end + 8))
        if (win8.contains("尾号")) return true

        // 3.4.1 格口/区号形态：`A区123格`、`B区56格`
        if (end < full.length && (full[end] == '格' || full[end] == '区')) return true
        if (start > 0 && (full[start - 1] == '格' || full[start - 1] == '区')) return true

        return false
    }

    private fun keep(full: String, c: Candidate): Boolean = !isRejectedValue(c.value, c.index, full)

    // -----------------------------------------------------------------------
    // 3.3 / 3.3.1 / 3.5 抓取
    // -----------------------------------------------------------------------

    /** cluster 里两个 token 之间是否只隔了分隔符/空白 */
    private fun gapIsSeparatorOnly(full: String, gapStart: Int, gapEnd: Int): Boolean {
        if (gapEnd <= gapStart) return true
        if (gapEnd - gapStart > 4) return false
        val gap = full.substring(gapStart, gapEnd)
        if (gap.any { it.isDigit() }) return false
        if (!CLUSTER_SEP.containsMatchIn(gap)) return false
        return gap.all { it == ',' || it == '，' || it == '、' || it == ';' || it == '；' || it.isWhitespace() }
    }

    /**
     * 关键词锚点：关键词**后面**的码优先；只有后面一个都没有时，才回头看紧贴
     * 关键词左侧的 token（避免把「A区123格，取件码 470812」的 123 当成码）。
     */
    private fun codesFromKeywordHit(
        full: String,
        hitStart: Int,
        hitEnd: Int,
        cands: List<Candidate>
    ): List<Candidate> {
        val winStart = if (hitStart - 20 > 0) hitStart - 20 else 0
        val limit = minOf(full.length, hitStart + 60)

        val after = ArrayList<Candidate>()
        var prevEnd = -1
        for (c in cands) {
            if (c.index < hitEnd || c.index >= limit) continue
            if (prevEnd < 0) {
                // 关键词后的第一个码：必须紧邻（0~3 个非数字字符，正是 3.3-3）
                if (c.index - hitEnd > 3) continue
            } else if (!gapIsSeparatorOnly(full, prevEnd, c.index)) {
                // 后续的码：只允许分隔符/空白相连（3.5 的 cluster 切分）
                continue
            }
            after.add(c)
            prevEnd = c.end
            if (after.size >= MAX_CODES_PER_TEXT) return after
        }
        if (after.isNotEmpty()) return after

        val before = ArrayList<Candidate>()
        for (c in cands) {
            if (c.end > hitStart || c.index < winStart) continue
            if (hitStart - c.end > 2) continue
            before.add(c)
            if (before.size >= MAX_CODES_PER_TEXT) break
        }
        return before
    }

    /** 3.3.1 `凭` 锚点 */
    private fun codesFromAnchor(full: String, cands: List<Candidate>): List<Candidate> {
        val out = ArrayList<Candidate>()
        for (re in listOf(ANCHOR_1, ANCHOR_2, ANCHOR_3)) {
            for (m in re.findAll(full)) {
                val raw = m.groups[1]?.value ?: continue
                val rawStart = m.range.first + m.value.lastIndexOf(raw)
                var offset = 0
                for (seg in raw.split(CLUSTER_SEP)) {
                    val at = rawStart + offset
                    offset += seg.length + 1 // 分隔符长度按 1 估（仅用于定位，够用）
                    if (seg.isEmpty()) continue
                    if (!isHyphenCode(seg) && !isPlainCode(seg)) continue
                    val cand = Candidate(seg, at, at + seg.length)
                    if (!keep(full, cand)) continue
                    out.add(cand)
                }
            }
        }
        return out
    }

    /** 3.4.3 消息级黑名单（3.4.4 强特征豁免） */
    private fun isBlacklistedMessage(full: String): Boolean {
        if (STRONG_FEATURES.containsMatchIn(full)) return false
        if (BLACKLIST_VERIFY.containsMatchIn(full) && !full.contains("取件")) return true
        if (BLACKLIST_GENERIC.containsMatchIn(full)) return true
        if (BLACKLIST_CARRIER.containsMatchIn(full)) return true
        return false
    }

    /** 3.4.5 兜底评分 */
    private fun fallbackScored(full: String, cands: List<Candidate>): List<Candidate> {
        val scored = ArrayList<Pair<Candidate, Int>>()
        for (c in cands) {
            if (!keep(full, c)) continue
            val from = if (c.index - 30 > 0) c.index - 30 else 0
            val window = full.substring(from, minOf(full.length, c.end + 30))
            var score = 0
            if (ALL_KEYWORDS.any { window.contains(it) }) score += 2
            if (ACTION_WORDS.containsMatchIn(window)) score += 2
            if (c.value.contains('-')) score += 1
            if (Regex("^\\d{6,9}$").matches(c.value)) score += 1
            if (STRONG_FEATURES.containsMatchIn(window)) score += 1
            if (score >= 3) scored.add(c to score)
        }
        scored.sortWith(compareByDescending<Pair<Candidate, Int>> { it.second }.thenBy { it.first.index })
        return scored.take(MAX_CODES_PER_TEXT).map { it.first }
    }

    /** 取码主流程 */
    private data class FoundCode(val code: String, val hitStart: Int?)

    private fun findCodes(full: String, hits: List<KeywordHit>): List<FoundCode> {
        val cands = scanCandidates(full)
        val collected = ArrayList<FoundCode>()
        val seen = HashSet<String>()

        fun push(code: String, hitStart: Int?) {
            val n = normalize(code)
            if (n.isEmpty() || seen.contains(n)) return
            seen.add(n)
            collected.add(FoundCode(code, hitStart))
        }

        // 主路径 1：关键词锚点（每个命中各自成 cluster，3.5 要求「各自独立扫」）
        for (h in hits) {
            for (c in codesFromKeywordHit(full, h.start, h.end, cands)) {
                push(c.value, h.start)
                if (collected.size >= MAX_CODES_PER_TEXT) return collected
            }
        }

        // 主路径 2：`凭` 锚点
        for (c in codesFromAnchor(full, cands)) {
            push(c.value, null)
            if (collected.size >= MAX_CODES_PER_TEXT) return collected
        }
        if (collected.isNotEmpty()) return collected

        // 兜底 3.4.5
        for (c in fallbackScored(full, cands)) {
            push(c.value, null)
            if (collected.size >= MAX_CODES_PER_TEXT) break
        }
        return collected
    }

    /** 找出全部关键词命中；验证码需满足附加条件 */
    private fun findKeywordHits(full: String): List<KeywordHit> {
        val raw = ArrayList<KeywordHit>()
        val verifyAllowed = VERIFY_HINTS.containsMatchIn(full)
        for (kw in ALL_KEYWORDS) {
            if (kw == "验证码" && !verifyAllowed) continue
            var from = 0
            while (true) {
                val i = full.indexOf(kw, from)
                if (i < 0) break
                raw.add(KeywordHit(kw, KEYWORD_WEIGHTS[kw] ?: 0, i, i + kw.length))
                from = i + 1
            }
        }
        // 按出现位置排序；同位置保留更长（权重更高）的
        raw.sortWith(compareBy({ it.start }, { -(it.end - it.start) }))
        val out = ArrayList<KeywordHit>()
        for (h in raw) {
            if (out.any { h.start < it.end && it.start < h.end }) continue
            out.add(h)
        }
        return out
    }

    private fun highestHit(hits: List<KeywordHit>): KeywordHit =
        hits.reduce { a, b -> if (b.weight > a.weight) b else a }

    // -----------------------------------------------------------------------
    // 3.7 网点 / 过期时间 / 备注
    // -----------------------------------------------------------------------

    /** 网点名清理：去掉首尾标点/空白，并裁掉括号后的尾巴 */
    private fun trimPunct(s: String?): String? {
        var t = (s ?: "").trim { it == '，' || it == ',' || it == '。' || it == '、' || it == '；' || it == ';' || it == '：' || it == ':' || it.isWhitespace() }
        val close = t.indexOf(')')
        val open = t.indexOf('(')
        if (close >= 0) t = t.substring(0, close) else if (open >= 0) t = t.substring(0, open)
        t = t.trim { it == '，' || it == ',' || it == '。' || it == '、' || it == '；' || it == ';' || it == '：' || it == ':' || it.isWhitespace() }
        return t.ifEmpty { null }
    }

    private fun extractStation(full: String): String? {
        // 契约 3.7 原文：网点名优先取「品牌(网点名)」的第 2 组
        Regex("(菜鸟驿站|丰巢|速递易|京东|顺丰)[(]([^)]{2,20})[)]").find(full)?.let {
            return trimPunct(it.groupValues[2])
        }
        // 补充：品牌与括号之间常夹设施类型，如「丰巢快递柜(中兴路店)」
        Regex("(菜鸟驿站|丰巢|速递易|京东|顺丰)[^)，,。；;]{0,6}?[(]([^)]{2,20})[)]").find(full)?.let {
            return trimPunct(it.groupValues[2])
        }
        // 补充：品牌表之外的驿站（中邮驿站 / 邻里驿站 / 妈妈驿站 …）
        Regex("(?:快递超市|驿站|代收点|自提柜|快递柜|便利店|门卫|物业)[(]([^)]{2,20})[)]").find(full)?.let {
            return trimPunct(it.groupValues[1])
        }
        Regex("到(.{2,20}?)取件").find(full)?.let { return trimPunct(it.groupValues[1]) }
        Regex("请到(.{2,20}?)领取").find(full)?.let { return trimPunct(it.groupValues[1]) }
        return null
    }

    private fun extractExpireAt(full: String, eventTime: Long): Long? {
        val m1 = Regex("(\\d{1,3})\\s*小时内取件").find(full)
            ?: Regex("(\\d{1,3})小时内").find(full)
        if (m1 != null) {
            val n = m1.groupValues[1].toLongOrNull() ?: return null
            return eventTime + n * 3600_000L
        }
        val m2 = Regex("(\\d{1,2})月(\\d{1,2})日\\s*(\\d{1,2})?[:：]?(\\d{2})?前?").find(full)
        if (m2 != null) {
            val month = m2.groupValues[1].toIntOrNull() ?: return null
            val day = m2.groupValues[2].toIntOrNull() ?: return null
            val hour = m2.groupValues[3].ifEmpty { "23" }.toIntOrNull() ?: 23
            val minute = m2.groupValues[4].ifEmpty { "59" }.toIntOrNull() ?: 59
            val cal = java.util.Calendar.getInstance()
            cal.timeInMillis = eventTime
            cal.set(java.util.Calendar.MONTH, month - 1)
            cal.set(java.util.Calendar.DAY_OF_MONTH, day)
            cal.set(java.util.Calendar.HOUR_OF_DAY, hour)
            cal.set(java.util.Calendar.MINUTE, minute)
            cal.set(java.util.Calendar.SECOND, 59)
            cal.set(java.util.Calendar.MILLISECOND, 0)
            return cal.timeInMillis
        }
        return null
    }

    private fun extractNote(full: String): String? {
        val cands = ArrayList<String>()
        for (m in Regex("(请)?(\\d{1,3})小时内取件|请及时取件|超时(将)?(退回|收费)").findAll(full)) {
            var start = m.range.first
            while (start > 0 && "，,。；;！!？?\n".indexOf(full[start - 1]) < 0) start--
            cands.add(full.substring(start, m.range.last + 1))
        }
        if (cands.isEmpty()) return null
        cands.sortByDescending { it.length }
        val best = cands[0]
        return if (best.length > 40) best.substring(0, 40) else best
    }

    /** 分组用位置：station > courier > 未识别网点 */
    private fun locationKey(station: String?, courier: String?): String =
        station ?: courier ?: "未识别网点"

    private fun make(
        code: String,
        keyword: String,
        src: String,
        full: String,
        source: String,
        eventTime: Long,
        sourceApp: String?
    ): PickupItem {
        val courier = detectCourier(full)
        val station = extractStation(full)
        return PickupItem(
            id = normalize(code) + "|" + normalize(locationKey(station, courier)),
            code = code,
            keyword = keyword,
            courier = courier,
            station = station,
            note = extractNote(full),
            source = source,
            sourceApp = sourceApp,
            rawText = if (src.length > 300) src.substring(0, 300) else src,
            eventTime = eventTime,
            createdAt = System.currentTimeMillis(),
            picked = false,
            expireAt = extractExpireAt(full, eventTime)
        )
    }
}
