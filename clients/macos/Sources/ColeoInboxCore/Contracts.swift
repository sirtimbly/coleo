import CryptoKit
import Foundation

public enum ContractError: Error, LocalizedError, Equatable, CustomStringConvertible {
    case invalid(String)
    public var description: String {
        switch self { case .invalid(let message): return message }
    }
    public var errorDescription: String? { description }
}

/// Short stable reference shown in place of a full ID, identical to the Python
/// client: `@` + first 8 hex chars of SHA-256(id).
public func shortReference(_ identifier: String) -> String {
    let digest = SHA256.hash(data: Data(identifier.utf8))
    return "@" + digest.map { String(format: "%02x", $0) }.joined().prefix(8)
}

/// Normalized Messaging query (schema v1). Mirrors `contracts.normalize` in the
/// Python client: same defaults, same validation, same canonical identity string
/// the server uses for `queryId`/`queryIdentity`.
public struct MessagingQuery: Equatable, Sendable {
    public var scope: String = "inbox"
    public var profileId: String = "local"
    public var facet: String = "attention"
    public var mailbox: String = "inbox"
    public var brainCategory: String = "all"
    public var search: String = ""
    public var sortDirection: String = "desc"
    public var limit: Int = 100

    public init() {}

    public init(json: JSONValue) throws {
        guard let object = json.object else { throw ContractError.invalid("Unsupported Messaging query") }
        let allowed: Set<String> = ["schemaVersion", "scope", "profileId", "facet", "mailbox", "brainCategory", "search", "filters", "sort", "limit"]
        guard Set(object.keys).isSubset(of: allowed) else { throw ContractError.invalid("Unsupported Messaging query") }
        if let version = object["schemaVersion"]?.int, version != 1 { throw ContractError.invalid("Unsupported Messaging query") }
        if let filters = object["filters"]?.array, !filters.isEmpty {
            // The native client does not yet construct filters; reject rather than drop them silently.
            throw ContractError.invalid("Messaging filters are not supported by the native client yet")
        }
        scope = object["scope"]?.string ?? scope
        profileId = (object["profileId"]?.string ?? profileId).trimmingCharacters(in: .whitespaces)
        facet = object["facet"]?.string ?? (scope == "mail" ? "messages" : facet)
        mailbox = object["mailbox"]?.string ?? mailbox
        brainCategory = object["brainCategory"]?.string ?? brainCategory
        search = (object["search"]?.string ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        if let sort = object["sort"]?.object {
            guard sort["field"]?.string == "timestamp" || sort["field"] == nil,
                  let direction = sort["direction"]?.string, ["asc", "desc"].contains(direction)
            else { throw ContractError.invalid("Invalid sort") }
            sortDirection = direction
        }
        limit = object["limit"]?.int ?? limit
        try validate()
    }

    public func validated() throws -> MessagingQuery { try validate(); return self }

    private func validate() throws {
        guard ["inbox", "mail"].contains(scope),
              ["attention", "messages", "brain", "arms", "history", "all"].contains(facet)
        else { throw ContractError.invalid("Invalid scope/facet") }
        if scope == "mail", facet != "messages" { throw ContractError.invalid("Mail scope only supports the messages facet") }
        guard ["inbox", "sent", "archive"].contains(mailbox),
              ["all", "operations", "tasks", "arms", "decisions", "planning", "alerts"].contains(brainCategory)
        else { throw ContractError.invalid("Invalid mailbox/category") }
        guard (1...200).contains(limit) else { throw ContractError.invalid("Limit must be 1-200") }
        guard !profileId.isEmpty else { throw ContractError.invalid("Profile is required") }
    }

    /// Canonical query honoring the server's facet-dependent field resets.
    public var normalized: MessagingQuery {
        var copy = self
        copy.search = search.trimmingCharacters(in: .whitespaces).lowercased()
        if facet != "messages" { copy.mailbox = "inbox" }
        if facet != "brain" { copy.brainCategory = "all" }
        return copy
    }

    /// Compact JSON in the server's exact key order (see Python `compact(normalize(q))`).
    public var identity: String {
        let q = normalized
        return "{\"schemaVersion\":1,\"scope\":\(JSONValue.escape(q.scope)),\"profileId\":\(JSONValue.escape(q.profileId)),"
            + "\"facet\":\(JSONValue.escape(q.facet)),\"mailbox\":\(JSONValue.escape(q.mailbox)),\"brainCategory\":\(JSONValue.escape(q.brainCategory)),"
            + "\"search\":\(JSONValue.escape(q.search)),\"filters\":[],\"sort\":{\"field\":\"timestamp\",\"direction\":\(JSONValue.escape(q.sortDirection))},\"limit\":\(q.limit)}"
    }

    public var json: JSONValue {
        .object([
            "schemaVersion": .number(1), "scope": .string(scope), "profileId": .string(profileId),
            "facet": .string(facet), "mailbox": .string(mailbox), "brainCategory": .string(brainCategory),
            "search": .string(search), "filters": .array([]),
            "sort": .object(["field": .string("timestamp"), "direction": .string(sortDirection)]),
            "limit": .number(Double(limit)),
        ])
    }
}

public func expectedSources(for query: MessagingQuery) -> [String] {
    switch query.facet {
    case "messages": return ["mail"]
    case "all", "attention": return ["records", "mail", "activity", "events"]
    default: return ["records", "activity", "events"]
    }
}
