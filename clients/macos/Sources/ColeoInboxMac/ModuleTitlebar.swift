import AppKit
import SwiftUI

/// Public AppKit tab-creation responder. The system
/// continues to own the tab strip, drag gestures, and window grouping.
@MainActor
final class ModuleTitlebar: NSResponder {
    private let popover = NSPopover()
    private weak var owner: NSWindow?
    private let workspace: WorkbenchWorkspace
    private let openWindow: OpenWindowAction

    init(window: NSWindow, workspace: WorkbenchWorkspace, openWindow: OpenWindowAction) {
        self.workspace = workspace
        self.openWindow = openWindow
        super.init()
        owner = window
        nextResponder = window.nextResponder
        window.nextResponder = self
        popover.behavior = .transient
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func newWindowForTab(_ sender: Any?) { showLauncher(sender) }

    @objc private func showLauncher(_ sender: Any?) {
        guard let owner else { return }
        owner.makeKeyAndOrderFront(nil)
        if popover.isShown { popover.performClose(sender); return }
        popover.contentViewController = NSHostingController(rootView:
            ModuleLauncherPanel(modules: workspace.modules) { [weak self] module, destination in
                guard let self else { return }
                self.popover.performClose(nil)
                self.workspace.launch(module, in: destination, using: self.openWindow)
            })
        if let anchor = sender as? NSView, anchor.window === owner {
            popover.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .minY)
        } else if let content = owner.contentView {
            let top = content.isFlipped ? content.bounds.minY : content.bounds.maxY
            popover.show(relativeTo: NSRect(x: content.bounds.maxX - 32, y: top, width: 24, height: 1),
                         of: content, preferredEdge: .minY)
        }
    }

    func detach() {
        popover.performClose(nil)
        guard let owner else { return }
        if owner.nextResponder === self { owner.nextResponder = nextResponder }
        self.owner = nil
    }
}
