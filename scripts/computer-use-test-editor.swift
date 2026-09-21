import AppKit

// Only an isolated acceptance fixture. It never opens or saves files.
final class TestEditor: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let field = NSTextField(frame: NSRect(x: 30, y: 110, width: 400, height: 50))
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 500, height: 240),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = ProcessInfo.processInfo.environment["TONGPIN_NATIVE_TEST_TITLE"]!
        window.isReleasedWhenClosed = false
        let button = NSButton(title: "Open test editor", target: self, action: #selector(openEditor))
        button.frame = NSRect(x: 30, y: 110, width: 200, height: 40)
        button.setAccessibilityLabel("Open test editor")
        window.contentView?.addSubview(button)
        field.setAccessibilityLabel("Test document")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        print("EDITOR_READY {\"pid\":\(ProcessInfo.processInfo.processIdentifier)}")
        fflush(stdout)
    }
    @objc func openEditor(_ sender: NSButton) {
        sender.removeFromSuperview()
        window.contentView?.addSubview(field)
        window.makeFirstResponder(field)
    }
}

let app = NSApplication.shared
let delegate = TestEditor()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
