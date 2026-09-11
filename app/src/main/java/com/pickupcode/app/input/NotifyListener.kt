package com.pickupcode.app.input

import android.app.Notification
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import android.widget.Toast
import com.pickupcode.app.R
import com.pickupcode.app.core.PickupItem
import com.pickupcode.app.core.PickupParser
import com.pickupcode.app.store.PickupStore
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 通知监听：从购物类 App 的取件通知里解析取件码。
 *
 * 只处理 [WHITELIST] 里的包名，其余一律忽略，避免刷屏与无谓耗电。
 * 通知回调里抛异常会被系统重试刷屏，所以这里全部 try/catch 吞掉。
 */
class NotifyListener : NotificationListenerService() {

    private val connectedToasted = AtomicBoolean(false)

    override fun onListenerConnected() {
        super.onListenerConnected()
        try {
            if (connectedToasted.compareAndSet(false, true)) {
                Toast.makeText(
                    applicationContext,
                    getString(R.string.toast_listener_connected),
                    Toast.LENGTH_SHORT
                ).show()
            }
        } catch (t: Throwable) {
            Log.w(TAG, "onListenerConnected failed", t)
        }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        try {
            if (sbn == null) return
            val pkg = sbn.packageName
            if (pkg == null || !WHITELIST.contains(pkg)) return

            val notification: Notification = sbn.notification ?: return
            val extras: Bundle = notification.extras ?: return

            val text = buildText(extras)
            if (text.isEmpty()) return

            val eventTime = if (sbn.postTime > 0L) sbn.postTime else System.currentTimeMillis()

            // 解析与落盘都放到后台线程：通知回调运行在系统服务线程上，不能在这里做重活。
            val appContext = applicationContext
            EXECUTOR.execute {
                try {
                    val parsed: List<PickupItem> = PickupParser.parse(text, SOURCE, eventTime, pkg)
                    if (parsed.isEmpty()) return@execute
                    PickupStore.init(appContext)
                    PickupStore.upsert(parsed)
                } catch (t: Throwable) {
                    Log.w(TAG, "parse/upsert failed", t)
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "onNotificationPosted failed", t)
        }
    }

    /** 拼接标题与正文，去重后以换行连接。 */
    private fun buildText(extras: Bundle): String {
        val parts = ArrayList<String>(4)
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)
        if (!title.isNullOrBlank()) parts.add(title.toString())

        val text = extras.getCharSequence(Notification.EXTRA_TEXT)
        if (!text.isNullOrBlank()) parts.add(text.toString())

        val big = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
        if (!big.isNullOrBlank()) parts.add(big.toString())

        val lines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
        if (lines != null) {
            for (line in lines) {
                if (!line.isNullOrBlank()) parts.add(line.toString())
            }
        }

        if (parts.isEmpty()) return ""
        val out = StringBuilder()
        for (p in parts) {
            val s = p.trim()
            if (s.isEmpty()) continue
            if (out.contains(s)) continue
            if (out.isNotEmpty()) out.append('\n')
            out.append(s)
        }
        return out.toString()
    }

    companion object {
        private const val TAG = "NotifyListener"
        private const val SOURCE = "notification"

        private val EXECUTOR = Executors.newSingleThreadExecutor()

        /** 契约第 4 节：通知监听白名单。 */
        private val WHITELIST: Set<String> = setOf(
            "com.xunmeng.pinduoduo",      // 拼多多
            "com.taobao.taobao",          // 淘宝
            "com.jingdong.app.mall",      // 京东
            "com.eg.android.AlipayGphone",// 支付宝
            "com.cainiao.wireless",       // 菜鸟
            "com.tencent.mm",             // 微信
            "com.tencent.mobileqq"        // QQ
        )
    }
}
