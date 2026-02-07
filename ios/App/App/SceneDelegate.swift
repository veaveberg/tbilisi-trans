import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = (scene as? UIWindowScene) else { return }

        let window = UIWindow(windowScene: windowScene)
        let viewController = BridgeViewController()
        window.rootViewController = viewController
        self.window = window
        window.makeKeyAndVisible()
        
        // Handle Universal Links from cold start
        print("[SceneDelegate] willConnectTo - userActivities count: \(connectionOptions.userActivities.count)")
        if let userActivity = connectionOptions.userActivities.first,
           let url = userActivity.webpageURL {
            print("[SceneDelegate] Cold start with URL: \(url.absoluteString)")
            // Delay to ensure webview is ready
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                self.handleUniversalLink(url)
            }
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        print("[SceneDelegate] openURLContexts: \(URLContexts.count)")
        guard let urlContext = URLContexts.first else { return }
        print("[SceneDelegate] URL: \(urlContext.url.absoluteString)")
        var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
        if let sourceApp = urlContext.options.sourceApplication {
            options[.sourceApplication] = sourceApp
        }
        if let annotation = urlContext.options.annotation {
            options[.annotation] = annotation
        }
        options[.openInPlace] = urlContext.options.openInPlace
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            open: urlContext.url,
            options: options
        )
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        guard let url = userActivity.webpageURL else { return }
        print("[SceneDelegate] continue userActivity: \(url.absoluteString)")
        handleUniversalLink(url)
    }
    
    private func handleUniversalLink(_ url: URL) {
        print("[SceneDelegate] Handling Universal Link: \(url.absoluteString)")
        
        // Extract full path starting from /tbilisi-trans
        // We want everything after the domain
        var fullPath = url.path
        if let query = url.query {
            fullPath += "?" + query
        }
        if let fragment = url.fragment {
            fullPath += "#" + fragment
        }
        
        // Remove /tbilisi-trans prefix if present
        var localPath = fullPath.replacingOccurrences(of: "/tbilisi-trans", with: "")
        if localPath.isEmpty { localPath = "/" }
        
        print("[SceneDelegate] Navigating to local path: \(localPath)")
        
        // Find the webview
        guard let rootVC = window?.rootViewController as? CAPBridgeViewController,
              let webView = rootVC.bridge?.webView else {
            print("[SceneDelegate] ERROR: Could not find webview")
            return
        }
        
        // Execute robust JS navigation
        let js = """
        (function() {
            const targetPath = '\(localPath)';
            console.log('[NativeLink] Attempting navigation to:', targetPath);
            
            // Function to perform the actual deep link
            const doLink = () => {
                window.history.replaceState({}, '', targetPath);
                if (typeof window.handleDeepLinks === 'function') {
                    console.log('[NativeLink] Calling handleDeepLinks');
                    window.handleDeepLinks();
                } else {
                    console.log('[NativeLink] handleDeepLinks not found, firing popstate');
                    window.dispatchEvent(new PopStateEvent('popstate'));
                }
            };
            
            // Wait for handleDeepLinks to be ready
            let attempts = 0;
            const checkReady = () => {
                // We check if handleDeepLinks is defined
                if (typeof window.handleDeepLinks === 'function') {
                    doLink();
                } else if (attempts < 50) {
                    attempts++;
                    setTimeout(checkReady, 200);
                } else {
                    console.error('[NativeLink] Timeout waiting for handleDeepLinks');
                }
            };
            
            checkReady();
        })();
        """
        
        webView.evaluateJavaScript(js) { result, error in
            if let error = error {
                print("[SceneDelegate] JS Eval Error: \(error.localizedDescription)")
            } else {
                print("[SceneDelegate] Navigation script injected")
            }
        }
    }
}

