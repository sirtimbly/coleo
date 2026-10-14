import ColeoInboxCore
import Foundation

/// One independent API session per non-messaging document. Collections retain
/// paging/filter state; overview sources fail independently and label stale data.
@MainActor
final class ResourceModuleSession: ObservableObject {
    let module: WorkbenchModule
    @Published var records: [ModuleRecord] = []
    @Published var total = 0
    @Published var focusID: String?
    @Published var detail: ModuleRecord?
    @Published var detailError: String?
    @Published var search = ""
    @Published var status = "all"
    @Published var isLoading = false
    @Published var isActing = false
    @Published var error: String?
    @Published var snapshots: [String: JSONValue] = [:]
    @Published var sourceErrors: [String: String] = [:]
    @Published var updatedAt: Date?
    private var transport: any InboxTransport
    private var appliedSearch = ""
    private var pages = 1
    private var generation = 0
    private var detailGeneration = 0
    private var detailRequest = UUID()
    private var timer: Task<Void, Never>?
    private var request: Task<Void, Never>?

    init(module: WorkbenchModule, transport: (any InboxTransport)? = nil) {
        self.module = module
        let settings = InboxSettings.load()
        self.transport = transport ?? URLSessionTransport(baseURL: settings.url, apiKey: settings.key)
    }

    var isCollection: Bool { ["tasks", "bugs"].contains(module.renderer) }
    var statuses: [String] {
        module.renderer == "tasks"
            ? ["draft", "pending", "claimed", "in_progress", "completing", "completed", "failed", "blocked", "cancelled"]
            : ["open", "investigating", "fixing", "verifying", "resolved", "closed"]
    }

    func start() {
        guard timer == nil else { return }
        reload()
        timer = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                guard let self else { return }
                if !self.isLoading { self.reload() }
            }
        }
    }

    func stop() {
        generation += 1
        detailGeneration += 1
        timer?.cancel()
        request?.cancel()
        timer = nil
        request = nil
    }

    func reconnect() {
        stop()
        let settings = InboxSettings.load()
        transport = URLSessionTransport(baseURL: settings.url, apiKey: settings.key)
        records = []; snapshots = [:]; sourceErrors = [:]; updatedAt = nil
        focusID = nil; detail = nil; total = 0; pages = 1
        start()
    }

    func reload(reset: Bool = false) {
        if reset {
            detailGeneration += 1
            appliedSearch = search
            pages = 1; records = []; total = 0; focusID = nil; detail = nil
        }
        generation += 1
        request?.cancel()
        request = Task { await refresh() }
    }

    func loadMore() { pages += 1; reload() }

    private func refresh() async {
        let version = generation
        let querySearch = appliedSearch
        let queryStatus = status
        let pageCount = pages
        let transport = transport
        isLoading = true
        defer { if generation == version { isLoading = false } }
        do {
            if isCollection {
                var loaded: [ModuleRecord] = []
                var count = 0
                for page in 0..<pageCount {
                    var query = [("limit", "100"), ("offset", String(page * 100))]
                    if !querySearch.isEmpty { query.append(("search", querySearch)) }
                    if queryStatus != "all" { query.append(("status", queryStatus)) }
                    let response = try await transport.request(path: "/api/\(module.renderer)", body: nil, queryItems: query)
                    let result = try ModuleRecordPage(json: response, renderer: module.renderer)
                    loaded += result.records
                    count = result.total
                    if loaded.count >= count || result.records.isEmpty { break }
                }
                guard version == generation, !Task.isCancelled else { return }
                var seen = Set<String>()
                records = loaded.filter { seen.insert($0.id).inserted }
                total = count
                if let focusID, !records.contains(where: { $0.id == focusID }) {
                    self.focusID = nil; detail = nil
                }
                if focusID != nil { await loadDetail(keepingCurrent: true) }
            } else {
                let sources = module.renderer == "brain" ? [("brain", "/api/brain/status")]
                    : [("brain", "/api/brain/status"), ("tasks", "/api/tasks/stats"), ("bugs", "/api/bugs/stats")]
                let transport = transport
                let results = await withTaskGroup(of: (String, JSONValue?, String?).self) { group in
                    for (name, path) in sources {
                        group.addTask {
                            do { return (name, try await transport.request(path: path), nil) }
                            catch { return (name, nil, error.localizedDescription) }
                        }
                    }
                    var values: [(String, JSONValue?, String?)] = []
                    for await value in group { values.append(value) }
                    return values
                }
                guard version == generation, !Task.isCancelled else { return }
                for (name, value, failure) in results {
                    if let value { snapshots[name] = value }
                    sourceErrors[name] = failure
                }
            }
            guard version == generation, !Task.isCancelled else { return }
            error = nil
            if isCollection || sourceErrors.isEmpty { updatedAt = Date() }
        } catch {
            guard version == generation, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    func loadDetail(keepingCurrent: Bool = false) async {
        let requestID = UUID()
        detailRequest = requestID
        if !keepingCurrent { detail = nil }
        detailError = nil
        guard let id = focusID else { detail = nil; return }
        let version = detailGeneration
        do {
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id
            let response = try await transport.request(path: "/api/\(module.renderer)/\(encoded)")
            let kind = module.renderer == "tasks" ? "task" : "bug"
            guard let raw = response[kind] else { throw ContractError.invalid("No \(kind) detail returned") }
            let record = try ModuleRecord(json: raw, kind: kind)
            guard record.id == id else { throw ContractError.invalid("Detail belongs to another resource") }
            guard focusID == id, detailGeneration == version, detailRequest == requestID, !Task.isCancelled else { return }
            detail = record
        } catch {
            guard focusID == id, detailGeneration == version, detailRequest == requestID, !Task.isCancelled else { return }
            detailError = error.localizedDescription
        }
    }

    func setBrainRunning(_ running: Bool) async {
        guard !isActing else { return }
        isActing = true
        defer { isActing = false }
        do {
            _ = try await transport.request(path: "/api/brain/\(running ? "start" : "stop")", body: .object([:]), queryItems: [])
            reload()
        } catch { self.error = error.localizedDescription }
    }
}
