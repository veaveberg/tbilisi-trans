package tbilisi.trans

import android.app.Dialog
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.pm.PackageInfoCompat
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.bottomsheet.BottomSheetDialogFragment
import org.json.JSONArray
import org.json.JSONObject

data class FavoriteItem(
    val key: String,
    val type: String,
    val title: String,
    var subtitle: String,
    val routeNumber: String,
    val routeColor: String,
    var stopIcon: String
)

class SettingsBottomSheet : BottomSheetDialogFragment() {

    // Callbacks
    var onToggle: ((String, Any) -> Unit)? = null
    var onDone: ((Map<String, Any>) -> Unit)? = null
    var onAction: ((Any) -> Unit)? = null
    var onOpenSupport: (() -> Unit)? = null
    var onOpenPrivacyPolicy: (() -> Unit)? = null
    var startWithFavorites: Boolean = false

    // Mutable state for sheet
    private var isSyncEnabled = mutableStateOf(false)
    private var uiLanguage = mutableStateOf("en")
    private var stopNamesLanguage = mutableStateOf("en")
    private var mapLanguage = mutableStateOf("en")
    private var simplifyRouteNumbers = mutableStateOf(false)
    private var showMinibuses = mutableStateOf(true)
    private var showRustaviBuses = mutableStateOf(true)
    private var show3DBuildings = mutableStateOf(false)
    private var show3DTerrain = mutableStateOf(false)
    private var exaggerateTerrain = mutableStateOf(false)
    private var showPoiLabels = mutableStateOf(true)
    private var themeValue = mutableStateOf("system")
    private var pageScale = mutableFloatStateOf(1.0f)
    private var favoritesList = mutableStateListOf<FavoriteItem>()

    fun applySettings(settings: JSONObject) {
        isSyncEnabled.value = settings.optBoolean("icloudSyncEnabled", false)
        uiLanguage.value = settings.optString("uiLanguage", settings.optString("language", "en"))
        if (uiLanguage.value != "ka" && uiLanguage.value != "ru") uiLanguage.value = "en"

        stopNamesLanguage.value = settings.optString("stopNamesLanguage", "en")
        mapLanguage.value = settings.optString("mapLanguage", "en")
        simplifyRouteNumbers.value = settings.optBoolean("simplifyNumbers", false)
        showMinibuses.value = settings.optBoolean("showMinibuses", true)
        showRustaviBuses.value = settings.optBoolean("showRustaviBuses", true)
        show3DBuildings.value = settings.optBoolean("show3DBuildings", false)
        show3DTerrain.value = settings.optBoolean("show3DTerrain", false)
        exaggerateTerrain.value = settings.optBoolean("exaggerateTerrain", false)
        showPoiLabels.value = settings.optBoolean("showPoiLabels", true)
        themeValue.value = settings.optString("theme", "system")
        pageScale.floatValue = settings.optDouble("pageScale", 1.0).toFloat()

        favoritesList.clear()
        val favoritesJson = settings.optJSONArray("favoritesList")
        if (favoritesJson != null) {
            for (i in 0 until favoritesJson.length()) {
                val itemObj = favoritesJson.optJSONObject(i) ?: continue
                val key = itemObj.optString("key").trim()
                val type = itemObj.optString("type").trim()
                val title = itemObj.optString("title").trim()
                val subtitle = itemObj.optString("subtitle").trim()
                val routeNumber = itemObj.optString("routeNumber").trim()
                val routeColor = itemObj.optString("routeColor").trim()
                val stopIcon = itemObj.optString("stopIcon").trim()
                if (key.isNotEmpty() && (type == "stop" || type == "route")) {
                    favoritesList.add(
                        FavoriteItem(
                            key = key,
                            type = type,
                            title = if (title.isEmpty()) key else title,
                            subtitle = subtitle,
                            routeNumber = routeNumber,
                            routeColor = routeColor,
                            stopIcon = stopIcon
                        )
                    )
                }
            }
        }
    }

