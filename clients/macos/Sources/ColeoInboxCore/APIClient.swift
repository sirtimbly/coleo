import Foundation

public enum APIError: Error, LocalizedError, CustomStringConvertible {
    case message(String)
    public var description: String { switch self { case .message(let text): return text } }
    public var errorDescription: String? { description }
}

public protocol InboxTransport: Sendable {
    func request(path: String, body: JSONValue?, queryItems: [(String, String)]) async throws -> JSONValue
}

public extension InboxTransport {
    func request(path: String) async throws -> JSONValue { try await request(path: path, body: nil, queryItems: []) }
}

/// HTTP client for the shared Coleo API. Like the Python client it never reads
/// SQLite/Maildir and never shells out to the TypeScript CLI.
public struct URLSessionTransport: InboxTransport {
    public var baseURL: URL
    public var apiKey: String
    public var session: URLSession

    public init(baseURL: URL, apiKey: String = "", session: URLSession = .shared) {
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.session = session
    }

    public static func environment() -> URLSessionTransport {
        let env = ProcessInfo.processInfo.environment
        let url = URL(string: env["COLEO_API_URL"] ?? "http://127.0.0.1:8080") ?? URL(string: "http://127.0.0.1:8080")!
        return URLSessionTransport(baseURL: url, apiKey: env["COLEO_API_KEY"] ?? "")
    }

    public func request(path: String, body: JSONValue?, queryItems: [(String, String)]) async throws -> JSONValue {
        // API paths already percent-encode each resource ID. appendingPathComponent
        // would encode those percent signs again, breaking mail/reference lookups.
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        let basePath = components?.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/")) ?? ""
        let requestPath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components?.percentEncodedPath = "/" + [basePath, requestPath].filter { !$0.isEmpty }.joined(separator: "/")
        components?.queryItems = queryItems.isEmpty ? nil : queryItems.map { URLQueryItem(name: $0.0, value: $0.1) }
        components?.fragment = nil
        guard let url = components?.url else { throw APIError.message("Invalid API URL") }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        if !apiKey.isEmpty {
            request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try body.encoded()
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.message("Inbox API request failed: \(error.localizedDescription); check COLEO_API_URL")
        }
        let value = try? JSONValue.decode(data)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw APIError.message(value?["error"]?.string ?? "HTTP \(http.statusCode)")
        }
        guard let value, value.object != nil else { throw APIError.message("Expected API object envelope") }
        return value
    }
}

private func encoded(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#@"))) ?? value
}

public struct InboxAPI: Sendable {
    public var transport: any InboxTransport
    public init(transport: any InboxTransport) { self.transport = transport }

    public func namedView(id: String, client: String = "native") async throws -> ResolvedView {
        let value = try await transport.request(path: "/api/workbench/named-views/\(encoded(id))", body: nil, queryItems: [("client", client)])
        let view = try ResolvedView(json: value)
        guard view.viewID == id else { throw ContractError.invalid("Incompatible named view") }
        return view
    }

    public func page(query: MessagingQuery, cursor: String?) async throws -> InboxPage {
        var items = [("query", query.identity)]
        if let cursor { items.append(("cursor", cursor)) }
        let value = try await transport.request(path: "/api/workbench/inbox", body: nil, queryItems: items)
        return try InboxPage(json: value, expectedQuery: query, expectedCursor: cursor)
    }

    /// Reference resolution is independent of listing filters/pagination (`show <ref>`).
    public func inspect(reference: String, profileId: String) async throws -> (target: JSONValue, detail: JSONValue) {
        let target = try await transport.request(path: "/api/workbench/inbox/references/\(encoded(reference))", body: nil, queryItems: [("profileId", profileId)])
        guard target["schemaVersion"]?.int == 1, let id = target["id"]?.string,
              reference == id || reference == shortReference(id)
        else { throw ContractError.invalid("Reference lookup returned another resource") }
        guard let detailRef = target["detail"] else { throw ContractError.invalid("Reference lookup returned no detail") }
        let detail: JSONValue
        switch detailRef["kind"]?.string {
        case "thread", "message":
            var path = "/api/mail/threads/\(encoded(detailRef["threadId"]?.string ?? ""))"
            if detailRef["kind"]?.string == "message" { path += "/messages/\(encoded(detailRef["messageId"]?.string ?? ""))" }
            detail = try await transport.request(path: path, body: nil, queryItems: [("mailbox", detailRef["mailbox"]?.string ?? "inbox")])
        case "event", "activity":
            var query: [(String, String)] = []
            if let sequence = detailRef["sequence"] { query.append(("sequence", sequence.compactSorted)) }
            detail = try await transport.request(path: "/api/workbench/inbox/events/\(encoded(id))", body: nil, queryItems: query)
        default:
            if id.hasPrefix("status:") {
                detail = try await transport.request(path: "/api/status-reports/\(encoded(String(id.dropFirst(7))))")
            } else {
                detail = try await transport.request(path: "/api/workbench/inbox/records/\(encoded(id))", body: nil, queryItems: [("profileId", profileId)])
            }
        }
        return (target, detail)
    }

