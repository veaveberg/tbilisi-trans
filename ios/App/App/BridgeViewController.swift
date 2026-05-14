import Capacitor
import ObjectiveC.runtime
import UIKit
import WebKit

private final class AccessoryHidingWebView: WKWebView {
    override var inputAccessoryView: UIView? {
        nil
    }
}

final class BridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(NativeSettingsPlugin())
        bridge?.registerPluginInstance(NativeGeolocationPlugin())
        disableKeyboardAccessoryBar()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        disableKeyboardAccessoryBar()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        disableKeyboardAccessoryBar()
    }

    private func disableKeyboardAccessoryBar() {
        guard let webView = bridge?.webView else { return }
        stripInputAssistant(from: webView)
        stripInputAssistant(from: webView.scrollView)
        webView.scrollView.subviews.forEach { stripInputAssistant(from: $0) }
        hideHTMLInputAccessoryView(in: webView)
    }

    private func stripInputAssistant(from view: UIView) {
        if let textInputView = view as? UIView & UITextInput {
            textInputView.inputAssistantItem.leadingBarButtonGroups = []
            textInputView.inputAssistantItem.trailingBarButtonGroups = []
        }

        view.subviews.forEach { stripInputAssistant(from: $0) }
    }

    private func hideHTMLInputAccessoryView(in webView: WKWebView) {
        guard let targetView = findWKContentView(in: webView.scrollView) else { return }
        let targetClass: AnyClass = object_getClass(targetView) ?? type(of: targetView)
        let newClassName = "\(NSStringFromClass(targetClass))_NoInputAccessoryView"

        if let existingClass = NSClassFromString(newClassName) {
            object_setClass(targetView, existingClass)
            return
        }

        guard
            let newClass = objc_allocateClassPair(targetClass, newClassName, 0),
            let method = class_getInstanceMethod(AccessoryHidingWebView.self, #selector(getter: AccessoryHidingWebView.inputAccessoryView))
        else {
            return
        }

        class_addMethod(
            newClass,
            #selector(getter: UIResponder.inputAccessoryView),
            method_getImplementation(method),
            method_getTypeEncoding(method)
        )
        objc_registerClassPair(newClass)
        object_setClass(targetView, newClass)
    }

    private func findWKContentView(in view: UIView) -> UIView? {
        if NSStringFromClass(type(of: view)).hasPrefix("WKContent") {
            return view
        }
        for subview in view.subviews {
            if let match = findWKContentView(in: subview) {
                return match
            }
        }
        return nil
    }
}
