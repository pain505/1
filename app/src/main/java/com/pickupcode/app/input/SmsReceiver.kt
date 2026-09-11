package com.pickupcode.app.input

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log
import com.pickupcode.app.R
import com.pickupcode.app.core.PickupItem
import com.pickupcode.app.core.PickupParser
import com.pickupcode.app.store.PickupStore
import com.pickupcode.app.ui.AppState
import com.pickupcode.app.ui.MainActivity
import java.util.concurrent.Executors

/**
 * 短信广播接收器（静态注册，priority=999）。
 *
 * 行为：
 *  - 取 `Telephony.Sms.Intents.getMessagesFromIntent(intent)` 的分片数组，
 *    按 originating address 合并多 part 成一条完整文案；
 *  - eventTime 使用分片的 `timestampMillis`；
 *  - 一律**不** abort 广播（不影响系统短信 App）；
 *  - 只有「有新条目」且 App 不在前台时才发一条汇总通知。
 */
class SmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        try {
            if (intent == null) return
            if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
            val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
            if (messages.isEmpty()) return

            // 按发件人合并分片：同一 address 的多个 part 属于同一条长短信
            val bodies = LinkedHashMap<String, StringBuilder>()
            val times = LinkedHashMap<String, Long>()
            for (msg in messages) {
                if (msg == null) continue
                val addr = msg.originatingAddress ?: ""
                val part = msg.messageBody ?: ""
                val sb = bodies[addr]
                if (sb == null) {
                    bodies[addr] = StringBuilder(part)
                } else {
                    sb.append(part)
                }
                val ts = msg.timestampMillis
                val old = times[addr]
                if (old == null || (ts > 0L && ts < old)) {
                    times[addr] = if (ts > 0L) ts else System.currentTimeMillis()
                }
            }

            val parsed = ArrayList<PickupItem>()
            for ((addr, sb) in bodies) {
                val text = sb.toString().trim()
                if (text.isEmpty()) continue
                val eventTime = times[addr] ?: System.currentTimeMillis()
                parsed.addAll(PickupParser.parse(text, SOURCE, eventTime, null))
            }
            if (parsed.isEmpty()) return

            // 广播回调里不做磁盘 IO
            val appContext = context.applicationContext
            EXECUTOR.execute {
                try {
                    PickupStore.init(appContext)
                    val added = PickupStore.upsert(parsed)
                    if (added > 0 && !AppState.foreground) {
                        notifyNew(appContext, added)
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "upsert failed", t)
                }
            }
        } catch (t: Throwable) {
            // 广播里抛异常会导致系统重试刷屏，全部吞掉
            Log.w(TAG, "onReceive failed", t)
        }
    }

    /** 发一条汇总通知：点开进 MainActivity。 */
    private fun notifyNew(context: Context, added: Int) {
        try {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                ?: return
            val channel = NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.notify_channel_new),
                NotificationManager.IMPORTANCE_DEFAULT
            )
            manager.createNotificationChannel(channel)

            val open = Intent(context, MainActivity::class.java)
            open.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            val pending = PendingIntent.getActivity(context, 0, open, flags)

            val builder = android.app.Notification.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_pickup)
                .setContentTitle(context.getString(R.string.app_name))
                .setContentText(context.getString(R.string.notify_new_body, added))
                .setAutoCancel(true)
                .setContentIntent(pending)
            if (added > 1) {
                builder.setStyle(
                    android.app.Notification.BigTextStyle()
                        .bigText(context.getString(R.string.notify_new_body, added))
                )
            }
            manager.notify(NOTIFICATION_ID, builder.build())
        } catch (t: Throwable) {
            Log.w(TAG, "notify failed", t)
        }
    }

    companion object {
        private const val TAG = "SmsReceiver"
        private const val SOURCE = "sms"
        private const val CHANNEL_ID = "pickup_new"
        private const val NOTIFICATION_ID = 1001

        private val EXECUTOR = Executors.newSingleThreadExecutor()
    }
}
