package com.pickupcode.app.input

import android.content.Context
import android.database.Cursor
import android.provider.Telephony
import android.util.Log
import com.pickupcode.app.core.PickupItem
import com.pickupcode.app.core.PickupParser
import com.pickupcode.app.store.PickupStore

/**
 * 历史短信导入：扫 `content://sms/inbox` 最近 [days] 天，逐条解析并入库。
 */
object SmsScan {

    private const val TAG = "SmsScan"

    /**
     * @return 新增条数；缺少 READ_SMS 权限时返回 -1；其他失败返回 0。
     */
    fun scanRecent(context: Context, days: Int = 60): Int {
        val resolver = context.contentResolver
        val since = System.currentTimeMillis() - days.toLong() * 24L * 60L * 60L * 1000L
        var cursor: Cursor? = null
        try {
            cursor = resolver.query(
                Telephony.Sms.Inbox.CONTENT_URI,
                PROJECTION,
                SELECTION,
                arrayOf(since.toString()),
                SORT_ORDER
            ) ?: return 0

            val idxAddress = cursor.getColumnIndex(Telephony.Sms.ADDRESS)
            val idxBody = cursor.getColumnIndex(Telephony.Sms.BODY)
            val idxDate = cursor.getColumnIndex(Telephony.Sms.DATE)

            val parsed = ArrayList<PickupItem>()
            while (cursor.moveToNext()) {
                val body: String? = if (idxBody >= 0) cursor.getString(idxBody) else null
                if (body.isNullOrEmpty()) continue
                val date: Long = if (idxDate >= 0) {
                    val v = cursor.getLong(idxDate)
                    if (v > 0L) v else System.currentTimeMillis()
                } else {
                    System.currentTimeMillis()
                }
                // address 目前不作为字段入库（PickupItem 无 address 字段），读出来仅用于日志排查
                val address: String? = if (idxAddress >= 0) cursor.getString(idxAddress) else null
                try {
                    val items = PickupParser.parse(body, SOURCE, date, null)
                    if (items.isNotEmpty()) parsed.addAll(items)
                } catch (t: Throwable) {
                    Log.w(TAG, "parse failed for sms from $address", t)
                }
            }

            if (parsed.isEmpty()) return 0
            PickupStore.init(context)
            return PickupStore.upsert(parsed)
        } catch (e: SecurityException) {
            // 没有 READ_SMS 权限
            Log.w(TAG, "no READ_SMS permission", e)
            return -1
        } catch (t: Throwable) {
            Log.w(TAG, "query failed", t)
            return 0
        } finally {
            try {
                cursor?.close()
            } catch (t: Throwable) {
                Log.w(TAG, "close failed", t)
            }
        }
    }

    private const val SOURCE = "sms"
    private const val SORT_ORDER = Telephony.Sms.DATE + " DESC"
    private const val SELECTION = Telephony.Sms.DATE + " >= ?"

    private val PROJECTION = arrayOf(
        Telephony.Sms._ID,
        Telephony.Sms.ADDRESS,
        Telephony.Sms.BODY,
        Telephony.Sms.DATE
    )
}
