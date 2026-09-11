package com.pickupcode.app.core

/**
 * 取件码条目（见 CONTRACT.md 第 2 节）。
 *
 * 可空性严格遵守契约：
 * `courier` / `station` / `note` / `sourceApp` 与 `expireAt` 可为 null，其余字段非空。
 * UI 与 Store 大量使用 `?:` 与 null 分支，字段类型不能改。
 *
 * 本文件是**纯 Kotlin**，禁止 import android.*（core 包要能脱离 Android 单测）。
 */
data class PickupItem(
    /** 稳定去重键：normalize(code) + "|" + normalize(location) */
    val id: String,
    /** 取件码原文，如 "8-3-2015" / "123456" / "A88123"；取不到码时为 "" */
    val code: String,
    /** 命中的关键词（或 `凭` 锚点兜底时的高权重关键词），如 "取件码" */
    val keyword: String,
    /** 快递公司，如 "菜鸟驿站"/"丰巢"/"京东"/"顺丰"，未知为 null */
    val courier: String?,
    /** 取件网点名，如 "阳光花园店"，未知为 null */
    val station: String?,
    /** 附加提示，如 "请24小时内取件" 截断片段，未知为 null */
    val note: String?,
    /** "sms" | "notification" | "import" | "manual" */
    val source: String,
    /** 通知来源包名，短信为 null */
    val sourceApp: String?,
    /** 原始文案（截断到 300 字） */
    val rawText: String,
    /** 短信/通知时间戳（毫秒） */
    val eventTime: Long,
    /** 入库时间（毫秒） */
    val createdAt: Long,
    /** 是否已取件 */
    val picked: Boolean,
    /** 过期时间戳（毫秒），算不出为 null */
    val expireAt: Long?
) {
    /** 单条序列化，字段名与 tools/node/extract.mjs 的 Item 完全一致 */
    fun toJson(): String = PickupJson.encodeItem(this)

    companion object {
        /** 反序列化；解析失败返回 null（不抛异常） */
        @JvmStatic
        fun fromJson(raw: String?): PickupItem? = PickupJson.decodeItem(raw)
    }
}
