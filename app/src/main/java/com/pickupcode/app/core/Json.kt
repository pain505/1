package com.pickupcode.app.core

/**
 * 极简 JSON 读写（不引第三方库，见 CONTRACT.md 第 2 节）。
 *
 * - 手写转义：`"` `\` `\n` `\r` `\t` 以及控制字符 `\u00XX`
 * - 解析失败一律返回 null，**不抛异常**
 * - encode/decode 的字段名与 tools/node/extract.mjs 输出的 Item 完全一致，
 *   这样 Node 镜像跑出来的 JSON 能直接被 Android 端读回来自查
 *
 * 本文件是**纯 Kotlin**，禁止 import android.*。
 */
object PickupJson {

    // -----------------------------------------------------------------------
    // PickupItem
    // -----------------------------------------------------------------------

    fun encodeItem(item: PickupItem): String {
        val sb = StringBuilder(320)
        sb.append('{')
        appendField(sb, "id", item.id)
        sb.append(',')
        appendField(sb, "code", item.code)
        sb.append(',')
        appendField(sb, "keyword", item.keyword)
        sb.append(',')
        appendNullableField(sb, "courier", item.courier)
        sb.append(',')
        appendNullableField(sb, "station", item.station)
        sb.append(',')
        appendNullableField(sb, "note", item.note)
        sb.append(',')
        appendField(sb, "source", item.source)
        sb.append(',')
        appendNullableField(sb, "sourceApp", item.sourceApp)
        sb.append(',')
        appendField(sb, "rawText", item.rawText)
        sb.append(',')
        appendLongField(sb, "eventTime", item.eventTime)
        sb.append(',')
        appendLongField(sb, "createdAt", item.createdAt)
        sb.append(',')
        sb.append("\"picked\":").append(if (item.picked) "true" else "false")
        sb.append(',')
        appendNullableLongField(sb, "expireAt", item.expireAt)
        sb.append('}')
        return sb.toString()
    }

    fun decodeItem(raw: String?): PickupItem? {
        if (raw == null) return null
        return try {
            val p = JsonReader(raw)
            p.skipWs()
            val map = p.readObject() ?: return null
            p.skipWs()
            if (!p.atEnd()) return null

            return itemFromMap(map)
        } catch (t: Throwable) {
            null
        }
    }

    // -----------------------------------------------------------------------
    // List<PickupItem>
    // -----------------------------------------------------------------------

    /** UI/store 使用的确切签名（不要改名） */
    fun encodeList(items: List<PickupItem>): String {
        val sb = StringBuilder(64 + items.size * 320)
        sb.append('[')
        for (i in items.indices) {
            if (i > 0) sb.append(',')
            sb.append(encodeItem(items[i]))
        }
        sb.append(']')
        return sb.toString()
    }

    /** 解析失败返回 null，不抛异常 */
    fun decodeList(raw: String?): List<PickupItem>? {
        if (raw == null) return null
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null
        return try {
            val p = JsonReader(trimmed)
            p.skipWs()
            if (p.peek() != '[') return null
            p.pos++
            val out = ArrayList<PickupItem>()
            p.skipWs()
            if (p.peek() == ']') {
                p.pos++
            } else {
                while (true) {
                    p.skipWs()
                    val map = p.readObject() ?: return null
                    out.add(itemFromMap(map) ?: return null)
                    p.skipWs()
                    val c = p.peek()
                    if (c == ',') {
                        p.pos++
                        continue
                    }
                    if (c == ']') {
                        p.pos++
                        break
                    }
                    return null
                }
            }
            p.skipWs()
            if (!p.atEnd()) return null
            out
        } catch (t: Throwable) {
            null
        }
    }

    private fun itemFromMap(map: Map<String, Any?>): PickupItem? {
        val id = map["id"] as? String ?: return null
        return PickupItem(
            id = id,
            code = map["code"] as? String ?: "",
            keyword = map["keyword"] as? String ?: "",
            courier = map["courier"] as? String,
            station = map["station"] as? String,
            note = map["note"] as? String,
            source = map["source"] as? String ?: "sms",
            sourceApp = map["sourceApp"] as? String,
            rawText = map["rawText"] as? String ?: "",
            eventTime = asLong(map["eventTime"]) ?: 0L,
            createdAt = asLong(map["createdAt"]) ?: 0L,
            picked = map["picked"] as? Boolean ?: false,
            expireAt = asLong(map["expireAt"])
        )
    }

    private fun asLong(v: Any?): Long? = when (v) {
        null -> null
        is Long -> v
        is Int -> v.toLong()
        is Double -> v.toLong()
        is String -> v.toLongOrNull()
        else -> null
    }

    // -----------------------------------------------------------------------
    // 编码辅助
    // -----------------------------------------------------------------------

    private fun appendField(sb: StringBuilder, name: String, value: String) {
        appendKey(sb, name)
        appendString(sb, value)
    }

    private fun appendNullableField(sb: StringBuilder, name: String, value: String?) {
        appendKey(sb, name)
        if (value == null) sb.append("null") else appendString(sb, value)
    }

    private fun appendLongField(sb: StringBuilder, name: String, value: Long) {
        appendKey(sb, name)
        sb.append(value)
    }

    private fun appendNullableLongField(sb: StringBuilder, name: String, value: Long?) {
        appendKey(sb, name)
        if (value == null) sb.append("null") else sb.append(value)
    }

    private fun appendKey(sb: StringBuilder, name: String) {
        appendString(sb, name)
        sb.append(':')
    }

