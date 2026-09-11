package com.pickupcode.app.store

import android.content.Context
import android.content.SharedPreferences
import com.pickupcode.app.core.PickupItem
import com.pickupcode.app.core.PickupJson

/**
 * 取件码持久化。
 *
 * 实现方式：SharedPreferences 单键 `items_v1` 存整个 List<PickupItem> 的 JSON。
 * 全部方法线程安全（@Synchronized，静态方法锁的是 PickupStore.kt 对应的 Class 对象）。
 *
 * 自动过期：eventTime 早于 45 天的**未取件**条目会被丢弃；
 * `all()` 会顺手做一次物理清理写回，`upsert()` 写入时也会清理。
 */
object PickupStore {

    private const val PREF_NAME = "pickup_store"
    private const val KEY_ITEMS = "items_v1"

    /** 未取件条目的保留时长：45 天。 */
    private const val MAX_AGE_MS: Long = 45L * 24L * 60L * 60L * 1000L

    @Volatile
    private var prefs: SharedPreferences? = null

    /** 在 Application/Activity 启动时调用一次即可，重复调用无副作用。 */
    @Synchronized
    fun init(context: Context) {
        if (prefs == null) {
            prefs = context.applicationContext.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        }
    }

    // ------------------------------------------------------------------ 读

    /** 未取件 + 45 天内，按 eventTime 倒序（新的在前）。 */
    @Synchronized
    fun all(): List<PickupItem> {
        val stored = readItems()
        val kept = stored.filter { !isExpired(it) }
        if (kept.size != stored.size) {
            // 物理清理过期数据
            save(kept)
        }
        return kept.sortedByDescending { it.eventTime }
    }

    /** 未取件条数。 */
    @Synchronized
    fun pendingCount(): Int = readItems().count { !it.picked && !isExpired(it) }

    /** 今天到期（expireAt 落在今天 00:00 ~ 24:00）的未取件条数。 */
    @Synchronized
    fun dueTodayCount(): Int {
        val cal = java.util.Calendar.getInstance()
        cal.set(java.util.Calendar.HOUR_OF_DAY, 0)
        cal.set(java.util.Calendar.MINUTE, 0)
        cal.set(java.util.Calendar.SECOND, 0)
        cal.set(java.util.Calendar.MILLISECOND, 0)
        val dayStart = cal.timeInMillis
        val dayEnd = dayStart + 24L * 60L * 60L * 1000L
        return readItems().count { item ->
            val at = item.expireAt
            !item.picked && !isExpired(item) && at != null && at >= dayStart && at < dayEnd
        }
    }

    // ------------------------------------------------------------------ 写

    /**
     * 按 id 去重写入。
     * 已存在的条目做合并：picked 取 or，station/courier/expireAt/note 取非空值，
     * 其余字段用新值覆盖。返回**新增**条数。
     */
    @Synchronized
    fun upsert(items: List<PickupItem>): Int {
        if (items.isEmpty()) return 0
        val current = readItems()
        val map = LinkedHashMap<String, PickupItem>(current.size + items.size)
        for (item in current) {
            map[item.id] = item
        }
        var added = 0
        for (incoming in items) {
            val old = map[incoming.id]
            if (old == null) {
                map[incoming.id] = incoming
                added++
            } else {
                map[incoming.id] = merge(old, incoming)
            }
        }
        if (added == 0 && map.size == current.size) return 0
        save(map.values.filter { !isExpired(it) })
        return added
    }

    /** 标记取件状态，返回是否命中了条目。 */
    @Synchronized
    fun markPicked(id: String, picked: Boolean): Boolean {
        val list = readItems()
        var hit = false
        for (i in list.indices) {
            if (list[i].id == id) {
                list[i] = list[i].copy(picked = picked)
                hit = true
            }
        }
        if (hit) save(list)
        return hit
    }

    /** 删除单条，返回是否删掉了东西。 */
    @Synchronized
    fun remove(id: String): Boolean {
        val list = readItems()
        val kept = list.filter { it.id != id }
        if (kept.size == list.size) return false
        save(kept)
        return true
    }

    /** 清空所有已取件条目，返回清理条数。 */
    @Synchronized
    fun clearPicked(): Int {
        val list = readItems()
        val kept = list.filter { !it.picked }
        val removed = list.size - kept.size
        if (removed > 0) save(kept)
        return removed
    }

    // ------------------------------------------------------------------ 内部

    private fun merge(old: PickupItem, incoming: PickupItem): PickupItem = PickupItem(
        id = old.id,
        code = if (incoming.code.isNotEmpty()) incoming.code else old.code,
        keyword = if (incoming.keyword.isNotEmpty()) incoming.keyword else old.keyword,
        courier = incoming.courier ?: old.courier,
        station = incoming.station ?: old.station,
        note = incoming.note ?: old.note,
        source = if (incoming.source.isNotEmpty()) incoming.source else old.source,
        sourceApp = incoming.sourceApp ?: old.sourceApp,
        rawText = if (incoming.rawText.isNotEmpty()) incoming.rawText else old.rawText,
        eventTime = if (incoming.eventTime > 0L) incoming.eventTime else old.eventTime,
        createdAt = if (old.createdAt > 0L) old.createdAt else incoming.createdAt,
        picked = old.picked || incoming.picked,
        expireAt = incoming.expireAt ?: old.expireAt
    )

    /** 未取件且超过 45 天 → 过期丢弃。已取件条目不自动清理。 */
    private fun isExpired(item: PickupItem): Boolean {
        if (item.picked) return false
        return System.currentTimeMillis() - item.eventTime > MAX_AGE_MS
    }

    private fun store(): SharedPreferences? = prefs

    private fun readItems(): MutableList<PickupItem> {
        val p = store() ?: return mutableListOf()
        val raw = p.getString(KEY_ITEMS, null)
        if (raw.isNullOrEmpty()) return mutableListOf()
        val decoded: List<PickupItem>? = PickupJson.decodeList(raw)
        return decoded?.toMutableList() ?: mutableListOf()
    }

    private fun save(items: List<PickupItem>) {
        val p = store() ?: return
        p.edit().putString(KEY_ITEMS, PickupJson.encodeList(items)).apply()
    }
}
