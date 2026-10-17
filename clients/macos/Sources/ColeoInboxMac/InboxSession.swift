import ColeoInboxCore
import Foundation

/// One ordered refresh lane; hint bursts coalesce, generations reject obsolete
/// reads, socket-only reconnect recovers through HTTP. Port of `session.py`.
@MainActor
final class InboxSession: ObservableObject {
    let module: WorkbenchModule
    @Published var view: ResolvedView?
    @Published var query = MessagingQuery()
    @Published var presentation = "grid"
    @Published var items: [InboxItem] = []
    @Published var rows: [CollectionRow] = []
    @Published var focusID: String?
    @Published var selection = SelectionState()
    @Published var folded: Set<String> = []
    @Published var summaries: Summaries?
    @Published var sources: [SourceStatus] = []
    @Published var diagnostics: [String] = []
    @Published var complete = true
    @Published var nextCursor: String?
    @Published var connection = "connecting"
    @Published var error: String?
    @Published var detailText: String?
    @Published var detailTitle: String?
    @Published var detailCards: [DetailCard] = []
    @Published var metadataVisible = false
    @Published var isLoading = false

    var api: InboxAPI
    var apiKey: String
    var baseURL: URL
    private var generation = 0
    private var pagesLoaded = 1
    private var initializedThreads = Set<String>()
    private var refreshTask: Task<Void, Never>?
    private var liveTask: Task<Void, Never>?
    private var writeInFlight = false
    private var detailRequest = UUID()

    init(module: WorkbenchModule = .inbox) {
        self.module = module
        let env = InboxSettings.load()
        baseURL = env.url
        apiKey = env.key
        api = InboxAPI(transport: URLSessionTransport(baseURL: env.url, apiKey: env.key))
    }

    func applySettings(url: URL, key: String) {
        stop()
        baseURL = url
        apiKey = key
        api = InboxAPI(transport: URLSessionTransport(baseURL: url, apiKey: key))
        InboxSettings.save(url: url, key: key)
        generation += 1
        items = []
        rows = []
        focusID = nil
        detailRequest = UUID()
        detailTitle = nil
        detailText = nil
        detailCards = []
        selection.clear()
        Task { await bootstrap() }
    }

    func bootstrap() async {
        do {
            guard let namedView = module.namedView else { throw ContractError.invalid("No named messaging view") }
            let resolved = try await api.namedView(id: namedView, client: "native")
            guard !Task.isCancelled else { return }
            let initialQuery = try module.initialQuery(from: resolved.query)
            let initialPresentation = module.presentation ?? resolved.activePresentation
            guard resolved.renderers.contains(where: { $0.id == initialPresentation }) else {
                throw ContractError.invalid("Presentation \(initialPresentation) is not available in \(namedView)")
            }
            view = resolved
            query = initialQuery
            presentation = initialPresentation
            await refresh(resetPages: true)
            startLive()
        } catch {
            self.error = "Could not load \(module.title): \(error.localizedDescription)"
            connection = "unavailable"
        }
    }

    // MARK: Query

    func changeQuery(_ mutate: (inout MessagingQuery) -> Void) {
        var next = query
        mutate(&next)
        next = next.normalized
        guard next != query else { return }
        query = next
        pagesLoaded = 1
        selection.clear()
        folded = []
        initializedThreads = []
        items = []
        rows = []
        focusID = nil
        detailRequest = UUID()
        detailTitle = nil
        detailText = nil
        detailCards = []
        generation += 1
        scheduleRefresh()
    }

    func setPresentation(_ id: String) {
        presentation = id
        rebuildRows()
    }

    // MARK: Refresh lane

