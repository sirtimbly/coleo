import AppKit
import ColeoInboxCore
import SwiftUI

/// Each native window/tab owns its query, selection, and live subscription.
@main
struct ColeoInboxApp: App {
    @StateObject private var workspace = WorkbenchWorkspace()

    init() { NSWindow.allowsAutomaticWindowTabbing = true }

    var body: some Scene {
        WindowGroup("Coleo Workbench", id: "workbench", for: ModuleDocument.self) { $document in
            ModuleWindow(document: document)
                .environmentObject(workspace)
        } defaultValue: {
            ModuleDocument(module: .inbox)
        }
        .defaultSize(width: 1180, height: 760)
        .windowStyle(.titleBar)
        .commands {
            ModuleCommands(workspace: workspace)
            WorkbenchKeyboardCommands()
        }
        Settings {
            SettingsView()
        }
    }
}

private struct ModuleWindow: View {
    @EnvironmentObject private var workspace: WorkbenchWorkspace
    let document: ModuleDocument

    var body: some View {
        Group {
            switch document.module.renderer {
            case "messaging": InboxModule(document: document)
            case "tasks", "bugs", "brain", "dashboard": ResourceModule(document: document)
            default:
                ContentUnavailableView("Module unavailable", systemImage: "exclamationmark.triangle",
                    description: Text("Unsupported renderer: \(document.module.renderer)"))
            }
        }
            .frame(minWidth: 860, minHeight: 480)
            .focusedSceneValue(\.workbenchModule, document.module)
            .alert("Module catalog unavailable", isPresented: Binding(
                get: { workspace.error != nil }, set: { if !$0 { workspace.error = nil } })) {
                Button("OK") { workspace.error = nil }
            } message: { Text(workspace.error ?? "") }
    }
}

private struct InboxModule: View {
    @EnvironmentObject private var workspace: WorkbenchWorkspace
    @StateObject private var session: InboxSession
    let document: ModuleDocument

    init(document: ModuleDocument) {
        self.document = document
        _session = StateObject(wrappedValue: InboxSession(module: document.module))
    }

    var body: some View {
        ContentView()
            .environmentObject(session)
            .background(WorkbenchWindowBridge(workspace: workspace, document: document, onClose: session.stop))
            .task {
                if session.view == nil {
                    await session.bootstrap()
                } else {
                    session.startLive()
                    session.scheduleRefresh()
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .inboxSettingsChanged)) { _ in
                let settings = InboxSettings.load()
                session.applySettings(url: settings.url, key: settings.key)
            }
    }
}

extension Notification.Name {
    static let inboxSettingsChanged = Notification.Name("coleo.inboxSettingsChanged")
}

/// Standard macOS Settings scene shared by every workbench window.
struct SettingsView: View {
    @State private var urlText = ""
    @State private var keyText = ""

    var body: some View {
        Form {
            TextField("API URL", text: $urlText)
                .textFieldStyle(.roundedBorder)
            SecureField("API key (X-API-Key)", text: $keyText)
            Text("Environment variables COLEO_API_URL / COLEO_API_KEY take precedence at launch. "
                 + "The key is stored in UserDefaults for this development build; move it to the Keychain before distribution.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button("Save and reconnect") {
                if let url = URL(string: urlText) {
                    InboxSettings.save(url: url, key: keyText)
                    NotificationCenter.default.post(name: .inboxSettingsChanged, object: nil)
                }
            }
        }
        .padding()
        .frame(width: 420)
        .onAppear {
            let settings = InboxSettings.load()
            urlText = settings.url.absoluteString
            keyText = settings.key
        }
    }
}
