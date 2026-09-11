package com.pickupcode.app.ui

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast
import com.pickupcode.app.R
import com.pickupcode.app.core.PickupItem
import com.pickupcode.app.core.PickupParser
import com.pickupcode.app.input.SmsScan
import com.pickupcode.app.store.PickupStore
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * 主界面：标题 + 统计 + 权限提示 + 分组列表。
 * 只用平台 API（ListView / BaseAdapter / AlertDialog），不引入任何 AndroidX。
 */
class MainActivity : Activity() {

    private lateinit var listView: ListView
    private lateinit var statsText: TextView
    private lateinit var permissionBar: LinearLayout
    private lateinit var smsPermissionRow: TextView
    private lateinit var notifyPermissionRow: TextView
    private lateinit var notifPermRow: TextView
    private lateinit var adapter: PickupAdapter
    private lateinit var executor: ExecutorService
    private var items: List<PickupItem> = emptyList()
    private var scanning = false

    // ------------------------------------------------------------------ 生命周期

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        PickupStore.init(this)
        executor = Executors.newSingleThreadExecutor()

        listView = findViewById(android.R.id.list)
        statsText = findViewById(R.id.statsText)
        permissionBar = findViewById(R.id.permissionBar)
        smsPermissionRow = findViewById(R.id.smsPermission)
        notifyPermissionRow = findViewById(R.id.notifyPermission)
        notifPermRow = findViewById(R.id.notifPerm)

