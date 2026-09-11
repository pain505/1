package com.pickupcode.app.ui

import android.content.Context
import com.pickupcode.app.R
import com.pickupcode.app.core.PickupItem
import java.util.Calendar

/**
 * 列表里的时间与倒计时文案（全部走 strings.xml）。
 */
object UiFormat {

    private const val MINUTE_MS = 60L * 1000L
    private const val HOUR_MS = 60L * MINUTE_MS
    private const val DAY_MS = 24L * HOUR_MS

    /** 无 expireAt 时的兜底有效期：到件时间 + 3 天，文案上会标「约」。 */
    private const val FALLBACK_EXPIRE_MS = 3L * DAY_MS

    /** 相对时间：刚刚 / N分钟前 / N小时前 / N天前。 */
    fun relTime(context: Context, t: Long): String {
        val diff = System.currentTimeMillis() - t
        if (diff < MINUTE_MS) return context.getString(R.string.rel_just_now)
        if (diff < HOUR_MS) return context.getString(R.string.rel_minutes, (diff / MINUTE_MS).toInt())
        if (diff < DAY_MS) return context.getString(R.string.rel_hours, (diff / HOUR_MS).toInt())
        return context.getString(R.string.rel_days, (diff / DAY_MS).toInt())
    }

    /** 倒计时文案。 */
    fun countdown(context: Context, item: PickupItem): String {
        if (item.picked) return context.getString(R.string.cd_picked)

        val explicit = item.expireAt
        if (explicit == null) {
            // 算不出过期时间：用「约 到件时间+3天」作参考，文案必须标「约」
            val approx = item.eventTime + FALLBACK_EXPIRE_MS
            return approxCountdown(context, approx)
        }
        return exactCountdown(context, explicit)
    }

    private fun exactCountdown(context: Context, expireAt: Long): String {
        val now = System.currentTimeMillis()
        val left = expireAt - now
        if (left <= 0L) {
            val days = (-left) / DAY_MS
            return context.getString(R.string.cd_expired_days, (if (days < 1L) 1L else days).toInt())
        }
        if (left < HOUR_MS) return context.getString(R.string.cd_less_than_hour)
        if (isToday(expireAt) && left < DAY_MS) {
            return context.getString(R.string.cd_today_before, hourOf(expireAt))
        }
        return context.getString(R.string.cd_hours_left, (left / HOUR_MS).toInt())
    }

    private fun approxCountdown(context: Context, approx: Long): String {
        val now = System.currentTimeMillis()
        val left = approx - now
        if (left <= 0L) return context.getString(R.string.cd_no_expire_passed)
        if (left < HOUR_MS) return context.getString(R.string.cd_no_expire_soon)
        if (isToday(approx)) {
            return context.getString(R.string.cd_about_today, hourOf(approx))
        }
        return context.getString(R.string.cd_about_hours, (left / HOUR_MS).toInt())
    }

    fun isToday(t: Long): Boolean {
        val a = Calendar.getInstance()
        val b = Calendar.getInstance()
        b.timeInMillis = t
        return a.get(Calendar.YEAR) == b.get(Calendar.YEAR) &&
            a.get(Calendar.DAY_OF_YEAR) == b.get(Calendar.DAY_OF_YEAR)
    }

    private fun hourOf(t: Long): Int {
        val cal = Calendar.getInstance()
        cal.timeInMillis = t
        return cal.get(Calendar.HOUR_OF_DAY)
    }
}
