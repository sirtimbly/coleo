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
    @Published private(set) var catalogURL: URL
    private static let catalogPathKey = "coleo.moduleCatalogPath"

    init(catalogURL: URL? = nil) {
        let defaultURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Coleo/modules.json")
        if let catalogURL {
            self.catalogURL = catalogURL
        } else if let path = UserDefaults.standard.string(forKey: Self.catalogPathKey) {
            self.catalogURL = URL(fileURLWithPath: path)
        } else {
            self.catalogURL = defaultURL
            // The packaged file is only a first-run starter. Existing catalogs
            // are authoritative and never merged with or replaced by the bundle.
            if !FileManager.default.fileExists(atPath: defaultURL.path) {
                do {
                    guard let starter = Bundle.main.url(forResource: "modules", withExtension: "json")
                        ?? Bundle.module.url(forResource: "modules", withExtension: "json") else {
                        throw ContractError.invalid("Starter module catalog is missing")
                    }
                    try FileManager.default.createDirectory(at: defaultURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try FileManager.default.copyItem(at: starter, to: defaultURL)
                } catch {
                    self.error = "Could not create module catalog: \(error.localizedDescription)"
                    modules = [.inbox]
                    return
                }
            }
        }
        reloadCatalog()
    }

    func reloadCatalog() {
        do {
            let catalog = try ModuleCatalog.decode(Data(contentsOf: catalogURL))
            modules = catalog.modules
            error = nil
        } catch {
            if modules.isEmpty { modules = [.inbox] }
            self.error = "Could not read \(catalogURL.path): \(error.localizedDescription)"
        }
    }

    func importCatalog() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "Choose the catalog to read at startup and on Reload. Edits to this file do not require rebuilding the app."
        panel.directoryURL = catalogURL.deletingLastPathComponent()
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let data = try Data(contentsOf: url)
            let catalog = try ModuleCatalog.decode(data)
            catalogURL = url
            UserDefaults.standard.set(url.path, forKey: Self.catalogPathKey)
            modules = catalog.modules
            error = nil
        } catch {
            self.error = "Could not load modules: \(error.localizedDescription)"
        }
    }

    func revealCatalog() {
        NSWorkspace.shared.activateFileViewerSelecting([catalogURL])
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
        window.tab.title = document.module.title
        let launch = launches.removeValue(forKey: document.id)
        // Explicit New Window must not be auto-tabbed by the system preference.
        window.tabbingMode = launch == nil ? .automatic : .disallowed
        if launch?.destination == .tab, let parent = launch?.parent, parent !== window {
            // SwiftUI creates every document at defaultSize. Match the existing
            // window before AppKit (and accessibility-based window managers) sees
            // the new tab, rather than letting that default resize the group.
            window.setFrame(parent.frame, display: false)
            window.title = parent.title
            window.subtitle = parent.subtitle
        }
        DispatchQueue.main.async { [weak window] in
            guard let window else { return }
            if launch?.destination == .tab, let parent = launch?.parent, parent !== window {
                // Use the latest frame: the window manager may have tiled the
                // parent between document creation and this attachment callback.
                window.setFrame(parent.frame, display: false)
                parent.addTabbedWindow(window, ordered: .above)
                window.makeKeyAndOrderFront(nil)
            }
            window.tabbingMode = .automatic
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
