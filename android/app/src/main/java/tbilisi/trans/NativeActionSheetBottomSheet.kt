package tbilisi.trans

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Place
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.bottomsheet.BottomSheetDialogFragment

data class NativeActionSheetItem(
    val id: String,
    val title: String,
    val style: String = "default",
    val accent: String? = null,
    val symbol: String? = null
)

class NativeActionSheetBottomSheet : BottomSheetDialogFragment() {
    var titleText: String? = null
    var messageText: String? = null
    var themeMode: String = "system"
    var actions: List<NativeActionSheetItem> = emptyList()
    var onActionSelected: ((String?) -> Unit)? = null

    private var resolved = false

    override fun onCreateDialog(savedInstanceState: Bundle?): BottomSheetDialog {
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

    override fun onDismiss(dialog: android.content.DialogInterface) {
        super.onDismiss(dialog)
        if (!resolved) {
            resolved = true
            onActionSelected?.invoke(null)
        }
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        return ComposeView(requireContext()).apply {
            setContent {
                val darkTheme = when (themeMode) {
                    "dark" -> true
                    "light" -> false
                    else -> androidx.compose.foundation.isSystemInDarkTheme()
                }
                val colorScheme = if (darkTheme) {
                    darkColorScheme(
                        primary = Color(0xFF60A5FA),
                        background = Color(0xFF0F172A),
                        surface = Color(0xFF1E293B),
                        onSurface = Color(0xFFF8FAFC),
                        onSurfaceVariant = Color(0xFF94A3B8)
                    )
                } else {
                    lightColorScheme(
                        primary = Color(0xFF1D4ED8),
                        background = Color(0xFFF8FAFC),
                        surface = Color(0xFFFFFFFF),
                        onSurface = Color(0xFF0F172A),
                        onSurfaceVariant = Color(0xFF64748B)
                    )
                }

                MaterialTheme(colorScheme = colorScheme) {
                    Surface(color = MaterialTheme.colorScheme.background) {
                        ActionSheetContent()
                    }
                }
            }
        }
    }

    @Composable
    private fun ActionSheetContent() {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Box(
                modifier = Modifier
                    .align(Alignment.CenterHorizontally)
                    .width(42.dp)
                    .height(5.dp)
                    .background(
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.28f),
                        shape = RoundedCornerShape(999.dp)
                    )
            )

            if (!titleText.isNullOrBlank() || !messageText.isNullOrBlank()) {
                Column(
                    modifier = Modifier.padding(horizontal = 4.dp, vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    if (!titleText.isNullOrBlank()) {
                        Text(
                            text = titleText.orEmpty(),
                            fontSize = 20.sp,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                    }
                    if (!messageText.isNullOrBlank()) {
                        Text(
                            text = messageText.orEmpty(),
                            fontSize = 14.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }

            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
            ) {
                Column {
                    actions.forEachIndexed { index, action ->
                        ActionRow(action)
                        if (index < actions.lastIndex) {
                            HorizontalDivider(color = MaterialTheme.colorScheme.background)
                        }
                    }
                }
            }

            OutlinedButton(
                onClick = { dismiss() },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp)
            ) {
                Text(text = "Cancel", fontWeight = FontWeight.Medium)
            }
        }
    }

    @Composable
    private fun ActionRow(action: NativeActionSheetItem) {
        val tint = when {
            action.style.equals("destructive", ignoreCase = true) -> Color(0xFFDC2626)
            action.accent.equals("yellow", ignoreCase = true) -> Color(0xFFEAB308)
            action.accent.equals("black", ignoreCase = true) -> MaterialTheme.colorScheme.onSurface
            else -> MaterialTheme.colorScheme.primary
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable {
                    if (!resolved) {
                        resolved = true
                        onActionSelected?.invoke(action.id)
                    }
                    dismiss()
                }
                .padding(horizontal = 18.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            resolveIcon(action.symbol)?.let { icon ->
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = tint,
                    modifier = Modifier.size(20.dp)
                )
                Spacer(modifier = Modifier.width(14.dp))
            }

            Text(
                text = action.title,
                color = if (action.style.equals("destructive", ignoreCase = true)) tint else MaterialTheme.colorScheme.onSurface,
                fontSize = 16.sp,
                fontWeight = FontWeight.Medium
            )
        }
    }

    private fun resolveIcon(symbol: String?): ImageVector? {
        return when (symbol) {
            "square.and.arrow.up" -> Icons.Default.Share
            "star", "star.fill" -> Icons.Default.Star
            "trash", "trash.fill" -> Icons.Default.Delete
            "pencil", "pencil.circle.fill" -> Icons.Default.Edit
            "info.circle", "ellipsis.circle.fill" -> Icons.Default.Info
            "location.fill", "location.north.line.fill", "mappin.and.ellipse" -> Icons.Default.Place
            "arrow.up.left", "chevron.backward.circle.fill" -> Icons.AutoMirrored.Filled.ArrowForward
            "line.3.horizontal.decrease.circle", "line.3.horizontal.decrease.circle.fill" -> Icons.Default.Settings
            else -> null
        }
    }
}
