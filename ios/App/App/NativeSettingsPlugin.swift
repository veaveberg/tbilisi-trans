import Capacitor
import UIKit
import WebKit

@objc(NativeSettingsPlugin)
public class NativeSettingsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeSettingsPlugin"
    public let jsName = "NativeSettings"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPageZoom", returnType: CAPPluginReturnPromise)
    ]

    private weak var settingsController: SettingsViewController?
    private var settingsNavController: UINavigationController?

    @objc func open(_ call: CAPPluginCall) {
        let initialSettings = call.getObject("settings") ?? [:]
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            let controller: SettingsViewController
            if let existing = self.settingsController {
                controller = existing
            } else {
                controller = SettingsViewController()
                self.settingsController = controller
                controller.onToggle = { [weak self] key, value in
                // Apply zoom immediately when scale changes
                if key == "pageScale", let scale = value as? Double {
                    self?.applyPageZoom(CGFloat(scale))
                }
                self?.notifyListeners("settingsChanged", data: ["key": key, "value": value])
                }
                controller.onDone = { [weak self] settings in
                // Apply final zoom on close
                if let scale = settings["pageScale"] as? Double {
                    self?.applyPageZoom(CGFloat(scale))
                }
                self?.notifyListeners("settingsClosed", data: ["settings": settings])
                }
            }

            controller.applySettings(initialSettings)
            controller.loadViewIfNeeded()
            controller.tableView.reloadData()

            let nav: UINavigationController
            if let existingNav = self.settingsNavController {
                nav = existingNav
            } else {
                nav = UINavigationController(rootViewController: controller)
                nav.modalPresentationStyle = .pageSheet
                self.settingsNavController = nav
            }

            if self.bridge?.viewController?.presentedViewController !== nav {
                self.bridge?.viewController?.present(nav, animated: true)
            }

            call.resolve()
        }
    }
    
    @objc func setPageZoom(_ call: CAPPluginCall) {
        let zoom = call.getFloat("zoom") ?? 1.0
        DispatchQueue.main.async { [weak self] in
            self?.applyPageZoom(CGFloat(zoom))
            call.resolve()
        }
    }
    
    private func applyPageZoom(_ zoom: CGFloat) {
        guard let webView = bridge?.webView else { return }
        
        // Use CSS transform with dimension compensation
        // When we scale up (e.g. 1.25x), we need to shrink the container to (1/1.25 = 80%)
        // so that when scaled, it fills exactly 100% of the viewport
        let inverseScale = 1.0 / zoom
        let widthPercent = inverseScale * 100.0
        let heightPercent = inverseScale * 100.0
        
        let js = """
        (function() {
            const html = document.documentElement;
            const body = document.body;
            const scale = \(zoom);
            if (scale === 1) {
                html.style.transform = '';
                html.style.transformOrigin = '';
                html.style.width = '';
                html.style.height = '';
                html.style.overflow = '';
                html.style.removeProperty('--page-scale');
                html.style.removeProperty('--inv-page-scale');
                if (body) {
                    body.style.width = '';
                    body.style.height = '';
                    body.style.overflow = '';
                }
            } else {
                html.style.transform = 'scale(' + scale + ')';
                html.style.transformOrigin = 'top left';
                html.style.width = '\(widthPercent)%';
                html.style.height = '\(heightPercent)%';
                html.style.overflow = 'hidden';
                html.style.setProperty('--page-scale', String(scale));
                html.style.setProperty('--inv-page-scale', String(1 / scale));
                if (body) {
                    body.style.width = '100%';
                    body.style.height = '100%';
                    body.style.overflow = 'hidden';
                }
            }
            // Trigger Mapbox resize after transform
            if (window.map && typeof window.map.resize === 'function') {
                setTimeout(function() { window.map.resize(); }, 50);
            }
        })();
        """
        
        webView.evaluateJavaScript(js) { _, error in
            if let error = error {
                print("[NativeSettings] Zoom JS error:", error.localizedDescription)
            }
        }
    }
}
