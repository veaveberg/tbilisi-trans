package tbilisi.trans

import android.content.Intent
import android.net.Uri
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

@CapacitorPlugin(name = "NativeSettings")
class NativeSettingsPlugin : Plugin() {

    private var settingsBottomSheet: SettingsBottomSheet? = null

    @PluginMethod
    fun open(call: PluginCall) {
        openSettings(call, false)
    }

    @PluginMethod
    fun openFavoritesMenu(call: PluginCall) {
        openSettings(call, true)
    }

    private fun openSettings(call: PluginCall, startWithFavorites: Boolean) {
        val initialSettings = call.getObject("settings") ?: JSObject()

        val activity = bridge.activity
        if (activity == null) {
            call.reject("Activity is not available.")
            return
        }

        activity.runOnUiThread {
            val sheet = SettingsBottomSheet().apply {
                this.startWithFavorites = startWithFavorites
            }
            settingsBottomSheet = sheet

            sheet.onToggle = { key, value ->
                // Apply page zoom immediately when scale changes
                if (key == "pageScale") {
                    val scale = (value as? Double) ?: 1.0
                    applyPageZoom(scale)
                }
                emitSettingsChanged(key, value)
            }

            sheet.onDone = { settings ->
                emitSettingsClosed(settings)
            }

            sheet.onOpenSupport = {
                presentSupportPage()
            }

            sheet.onOpenPrivacyPolicy = {
                presentPrivacyPolicySheet()
            }

            sheet.onAction = { action ->
                emitSettingsChanged("favoritesAction", action)
            }

            sheet.applySettings(initialSettings)
            sheet.show(activity.supportFragmentManager, "SettingsBottomSheet")
            call.resolve()
        }
    }

    @PluginMethod
    fun setPageZoom(call: PluginCall) {
        val scale = call.getDouble("zoom") ?: call.getDouble("scale") ?: 1.0
        activity.runOnUiThread {
            applyPageZoom(scale)
            call.resolve()
        }
    }

    @PluginMethod
    fun hideSplash(call: PluginCall) {
        activity.runOnUiThread {
            val mainActivity = activity as? MainActivity
            if (mainActivity != null) {
                mainActivity.hideSplash()
                call.resolve()
            } else {
                call.reject("MainActivity not found.")
            }
        }
    }

    @PluginMethod
    fun warmUI(call: PluginCall) {
        call.resolve()
    }

    @PluginMethod
    fun showActionSheet(call: PluginCall) {
        val title = call.getString("title")
        val message = call.getString("message")
        val theme = call.getString("theme") ?: "system"
        val actionsRaw = call.getArray("actions") ?: JSArray()

        if (actionsRaw.length() == 0) {
            call.reject("actions_required")
            return
        }

        val activity = bridge.activity
        if (activity == null) {
            call.reject("activity_unavailable")
            return
        }

        activity.runOnUiThread {
            val actionItems = buildList {
                for (i in 0 until actionsRaw.length()) {
                    val actionObj = actionsRaw.optJSONObject(i) ?: continue
                    val actionId = actionObj.optString("id").trim()
                    val actionTitle = actionObj.optString("title").trim()
                    if (actionId.isEmpty() || actionTitle.isEmpty()) continue
                    add(
                        NativeActionSheetItem(
                            id = actionId,
                            title = actionTitle,
                            style = actionObj.optString("style", "default"),
                            accent = actionObj.optString("accent").takeIf { it.isNotBlank() },
                            symbol = actionObj.optString("symbol").takeIf { it.isNotBlank() }
                        )
                    )
                }
            }
            if (actionItems.isEmpty()) {
                call.reject("actions_required")
                return@runOnUiThread
            }

            val sheet = NativeActionSheetBottomSheet().apply {
                titleText = title
                messageText = message
                themeMode = theme
                actions = actionItems
                onActionSelected = { actionId ->
                    val res = JSObject()
                    res.put("action", actionId ?: JSONObject.NULL)
                    call.resolve(res)
                }
            }

            sheet.show(activity.supportFragmentManager, "NativeActionSheetBottomSheet")
        }
    }

    @PluginMethod
    fun shareUrl(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrEmpty()) {
            call.reject("url_required")
            return
        }

        val activity = bridge.activity
        if (activity == null) {
            call.reject("activity_unavailable")
            return
        }

        activity.runOnUiThread {
            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, url)
            }
            activity.startActivity(Intent.createChooser(shareIntent, "Share Link"))
            call.resolve()
        }
    }

    // Cloud Sync Fallbacks
    @PluginMethod
    fun getICloudSyncState(call: PluginCall) {
        val res = JSObject()
        res.put("available", false)
        call.resolve(res)
    }

    @PluginMethod
    fun setICloudSyncEnabled(call: PluginCall) {
        val res = JSObject()
        res.put("available", false)
        call.resolve(res)
    }

    @PluginMethod
    fun syncHistory(call: PluginCall) {
        val res = JSObject()
        res.put("available", false)
        call.resolve(res)
    }

    @PluginMethod
    fun getSyncedHistory(call: PluginCall) {
        val res = JSObject()
        res.put("available", false)
        res.put("searchHistoryJson", "[]")
        res.put("cardHistoryJson", "[]")
        call.resolve(res)
    }

    @PluginMethod
    fun syncFavorites(call: PluginCall) {
        val res = JSObject()
        res.put("available", false)
        call.resolve(res)
    }

    @PluginMethod
    fun getSyncedFavorites(call: PluginCall) {
        val res = JSObject()
        res.put("available", false)
        res.put("favoritesJson", "[]")
        call.resolve(res)
    }

    // --- Private Utilities ---

    private fun applyPageZoom(scale: Double) {
        val webView = bridge?.webView ?: return
        val inverseScale = 1.0 / scale
        val pct = inverseScale * 100.0

        val js = """
        (function() {
            const html = document.documentElement;
            const body = document.body;
            const scale = $scale;
            const pct = $pct;
            
            html.style.width = pct + '%';
            html.style.height = pct + '%';
            html.style.transform = 'scale(' + scale + ')';
            html.style.transformOrigin = 'top left';
            
            body.style.width = '100%';
            body.style.height = '100%';
            
            window.dispatchEvent(new Event('resize'));
        })();
        """.trimIndent()

        webView.evaluateJavascript(js, null)
    }

    private fun emitSettingsChanged(key: String, value: Any) {
        val data = JSObject()
        data.put("key", key)
        data.put("value", value)
        notifyListeners("settingsChanged", data)
    }

    private fun emitSettingsClosed(settings: Map<String, Any>) {
        val data = JSObject()
        val settingsObj = JSObject()
        for ((k, v) in settings) {
            settingsObj.put(k, v)
        }
        data.put("settings", settingsObj)
        notifyListeners("settingsClosed", data)
    }

    private fun presentPrivacyPolicySheet() {
        val activity = bridge.activity ?: return
        activity.runOnUiThread {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://veaveberg.github.io/tbilisi-trans/privacy-policy/"))
            activity.startActivity(intent)
        }
    }

    private fun presentSupportPage() {
        val activity = bridge.activity ?: return
        activity.runOnUiThread {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://veaveberg.github.io/tbilisi-trans/support/"))
            activity.startActivity(intent)
        }
    }
}
