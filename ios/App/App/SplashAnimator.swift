import UIKit

/// Native splash overlay that continues seamlessly from LaunchScreen.storyboard
/// and performs the zoom-reveal animation when the webview signals readiness.
class SplashAnimator {
    
    static let shared = SplashAnimator()
    
    private var overlayView: UIView?
    private var opaqueImageView: UIImageView?
    private var cutoutImageView: UIImageView?
    private var isAnimating = false
    
    private init() {}
    
    /// Call immediately after window.makeKeyAndVisible() to cover any gap.
    /// Shows the same image as LaunchScreen.storyboard.
    func install(in window: UIWindow) {
        // Overlay container (clear background, images provide coverage)
        let overlay = UIView(frame: window.bounds)
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        overlay.backgroundColor = .clear
        
        // Cutout splash (transparent arrow) — visible from start, underneath opaque
        let cutout = UIImageView(frame: overlay.bounds)
        cutout.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cutout.contentMode = .scaleAspectFill
        cutout.clipsToBounds = true
        cutout.image = UIImage(named: "SplashCutout")
        
        // Opaque splash (yellow arrow) — on top, fades out to reveal cutout
        let opaque = UIImageView(frame: overlay.bounds)
        opaque.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        opaque.contentMode = .scaleAspectFill
        opaque.clipsToBounds = true
        opaque.image = UIImage(named: "SplashOpaque")
        
        overlay.addSubview(cutout)
        overlay.addSubview(opaque)
        
        window.addSubview(overlay)
        
        self.overlayView = overlay
        self.opaqueImageView = opaque
        self.cutoutImageView = cutout
    }
    
    /// Perform the zoom-reveal animation. Call from JS bridge when the map is loaded.
    func animateReveal() {
        guard let overlay = overlayView, !isAnimating else { return }
        isAnimating = true
        
        // Phase 1: Fade out opaque to reveal cutout (map peeks through transparent arrow)
        UIView.animate(withDuration: 0.25, delay: 0, options: .curveEaseInOut) {
            self.opaqueImageView?.alpha = 0
        } completion: { _ in
            // Phase 2: Zoom to 6x (arrow expands, revealing full map)
            UIView.animate(withDuration: 0.5, delay: 0, options: .curveEaseIn) {
                overlay.transform = CGAffineTransform(scaleX: 6, y: 6)
            } completion: { _ in
                // Done — at 6x the cutout background is off-screen, just remove
                overlay.removeFromSuperview()
                self.overlayView = nil
                self.opaqueImageView = nil
                self.cutoutImageView = nil
                self.isAnimating = false
            }
        }
    }
}
