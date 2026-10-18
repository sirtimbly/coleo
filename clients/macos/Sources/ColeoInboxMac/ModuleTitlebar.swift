import AppKit
import ColeoInboxCore
import SwiftUI

/// Public AppKit tab-creation responder. The system
/// continues to own the tab strip, drag gestures, and window grouping.
@MainActor
final class ModuleTitlebar: NSResponder {
    private let popover = NSPopover()
    private weak var owner: NSWindow?
    private let workspace: WorkbenchWorkspace
    private let openWindow: OpenWindowAction
    private var identityTask: Task<Void, Never>?
    private var settingsObserver: NSObjectProtocol?
    private struct Identity {
        let url: URL
        let key: String
        let projectName: String
    }
    private static var cachedIdentity: Identity?

    init(window: NSWindow, workspace: WorkbenchWorkspace, openWindow: OpenWindowAction) {
        self.workspace = workspace
        self.openWindow = openWindow
        super.init()
        owner = window
        nextResponder = window.nextResponder
        window.nextResponder = self
        popover.behavior = .transient
        refreshIdentity()
        settingsObserver = NotificationCenter.default.addObserver(forName: .inboxSettingsChanged,
            object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.refreshIdentity() }
            }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func newWindowForTab(_ sender: Any?) { showLauncher(sender) }

    private func refreshIdentity() {
        identityTask?.cancel()
        let settings = InboxSettings.load()
        var components = URLComponents(url: settings.url, resolvingAgainstBaseURL: false)
        components?.user = nil
        components?.password = nil
        components?.query = nil
        components?.fragment = nil
        owner?.titleVisibility = .visible
        let cached = Self.cachedIdentity
        let cachedName = cached?.url == settings.url && cached?.key == settings.key ? cached?.projectName : nil
        owner?.title = cachedName ?? "Coleo Workbench"
        owner?.subtitle = components?.string ?? settings.url.host ?? "Coleo server"
        // Every native tab has its own NSWindow, but the connected project is
        // shared. Avoid transient title changes when opening another document.
        if cachedName != nil { return }
        identityTask = Task { [weak self] in
            do {
                let status = try await URLSessionTransport(baseURL: settings.url, apiKey: settings.key)
                    .request(path: "/api/status")
                guard !Task.isCancelled else { return }
                let name = status["projectName"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
                if let name, !name.isEmpty {
                    Self.cachedIdentity = Identity(url: settings.url, key: settings.key, projectName: name)
                    self?.owner?.title = name
                } else {
                    self?.owner?.title = "Project unavailable"
                }
            } catch {
                guard !Task.isCancelled else { return }
                self?.owner?.title = "Project unavailable"
            }
        }
    }

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
        identityTask?.cancel()
        identityTask = nil
        if let settingsObserver { NotificationCenter.default.removeObserver(settingsObserver) }
        settingsObserver = nil
        popover.performClose(nil)
        guard let owner else { return }
        if owner.nextResponder === self { owner.nextResponder = nextResponder }
        self.owner = nil
    }
}
