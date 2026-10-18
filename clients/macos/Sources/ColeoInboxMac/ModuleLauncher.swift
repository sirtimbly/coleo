import ColeoInboxCore
import SwiftUI

/// The menu bar and native tab-plus panel share the same file-backed module catalog.
struct ModuleCommands: Commands {
    @ObservedObject var workspace: WorkbenchWorkspace
    @Environment(\.openWindow) private var openWindow
    @FocusedValue(\.workbenchModule) private var currentModule

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Window") { launchCurrent(.window) }
                .keyboardShortcut("n", modifiers: .command)
            Button("New Tab") { launchCurrent(.tab) }
                .keyboardShortcut("t", modifiers: .command)
        }
        CommandMenu("Modules") {
            ForEach(workspace.modules) { module in
                Button { workspace.launch(module, in: .tab, using: openWindow) } label: {
                    Label(module.title, systemImage: module.symbol)
                }
            }
            Divider()
            Menu("Open in New Window") {
                ForEach(workspace.modules) { module in
                    Button(module.title) { workspace.launch(module, in: .window, using: openWindow) }
                }
            }
            Divider()
            Button("Choose Module Catalog…") { workspace.importCatalog() }
            Button("Reload Module Catalog") { workspace.reloadCatalog() }
            Button("Show Module Catalog in Finder") { workspace.revealCatalog() }
        }
    }

    private func launchCurrent(_ destination: ModuleDestination) {
        workspace.launch(currentModule ?? workspace.modules.first ?? .inbox, in: destination, using: openWindow)
    }
}

/// A compact native popover, with one explicit launch destination for all rows.
struct ModuleLauncherPanel: View {
    let modules: [WorkbenchModule]
    let onLaunch: (WorkbenchModule, ModuleDestination) -> Void
    @State private var search = ""
    @State private var destination: ModuleDestination = .tab

    private var results: [WorkbenchModule] {
        modules.filter { search.isEmpty || "\($0.title) \($0.description)".localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Open a module").font(.headline)
            TextField("Find a module", text: $search)
                .textFieldStyle(.roundedBorder)
                .onSubmit { if let first = results.first { onLaunch(first, destination) } }
            Picker("Open in", selection: $destination) {
                ForEach(ModuleDestination.allCases) { destination in
                    Text("New \(destination.rawValue)").tag(destination)
                }
            }
            .pickerStyle(.segmented)
            Divider()
            ScrollView {
                VStack(spacing: 2) {
                    ForEach(results) { module in
                        Button { onLaunch(module, destination) } label: {
                            HStack(spacing: 12) {
                                Image(systemName: module.symbol).foregroundStyle(Color.accentColor)
                                    .font(.title3).frame(width: 26)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(module.title).font(.body).fontWeight(.medium)
                                    Text(module.description).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 0)
                                Image(systemName: destination == .tab ? "plus.rectangle.on.rectangle" : "macwindow.badge.plus")
                                    .foregroundStyle(.secondary).font(.caption)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading).padding(8)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Open \(module.title) in a new \(destination.rawValue.lowercased())")
                    }
                    if results.isEmpty {
                        Text("No matching modules").foregroundStyle(.secondary).padding(.vertical, 24)
                    }
                }
            }
            .frame(maxHeight: 330)
            Text("Drag a tab out to make a window. Use Window → Merge All Windows to bring them together.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(16).frame(width: 340)
    }
}
