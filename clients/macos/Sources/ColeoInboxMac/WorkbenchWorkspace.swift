import AppKit
import ColeoInboxCore
import SwiftUI
import UniformTypeIdentifiers

enum ModuleDestination: String, CaseIterable, Identifiable {
    case tab = "Tab"
    case window = "Window"
    var id: String { rawValue }
}

/// Shared launch/catalog coordination only. Sessions remain document-owned.
@MainActor
final class WorkbenchWorkspace: ObservableObject {
    @Published private(set) var modules: [WorkbenchModule] = []
    @Published var error: String?

    private final class Launch {
        weak var parent: NSWindow?
        let destination: ModuleDestination
        init(parent: NSWindow?, destination: ModuleDestination) {
            self.parent = parent
            self.destination = destination
        }
    }
    private var launches: [UUID: Launch] = [:]
    private let installedURL: URL

    init() {
        installedURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Coleo/modules.json")
        reloadCatalog()
    }

    func reloadCatalog() {
        do {
            guard let url = Bundle.main.url(forResource: "modules", withExtension: "json")
                ?? Bundle.module.url(forResource: "modules", withExtension: "json") else {
                throw ContractError.invalid("Bundled module catalog is missing")
            }
            modules = try ModuleCatalog.decode(Data(contentsOf: url)).modules
            if FileManager.default.fileExists(atPath: installedURL.path) {
                merge(try ModuleCatalog.decode(Data(contentsOf: installedURL)).modules)
            }
        } catch {
            if modules.isEmpty { modules = [.inbox] }
            self.error = error.localizedDescription
        }
    }

    func importCatalog() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "Load module launch recipes from a Coleo module catalog."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let data = try Data(contentsOf: url)
            _ = try ModuleCatalog.decode(data)
            try FileManager.default.createDirectory(at: installedURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: installedURL, options: .atomic)
            reloadCatalog()
        } catch {
            self.error = "Could not load modules: \(error.localizedDescription)"
        }
    }

    private func merge(_ incoming: [WorkbenchModule]) {
        for module in incoming {
            if let index = modules.firstIndex(where: { $0.id == module.id }) { modules[index] = module }
            else { modules.append(module) }
        }
    }

    func launch(_ module: WorkbenchModule, in destination: ModuleDestination, using openWindow: OpenWindowAction) {
        let document = ModuleDocument(module: module)
        let parent = [NSApp.keyWindow, NSApp.mainWindow].compactMap { $0 }
            .first { $0.tabbingIdentifier == "coleo.workbench" }
        launches[document.id] = Launch(parent: parent, destination: destination)
        openWindow(id: "workbench", value: document)
    }

    func attach(_ window: NSWindow, document: ModuleDocument) {
        window.tabbingIdentifier = "coleo.workbench"
        window.title = document.module.title
        let launch = launches.removeValue(forKey: document.id)
        // Explicit New Window must not be auto-tabbed by the system preference.
        window.tabbingMode = launch == nil ? .automatic : .disallowed
        DispatchQueue.main.async { [weak window] in
            guard let window else { return }
            window.tabbingMode = .automatic
            if launch?.destination == .tab, let parent = launch?.parent, parent !== window {
                parent.addTabbedWindow(window, ordered: .above)
                window.makeKeyAndOrderFront(nil)
            }
            if window.tabGroup?.isTabBarVisible == false { window.toggleTabBar(nil) }
        }
    }
}

/// AppKit owns tab dragging, detaching, merging, and the Window menu. Stop a
/// document's live work on window close, not when another tab becomes visible.
struct WorkbenchWindowBridge: NSViewRepresentable {
    @Environment(\.openWindow) private var openWindow
    let workspace: WorkbenchWorkspace
    let document: ModuleDocument
    let onClose: () -> Void

    final class Probe: NSView {
        var attach: ((NSWindow) -> Void)?
        var onClose: (() -> Void)?
        private weak var attachedWindow: NSWindow?
        private var closeObserver: NSObjectProtocol?
        var titlebar: ModuleTitlebar?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard let window, window !== attachedWindow else { return }
            titlebar?.detach()
            if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) }
            attachedWindow = window
            attach?(window)
            closeObserver = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification,
                object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated {
                        self?.titlebar?.detach()
                        self?.onClose?()
                    }
                }
        }

        deinit {
            if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) }
        }
    }

    func makeNSView(context: Context) -> Probe {
        let probe = Probe()
        probe.attach = { [weak probe] window in
            workspace.attach(window, document: document)
            probe?.titlebar = ModuleTitlebar(window: window, workspace: workspace, openWindow: openWindow)
        }
        probe.onClose = onClose
        return probe
    }
    func updateNSView(_ nsView: Probe, context: Context) {}
}

private struct ActiveModuleKey: FocusedValueKey { typealias Value = WorkbenchModule }
extension FocusedValues {
    var workbenchModule: WorkbenchModule? {
        get { self[ActiveModuleKey.self] }
        set { self[ActiveModuleKey.self] = newValue }
    }
}