        adapter = PickupAdapter(
            this,
            onItemClick = { item -> onRowClick(item) },
            onItemLongClick = { item -> onRowLongClick(item) }
        )
        listView.adapter = adapter
    }

    override fun onResume() {
        super.onResume()
        AppState.foreground = true
        render()
    }

    override fun onPause() {
        AppState.foreground = false
        super.onPause()
    }

    override fun onDestroy() {
        executor.shutdown()
        super.onDestroy()
    }

    // ------------------------------------------------------------------ 渲染

    private fun render() {
        items = try {
            PickupStore.all()
        } catch (t: Throwable) {
            Log.w(TAG, "load failed", t)
            emptyList()
        }
        adapter.setItems(items)
        statsText.text = getString(R.string.stats_fmt, countPending(items), countDueToday(items))
        renderPermissionBar()
    }

    private fun countPending(list: List<PickupItem>): Int = list.count { !it.picked }

    private fun countDueToday(list: List<PickupItem>): Int =
        list.count { !it.picked && it.expireAt != null && UiFormat.isToday(it.expireAt) }

    @Suppress("DEPRECATION")
    private fun renderPermissionBar() {
        val smsOk = hasPermission(Manifest.permission.RECEIVE_SMS) &&
            hasPermission(Manifest.permission.READ_SMS)
        val notifyOk = isListenerEnabled()
        // POST_NOTIFICATIONS 是 API 33 才有的权限；低版本上 checkSelfPermission 永远返回拒绝，
        // 不判版本会导致「通知权限」这一行永远消不掉。
        val notifPermOk = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            hasPermission(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            true
        }

        // 短信权限行
        if (smsOk) {
            smsPermissionRow.visibility = View.GONE
        } else {
            smsPermissionRow.visibility = View.VISIBLE
            smsPermissionRow.setText(R.string.permission_sms)
            smsPermissionRow.setOnClickListener { requestSmsPermissions() }
        }

        // 通知监听权限行
        if (notifyOk) {
            notifyPermissionRow.visibility = View.GONE
        } else {
            notifyPermissionRow.visibility = View.VISIBLE
            notifyPermissionRow.setText(R.string.permission_notify)
            notifyPermissionRow.setOnClickListener { openNotificationSettings() }
        }

        // 通知（Android 13+）权限行
        if (notifPermOk) {
            notifPermRow.visibility = View.GONE
        } else {
            notifPermRow.visibility = View.VISIBLE
            notifPermRow.setText(R.string.permission_notif_perm)
            notifPermRow.setOnClickListener { requestNotificationPermission() }
        }

        permissionBar.visibility =
            if (smsPermissionRow.visibility == View.VISIBLE ||
                notifyPermissionRow.visibility == View.VISIBLE ||
                notifPermRow.visibility == View.VISIBLE
            ) View.VISIBLE else View.GONE
    }

    private fun hasPermission(permission: String): Boolean =
        checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun requestSmsPermissions() {
        val needed = ArrayList<String>(3)
        if (!hasPermission(Manifest.permission.RECEIVE_SMS)) needed.add(Manifest.permission.RECEIVE_SMS)
        if (!hasPermission(Manifest.permission.READ_SMS)) needed.add(Manifest.permission.READ_SMS)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !hasPermission(Manifest.permission.POST_NOTIFICATIONS)
        ) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (needed.isEmpty()) {
            renderPermissionBar()
            return
        }
        requestPermissions(needed.toTypedArray(), REQ_PERMISSIONS)
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            renderPermissionBar()
            return
        }
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_PERMISSIONS)
    }

    private fun openNotificationSettings() {
        try {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        } catch (t: Throwable) {
            Log.w(TAG, "cannot open notification listener settings", t)
            toast(getString(R.string.permission_notify_manual))
        }
    }

    /** 不依赖 AndroidX：直接读系统设置里的已启用监听器列表。 */
    private fun isListenerEnabled(): Boolean {
        return try {
            val flat: String = Settings.Secure.getString(contentResolver, ENABLED_LISTENERS) ?: ""
            if (flat.isEmpty()) {
                false
            } else {
                val target = Uri.decode(packageName)
                flat.split(':').any { part ->
                    val trimmed = part.trim()
                    trimmed.isNotEmpty() && (trimmed.startsWith(target) || trimmed.contains(target))
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "isListenerEnabled failed", t)
            false
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_PERMISSIONS) return

        var grantedAny = false
        for (i in grantResults.indices) {
            if (permissions[i] == Manifest.permission.READ_SMS &&
                grantResults[i] == PackageManager.PERMISSION_GRANTED
            ) {
                grantedAny = true
            }
        }
        renderPermissionBar()

        if (grantedAny) {
            // READ_SMS 授权成功后自动补一次历史短信扫描
            startBackground(getString(R.string.toast_scanning)) { runScan() }
        } else {
            toast(getString(R.string.toast_permission_denied))
        }
    }

    // ------------------------------------------------------------------ 菜单

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.main, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        val id = item.itemId
        return when (id) {
            R.id.action_scan -> {
                startBackground(getString(R.string.toast_scanning)) { runScan() }
                true
            }

            R.id.action_paste -> {
                pasteImport()
                true
            }

            R.id.action_clear_picked -> {
                confirmClearPicked()
                true
            }

            R.id.action_help -> {
                showHelp()
                true
            }

            else -> super.onOptionsItemSelected(item)
        }
    }

    @Suppress("DEPRECATION")
    private fun pasteImport() {
        val text: String? = try {
            val manager = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            val clip = manager?.primaryClip
            if (clip != null && clip.itemCount > 0) clip.getItemAt(0).coerceToText(this)?.toString() else null
        } catch (t: Throwable) {
            Log.w(TAG, "clipboard read failed", t)
            null
        }

        if (text.isNullOrBlank()) {
            toast(getString(R.string.toast_clipboard_empty))
            return
        }
        val parsed = try {
            PickupParser.parse(text.trim(), SOURCE_MANUAL, System.currentTimeMillis(), null)
        } catch (t: Throwable) {
            Log.w(TAG, "parse failed", t)
            emptyList()
        }
        if (parsed.isEmpty()) {
            toast(getString(R.string.toast_import_none))
            return
        }
        val added = PickupStore.upsert(parsed)
        toast(getString(R.string.toast_import_ok, added))
        render()
    }

    private fun confirmClearPicked() {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.menu_clear_picked))
            .setMessage(getString(R.string.dialog_clear_picked_msg))
            .setPositiveButton(getString(R.string.action_ok)) { _, _ ->
                val removed = PickupStore.clearPicked()
                toast(getString(R.string.toast_cleared, removed))
                render()
            }
            .setNegativeButton(getString(R.string.action_cancel), null)
            .show()
    }

    private fun showHelp() {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.menu_help))
            .setMessage(getString(R.string.help_message))
            .setPositiveButton(getString(R.string.action_ok), null)
            .show()
    }

    // ------------------------------------------------------------------ 行交互

    private fun onRowClick(item: PickupItem) {
        if (item.code.isEmpty()) {
            toast(getString(R.string.toast_no_code))
            showRawDialog(item)
            return
        }
        copyToClipboard(item.code)
        toast(getString(R.string.toast_copied, item.code))
    }

    private fun onRowLongClick(item: PickupItem) {
        val title = if (item.code.isEmpty()) getString(R.string.code_unknown) else item.code
        val options = arrayOf(
            getString(if (item.picked) R.string.action_mark_unpicked else R.string.action_mark_picked),
            getString(R.string.action_delete),
            getString(R.string.action_copy_raw),
            getString(R.string.action_view_raw)
        )
        AlertDialog.Builder(this)
            .setTitle(title)
            .setItems(options) { _, which ->
                when (which) {
                    0 -> {
                        PickupStore.markPicked(item.id, !item.picked)
                        toast(
                            getString(
                                if (item.picked) R.string.toast_marked_unpicked
                                else R.string.toast_marked_picked
                            )
                        )
                        render()
                    }

                    1 -> {
                        PickupStore.remove(item.id)
                        toast(getString(R.string.toast_deleted))
                        render()
                    }

                    2 -> {
                        copyToClipboard(item.rawText)
                        toast(getString(R.string.toast_copied_raw))
                    }

                    3 -> showRawDialog(item)

                    else -> Unit
                }
            }
            .setNegativeButton(getString(R.string.action_cancel), null)
            .show()
    }

    private fun showRawDialog(item: PickupItem) {
        val raw = if (item.rawText.isBlank()) getString(R.string.raw_empty) else item.rawText
        AlertDialog.Builder(this)
            .setTitle(R.string.dialog_raw_title)
            .setMessage(raw)
            .setPositiveButton(R.string.action_copy) { _, _ ->
                copyToClipboard(item.rawText)
                toast(getString(R.string.toast_copied_raw))
            }
            .setNegativeButton(R.string.action_cancel, null)
            .show()
    }

    private fun copyToClipboard(text: String) {
        try {
            val manager = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            manager?.setPrimaryClip(ClipData.newPlainText(getString(R.string.clip_label), text))
        } catch (t: Throwable) {
            Log.w(TAG, "clipboard write failed", t)
        }
    }

    // ------------------------------------------------------------------ 扫描

    private fun runScan() {
        // 注意：互斥由调用方 startBackground() 负责（它已把 scanning 置 true）。
        // 这里不要再判断 scanning，否则会把自己挡掉、扫描永远不执行。
        val result = try {
            SmsScan.scanRecent(this)
        } catch (t: Throwable) {
            Log.w(TAG, "scan failed", t)
            0
        }
        runOnUiThread {
            scanning = false
            when {
                result < 0 -> toast(getString(R.string.toast_scan_no_permission))
                result == 0 -> toast(getString(R.string.toast_scan_none))
                else -> toast(getString(R.string.toast_scan_added, result))
            }
            render()
        }
    }

    /** 统一把耗时活儿丢到单线程池，完成后回主线程刷新。 */
    private fun startBackground(busyMessage: String, job: () -> Unit) {
        if (scanning) {
            toast(getString(R.string.toast_busy))
            return
        }
        scanning = true
        toast(busyMessage)
        executor.execute {
            try {
                job()
            } catch (t: Throwable) {
                Log.w(TAG, "background job failed", t)
                runOnUiThread {
                    scanning = false
                    toast(getString(R.string.toast_failed))
                }
            }
        }
    }

    private fun toast(message: String) {
        try {
            Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
        } catch (t: Throwable) {
            Log.w(TAG, "toast failed", t)
        }
    }

    private companion object {
        private const val TAG = "MainActivity"
        private const val REQ_PERMISSIONS = 100
        private const val SOURCE_MANUAL = "manual"
        private const val ENABLED_LISTENERS = "enabled_notification_listeners"
    }
}
