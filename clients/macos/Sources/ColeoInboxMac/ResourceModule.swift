import ColeoInboxCore
import SwiftUI

/// Host for real domain modules, separate from the Inbox's facet projections.
struct ResourceModule: View {
    @EnvironmentObject private var workspace: WorkbenchWorkspace
    @StateObject private var session: ResourceModuleSession
    @State private var sidebarVisible = true
    @FocusState private var searchFocused: Bool
    let document: ModuleDocument

    init(document: ModuleDocument) {
        self.document = document
        _session = StateObject(wrappedValue: ResourceModuleSession(module: document.module))
    }

    var body: some View {
        VStack(spacing: 0) {
            ModuleControlBar {
                if session.isCollection { ModuleSidebarToggle(isVisible: $sidebarVisible) }
                Button { session.reload() } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .keyboardShortcut("r", modifiers: .command).help("Refresh \(document.module.title)")
                Spacer()
                if session.isCollection {
                    TextField("Search \(document.module.title.lowercased())", text: $session.search)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 220)
                        .focused($searchFocused)
                        .onSubmit { session.reload(reset: true) }
                    Button { searchFocused = true } label: { Label("Find", systemImage: "magnifyingglass") }
                        .labelStyle(.iconOnly).keyboardShortcut("f", modifiers: .command)
                }
            }
            Divider()
            if session.isCollection { collection }
            else { ModuleOverview(session: session) }
        }
        .background(WorkbenchWindowBridge(workspace: workspace, document: document, onClose: session.stop))
        .safeAreaInset(edge: .bottom, spacing: 0) { statusBar }
        .task { session.start() }
        .onReceive(NotificationCenter.default.publisher(for: .inboxSettingsChanged)) { _ in session.reconnect() }
    }

    private var collection: some View {
        HSplitView {
            if sidebarVisible {
            List(selection: Binding<String?>(get: { session.status }, set: { value in
                if let value { session.status = value; session.reload(reset: true) }
            })) {
                Section("Status") {
                    Label("All \(document.module.title.lowercased())", systemImage: document.module.symbol).tag("all")
                    ForEach(session.statuses, id: \.self) { status in
                        Text(status.replacingOccurrences(of: "_", with: " ").capitalized).tag(status)
                    }
                }
            }
            .listStyle(.sidebar)
            .frame(minWidth: 150, idealWidth: 150, maxWidth: 240)
            }
            VStack(spacing: 0) {
                    Table(session.records, selection: $session.focusID) {
                        TableColumn("Title", value: \.title).width(min: 180, ideal: 280)
                        TableColumn("Status") { record in
                            Text(record.status.replacingOccurrences(of: "_", with: " ").capitalized)
                        }.width(min: 80, ideal: 100)
                        TableColumn("Priority") { record in Text(record.priority.capitalized) }.width(70)
                        TableColumn("Assigned to", value: \.owner).width(min: 80, ideal: 120)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .overlay {
                        if session.records.isEmpty {
                            ContentUnavailableView(session.isLoading ? "Loading…" : "No \(document.module.title.lowercased())",
                                systemImage: document.module.symbol,
                                description: Text(session.error ?? "Try another status or search."))
                        }
                    }
            }
            .frame(minWidth: 300, idealWidth: 640, maxWidth: .infinity, maxHeight: .infinity)
            .background(ModuleColumnDefaults(sidebarWidth: 150, collectionWidth: 640,
                                             sidebarVisible: sidebarVisible))
            recordDetail.frame(minWidth: 280, idealWidth: 360, maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onChange(of: session.search) { old, new in
            if !old.isEmpty, new.isEmpty { session.reload(reset: true) }
        }
        .task(id: session.focusID) { await session.loadDetail() }
    }

    @ViewBuilder
    private var recordDetail: some View {
        if let detail = session.detail {
            VStack(spacing: 0) {
                if let error = session.detailError {
                    Label("Detail refresh failed; showing previous content. \(error)", systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.red).padding(12)
                }
                DetailCardsView(cards: [detail.card])
            }
        } else if let error = session.detailError {
            ContentUnavailableView {
                Label("Detail unavailable", systemImage: "exclamationmark.triangle")
            } description: { Text(error) } actions: {
                Button("Retry") { Task { await session.loadDetail() } }
            }
        } else if session.focusID != nil {
            ProgressView("Loading detail…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ContentUnavailableView("No item selected", systemImage: "doc.text.magnifyingglass",
                description: Text("Select a row to inspect its full details."))
        }
    }

    private var statusBar: some View {
        VStack(alignment: .leading, spacing: 4) {
            Divider()
            HStack(spacing: 8) {
                if session.isLoading { ProgressView().controlSize(.mini) }
                if session.isCollection { Text("\(session.records.count) of \(session.total) loaded") }
                if session.isCollection, session.records.count < session.total {
                    Button("Load more") { session.loadMore() }.controlSize(.small).disabled(session.isLoading)
                }
                Spacer()
                if let updated = session.updatedAt {
                    Text("Updated \(updated.formatted(date: .omitted, time: .shortened)) · Refreshes every 15s")
                }
            }
            if let error = session.error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.red).textSelection(.enabled)
                if !session.records.isEmpty { Text("Showing the last successful snapshot.") }
            }
        }
        .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 12).padding(.bottom, 8)
        .background(.bar)
    }
}