    private fun getAllSettings(): Map<String, Any> {
        return mapOf(
            "icloudSyncEnabled" to isSyncEnabled.value,
            "uiLanguage" to uiLanguage.value,
            "stopNamesLanguage" to stopNamesLanguage.value,
            "mapLanguage" to mapLanguage.value,
            "simplifyNumbers" to simplifyRouteNumbers.value,
            "showMinibuses" to showMinibuses.value,
            "showRustaviBuses" to showRustaviBuses.value,
            "show3DBuildings" to show3DBuildings.value,
            "show3DTerrain" to show3DTerrain.value,
            "exaggerateTerrain" to exaggerateTerrain.value,
            "showPoiLabels" to showPoiLabels.value,
            "theme" to themeValue.value,
            "pageScale" to pageScale.floatValue.toDouble()
        )
    }

    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        val dialog = super.onCreateDialog(savedInstanceState) as BottomSheetDialog
        dialog.setOnShowListener {
            val bottomSheet = dialog.findViewById<FrameLayout>(com.google.android.material.R.id.design_bottom_sheet)
            if (bottomSheet != null) {
                val behavior = BottomSheetBehavior.from(bottomSheet)
                behavior.state = BottomSheetBehavior.STATE_EXPANDED
                behavior.skipCollapsed = true
            }
        }
        return dialog
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        return ComposeView(requireContext()).apply {
            setContent {
                val darkTheme = when (themeValue.value) {
                    "dark" -> true
                    "light" -> false
                    else -> isSystemInDarkTheme()
                }
                val colorScheme = if (darkTheme) darkColorScheme(
                    primary = Color(0xFF60A5FA),
                    background = Color(0xFF0F172A),
                    surface = Color(0xFF1E293B),
                    onSurface = Color(0xFFF1F5F9),
                    onSurfaceVariant = Color(0xFF94A3B8)
                ) else lightColorScheme(
                    primary = Color(0xFF1D4ED8),
                    background = Color(0xFFF8FAFC),
                    surface = Color(0xFFFFFFFF),
                    onSurface = Color(0xFF0F172A),
                    onSurfaceVariant = Color(0xFF64748B)
                )

                MaterialTheme(colorScheme = colorScheme) {
                    val context = requireContext()
                    val packageInfo = remember {
                        context.packageManager.getPackageInfo(context.packageName, 0)
                    }
                    val versionName = remember(packageInfo) {
                        packageInfo.versionName?.trim().orEmpty().ifEmpty { "?" }
                    }
                    val versionCode = remember(packageInfo) {
                        PackageInfoCompat.getLongVersionCode(packageInfo).toString()
                    }
                    var currentScreen by remember { mutableStateOf(if (startWithFavorites) "favorites" else "settings") }

                    Surface(
                        modifier = Modifier.fillMaxWidth().fillMaxHeight(0.9f),
                        color = MaterialTheme.colorScheme.background
                    ) {
                        AnimatedContent(
                            targetState = currentScreen,
                            transitionSpec = {
                                if (targetState == "favorites") {
                                    slideInHorizontally { width -> width } togetherWith slideOutHorizontally { width -> -width }
                                } else {
                                    slideInHorizontally { width -> -width } togetherWith slideOutHorizontally { width -> width }
                                }
                            },
                            label = "screen_transition"
                        ) { screen ->
                            when (screen) {
                                "settings" -> SettingsScreen(
                                    versionName = versionName,
                                    versionCode = versionCode,
                                    onOpenFavorites = { currentScreen = "favorites" },
                                    onClose = {
                                        onDone?.invoke(getAllSettings())
                                        dismiss()
                                    }
                                )
                                "favorites" -> FavoritesScreen(
                                    onBack = { currentScreen = "settings" }
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    // --- Helper classes for Translation ---
    private fun getLocalizedText(en: String, ka: String, ru: String): String {
        return when (uiLanguage.value) {
            "ka" -> ka
            "ru" -> ru
            else -> en
        }
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    fun SettingsScreen(
        versionName: String,
        versionCode: String,
        onOpenFavorites: () -> Unit,
        onClose: () -> Unit
    ) {
        val scrollState = rememberScrollState()

        Scaffold(
            topBar = {
                CenterAlignedTopAppBar(
                    title = {
                        Text(
                            text = getLocalizedText("Settings", "პარამეტრები", "Настройки"),
                            fontWeight = FontWeight.Bold,
                            fontSize = 20.sp
                        )
                    },
                    actions = {
                        IconButton(onClick = onClose) {
                            Icon(imageVector = Icons.Default.Done, contentDescription = "Done")
                        }
                    },
                    colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                        containerColor = MaterialTheme.colorScheme.background
                    )
                )
            }
        ) { padding ->
            Column(
                modifier = Modifier
                    .padding(padding)
                    .fillMaxSize()
                    .verticalScroll(scrollState)
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                // Section 1: Favorites
                SettingsCard {
                    SettingsRow(
                        title = getLocalizedText("Favorites", "რჩეულები", "Избранное"),
                        icon = Icons.Default.Star,
                        onClick = onOpenFavorites
                    )
                }

                // Section 2: Languages
                Text(
                    text = getLocalizedText("Language", "ენა", "Язык"),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 4.dp)
                )
                SettingsCard {
                    Column {
                        LanguageToggleRow(
                            title = getLocalizedText("Interface", "ინტერფეისი", "Интерфейс"),
                            options = listOf("ka" to "ქა", "en" to "en", "ru" to "ру"),
                            selectedValue = uiLanguage.value,
                            onSelected = {
                                uiLanguage.value = it
                                onToggle?.invoke("uiLanguage", it)
                            }
                        )
                        HorizontalDivider(color = MaterialTheme.colorScheme.background)
                        LanguageToggleRow(
                            title = getLocalizedText("Stop names", "გაჩერებების სახელები", "Названия остановок"),
                            options = listOf("ka" to "ქა", "en" to "en"),
                            selectedValue = stopNamesLanguage.value,
                            onSelected = {
                                stopNamesLanguage.value = it
                                onToggle?.invoke("stopNamesLanguage", it)
                            }
                        )
                        HorizontalDivider(color = MaterialTheme.colorScheme.background)
                        LanguageToggleRow(
                            title = getLocalizedText("Map", "რუკა", "Карта"),
                            options = listOf("ka" to "ქა", "en" to "en", "ru" to "ру"),
                            selectedValue = mapLanguage.value,
                            onSelected = {
                                mapLanguage.value = it
                                onToggle?.invoke("mapLanguage", it)
                            }
                        )
                    }
                }

                // Section 3: Routes
                Text(
                    text = getLocalizedText("Routes", "მარშრუტები", "Маршруты"),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 4.dp)
                )
                SettingsCard {
                    Column {
                        ToggleRow(
                            title = getLocalizedText("Simplify Route Numbers", "მარშრუტების ნომრების გამარტივება", "Упростить номера маршрутов"),
                            icon = Icons.Default.Info,
                            checked = simplifyRouteNumbers.value,
                            onCheckedChange = {
                                simplifyRouteNumbers.value = it
                                onToggle?.invoke("simplifyNumbers", it)
                            }
                        )
                        HorizontalDivider(color = MaterialTheme.colorScheme.background)
                        ToggleRow(
                            title = getLocalizedText("Show Minibuses", "მარშრუტკების ჩვენება", "Показывать маршрутки"),
                            checked = showMinibuses.value,
                            onCheckedChange = {
                                showMinibuses.value = it
                                onToggle?.invoke("showMinibuses", it)
                            }
                        )
                        HorizontalDivider(color = MaterialTheme.colorScheme.background)
                        ToggleRow(
                            title = getLocalizedText("Show Rustavi Buses", "რუსთავის ავტობუსების ჩვენება", "Показывать автобусы Рустави"),
                            checked = showRustaviBuses.value,
                            onCheckedChange = {
                                showRustaviBuses.value = it
                                onToggle?.invoke("showRustaviBuses", it)
                            }
                        )
                    }
                }

                // Section 4: Map
                Text(
                    text = getLocalizedText("Map", "რუკა", "Карта"),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 4.dp)
                )
                SettingsCard {
                    Column {
                        ToggleRow(
                            title = getLocalizedText("3D Buildings", "3D შენობები", "3D здания"),
                            icon = Icons.Default.Home,
                            checked = show3DBuildings.value,
                            onCheckedChange = {
                                show3DBuildings.value = it
                                onToggle?.invoke("show3DBuildings", it)
                            }
                        )
                        HorizontalDivider(color = MaterialTheme.colorScheme.background)
                        ToggleRow(
                            title = getLocalizedText("3D Terrain", "3D რელიეფი", "3D рельеф"),
                            icon = Icons.Default.Place,
                            checked = show3DTerrain.value,
                            onCheckedChange = {
                                show3DTerrain.value = it
                                onToggle?.invoke("show3DTerrain", it)
                            }
                        )
                        HorizontalDivider(color = MaterialTheme.colorScheme.background)
                        ToggleRow(
                            title = getLocalizedText("Exaggerate Terrain", "რელიეფის გამოკვეთა", "Усилить рельеф"),
                            icon = Icons.Default.Menu,
                            checked = exaggerateTerrain.value,
                            onCheckedChange = {
                                exaggerateTerrain.value = it
                                onToggle?.invoke("exaggerateTerrain", it)
                            }
                        )
                        HorizontalDivider(color = MaterialTheme.colorScheme.background)
                        ToggleRow(
                            title = getLocalizedText("Points of Interest", "საინტერესო ადგილები", "Точки интереса"),
                            icon = Icons.Default.LocationOn,
                            checked = showPoiLabels.value,
                            onCheckedChange = {
                                showPoiLabels.value = it
                                onToggle?.invoke("showPoiLabels", it)
                            }
                        )
                    }
                }

                // Section 5: Appearance
                Text(
                    text = getLocalizedText("Appearance", "იერსახე", "Оформление"),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 4.dp)
                )
                SettingsCard {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Text(
                            text = getLocalizedText("Theme", "თემა", "Тема"),
                            fontWeight = FontWeight.Bold,
                            fontSize = 15.sp,
                            modifier = Modifier.padding(bottom = 8.dp)
                        )
                        Row(
                            modifier = Modifier.fillMaxWidth().height(36.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.background),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            listOf("system" to getLocalizedText("Auto", "ავტო", "Авто"),
                                "light" to getLocalizedText("Light", "ნათელი", "Светлая"),
                                "dark" to getLocalizedText("Dark", "მუქი", "Тёмная")
                            ).forEach { (mode, label) ->
                                val selected = themeValue.value == mode
                                Box(
                                    modifier = Modifier
                                        .weight(1f)
                                        .fillMaxHeight()
                                        .clip(RoundedCornerShape(6.dp))
                                        .background(if (selected) MaterialTheme.colorScheme.primary else Color.Transparent)
                                        .clickable {
                                            themeValue.value = mode
                                            onToggle?.invoke("theme", mode)
                                        },
                                    contentAlignment = Alignment.Center
                                ) {
                                    Text(
                                        text = label,
                                        color = if (selected) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                                        fontSize = 13.sp,
                                        fontWeight = FontWeight.Medium
                                    )
                                }
                            }
                        }

                        Spacer(modifier = Modifier.height(16.dp))

                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(
                                text = getLocalizedText("Interface Scale", "ინტერფეისის მასშტაბი", "Масштаб интерфейса"),
                                fontWeight = FontWeight.Bold,
                                fontSize = 15.sp
                            )
                            Spacer(modifier = Modifier.weight(1f))
                            Text(
                                text = String.format("%.2f", pageScale.floatValue),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                fontSize = 14.sp
                            )
                        }
                        Slider(
                            value = pageScale.floatValue,
                            onValueChange = { scale ->
                                val stepped = Math.round(scale / 0.05f) * 0.05f
                                pageScale.floatValue = stepped
                                onToggle?.invoke("pageScale", stepped.toDouble())
                            },
                            valueRange = 0.8f..1.5f,
                            steps = 13
                        )
                    }
                }

                // Section 6: Support & Credits
                SettingsCard {
                    Column {
                        SettingsRow(
                            title = getLocalizedText("Support", "მხარდაჭერა", "Поддержка"),
                            onClick = { onOpenSupport?.invoke() }
                        )
                        HorizontalDivider(color = MaterialTheme.colorScheme.background)
                        SettingsRow(
                            title = getLocalizedText("Privacy Policy", "კონფიდენციალურობის პოლიტიკა", "Политика конфиденциальности"),
                            onClick = { onOpenPrivacyPolicy?.invoke() }
                        )
                    }
                }

                // Version Info & Credits
                Column(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Text(
                        text = "Made by Sasha Berg for Tbilisi commuters ♥",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontSize = 12.sp,
                        textAlign = TextAlign.Center
                    )
                    Text(
                        text = "Version $versionName ($versionCode)",
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                        fontSize = 12.sp,
                        textAlign = TextAlign.Center
                    )
                }
            }
        }
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    fun FavoritesScreen(onBack: () -> Unit) {
        val stopItems = favoritesList.filter { it.type == "stop" }
        val routeItems = favoritesList.filter { it.type == "route" }

        var showClearAllDialog by remember { mutableStateOf(false) }
        var editingItem by remember { mutableStateOf<FavoriteItem?>(null) }

        if (showClearAllDialog) {
            AlertDialog(
                onDismissRequest = { showClearAllDialog = false },
                title = { Text(text = getLocalizedText("Clear All Favorites?", "ყველა რჩეულის წაშლა?", "Очистить избранное?")) },
                text = { Text(text = getLocalizedText("This will remove all saved stops and routes.", "ეს წაშლის ყველა შენახულ გაჩერებას და მარშრუტს.", "Это удалит все сохранённые остановки и маршруты.")) },
                confirmButton = {
                    TextButton(
                        onClick = {
                            onAction?.invoke("clearAll")
                            favoritesList.clear()
                            showClearAllDialog = false
                        }
                    ) {
                        Text(text = getLocalizedText("Clear", "წაშლა", "Очистить"), color = Color.Red)
                    }
                },
                dismissButton = {
                    TextButton(onClick = { showClearAllDialog = false }) {
                        Text(text = getLocalizedText("Cancel", "გაუქმება", "Отмена"))
                    }
                }
            )
        }

        editingItem?.let { item ->
            var newSubtitle by remember { mutableStateOf(item.subtitle) }
            var newIcon by remember { mutableStateOf(if (item.type == "stop") item.stopIcon else "") }

            AlertDialog(
                onDismissRequest = { editingItem = null },
                title = {
                    Text(
                        text = if (item.type == "stop") getLocalizedText("Edit Stop Favorite", "გაჩერების რედაქტირება", "Редактировать остановку")
                        else getLocalizedText("Edit Secondary Text", "მეორადი ტექსტის რედაქტირება", "Редактировать текст")
                    )
                },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextField(
                            value = newSubtitle,
                            onValueChange = { newSubtitle = it },
                            label = { Text("Secondary Text") }
                        )
                        if (item.type == "stop") {
                            TextField(
                                value = newIcon,
                                onValueChange = { newIcon = it },
                                label = { Text("Custom Symbol/Emoji") }
                            )
                        }
                    }
                },
                confirmButton = {
                    TextButton(
                        onClick = {
                            if (newSubtitle != item.subtitle) {
                                item.subtitle = newSubtitle
                                onAction?.invoke(mapOf(
                                    "action" to "editSubtitle",
                                    "key" to item.key,
                                    "subtitle" to newSubtitle
                                ))
                            }
                            if (item.type == "stop" && newIcon != item.stopIcon) {
                                val trimmed = newIcon.trim()
                                val singleChar = if (trimmed.isNotEmpty()) trimmed.substring(0, 1) else ""
                                item.stopIcon = singleChar
                                onAction?.invoke(mapOf(
                                    "action" to "editIcon",
                                    "key" to item.key,
                                    "icon" to singleChar
                                ))
                            }
                            editingItem = null
                        }
                    ) {
                        Text(text = getLocalizedText("Save", "შენახვა", "Сохранить"))
                    }
                },
                dismissButton = {
                    TextButton(onClick = { editingItem = null }) {
                        Text(text = getLocalizedText("Cancel", "გაუქმება", "Отмена"))
                    }
                }
            )
        }

        Scaffold(
            topBar = {
                MediumTopAppBar(
                    title = {
                        Text(
                            text = getLocalizedText("Favorites", "რჩეულები", "Избранное"),
                            fontWeight = FontWeight.Bold
                        )
                    },
                    navigationIcon = {
                        IconButton(onClick = onBack) {
                            Icon(imageVector = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
                    },
                    colors = TopAppBarDefaults.mediumTopAppBarColors(
                        containerColor = MaterialTheme.colorScheme.background
                    )
                )
            }
        ) { padding ->
            Column(
                modifier = Modifier
                    .padding(padding)
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                // Section: Stops
                Text(
                    text = getLocalizedText("Stops", "გაჩერებები", "Остановки"),
                    fontWeight = FontWeight.Bold,
                    fontSize = 16.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                SettingsCard {
                    Column {
                        if (stopItems.isEmpty()) {
                            Box(
                                modifier = Modifier.fillMaxWidth().padding(24.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = getLocalizedText("No favorite stops", "რჩეული გაჩერებები არ არის", "Нет избранных остановок"),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
                                )
                            }
                        } else {
                            stopItems.forEachIndexed { index, item ->
                                FavoriteStopRow(
                                    item = item,
                                    onEdit = { editingItem = item },
                                    onDelete = {
                                        onAction?.invoke("remove:${item.key}")
                                        favoritesList.remove(item)
                                    },
                                    onClick = {
                                        onAction?.invoke("open:${item.key}")
                                        dismiss()
                                    }
                                )
                                if (index < stopItems.size - 1) {
                                    HorizontalDivider(color = MaterialTheme.colorScheme.background)
                                }
                            }
                        }
                    }
                }

                // Section: Routes
                Text(
                    text = getLocalizedText("Routes", "მარშრუტები", "Маршруты"),
                    fontWeight = FontWeight.Bold,
                    fontSize = 16.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                SettingsCard {
                    Column {
                        if (routeItems.isEmpty()) {
                            Box(
                                modifier = Modifier.fillMaxWidth().padding(24.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = getLocalizedText("No favorite routes", "რჩეული მარშრუტები არ არის", "Нет избранных маршрутов"),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
                                )
                            }
                        } else {
                            routeItems.forEachIndexed { index, item ->
                                FavoriteRouteRow(
                                    item = item,
                                    onEdit = { editingItem = item },
                                    onDelete = {
                                        onAction?.invoke("remove:${item.key}")
                                        favoritesList.remove(item)
                                    },
                                    onClick = {
                                        onAction?.invoke("open:${item.key}")
                                        dismiss()
                                    }
                                )
                                if (index < routeItems.size - 1) {
                                    HorizontalDivider(color = MaterialTheme.colorScheme.background)
                                }
                            }
                        }
                    }
                }

                // Clear All Button
                if (favoritesList.isNotEmpty()) {
                    Button(
                        onClick = { showClearAllDialog = true },
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFEF4444)),
                        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Icon(imageVector = Icons.Default.Delete, contentDescription = null, tint = Color.White)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = getLocalizedText("Clear All Favorites", "ყველა რჩეულის წაშლა", "Очистить всё избранное"),
                            color = Color.White,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }
            }
        }
    }

    // --- Compose UI Helpers ---

    @Composable
    fun SettingsCard(content: @Composable () -> Unit) {
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(12.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            content = { content() }
        )
    }

    @Composable
    fun SettingsRow(title: String, icon: ImageVector? = null, onClick: () -> Unit) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { onClick() }
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            if (icon != null) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(22.dp)
                )
                Spacer(modifier = Modifier.width(12.dp))
            }
            Text(text = title, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            Spacer(modifier = Modifier.weight(1f))
            Icon(
                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }

    @Composable
    fun ToggleRow(title: String, icon: ImageVector? = null, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            if (icon != null) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(20.dp)
                )
                Spacer(modifier = Modifier.width(12.dp))
            }
            Text(
                text = title,
                fontSize = 15.sp,
                modifier = Modifier.weight(1f),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            Switch(
                checked = checked,
                onCheckedChange = onCheckedChange
            )
        }
    }

