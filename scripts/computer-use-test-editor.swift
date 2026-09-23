import AppKit

// Only an isolated acceptance fixture. It never opens or saves files.
final class FlippedDocument: NSView {
    override var isFlipped: Bool { true }
}
final class TestEditor: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let field = NSTextField(frame: NSRect(x: 30, y: 225, width: 400, height: 50))
    let scrollView = NSScrollView(frame: NSRect(x: 30, y: 20, width: 400, height: 140))
    let scrollPosition = NSTextField(labelWithString: "0")
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 500, height: 360),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = ProcessInfo.processInfo.environment["TONGPIN_NATIVE_TEST_TITLE"]!
        window.isReleasedWhenClosed = false
        let button = NSButton(title: "Open test editor", target: self, action: #selector(openEditor))
        button.frame = NSRect(x: 30, y: 225, width: 200, height: 40)
        button.setAccessibilityLabel("Open test editor")
        window.contentView?.addSubview(button)
        field.setAccessibilityLabel("Test document")
        let document = FlippedDocument(frame: NSRect(x: 0, y: 0, width: 380, height: 1600))
        let scrollTarget = NSButton(title: "Scroll target", target: nil, action: nil)
        scrollTarget.frame = NSRect(x: 10, y: 10, width: 180, height: 32)
        scrollTarget.setAccessibilityLabel("Scroll target")
        document.addSubview(scrollTarget)
        for index in 0..<40 {
            let line = NSTextField(labelWithString: "Line \(index + 1)")
            line.frame = NSRect(x: 10, y: 55 + index * 38, width: 350, height: 25)
            document.addSubview(line)
        }
        scrollView.documentView = document
        scrollView.hasVerticalScroller = true
        scrollView.borderType = .bezelBorder
        scrollView.setAccessibilityLabel("Test scroll region")
        scrollView.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(scrolled),
                                               name: NSView.boundsDidChangeNotification,
                                               object: scrollView.contentView)
        window.contentView?.addSubview(scrollView)
        scrollPosition.frame = NSRect(x: 30, y: 168, width: 400, height: 22)
        scrollPosition.setAccessibilityLabel("Scroll position")
        window.contentView?.addSubview(scrollPosition)
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
    @objc func scrolled(_ notification: Notification) {
        scrollPosition.stringValue = String(Int(scrollView.contentView.bounds.origin.y.rounded()))
    }
}

let app = NSApplication.shared
let delegate = TestEditor()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
