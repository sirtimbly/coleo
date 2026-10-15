import AppKit
import SwiftUI

/// Standard modified shortcuts live in menus, routed to the active document.
struct WorkbenchActions {
    var refresh: () -> Void
    var find: (() -> Void)?
    var toggleSidebar: (() -> Void)?
    var help: (() -> Void)?
    var markRead: (() -> Void)?
    var selectBranch: (() -> Void)?
}

private struct WorkbenchActionsKey: FocusedValueKey { typealias Value = WorkbenchActions }
extension FocusedValues {
    var workbenchActions: WorkbenchActions? {
        get { self[WorkbenchActionsKey.self] }
        set { self[WorkbenchActionsKey.self] = newValue }
    }
}

struct WorkbenchKeyboardCommands: Commands {
    @FocusedValue(\.workbenchActions) private var actions

    var body: some Commands {
        CommandGroup(after: .textEditing) {
            Button("Find in Module") { actions?.find?() }
                .keyboardShortcut("f", modifiers: .command).disabled(actions?.find == nil)
        }
        CommandMenu("Collection") {
            Button("Refresh") { actions?.refresh() }
                .keyboardShortcut("r", modifiers: .command).disabled(actions == nil)
            Button("Toggle Sidebar") { actions?.toggleSidebar?() }
                .keyboardShortcut("s", modifiers: [.command, .control]).disabled(actions?.toggleSidebar == nil)
            Divider()
            Button("Mark Selection Read") { actions?.markRead?() }
                .keyboardShortcut("r", modifiers: [.command, .shift]).disabled(actions?.markRead == nil)
            Button("Select Branch") { actions?.selectBranch?() }
                .keyboardShortcut("b", modifiers: [.command, .shift]).disabled(actions?.selectBranch == nil)
            Divider()
            Button("Keyboard Shortcuts") { actions?.help?() }
                .keyboardShortcut("/", modifiers: [.command, .shift]).disabled(actions?.help == nil)
        }
    }
}

/// Native List/Table consume key events before SwiftUI onKeyPress. A local
/// monitor handles declared collection keys first, only in this key window.
/// It never intercepts text editing, controls, menus, sheets, or other tabs.
struct CollectionKeyboard: NSViewRepresentable {
    let enabled: Bool
    let onKey: (String, Set<String>) -> Bool

    final class Probe: NSView {
        var enabled = true
        var onKey: ((String, Set<String>) -> Bool)?
        private var monitor: Any?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, self.enabled, let window = self.window,
                      window.isKeyWindow, event.window === window,
                      window.attachedSheet == nil, NSApp.currentEvent?.type == .keyDown else { return event }
                if window.firstResponder is NSTextView { return event }
                if let control = window.firstResponder as? NSControl,
                   !(control is NSTableView) { return event }
                // The monitor is attached to the collection pane. Sidebar
                // arrows and detail text selection must keep native behavior.
                if let responder = window.firstResponder as? NSView {
                    var pane: NSView = self
                    while let parent = pane.superview, !(parent is NSSplitView) { pane = parent }
                    guard pane.superview is NSSplitView, responder.isDescendant(of: pane) else { return event }
                }
                let key: String
                switch event.keyCode {
                case 123: key = "ArrowLeft"
                case 124: key = "ArrowRight"
                case 125: key = "ArrowDown"
                case 126: key = "ArrowUp"
                case 36, 76: key = "Enter"
                case 53: key = "Escape"
                case 49: key = "Space"
                default: key = event.charactersIgnoringModifiers ?? ""
                }
                let flags = event.modifierFlags
                var modifiers = Set<String>()
                if flags.contains(.command) { modifiers.insert("command") }
                if flags.contains(.control) { modifiers.insert("control") }
                if flags.contains(.option) { modifiers.insert("option") }
                if flags.contains(.shift) { modifiers.insert("shift") }
                return self.onKey?(key, modifiers) == true ? nil : event
            }
        }

        func stop() {
            if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
        }
    }

    func makeNSView(context: Context) -> Probe { Probe() }
    func updateNSView(_ view: Probe, context: Context) { view.enabled = enabled; view.onKey = onKey }
    static func dismantleNSView(_ view: Probe, coordinator: ()) { view.stop() }
}
