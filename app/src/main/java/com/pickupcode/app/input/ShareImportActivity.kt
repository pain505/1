package com.pickupcode.app.input

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import com.pickupcode.app.R
import com.pickupcode.app.core.PickupParser
import com.pickupcode.app.store.PickupStore

/**
 * 分享 / 划词导入：无界面 Activity。
 *
 * 支持 `ACTION_SEND`（text/plain）与 `ACTION_PROCESS_TEXT`；
 * 导入完成后 Toast 提示并立即 finish()。
 */
class ShareImportActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        // 必须在 super.onCreate 之前设置，否则窗口已按清单主题创建完毕
        setTheme(android.R.style.Theme_Translucent_NoTitleBar)
        super.onCreate(savedInstanceState)
    }

    override fun onPostResume() {
        super.onPostResume()
        // 放到 onPostResume：无论冷启动还是复用实例都能拿到最新的 Intent
        try {
            handleIntent(intent)
        } catch (t: Throwable) {
            Toast.makeText(this, getString(R.string.toast_import_failed), Toast.LENGTH_SHORT).show()
        } finally {
            finish()
        }
    }

    @Suppress("DEPRECATION")
    private fun handleIntent(intent: Intent?) {
        if (intent == null) return
        val action = intent.action
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_PROCESS_TEXT) return

        // 三种取法都试：CharSequence（多数 App）、String（部分 App 只放 String）、
        // 以及划词菜单的 EXTRA_PROCESS_TEXT。
        var text: String? = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        if (text.isNullOrEmpty()) text = intent.getStringExtra(Intent.EXTRA_TEXT)
        if (text.isNullOrEmpty()) text = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()
        if (text.isNullOrEmpty()) text = intent.getStringExtra(Intent.EXTRA_PROCESS_TEXT)
        if (text.isNullOrBlank()) {
            Toast.makeText(this, getString(R.string.toast_import_empty), Toast.LENGTH_SHORT).show()
            return
        }

        val parsed = PickupParser.parse(text.trim(), SOURCE, System.currentTimeMillis(), null)
        if (parsed.isEmpty()) {
            Toast.makeText(this, getString(R.string.toast_import_none), Toast.LENGTH_SHORT).show()
            return
        }

        PickupStore.init(this)
        val added = PickupStore.upsert(parsed)
        Toast.makeText(this, getString(R.string.toast_import_ok, added), Toast.LENGTH_SHORT).show()
    }

    private companion object {
        private const val SOURCE = "import"
    }
}