    /** 手写字符串转义：`"` `\` `\n` `\r` `\t` 以及控制字符 `\u00XX` */
    private fun appendString(sb: StringBuilder, s: String) {
        sb.append('"')
        for (ch in s) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                '\b' -> sb.append("\\b")
                '\u000C' -> sb.append("\\f")
                else -> if (ch < ' ') {
                    sb.append("\\u")
                    val hex = ch.code.toString(16)
                    repeat(4 - hex.length) { sb.append('0') }
                    sb.append(hex)
                } else {
                    sb.append(ch)
                }
            }
        }
        sb.append('"')
    }

    // -----------------------------------------------------------------------
    // 解析器
    // -----------------------------------------------------------------------

    private class JsonReader(private val src: String) {
        var pos = 0

        fun atEnd(): Boolean = pos >= src.length

        fun peek(): Char = if (pos < src.length) src[pos] else '\u0000'

        fun skipWs() {
            while (pos < src.length) {
                val c = src[pos]
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') pos++ else break
            }
        }

        /** 解析一个对象；失败返回 null，空对象 `{}` 返回空 Map */
        fun readObject(): Map<String, Any?>? {
            skipWs()
            if (peek() != '{') return null
            pos++
            val map = LinkedHashMap<String, Any?>()
            skipWs()
            if (peek() == '}') {
                pos++
                return map
            }
            while (true) {
                skipWs()
                val key = readString() ?: return null
                skipWs()
                if (peek() != ':') return null
                pos++
                skipWs()
                // 注意用 `=== ParseError` 判定失败：JSON 的 null 是**合法值**，
                // 而 `false` 本身就是 Any? 里的非 null 值。之前写成 `?: return null`
                // 会让 `"picked": false` 被当成解析失败，丢光所有数据。
                val value = readValue()
                if (value === ParseError) return null
                map[key] = if (value === NullValue) null else value
                skipWs()
                when (peek()) {
                    ',' -> pos++
                    '}' -> {
                        pos++
                        return map
                    }
                    else -> return null
                }
            }
        }

        /**
         * 解析一个值。返回值约定：
         *  - `null` 表示**合法的 JSON null**；
         *  - [NullValue] 不再用于值本身（保留给内部/向后兼容）；
         *  - [ParseError] 表示**非法输入**。
         *
         * 之所以要区分「合法 null」和「非法输入」：`readObject()` / `readArray()`
         * 失败时返回 null，如果非法输入也用 null 表示，就无法把它们与合法空对象区分开。
         */
        fun readValue(): Any? {
            skipWs()
            return when (val c = peek()) {
                '{' -> readObject() ?: ParseError
                '[' -> readArray() ?: ParseError
                '"' -> readString() ?: ParseError
                't' -> if (src.startsWith("true", pos)) {
                    pos += 4
                    true
                } else {
                    ParseError
                }
                'f' -> if (src.startsWith("false", pos)) {
                    pos += 5
                    false
                } else {
                    ParseError
                }
                'n' -> if (src.startsWith("null", pos)) {
                    pos += 4
                    null
                } else {
                    ParseError
                }
                else -> if (c == '-' || c.isDigit()) readNumber() ?: ParseError else ParseError
            }
        }

        private fun readArray(): List<Any?>? {
            skipWs()
            if (peek() != '[') return null
            pos++
            val out = ArrayList<Any?>()
            skipWs()
            if (peek() == ']') {
                pos++
                return out
            }
            while (true) {
                skipWs()
                val v = readValue()
                if (v === ParseError) return null
                out.add(if (v === NullValue) null else v)
                skipWs()
                when (peek()) {
                    ',' -> pos++
                    ']' -> {
                        pos++
                        return out
                    }
                    else -> return null
                }
            }
        }

        private fun readString(): String? {
            skipWs()
            if (peek() != '"') return null
            pos++
            val sb = StringBuilder()
            while (pos < src.length) {
                val c = src[pos++]
                when {
                    c == '"' -> return sb.toString()
                    c == '\\' -> {
                        if (pos >= src.length) return null
                        when (val e = src[pos++]) {
                            '"' -> sb.append('"')
                            '\\' -> sb.append('\\')
                            '/' -> sb.append('/')
                            'b' -> sb.append('\b')
                            'f' -> sb.append('\u000C')
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'u' -> {
                                if (pos + 4 > src.length) return null
                                val hex = src.substring(pos, pos + 4)
                                val code = hex.toIntOrNull(16) ?: return null
                                sb.append(code.toChar())
                                pos += 4
                            }
                            else -> return null
                        }
                    }
                    else -> sb.append(c)
                }
            }
            return null
        }

        private fun readNumber(): Any? {
            val start = pos
            if (peek() == '-') pos++
            while (pos < src.length && src[pos].isDigit()) pos++
            var isDouble = false
            if (pos < src.length && src[pos] == '.') {
                isDouble = true
                pos++
                while (pos < src.length && src[pos].isDigit()) pos++
            }
            if (pos < src.length && (src[pos] == 'e' || src[pos] == 'E')) {
                isDouble = true
                pos++
                if (pos < src.length && (src[pos] == '+' || src[pos] == '-')) pos++
                while (pos < src.length && src[pos].isDigit()) pos++
            }
            if (pos == start) return null
            val text = src.substring(start, pos)
            return if (isDouble) text.toDoubleOrNull() else text.toLongOrNull()
        }
    }

    /** 非法输入的哨兵值（区别于合法的 JSON null，也区别于 `false` 这类非 null 值） */
    private val ParseError = Any()

    /** 历史遗留哨兵：现在 readValue 对合法 JSON null 直接返回 null，此值仅作兼容保留。 */
    private val NullValue = Any()
}