    /// Exact, revision-checked mark-read. Never retries writes automatically;
    /// a 409 surfaces to the caller. Sent-only context is reported as skipped by the server.
    public func execute(_ plan: SelectionPlan) async throws -> ActionResult {
        var result = ActionResult()
        result.selectedMemberIds = Array(Set(plan.threads.values.flatMap(\.memberIds)))
        do {
            for (itemID, thread) in plan.threads.sorted(by: { $0.key < $1.key }) {
                let body: JSONValue = .object([
                    "mailbox": .string(thread.mailbox), "revision": .string(thread.revision),
                    "memberIds": .array(thread.memberIds.map(JSONValue.string)), "action": .string("read"),
                ])
                let response = try await transport.request(path: "/api/mail/threads/\(encoded(thread.threadId))/actions", body: body, queryItems: [])
                guard response["ok"]?.bool == true else { throw ContractError.invalid("Invalid thread action response") }
                result.completedItemIds.append(itemID)
                result.completedMessageIds += response["completedMessageIds"]?.array?.compactMap(\.string) ?? []
                result.skippedMemberIds += response["skippedMemberIds"]?.array?.compactMap(\.string) ?? []
            }
            for batch in stride(from: 0, to: plan.records.count, by: 500) {
                let slice = Array(plan.records[batch..<min(batch + 500, plan.records.count)])
                _ = try await transport.request(path: "/api/workbench/attention/bulk", body: .object([
                    "profileId": .string(plan.profileId), "itemKeys": .array(slice.map(JSONValue.string)), "action": .string("read"),
                ]), queryItems: [])
                result.completedItemIds += slice
            }
        } catch {
            result.error = error.localizedDescription
        }
        return result
    }
}

/// Flattens loaded items into collection rows honoring expansion state, the same
/// recipe the TUI builds in `update_view`: folding preserves selection because
/// selection lives outside the row list.
public func collectionRows(items: [InboxItem], expansion: String, folded: Set<String>, initializedThreads: inout Set<String>) -> [CollectionRow] {
    var rows: [CollectionRow] = []
    var mutableFolded = folded
    for item in items {
        rows.append(CollectionRow(id: item.id, parentId: nil, depth: 0, itemID: item.id,
                                  selectable: item.thread == nil, title: item.title, summary: item.summary,
                                  timestamp: item.timestamp, source: item.source, unread: item.unread,
                                  requiresAction: item.requiresAction, hasChildren: item.thread != nil))
        guard let thread = item.thread, let flattened = try? thread.flattened() else { continue }
        if !initializedThreads.contains(item.id) {
            initializedThreads.insert(item.id)
            if expansion == "collapsed" { mutableFolded.insert(item.id) }
            if expansion == "roots" { mutableFolded.formUnion(thread.rootIds) }
        }
        var hidden = Set<String>()
        for (node, depth) in flattened.rows where node.id != item.id {
            let parent = node.parentId ?? item.id // root group nodes hang off the item, as in the TUI
            if hidden.contains(parent) || mutableFolded.contains(parent) {
                hidden.insert(node.id)
                continue
            }
            let children = flattened.children[node.id] ?? []
            rows.append(CollectionRow(id: node.id, parentId: parent, depth: depth + 1, itemID: item.id,
                                      selectable: node.selectable, title: node.title, summary: node.summary,
                                      timestamp: node.timestamp, source: node.source, unread: node.unread,
                                      requiresAction: node.requiresAction, hasChildren: !children.isEmpty))
        }
    }
    return rows
}

public func formatAge(_ value: String?, now: Date = Date()) -> String {
    guard let value, let date = ISO8601DateFormatter.withFractional.date(from: value) ?? ISO8601DateFormatter().date(from: value) else { return "unknown" }
    let seconds = now.timeIntervalSince(date)
    let distance = abs(seconds)
    if distance >= 30 * 86400 {
        let formatter = DateFormatter()
        formatter.dateFormat = Calendar.current.isDate(date, equalTo: now, toGranularity: .year) ? "d MMM" : "yyyy-MM-dd"
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: date)
    }
    if distance < 60 { return "now" }
    if distance < 3600 { return "\(Int(distance / 60))m" }
    if distance < 86400 { return "\(Int(distance / 3600))h" }
    return "\(Int(distance / 86400))d"
}

extension ISO8601DateFormatter {
    static var withFractional: ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }
}
