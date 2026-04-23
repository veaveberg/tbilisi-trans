import Capacitor
import UIKit
import WebKit
import SafariServices

@objc(NativeSettingsPlugin)
public class NativeSettingsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeSettingsPlugin"
    public let jsName = "NativeSettings"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openFavoritesMenu", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPageZoom", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hideSplash", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "warmUI", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showActionSheet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getICloudSyncState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setICloudSyncEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncHistory", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSyncedHistory", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncFavorites", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSyncedFavorites", returnType: CAPPluginReturnPromise)
    ]

    private let iCloudSearchHistoryKey = "sync.search_history_v1"
    private let iCloudCardHistoryKey = "sync.card_history_v1"
    private let iCloudFavoritesKey = "sync.favorites_v1"
    private let iCloudSyncEnabledKey = "icloudSyncEnabled"
    private let supportUrlString = "https://veaveberg.github.io/tbilisi-trans/support.html"
    private let privacyPolicyUrlString = "https://veaveberg.github.io/tbilisi-trans/privacy-policy.html"

    private weak var settingsController: SettingsViewController?
    private var settingsNavController: UINavigationController?
    private var iCloudObserver: NSObjectProtocol?
    private var didWarmUI = false

    public override func load() {
        super.load()
        DispatchQueue.main.async { [weak self] in
            self?.warmUIComponentsIfNeeded()
        }
        iCloudObserver = NotificationCenter.default.addObserver(
            forName: NSUbiquitousKeyValueStore.didChangeExternallyNotification,
            object: NSUbiquitousKeyValueStore.default,
            queue: .main
        ) { [weak self] notification in
            self?.handleICloudExternalChange(notification)
        }
        NSUbiquitousKeyValueStore.default.synchronize()
    }

    deinit {
        if let observer = iCloudObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    @objc func open(_ call: CAPPluginCall) {
        let initialSettings = call.getObject("settings") ?? [:]
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if let theme = initialSettings["theme"] as? String {
                self.applyNativeTheme(theme)
            }

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
                if key == "theme", let theme = value as? String {
                    self?.applyNativeTheme(theme)
                }
                self?.emitSettingsChanged(key: key, value: value)
                }
                controller.onDone = { [weak self] settings in
                // Apply final zoom on close
                if let scale = settings["pageScale"] as? Double {
                    self?.applyPageZoom(CGFloat(scale))
                }
                if let theme = settings["theme"] as? String {
                    self?.applyNativeTheme(theme)
                }
                self?.emitSettingsClosed(settings: settings)
                }
                controller.onOpenPrivacyPolicy = { [weak self] in
                    self?.presentPrivacyPolicySheet()
                }
                controller.onOpenSupport = { [weak self] in
                    self?.presentSupportPage()
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

    @objc func openFavoritesMenu(_ call: CAPPluginCall) {
        let initialSettings = call.getObject("settings") ?? [:]
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if let theme = initialSettings["theme"] as? String {
                self.applyNativeTheme(theme)
            }

            let controller: SettingsViewController
            if let existing = self.settingsController {
                controller = existing
            } else {
                controller = SettingsViewController()
                self.settingsController = controller
                controller.onToggle = { [weak self] key, value in
                    if key == "pageScale", let scale = value as? Double {
                        self?.applyPageZoom(CGFloat(scale))
                    }
                    if key == "theme", let theme = value as? String {
                        self?.applyNativeTheme(theme)
                    }
                    self?.emitSettingsChanged(key: key, value: value)
                }
                controller.onDone = { [weak self] settings in
                    if let scale = settings["pageScale"] as? Double {
                        self?.applyPageZoom(CGFloat(scale))
                    }
                    if let theme = settings["theme"] as? String {
                        self?.applyNativeTheme(theme)
                    }
                    self?.emitSettingsClosed(settings: settings)
                }
                controller.onOpenPrivacyPolicy = { [weak self] in
                    self?.presentPrivacyPolicySheet()
                }
                controller.onOpenSupport = { [weak self] in
                    self?.presentSupportPage()
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

            let openMenu = {
                if nav.viewControllers.isEmpty {
                    nav.viewControllers = [controller]
                } else if nav.viewControllers.first !== controller {
                    nav.setViewControllers([controller], animated: false)
                }
                controller.openFavoritesMenu()
            }

            if self.bridge?.viewController?.presentedViewController !== nav {
                self.bridge?.viewController?.present(nav, animated: true) {
                    openMenu()
                }
            } else {
                openMenu()
            }

            call.resolve()
        }
    }

    @objc func hideSplash(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            SplashAnimator.shared.animateReveal()
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

    @objc func warmUI(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.warmUIComponentsIfNeeded()
            call.resolve()
        }
    }

    @objc func showActionSheet(_ call: CAPPluginCall) {
        let work = { [weak self] in
            guard let self = self, let presenter = self.bridge?.viewController else {
                call.reject("presenter_unavailable")
                return
            }
            self.warmUIComponentsIfNeeded()

            let title = call.getString("title")
            let message = call.getString("message")
            let actionsRaw = (call.getArray("actions") as? [[String: Any]]) ?? []
            if actionsRaw.isEmpty {
                call.reject("actions_required")
                return
            }

            let alert = UIAlertController(title: title, message: message, preferredStyle: .actionSheet)

            for raw in actionsRaw {
                guard let actionId = raw["id"] as? String, !actionId.isEmpty else { continue }
                let actionTitle = (raw["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                if actionTitle?.isEmpty != false { continue }

                let styleRaw = (raw["style"] as? String ?? "default").lowercased()
                let style: UIAlertAction.Style = (styleRaw == "destructive") ? .destructive : .default

                let action = UIAlertAction(title: actionTitle, style: style) { _ in
                    call.resolve(["action": actionId])
                }
                let accentRaw = (raw["accent"] as? String ?? "").lowercased()
                let isYellowAccent = accentRaw == "yellow"
                let isBlackAccent = accentRaw == "black"
                if let symbolName = raw["symbol"] as? String, !symbolName.isEmpty {
                    let symbolConfig = UIImage.SymbolConfiguration(pointSize: 20, weight: .regular, scale: .medium)
                    if let baseImage = UIImage(systemName: symbolName, withConfiguration: symbolConfig) {
                        let symbolImage: UIImage
                        if isYellowAccent {
                            symbolImage = baseImage.withTintColor(.systemYellow, renderingMode: .alwaysOriginal)
                        } else if isBlackAccent {
                            symbolImage = baseImage.withTintColor(.black, renderingMode: .alwaysOriginal)
                        } else {
                            symbolImage = baseImage.withRenderingMode(.alwaysTemplate)
                        }
                        action.setValue(symbolImage, forKey: "image")
                    }
                }
                if isYellowAccent {
                    action.setValue(UIColor.systemYellow, forKey: "titleTextColor")
                } else if isBlackAccent {
                    action.setValue(UIColor.black, forKey: "titleTextColor")
                }
                alert.addAction(action)
            }

            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in
                call.resolve(["action": NSNull()])
            })

            if let popover = alert.popoverPresentationController {
                guard let sourceView = self.bridge?.webView ?? presenter.view else {
                    call.reject("popover_source_unavailable")
                    return
                }
                popover.sourceView = sourceView

                let rawX = call.getDouble("anchorX") ?? sourceView.bounds.midX
                let rawY = call.getDouble("anchorY") ?? sourceView.bounds.maxY - 8.0
                let x = min(max(rawX, 1.0), sourceView.bounds.maxX - 1.0)
                let y = min(max(rawY, 1.0), sourceView.bounds.maxY - 1.0)
                popover.sourceRect = CGRect(x: x, y: y, width: 1.0, height: 1.0)
                popover.permittedArrowDirections = .any
            }

            presenter.present(alert, animated: true)
        }
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.async(execute: work)
        }
    }

    @objc func shareUrl(_ call: CAPPluginCall) {
        let work = { [weak self] in
            guard let self = self, let presenter = self.bridge?.viewController else {
                call.reject("presenter_unavailable")
                return
            }

            let urlString = (call.getString("url") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !urlString.isEmpty else {
                call.reject("url_required")
                return
            }

            let item: Any = URL(string: urlString) ?? urlString
            let activity = UIActivityViewController(activityItems: [item], applicationActivities: nil)

            if let popover = activity.popoverPresentationController {
                guard let sourceView = self.bridge?.webView ?? presenter.view else {
                    call.reject("popover_source_unavailable")
                    return
                }
                popover.sourceView = sourceView
                let rawX = call.getDouble("anchorX") ?? sourceView.bounds.midX
                let rawY = call.getDouble("anchorY") ?? sourceView.bounds.maxY - 8.0
                let x = min(max(rawX, 1.0), sourceView.bounds.maxX - 1.0)
                let y = min(max(rawY, 1.0), sourceView.bounds.maxY - 1.0)
                popover.sourceRect = CGRect(x: x, y: y, width: 1.0, height: 1.0)
                popover.permittedArrowDirections = .any
            }

            presenter.present(activity, animated: true) {
                call.resolve()
            }
        }

        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.async(execute: work)
        }
    }

    private func warmUIComponentsIfNeeded() {
        guard !didWarmUI else { return }
        didWarmUI = true

        // Preload UIKit components that are first-used by settings/actions to reduce initial interaction latency.
        _ = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        let alertWarm = UIAlertController(title: "Warm", message: nil, preferredStyle: .alert)
        alertWarm.addTextField { _ in }
        _ = alertWarm
        let dummyEdit = UIContextualAction(style: .normal, title: "Edit") { _, _, completion in
            completion(false)
        }
        let dummyDelete = UIContextualAction(style: .destructive, title: "Delete") { _, _, completion in
            completion(false)
        }
        _ = UISwipeActionsConfiguration(actions: [dummyDelete, dummyEdit])
        let warmSwitch = UISwitch(frame: .zero)
        warmSwitch.setOn(false, animated: false)
        warmSwitch.setOn(true, animated: false)
        let impact = UIImpactFeedbackGenerator(style: .light)
        impact.prepare()
    }

    private func emitSettingsChanged(key: String, value: Any) {
        DispatchQueue.main.async { [weak self] in
            self?.notifyListeners("settingsChanged", data: ["key": key, "value": value])
        }
    }

    private func emitSettingsClosed(settings: [String: Any]) {
        DispatchQueue.main.async { [weak self] in
            self?.notifyListeners("settingsClosed", data: ["settings": settings])
        }
    }

    private func applyNativeTheme(_ theme: String) {
        let style: UIUserInterfaceStyle
        switch theme {
        case "light":
            style = .light
        case "dark":
            style = .dark
        default:
            style = .unspecified
        }

        bridge?.viewController?.overrideUserInterfaceStyle = style
        settingsNavController?.overrideUserInterfaceStyle = style
        settingsController?.overrideUserInterfaceStyle = style
    }

    private func presentPrivacyPolicySheet() {
        guard let presenter = settingsNavController?.topViewController ?? bridge?.viewController else { return }
        guard let url = URL(string: privacyPolicyUrlString) else { return }

        let safari = SFSafariViewController(url: url)
        safari.dismissButtonStyle = .close
        safari.preferredControlTintColor = .label
        presenter.present(safari, animated: true)
    }

    private func presentSupportPage() {
        guard let presenter = settingsNavController?.topViewController ?? bridge?.viewController else { return }
        guard let url = URL(string: supportUrlString) else { return }

        let safari = SFSafariViewController(url: url)
        safari.dismissButtonStyle = .close
        safari.preferredControlTintColor = .label
        presenter.present(safari, animated: true)
    }

    @objc func getICloudSyncState(_ call: CAPPluginCall) {
        let available = FileManager.default.ubiquityIdentityToken != nil
        let enabled = UserDefaults.standard.object(forKey: iCloudSyncEnabledKey) as? Bool ?? true
        call.resolve([
            "available": available,
            "enabled": enabled
        ])
    }

    @objc func setICloudSyncEnabled(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? true
        UserDefaults.standard.set(enabled, forKey: iCloudSyncEnabledKey)
        call.resolve([
            "enabled": enabled
        ])
    }

    @objc func syncHistory(_ call: CAPPluginCall) {
        guard FileManager.default.ubiquityIdentityToken != nil else {
            call.resolve(["available": false])
            return
        }

        let searchJson = call.getString("searchHistoryJson")
        let cardJson = call.getString("cardHistoryJson")
        let store = NSUbiquitousKeyValueStore.default

        if let searchJson {
            store.set(searchJson, forKey: iCloudSearchHistoryKey)
        }
        if let cardJson {
            store.set(cardJson, forKey: iCloudCardHistoryKey)
        }
        store.synchronize()

        call.resolve(["available": true])
    }

    @objc func getSyncedHistory(_ call: CAPPluginCall) {
        guard FileManager.default.ubiquityIdentityToken != nil else {
            call.resolve([
                "available": false,
                "searchHistoryJson": "[]",
                "cardHistoryJson": "[]"
            ])
            return
        }

        let store = NSUbiquitousKeyValueStore.default
        store.synchronize()
        let searchHistoryJson = store.string(forKey: iCloudSearchHistoryKey) ?? "[]"
        let cardHistoryJson = store.string(forKey: iCloudCardHistoryKey) ?? "[]"

        call.resolve([
            "available": true,
            "searchHistoryJson": searchHistoryJson,
            "cardHistoryJson": cardHistoryJson
        ])
    }

    @objc func syncFavorites(_ call: CAPPluginCall) {
        guard FileManager.default.ubiquityIdentityToken != nil else {
            call.resolve(["available": false])
            return
        }

        let favoritesJson = call.getString("favoritesJson")
        let store = NSUbiquitousKeyValueStore.default

        if let favoritesJson {
            store.set(favoritesJson, forKey: iCloudFavoritesKey)
        }
        store.synchronize()

        call.resolve(["available": true])
    }

    @objc func getSyncedFavorites(_ call: CAPPluginCall) {
        guard FileManager.default.ubiquityIdentityToken != nil else {
            call.resolve([
                "available": false,
                "favoritesJson": "[]"
            ])
            return
        }

        let store = NSUbiquitousKeyValueStore.default
        store.synchronize()
        let favoritesJson = store.string(forKey: iCloudFavoritesKey) ?? "[]"

        call.resolve([
            "available": true,
            "favoritesJson": favoritesJson
        ])
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

    private func handleICloudExternalChange(_ notification: Notification) {
        guard UserDefaults.standard.object(forKey: iCloudSyncEnabledKey) as? Bool ?? true else {
            return
        }

        let changedKeys = notification.userInfo?[NSUbiquitousKeyValueStoreChangedKeysKey] as? [String] ?? []
        let didChangeSyncedData = changedKeys.contains(iCloudSearchHistoryKey) ||
            changedKeys.contains(iCloudCardHistoryKey) ||
            changedKeys.contains(iCloudFavoritesKey)
        if didChangeSyncedData {
            notifyListeners("iCloudHistoryUpdated", data: [:])
        }
    }
}