    func scheduleRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 120_000_000) // coalesce bursts, as in session.py
            guard !Task.isCancelled else { return }
            await self?.refresh(resetPages: false)
        }
    }

    func refresh(resetPages: Bool) async {
        if resetPages { pagesLoaded = 1 }
        let currentGeneration = generation
        let currentQuery = query
        isLoading = true
        defer { isLoading = false }
        do {
            var loaded: [InboxPage] = []
            var cursor: String?
            var seenCursors = Set<String?>()
            for _ in 0..<pagesLoaded {
                guard !seenCursors.contains(cursor) else { throw ContractError.invalid("Repeated continuation cursor") }
                seenCursors.insert(cursor)
                let page = try await api.page(query: currentQuery, cursor: cursor)
                loaded.append(page)
                guard page.nextCursor != nil else { break }
                cursor = page.nextCursor
            }
            guard currentGeneration == generation else { return } // obsolete response
            var merged: [InboxItem] = []
            var seenIDs = Set<String>()
            var notes: [String] = []
            var isComplete = true
            for page in loaded {
                for item in page.items {
                    if seenIDs.contains(item.id) {
                        isComplete = false
                        notes.append("Repeated item across pages: \(item.id); traversal stopped")
                    } else {
                        seenIDs.insert(item.id)
                        merged.append(item)
                    }
                }
                for sourceID in expectedSources(for: currentQuery) where !page.sources.contains(where: { $0.id == sourceID }) {
                    isComplete = false
                    notes.append("Source \(sourceID) did not report freshness/completeness")
                }
                for source in page.sources where source.status != "fresh" || !source.complete {
                    isComplete = false
                    notes.append("\(source.id): \(source.status)" + (source.complete ? "" : " / incomplete") + (source.errorMessage.map { " (\($0))" } ?? ""))
                }
                if !page.summaries.complete {
                    isComplete = false
                    notes.append("Query-wide counts are incomplete")
                }
            }
            if let feature = view?.feature(forPresentation: presentation), let diagnostic = feature.diagnostic {
                notes.append(diagnostic)
            }
            // Retain labeled stale items from sources the new snapshot cannot replace.
            if !isComplete, !items.isEmpty {
                let healthy = Set(loaded.flatMap(\.sources).filter { $0.status == "fresh" && $0.complete }.map(\.id))
                let retained = items.filter { !healthy.contains($0.sourceId) && !seenIDs.contains($0.id) }
                if !retained.isEmpty {
                    merged += retained
                    notes.append("Retained \(retained.count) stale items from unavailable sources; actions disabled")
                }
            }
            items = merged
            summaries = loaded.first?.summaries
            sources = loaded.last?.sources ?? []
            nextCursor = isComplete ? loaded.last?.nextCursor : nil
            complete = isComplete
            diagnostics = Array(Set(notes)).sorted()
            error = nil
            rebuildRows()
        } catch {
            guard currentGeneration == generation else { return }
            self.error = error.localizedDescription
            if !items.isEmpty {
                complete = false
                diagnostics = ["Retained stale data: \(error.localizedDescription)"]
            }
        }
    }

    func loadMore() {
        guard nextCursor != nil else { return }
        pagesLoaded = min(100, pagesLoaded + 1)
        generation += 1
        scheduleRefresh()
    }

    func rebuildRows() {
        rows = collectionRows(items: items, expansion: view?.initialExpansion ?? "all", folded: folded, initializedThreads: &initializedThreads)
        if let focusID, !rows.contains(where: { $0.id == focusID }) { self.focusID = rows.first?.id }
        if focusID == nil { focusID = rows.first?.id }
    }

    func toggleFold(_ row: CollectionRow) {
        if folded.contains(row.id) { folded.remove(row.id) } else { folded.insert(row.id) }
        rebuildRows()
    }

    // MARK: Selection / actions

    func selectAll() {
        do {
            try selection.selectAll(items: items, complete: complete, profileId: query.profileId)
        } catch {
            self.error = error.localizedDescription
        }
    }

    func toggleSelection(_ row: CollectionRow, branch: Bool = false) {
        do {
            try selection.toggle(items: items, complete: complete, profileId: query.profileId, identifier: row.id, branch: branch)
        } catch {
            self.error = error.localizedDescription
        }
    }

    func isSelected(_ row: CollectionRow) -> Bool { selection.entries[row.id] != nil }

    func markRead() async {
        guard !writeInFlight else { return }
        defer { writeInFlight = false }
        guard view?.commands.contains("inbox.mark-read") == true else {
            error = "Read command is not declared by this view"
            return
        }
        do {
            let plan = try selection.plan(complete: complete, profileId: query.profileId)
            writeInFlight = true
            let result = try await api.execute(plan)
            selection.clear()
            if let actionError = result.error {
                error = actionError
            } else {
                error = "Read \(result.completedMessageIds.count) messages / \(result.completedItemIds.count) items; skipped \(result.skippedMemberIds.count) context members"
            }
            scheduleRefresh()
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: Detail

    func clearDetail() {
        detailRequest = UUID()
        detailTitle = nil
        detailText = nil
        detailCards = []
    }

    func openDetail(_ row: CollectionRow) async {
        let request = UUID()
        detailRequest = request
        focusID = row.id
        detailTitle = row.title
        detailCards = []
        detailText = "Loading full content…"
        do {
            let (_, detail) = try await api.inspect(reference: row.id, profileId: query.profileId)
            guard detailRequest == request else { return }
            detailCards = DetailCard.present(detail, fallback: row)
            detailText = Self.renderDetail(detail)
        } catch {
            guard detailRequest == request else { return }
            detailText = "Detail unavailable: \(error.localizedDescription)"
        }
    }

    func stop() {
        refreshTask?.cancel()
        liveTask?.cancel()
        detailRequest = UUID()
    }

    static func renderDetail(_ detail: JSONValue) -> String {
        let messages = detail["messages"]?.array ?? (detail["message"].map { [$0] } ?? [])
        if !messages.isEmpty {
            return messages.map { message in
                "# \(message["subject"]?.string ?? "Message")\n\nFrom: \(message["from"]?.string ?? "")  \nTo: \(message["to"]?.string ?? "")  \n\(message["timestamp"]?.string ?? "")\n\n\(message["body"]?.string ?? "")"
            }.joined(separator: "\n\n---\n\n")
        }
        func fields(_ value: JSONValue, depth: Int) -> String {
            switch value {
            case .object(let object):
                return object.sorted(by: { $0.key < $1.key }).map { "\(String(repeating: "#", count: min(depth, 6))) \($0.key)\n\n\(fields($0.value, depth: depth + 1))" }.joined(separator: "\n\n")
            case .array(let values):
                return values.map { fields($0, depth: depth) }.joined(separator: "\n\n")
            case .string(let text): return text
            case .null: return ""
            default: return value.compactSorted
            }
        }
        return fields(detail, depth: 2)
    }

    // MARK: Live hints (WebSocket)

    func startLive() {
        liveTask?.cancel()
        liveTask = Task { [weak self] in await self?.liveLoop() }
    }

    private func liveLoop() async {
        var delay: UInt64 = 500_000_000
        while !Task.isCancelled {
            do {
                try await connectOnce()
                delay = 500_000_000
            } catch is CancellationError {
                return
            } catch {
                connection = "disconnected: \(type(of: error)); retrying"
            }
            try? await Task.sleep(nanoseconds: delay)
            delay = min(delay * 2, 15_000_000_000)
        }
    }

    private func connectOnce() async throws {
        var components = URLComponents(url: baseURL.appendingPathComponent("ws"), resolvingAgainstBaseURL: false)
        components?.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        guard let url = components?.url else { throw ContractError.invalid("Invalid WebSocket URL") }
        let task = URLSession.shared.webSocketTask(with: url)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }
        let authMessage = "{\"type\":\"auth\",\"apiKey\":\(JSONValue.escape(apiKey))}"
        try await withAuthenticationDeadline(cancel: { task.cancel(with: .goingAway, reason: nil) }) {
            try await task.send(.string(authMessage))
            // One deadline covers the entire exchange, including unrelated messages.
            while true {
                let message = try await task.receive()
                guard case .string(let text) = message, let value = try? JSONValue.decode(Data(text.utf8)) else { continue }
                if value["type"]?.string == "auth" {
                    guard value["success"]?.bool == true else { throw ContractError.invalid("WebSocket authentication rejected") }
                    break
                }
            }
        }
        for channel in ["workbench", "mail", "activity", "brain", "tasks", "bugs", "arms", "proposals"] {
            try await task.send(.string("{\"type\":\"subscribe\",\"channel\":\"\(channel)\"}"))
        }
        connection = "live / authenticated"
        scheduleRefresh() // socket-only reconnect always recovers via HTTP
        let ping = Task {
            while !Task.isCancelled {
                try? await task.send(.string("{\"type\":\"ping\"}"))
                try? await Task.sleep(nanoseconds: 20_000_000_000)
            }
        }
        defer { ping.cancel() }
        while !Task.isCancelled {
            let message = try await task.receive()
            guard case .string(let text) = message, let value = try? JSONValue.decode(Data(text.utf8)) else { continue }
            if value["channel"] != nil, value["event"] != nil, !writeInFlight {
                scheduleRefresh() // hints only invalidate; HTTP stays authoritative
            }
        }
    }
}

enum InboxSettings {
    static func load() -> (url: URL, key: String) {
        let env = ProcessInfo.processInfo.environment
        let defaults = UserDefaults.standard
        let urlString = env["COLEO_API_URL"] ?? defaults.string(forKey: "coleo.apiURL") ?? "http://127.0.0.1:8080"
        let key = env["COLEO_API_KEY"] ?? defaults.string(forKey: "coleo.apiKey") ?? ""
        return (URL(string: urlString) ?? URL(string: "http://127.0.0.1:8080")!, key)
    }

    static func save(url: URL, key: String) {
        UserDefaults.standard.set(url.absoluteString, forKey: "coleo.apiURL")
        UserDefaults.standard.set(key, forKey: "coleo.apiKey")
    }
}