    @Composable
    fun LanguageToggleRow(
        title: String,
        options: List<Pair<String, String>>,
        selectedValue: String,
        onSelected: (String) -> Unit
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = title,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.weight(1.2f)
            )
            Spacer(modifier = Modifier.width(8.dp))
            Row(
                modifier = Modifier
                    .weight(1.8f)
                    .height(30.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(MaterialTheme.colorScheme.background),
                verticalAlignment = Alignment.CenterVertically
            ) {
                options.forEach { (value, label) ->
                    val selected = selectedValue == value
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxHeight()
                            .clip(RoundedCornerShape(6.dp))
                            .background(if (selected) MaterialTheme.colorScheme.primary else Color.Transparent)
                            .clickable { onSelected(value) },
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = label,
                            color = if (selected) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }
            }
        }
    }

    @Composable
    fun FavoriteStopRow(item: FavoriteItem, onEdit: () -> Unit, onDelete: () -> Unit, onClick: () -> Unit) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { onClick() }
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Stop Icon / Custom Emoji badge
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)),
                contentAlignment = Alignment.Center
            ) {
                if (item.stopIcon.isNotEmpty()) {
                    Text(text = item.stopIcon, fontSize = 16.sp)
                } else {
                    Icon(imageVector = Icons.Default.Place, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                }
            }
            Spacer(modifier = Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(text = item.title, fontSize = 15.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    text = if (item.subtitle.isEmpty()) item.key else item.subtitle,
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
            Spacer(modifier = Modifier.width(8.dp))
            IconButton(onClick = onEdit) {
                Icon(imageVector = Icons.Default.Edit, contentDescription = "Edit Subtitle", tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
            }
            IconButton(onClick = onDelete) {
                Icon(imageVector = Icons.Default.Delete, contentDescription = "Delete", tint = Color.Red, modifier = Modifier.size(18.dp))
            }
        }
    }

    @Composable
    fun FavoriteRouteRow(item: FavoriteItem, onEdit: () -> Unit, onDelete: () -> Unit, onClick: () -> Unit) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { onClick() }
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Colored Badge for Route
            val parsedColor = remember(item.routeColor) {
                try {
                    Color(android.graphics.Color.parseColor(item.routeColor))
                } catch (e: Exception) {
                    Color(0xFF3B82F6)
                }
            }
            Box(
                modifier = Modifier
                    .width(60.dp)
                    .height(30.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(parsedColor.copy(alpha = 0.15f)),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = if (item.routeNumber.isEmpty()) item.title.replace("Route ", "") else item.routeNumber,
                    color = parsedColor,
                    fontWeight = FontWeight.Bold,
                    fontSize = 14.sp
                )
            }
            Spacer(modifier = Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(text = item.title, fontSize = 15.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (item.subtitle.isNotEmpty()) {
                    Text(
                        text = item.subtitle,
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
            Spacer(modifier = Modifier.width(8.dp))
            IconButton(onClick = onEdit) {
                Icon(imageVector = Icons.Default.Edit, contentDescription = "Edit Subtitle", tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
            }
            IconButton(onClick = onDelete) {
                Icon(imageVector = Icons.Default.Delete, contentDescription = "Delete", tint = Color.Red, modifier = Modifier.size(18.dp))
            }
        }
    }
}
