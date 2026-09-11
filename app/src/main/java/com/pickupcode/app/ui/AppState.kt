package com.pickupcode.app.ui

/**
 * 极轻量的进程内状态：MainActivity 是否在前台。
 *
 * 广播接收器用它决定要不要弹通知（用户正在看列表时不必打扰）。
 */
object AppState {

    @Volatile
    var foreground: Boolean = false
}
