package com.pickupcode.app.ui

import android.content.Context
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.TextView
import com.pickupcode.app.R
import com.pickupcode.app.core.PickupItem

/**
 * 取件码列表适配器（平台 BaseAdapter，不依赖 RecyclerView）。
 *
 * 结构：分组头（不可点）+ 条目行。
 * 分组规则：`station ?: courier ?: "未识别网点"`，组内按 `expireAt ?: Long.MAX_VALUE` 升序；
 * 已取件条目统一挪到列表最后的分组「已取件」。
 */
class PickupAdapter(
    private val context: Context,
    private val onItemClick: (PickupItem) -> Unit,
    private val onItemLongClick: (PickupItem) -> Unit
) : BaseAdapter() {

    /** 一行：要么是分组头，要么是一个条目。 */
    private class Row private constructor(
        val isHeader: Boolean,
        val title: String?,
        val count: Int,
        val item: PickupItem?
    ) {
        companion object {
            fun header(title: String, count: Int): Row = Row(true, title, count, null)
            fun item(item: PickupItem): Row = Row(false, null, 0, item)
        }
    }

    private val rows: MutableList<Row> = ArrayList()

    /** 展示用网点名 = 分组键：station ?: courier ?: 「未识别网点」。 */
    private val placeholder: String = context.getString(R.string.group_unknown)

    private fun locationKey(item: PickupItem): String =
        item.station ?: item.courier ?: placeholder

    /** 替换全部数据并重建分组。 */
    fun setItems(items: List<PickupItem>) {
        val built = ArrayList<Row>(items.size + 8)

        val active = ArrayList<PickupItem>()
        val picked = ArrayList<PickupItem>()
        for (item in items) {
            if (item.picked) picked.add(item) else active.add(item)
        }

        // LinkedHashMap 保留首次出现顺序，保证列表稳定不会乱跳
        val groups = LinkedHashMap<String, MutableList<PickupItem>>()
        for (item in active) {
            val key = locationKey(item)
            val bucket = groups[key]
            if (bucket == null) {
                groups[key] = arrayListOf(item)
            } else {
                bucket.add(item)
            }
        }

        for ((key, bucket) in groups) {
            bucket.sortWith(COMPARATOR)
            built.add(Row.header(key, bucket.size))
            for (item in bucket) built.add(Row.item(item))
        }

        if (picked.isNotEmpty()) {
            picked.sortWith(COMPARATOR)
            built.add(Row.header(context.getString(R.string.group_picked), picked.size))
            for (item in picked) built.add(Row.item(item))
        }

        rows.clear()
        rows.addAll(built)
        notifyDataSetChanged()
    }

    override fun getCount(): Int = rows.size

    override fun getItem(position: Int): Any? = rows.getOrNull(position)?.item

    override fun getItemId(position: Int): Long = position.toLong()

    override fun areAllItemsEnabled(): Boolean = false

    /** 分组头不可点。 */
    override fun isEnabled(position: Int): Boolean = !(rows.getOrNull(position)?.isHeader ?: true)

    override fun getViewTypeCount(): Int = TYPE_COUNT

    override fun getItemViewType(position: Int): Int {
        val row = rows.getOrNull(position) ?: return TYPE_ITEM
        return if (row.isHeader) TYPE_HEADER else TYPE_ITEM
    }

    override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
        val row = rows.getOrNull(position)
        val type = getItemViewType(position)
        val view = convertView ?: LayoutInflater.from(context)
            .inflate(
                if (type == TYPE_HEADER) R.layout.group_header else R.layout.item_pickup,
                parent,
                false
            )

        if (type == TYPE_HEADER) {
            bindHeader(view, row)
        } else {
            bindItem(view, row?.item)
        }
        return view
    }

    // ------------------------------------------------------------------ 绑定

    private fun bindHeader(view: View, row: Row?) {
        val titleView = view.findViewById<TextView>(R.id.groupTitle)
        val countView = view.findViewById<TextView>(R.id.groupCount)
        titleView.text = row?.title ?: ""
        countView.text = context.getString(R.string.group_count, row?.count ?: 0)
    }

    private fun bindItem(view: View, item: PickupItem?) {
        val codeView = view.findViewById<TextView>(R.id.codeText)
        val stationView = view.findViewById<TextView>(R.id.stationText)
        val tagView = view.findViewById<TextView>(R.id.courierTag)
        val relView = view.findViewById<TextView>(R.id.relTimeText)
        val countdownView = view.findViewById<TextView>(R.id.countdownText)
        val noteView = view.findViewById<TextView>(R.id.noteText)

        if (item == null) {
            codeView.text = ""
            stationView.text = ""
            tagView.visibility = View.GONE
            relView.text = ""
            countdownView.text = ""
            noteView.visibility = View.GONE
            return
        }

        val hasCode = item.code.isNotEmpty()
        codeView.text = if (hasCode) item.code else context.getString(R.string.code_unknown)
        codeView.setTextColor(
            context.getColor(if (hasCode) R.color.code_text else R.color.code_text_unknown)
        )
        codeView.visibility = View.VISIBLE

        stationView.text = locationKey(item)

        val courier = item.courier
        if (courier.isNullOrEmpty()) {
            tagView.visibility = View.GONE
        } else {
            tagView.visibility = View.VISIBLE
            tagView.text = courier
        }

        relView.text = UiFormat.relTime(context, item.eventTime)
        countdownView.text = UiFormat.countdown(context, item)

        val note = item.note
        if (note.isNullOrBlank()) {
            noteView.visibility = View.GONE
        } else {
            noteView.visibility = View.VISIBLE
            noteView.text = note
        }

        // 已取件置灰
        val alpha = if (item.picked) 0.45f else 1.0f
        stationView.alpha = alpha
        tagView.alpha = alpha
        relView.alpha = alpha
        noteView.alpha = alpha
        codeView.alpha = alpha
        countdownView.alpha = 1.0f

        view.isEnabled = true
        view.setOnClickListener { onItemClick(item) }
        view.setOnLongClickListener {
            onItemLongClick(item)
            true
        }
    }

    companion object {
        private const val TYPE_HEADER = 0
        private const val TYPE_ITEM = 1
        private const val TYPE_COUNT = 2

        /** 组内排序：先按过期时间，再按事件时间。 */
        private val COMPARATOR = Comparator<PickupItem> { a, b ->
            val ea = a.expireAt ?: Long.MAX_VALUE
            val eb = b.expireAt ?: Long.MAX_VALUE
            val byExpire = ea.compareTo(eb)
            if (byExpire != 0) byExpire else a.eventTime.compareTo(b.eventTime)
        }
    }
}
