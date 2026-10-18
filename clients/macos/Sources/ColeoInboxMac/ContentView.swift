import ColeoInboxCore
import SwiftUI

/// Navigation, toolbar actions, presentations, fields, and shortcuts come from the
/// API-resolved named view (`client=native`), the same definition the Python
/// Textual client consumes as `client=tui`. Unknown widgets render an explicit
/// unsupported diagnostic instead of being silently dropped.
struct ContentView: View {
    @EnvironmentObject private var session: InboxSession
    @State private var searchDraft = ""
    @State private var showHelp = false
    @State private var sidebarVisible = true
    @FocusState private var searchFocused: Bool

    var body: some View {
        ZStack {
            if let view = session.view {
                VStack(spacing: 0) {
                    ModuleControlBar {
                        ModuleSidebarToggle(isVisible: $sidebarVisible)
                        windowToolbar(view)
                    }
                    Divider()
                    HSplitView {
                        if sidebarVisible {
                            sidebar(view).frame(minWidth: 160, idealWidth: 160, maxWidth: 260)
                        }
                        collectionColumn(view)
                            .frame(minWidth: 300, idealWidth: collectionWidth(view), maxWidth: .infinity, maxHeight: .infinity)
                            .background(ModuleColumnDefaults(sidebarWidth: 160,
                                collectionWidth: collectionWidth(view), sidebarVisible: sidebarVisible))
                            .background(CollectionKeyboard(enabled: !showHelp && !searchFocused) { key, modifiers in
                                handleKey(key, modifiers: modifiers, view: view)
                            })
                        detailColumn
                            .frame(minWidth: 280, idealWidth: 400, maxWidth: .infinity, maxHeight: .infinity)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                VStack(spacing: 12) {
                    ModuleControlBar { Spacer() }
                    Spacer()
                    ProgressView()
                    Text(session.error ?? "Loading \(session.module.title)…")
                        .foregroundStyle(session.error == nil ? Color.secondary : Color.red)
                    if session.error != nil {
                        Button("Retry") { Task { await session.bootstrap() } }
                    }
                    Spacer()
                }
                .padding()
            }
        }
        .sheet(isPresented: $showHelp) { helpView }
        .focusedSceneValue(\.workbenchActions, WorkbenchActions(
            refresh: { session.scheduleRefresh() },
            find: { searchFocused = true },
            toggleSidebar: { sidebarVisible.toggle() },
            help: { showHelp = true },
            markRead: !session.selection.isEmpty && session.complete && session.view?.commands.contains("inbox.mark-read") == true
                ? { Task { await session.markRead() } } : nil,
            selectBranch: session.focusID != nil ? { toggleFocusedBranch() } : nil))
        .onChange(of: session.focusID) { _, id in
            guard let row = session.rows.first(where: { $0.id == id }) else {
                session.clearDetail()
                return
            }
            Task { await session.openDetail(row) }
        }
    }

    // MARK: Collection column

    private func collectionWidth(_ view: ResolvedView) -> CGFloat {
        let kind = view.renderers.first { $0.id == session.presentation }?.kind
        return kind == "grid" || kind == "table" ? 640 : 340
    }

    private func collectionColumn(_ view: ResolvedView) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text(session.query.facet == "all" ? "All items" : session.query.facet.capitalized)
                    .font(.headline)
                Spacer()
                if session.isLoading { ProgressView().controlSize(.small) }
                Text("\(session.rows.count.formatted()) loaded").foregroundStyle(.secondary)
            }
            .padding(12)
            Divider()
            presentationView(view)
                .overlay {
                    if session.rows.isEmpty {
                        ContentUnavailableView(session.isLoading ? "Loading inbox…" : "No items",
                                               systemImage: "tray",
                                               description: Text("Items for this view will appear here."))
                    }
                }
            if session.nextCursor != nil {
                Button("Load more") { session.loadMore() }
                    .disabled(session.isLoading)
                    .padding(8)
            }
            Divider()
            statusBar
        }
    }

    private func controls(_ view: ResolvedView) -> [ViewControl] { view.slots.flatMap(\.controls) }

    private func identity(_ view: ResolvedView) -> String {
        controls(view).first { $0.widget == "resource.identity" }?.label ?? "Coleo Inbox"
    }

    private func sidebar(_ view: ResolvedView) -> some View {
        List(selection: Binding<String?>(get: { session.query.facet }, set: { value in
            if let value { session.changeQuery { $0.facet = value } }
        })) {
            if let facet = controls(view).first(where: { $0.widget == "inbox.facet" }) {
                Section(facet.label) {
                    ForEach(choices(forBinding: "query.facet", view: view), id: \.self) { facet in
                        Label(facet == "all" ? "All items" : facet.capitalized, systemImage: facetSymbol(facet))
                            .tag(facet)
                    }
                }
            }
            if session.query.facet == "messages" || session.query.facet == "brain" {
                Section("Filters") { uncoveredQueryPickers(view) }
            }
            if controls(view).contains(where: { $0.widget == "collection.count" }) {
                Section("This view") {
                    summaryRow("Total", value: session.summaries?.total)
                    summaryRow("Unread", value: session.summaries?.unread)
                    summaryRow("Needs action", value: session.summaries?.requiresAction)
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            HStack {
                Image(systemName: "server.rack")
                Text(session.baseURL.host ?? "Coleo").lineLimit(1)
                Spacer()
                SettingsLink { Image(systemName: "gearshape") }.buttonStyle(.plain)
                    .help("Connection settings")
            }
            .font(.caption).foregroundStyle(.secondary).padding(12)
        }
    }

    private func facetSymbol(_ facet: String) -> String {
        switch facet {
        case "all": return "tray.full"
        case "messages": return "envelope"
        case "brain": return "brain"
        case "arms": return "bolt.horizontal.circle"
        case "attention": return "flag"
        case "history": return "clock"
        default: return "tray"
        }
    }

    private func summaryRow(_ label: String, value: Int?) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text(value?.formatted() ?? "—").monospacedDigit()
        }
        .font(.caption).foregroundStyle(.secondary)
    }

    @ViewBuilder
    private func windowToolbar(_ view: ResolvedView) -> some View {
        Group {
            ForEach(controls(view).filter { $0.command != nil }) { control in
                if let command = control.command { commandButton(control, command: command, view: view) }
            }
        }
        Group {
            Menu {
                ForEach(controls(view).filter {
                    ["collection.sort", "collection.presentation", "collection.insights"].contains($0.widget)
                }) { control in controlView(control, view: view) }
                Divider()
                ForEach(controls(view).filter {
                    $0.command == nil && !["resource.identity", "inbox.facet", "collection.search",
                        "collection.count", "collection.selection", "collection.sort",
                        "collection.presentation", "collection.insights"].contains($0.widget)
                }) { control in unsupported(control) }
                Button("Keyboard Shortcuts") { showHelp = true }
            } label: { Label("View options", systemImage: "slider.horizontal.3") }
            .help("Presentation, sort order, and metadata")
        }
        Spacer(minLength: 8)
        Group {
            if let search = controls(view).first(where: { $0.widget == "collection.search" }) {
                HStack(spacing: 5) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField(search.label, text: $searchDraft)
                        .textFieldStyle(.plain).focused($searchFocused)
                        .onSubmit { session.changeQuery { $0.search = searchDraft } }
                        .onAppear { searchDraft = session.query.search }
                    if !searchDraft.isEmpty {
                        Button { searchDraft = ""; session.changeQuery { $0.search = "" } } label: {
                            Image(systemName: "xmark.circle.fill")
                        }.buttonStyle(.plain).help("Clear search")
                    }
                }
                .padding(6).frame(width: 180)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
            }
        }
    }

    @ViewBuilder
    private func controlView(_ control: ViewControl, view: ResolvedView) -> some View {
        switch control.widget {
        case "resource.identity":
            Text(control.label).font(.headline)
        case "collection.search":
            HStack {
                TextField(control.label, text: $searchDraft)
                    .textFieldStyle(.roundedBorder)
                    .frame(minWidth: 140, maxWidth: 280)
                    .focused($searchFocused)
                    .onSubmit { session.changeQuery { $0.search = searchDraft } }
                    .onAppear { searchDraft = session.query.search }
                if !searchDraft.isEmpty {
                    Button("Clear") { searchDraft = ""; session.changeQuery { $0.search = "" } }
                }
            }
        case "inbox.facet":
            picker(label: control.label, choices: choices(forBinding: "query.facet", view: view),
                   value: session.query.facet) { value in session.changeQuery { $0.facet = value } }
        case "collection.sort":
            picker(label: control.label, choices: choices(forBinding: "query.sort.direction", view: view),
                   value: session.query.sortDirection) { value in session.changeQuery { $0.sortDirection = value } }
        case "collection.presentation":
            Picker(control.label, selection: Binding(get: { session.presentation }, set: { session.setPresentation($0) })) {
                ForEach(view.renderers) { renderer in Text(renderer.label).tag(renderer.id) }
            }
            .pickerStyle(.menu)
            .frame(maxWidth: 190)
        case "collection.count":
            Text(countText).font(.callout).foregroundStyle(.secondary)
        case "collection.selection":
            HStack {
                Text("\(session.selection.count) selected").font(.callout)
                if !session.selection.isEmpty {
                    Button("Clear") { session.selection.clear() }
                }
            }
        case "collection.insights":
            Toggle(control.label, isOn: Binding(get: { session.metadataVisible }, set: { session.metadataVisible = $0 })).toggleStyle(.switch).controlSize(.small)
        default:
            if let command = control.command { commandButton(control, command: command, view: view) } else { unsupported(control) }
        }
    }

    @ViewBuilder
    private func commandButton(_ control: ViewControl, command: String, view: ResolvedView) -> some View {
        switch command {
        case "inbox.refresh":
            Button { session.scheduleRefresh() } label: { Label(control.label, systemImage: "arrow.clockwise") }
                .help("\(control.label) (⌘R)")
        case "inbox.mark-read":
            Button { Task { await session.markRead() } } label: { Label(control.label, systemImage: "envelope.open") }
                .help("\(control.label) (⇧⌘R)")
                .disabled(session.selection.isEmpty || !session.complete)
        default:
            unsupported(control)
        }
    }

    private func unsupported(_ control: ViewControl) -> some View {
        Label("Unsupported: \(control.widget)", systemImage: "exclamationmark.triangle")
            .font(.caption)
            .foregroundStyle(.orange)
    }

    /// Mailbox/Brain-category are declared as interaction bindings, not toolbar
    /// slots; the TUI exposes them as native selects, so the native client does too.
    private func uncoveredQueryPickers(_ view: ResolvedView) -> some View {
        Group {
            if session.query.facet == "messages", view.binding(forOperation: "inbox.mailbox")?.available == true {
                picker(label: "Mailbox", choices: choices(forBinding: "query.mailbox", view: view),
                       value: session.query.mailbox) { value in session.changeQuery { $0.mailbox = value } }
                    .disabled(session.query.facet != "messages")
            }
            if session.query.facet == "brain", view.binding(forOperation: "inbox.brain-category")?.available == true {
                picker(label: "Category", choices: choices(forBinding: "query.brainCategory", view: view),
                       value: session.query.brainCategory) { value in session.changeQuery { $0.brainCategory = value } }
                    .disabled(session.query.facet != "brain")
            }
        }
    }

    private func picker(label: String, choices: [String], value: String, onChange: @escaping (String) -> Void) -> some View {
        Picker(label, selection: Binding(get: { value }, set: onChange)) {
            ForEach(choices, id: \.self) { Text($0.capitalized).tag($0) }
        }
        .pickerStyle(.menu)
        .frame(maxWidth: 170)
    }

    private func choices(forBinding name: String, view: ResolvedView) -> [String] {
        view.bindings.first { $0.binding == name }?.choices ?? []
    }

    private var countText: String {
        guard let summaries = session.summaries else { return "…" }
        func count(_ value: Int?) -> String { value.map(String.init) ?? "unknown" }
        return "\(count(summaries.total)) total · \(count(summaries.unread)) unread · \(count(summaries.requiresAction)) action"
    }

    private var statusBar: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Circle().fill(session.connection.hasPrefix("live") ? Color.green : Color.orange).frame(width: 8, height: 8)
                Text(session.connection.hasPrefix("live") ? "Live" : "Reconnecting…")
                    .help(session.connection).lineLimit(1)
                if !session.complete { Label("Partial data", systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
                Spacer()
                Button("Select All") { session.selectAll() }
                    .buttonStyle(.borderless)
                    .disabled(!session.complete || session.items.isEmpty)
                    .help("Select all loaded items, including collapsed threads (⌘A). Unloaded pages are not selected.")
                if !session.selection.isEmpty {
                    Text("\(session.selection.count) selected").lineLimit(1)
                    Button("Clear") { session.selection.clear() }.buttonStyle(.borderless)
                }
            }
            if let error = session.error {
                Text(error).font(.caption).foregroundStyle(.red).lineLimit(2)
            }
            ForEach(session.diagnostics, id: \.self) { note in
                Text(note).font(.caption).foregroundStyle(.orange).lineLimit(1)
            }
        }
        .font(.caption)
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
    }

    private func metadataPanel(_ view: ResolvedView) -> some View {
        let panel = view.insightPanels.first
        return GroupBox(panel?.label ?? "Metadata") {
            VStack(alignment: .leading) {
                Text(countText)
                ForEach(session.sources) { source in
                    Text("\(source.id): \(source.status) / \(source.complete ? "complete" : "incomplete") (as of \(formatAge(source.asOf)))")
                }
            }
            .font(.caption)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 8)
    }

    // MARK: Presentations (fields come from the active renderer definition)

    @ViewBuilder
    private func presentationView(_ view: ResolvedView) -> some View {
        let renderer = view.renderers.first { $0.id == session.presentation }
        let fields = renderer?.fields ?? ["title"]
        Group {
            switch renderer?.kind {
            case "cards":
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(session.rows) { row in cardRow(row, fields: fields) }
                    }
                    .padding(8)
                }
            case "custom": // messaging.timeline
                List(session.rows, selection: $session.focusID) { row in
                    HStack(alignment: .top) {
                        Text(formatAge(row.timestamp)).font(.caption).frame(width: 44, alignment: .trailing)
                        Circle().fill(row.requiresAction ? Color.red : Color.secondary).frame(width: 7, height: 7).padding(.top, 5)
                        rowContent(row, fields: fields)
                    }
                    .tag(row.id)
                    .contextMenu { rowMenu(row) }
                    .onTapGesture(count: 2) { Task { await session.openDetail(row) } }
                }
            default: // grid
                List(session.rows, selection: Binding(get: { session.focusID }, set: { session.focusID = $0 })) { row in
                    rowContent(row, fields: fields)
                        .tag(row.id)
                        .contextMenu { rowMenu(row) }
                        .onTapGesture(count: 2) { Task { await session.openDetail(row) } }
                }
            }
        }
        .listStyle(.inset)
    }

    private func cardRow(_ row: CollectionRow, fields: [String]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                selectionToggle(row)
                if fields.contains("source"), let source = row.source {
                    CardCreator(name: source)
                    Text(source).font(.caption).fontWeight(.semibold).lineLimit(1)
                }
                Spacer()
                if row.hasChildren { foldButton(row) }
            }
            .padding(10)
            .background(Color(nsColor: .controlBackgroundColor))
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                ForEach(fields.filter { $0 != "source" }, id: \.self) { field in
                    fieldView(field, row: row, prominent: field == "title")
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(nsColor: .textBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(
            session.focusID == row.id ? Color.accentColor : Color(nsColor: .separatorColor), lineWidth: 1))
        .padding(.leading, CGFloat(row.depth) * 14)
        .onTapGesture { session.focusID = row.id }
        .onTapGesture(count: 2) { Task { await session.openDetail(row) } }
        .contextMenu { rowMenu(row) }
    }

    private func rowContent(_ row: CollectionRow, fields: [String]) -> some View {
        HStack(alignment: .top, spacing: 8) {
            selectionToggle(row)
                .padding(.top, 2)
            if row.hasChildren { foldButton(row) }
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    if fields.contains("title") {
                        Text(row.title).font(.body).fontWeight(row.unread ? .semibold : .regular).lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    if fields.contains("timestamp") {
                        Text(formatAge(row.timestamp)).font(.caption).foregroundStyle(.secondary).fixedSize()
                    }
                }
                ForEach(fields.filter { !["title", "timestamp", "unread", "requiresAction"].contains($0) }, id: \.self) { field in
                    fieldView(field, row: row, prominent: false)
                }
                if (fields.contains("unread") && row.unread) || (fields.contains("requiresAction") && row.requiresAction) {
                    HStack(spacing: 10) {
                        if fields.contains("unread"), row.unread {
                            Label("Unread", systemImage: "circle.fill").foregroundStyle(Color.accentColor)
                        }
                        if fields.contains("requiresAction"), row.requiresAction {
                            Label("Needs action", systemImage: "flag").foregroundStyle(.secondary)
                        }
                    }
                    .font(.caption2)
                }
            }
        }
        .padding(.vertical, 5)
        .padding(.leading, CGFloat(row.depth) * 14)
    }

    @ViewBuilder
    private func fieldView(_ field: String, row: CollectionRow, prominent: Bool) -> some View {
        switch field {
        case "title": Text(row.title).font(prominent ? .headline : .body).lineLimit(2)
        case "summary": if !row.summary.isEmpty { Text(row.summary).font(.callout).foregroundStyle(.secondary).lineLimit(3) }
        case "source": if let source = row.source { Text(source).font(.caption).foregroundStyle(.secondary) }
        case "timestamp": Text(formatAge(row.timestamp)).font(.caption).foregroundStyle(.secondary)
        case "unread": if row.unread { Text("Unread").font(.caption) }
        case "requiresAction": if row.requiresAction { Text("Needs action").font(.caption).foregroundStyle(.red) }
        default: Text("Unsupported field: \(field)").font(.caption).foregroundStyle(.orange)
        }
    }

    private func rowState(_ row: CollectionRow) -> String {
        row.requiresAction ? "ACTION" : row.unread ? "unread" : "read"
    }

    private func selectionToggle(_ row: CollectionRow) -> some View {
        Button {
            session.toggleSelection(row)
        } label: {
            Image(systemName: session.isSelected(row) ? "checkmark.square.fill" : "square")
        }
        .buttonStyle(.plain)
        .disabled(!row.selectable || !session.complete)
        .accessibilityLabel("\(session.isSelected(row) ? "Deselect" : "Select") \(row.title)")
        .help("Select (Space)")
    }

    private func foldButton(_ row: CollectionRow) -> some View {
        Button { session.toggleFold(row) } label: {
            Image(systemName: session.folded.contains(row.id) ? "chevron.right" : "chevron.down")
        }
        .buttonStyle(.plain)
        .help("Collapse/expand branch (←/→)")
    }

    @ViewBuilder
    private func rowMenu(_ row: CollectionRow) -> some View {
        Button("Open") { Task { await session.openDetail(row) } }
        Button(session.isSelected(row) ? "Deselect" : "Select") { session.toggleSelection(row) }
        Button("Select loaded branch") { session.toggleSelection(row, branch: true) }
        Button("Mark selection read") { Task { await session.markRead() } }
            .disabled(session.selection.isEmpty || !session.complete)
    }

    // MARK: Detail

    private var detailColumn: some View {
        VStack(spacing: 0) {
            if session.metadataVisible, let view = session.view {
                metadataPanel(view).padding(.vertical, 12)
                Divider()
            }
            if !session.detailCards.isEmpty {
                DetailCardsView(cards: session.detailCards)
            } else if let text = session.detailText {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if let title = session.detailTitle {
                            Text(title).font(.title2).fontWeight(.semibold).textSelection(.enabled)
                        }
                        Divider()
                        DetailDocument(text: text)
                    }
                    .padding(24)
                    .frame(maxWidth: 760, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
            } else {
                ContentUnavailableView("No item selected", systemImage: "doc.text.magnifyingglass",
                                       description: Text("Select an item to read its full content."))
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
    }

    // MARK: Keyboard (driven by resolved bindings, not hard-coded operations)

    private func toggleFocusedBranch() {
        if let row = session.rows.first(where: { $0.id == session.focusID }) { session.toggleSelection(row, branch: true) }
    }

    private func handleKey(_ key: String, modifiers: Set<String>, view: ResolvedView) -> Bool {
        if key.lowercased() == "a", modifiers == ["command"] {
            session.selectAll()
            return true
        }
        let tree = view.renderers.first { $0.id == session.presentation }?.kind != "grid"
        guard let operation = keyboardOperation(bindings: view.bindings, key: key, modifiers: modifiers, tree: tree) else { return false }
        let indexed = session.rows.firstIndex { $0.id == session.focusID }
        switch operation {
        case "collection.next":
            let next = indexed.map { $0 + 1 } ?? 0
            if next < session.rows.count { session.focusID = session.rows[next].id }
        case "collection.previous":
            let previous = indexed.map { max(0, $0 - 1) } ?? 0
            if previous < session.rows.count { session.focusID = session.rows[previous].id }
        case "collection.select":
            if let row = session.rows.first(where: { $0.id == session.focusID }) { session.toggleSelection(row) }
        case "collection.select-branch": toggleFocusedBranch()
        case "collection.refresh": session.scheduleRefresh()
        case "collection.search": searchFocused = true
        case "collection.help": showHelp = true
        case "collection.open":
            if let row = session.rows.first(where: { $0.id == session.focusID }) { Task { await session.openDetail(row) } }
        case "collection.collapse", "collection.expand":
            if let row = session.rows.first(where: { $0.id == session.focusID }), row.hasChildren {
                let shouldFold = operation == "collection.collapse"
                if session.folded.contains(row.id) != shouldFold { session.toggleFold(row) }
            }
        default: return false
        }
        return true
    }

    // MARK: Help (generated from resolved bindings)

    private var helpView: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Keyboard").font(.headline)
            Text("⌘F Find · ⌘R Refresh · ⇧⌘R Mark read · ⇧⌘B Select branch · ⌃⌘S Sidebar · ⇧⌘/ Help")
                .font(.caption)
            if let view = session.view {
                ForEach(view.bindings) { binding in
                    HStack {
                        Text(binding.keyboard.map(\.display).joined(separator: ", "))
                            .font(.system(.caption, design: .monospaced))
                            .frame(width: 110, alignment: .leading)
                        Text("\(binding.label) — \(binding.operation)")
                        if !binding.available {
                            Text(binding.diagnostic ?? "unavailable").foregroundStyle(.orange)
                        }
                    }
                    .font(.caption)
                }
            }
            Text("Select a row to read it · checkbox/Space selects for actions · branch selection is in the context menu. Selection freezes IDs and thread revision; new replies stay unselected.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(countText).font(.caption)
            Button("Close") { showHelp = false }.keyboardShortcut(.cancelAction)
        }
        .padding()
        .frame(minWidth: 520)
    }
}
