package tbilisi.trans

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.view.animation.AccelerateInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {

    private lateinit var overlayContainer: FrameLayout
    private lateinit var opaqueView: ImageView
    private lateinit var cutoutView: ImageView
    private var splashDismissed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        // Register custom Capacitor plugins BEFORE super.onCreate()
        // The bridge initializes during super.onCreate() and must know about plugins beforehand
        registerPlugin(NativeSettingsPlugin::class.java)
        registerPlugin(NativeGeolocationPlugin::class.java)

        super.onCreate(savedInstanceState)

        // Initialize Splash Zoom-Reveal Overlay
        setupSplashOverlay()

        // Safety timeout: auto-hide splash after 8 seconds if JS never calls hideSplash
        Handler(Looper.getMainLooper()).postDelayed({
            if (!splashDismissed) {
                android.util.Log.w("MainActivity", "Splash safety timeout triggered — auto-hiding splash")
                hideSplash()
            }
        }, 8000)
    }

    private fun setupSplashOverlay() {
        val context = this
        overlayContainer = FrameLayout(context).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(android.graphics.Color.TRANSPARENT)
        }

        // Add back-layer: Opaque Splash background
        opaqueView = ImageView(context).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            scaleType = ImageView.ScaleType.CENTER_CROP
            val opaqueResId = resources.getIdentifier("splash_opaque", "drawable", packageName)
            if (opaqueResId != 0) {
                setImageResource(opaqueResId)
            } else {
                setBackgroundColor(android.graphics.Color.parseColor("#0F172A"))
            }
        }

        // Add top-layer: Transparent Cutout Splash logo overlay
        cutoutView = ImageView(context).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            scaleType = ImageView.ScaleType.CENTER_CROP
            val cutoutResId = resources.getIdentifier("splash_cutout", "drawable", packageName)
            if (cutoutResId != 0) {
                setImageResource(cutoutResId)
            }
        }

        overlayContainer.addView(opaqueView)
        overlayContainer.addView(cutoutView)

        // Add overlay layout directly on top of the root window content view
        val rootLayout = window.decorView.findViewById<ViewGroup>(android.R.id.content)
        rootLayout.addView(overlayContainer)
    }

    fun hideSplash() {
        if (splashDismissed) return
        splashDismissed = true

        runOnUiThread {
            // Replicating iOS fluid animation curves exactly:
            // 1. Opaque fade-out: 250ms
            // 2. Cutout scale up to 6.0x + fade-out: 500ms
            
            opaqueView.animate()
                .alpha(0f)
                .setDuration(250)
                .start()

            cutoutView.animate()
                .scaleX(6.0f)
                .scaleY(6.0f)
                .alpha(0f)
                .setDuration(500)
                .setInterpolator(AccelerateInterpolator())
                .setListener(object : AnimatorListenerAdapter() {
                    override fun onAnimationEnd(animation: Animator) {
                        // Remove completely from parent layout
                        val rootLayout = window.decorView.findViewById<ViewGroup>(android.R.id.content)
                        rootLayout.removeView(overlayContainer)
                    }
                })
                .start()
        }
    }
}
