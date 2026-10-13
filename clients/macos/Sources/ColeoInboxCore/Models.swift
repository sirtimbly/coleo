import Foundation

// MARK: - Resolved named view (GET /api/workbench/named-views/:id?client=native)

public struct ViewControl: Equatable, Sendable, Identifiable {
    public var id: String
    public var widget: String
    public var label: String
    public var binding: String?
    public var command: String?
}

public struct ViewRenderer: Equatable, Sendable, Identifiable {
    public var id: String
    public var renderer: String
    public var label: String
    public var fields: [String]
    public var kind: String?
}

public struct KeyboardBinding: Equatable, Sendable {
    public var key: String
    public var modifiers: [String]
    public var scope: String
    /// Human label, e.g. `⌘R` / `r` / `↑`; `primary` resolves to Command on macOS.
    public var display: String {
        let symbols = ["control": "⌃", "meta": "⌘", "primary": "⌘", "alt": "⌥", "shift": "⇧"]
        let prefix = modifiers.map { symbols[$0] ?? $0 }.joined()
        let keyNames = ["Space": "Space", "Enter": "Return", "Escape": "Esc", "ArrowUp": "↑", "ArrowDown": "↓", "ArrowLeft": "←", "ArrowRight": "→"]
        return prefix + (keyNames[key] ?? key)
    }
}

public struct ResolvedBinding: Equatable, Sendable, Identifiable {
    public var id: String
    public var operation: String
    public var label: String
    public var kind: String
    public var available: Bool
    public var diagnostic: String?
    public var binding: String?
    public var command: String?
    public var target: String?
    public var keyboard: [KeyboardBinding]
    public var choices: [String]
    public var valueType: String?
}

public struct ResolvedFeature: Equatable, Sendable, Identifiable {
    public var id: String
    public var implementation: String?
    public var diagnostic: String?
}

public struct ResolvedView: Equatable, Sendable {
    public var client: String
    public var viewID: String
    public var resource: String
    public var query: MessagingQuery
    public var queryIdentity: String
    public var commands: [String]
    /// Slot name -> controls, in definition order.
    public var slots: [(slot: String, controls: [ViewControl])]
    public var toolbarMaxRows: Int
    public var initialExpansion: String
    public var activePresentation: String
    public var renderers: [ViewRenderer]
    public var insightPanels: [ViewRenderer]
    public var presentationFeatures: [ResolvedFeature]
    public var bindings: [ResolvedBinding]

    public func binding(forOperation operation: String) -> ResolvedBinding? {
        bindings.first { $0.operation == operation }
    }
    public func feature(forPresentation id: String) -> ResolvedFeature? {
        presentationFeatures.first { $0.id == id }
    }

    public init(json: JSONValue) throws {
        guard json["schemaVersion"]?.int == 1, let definition = json["definition"] else {
            throw ContractError.invalid("Incompatible named view")
        }
        client = json["client"]?.string ?? ""
        viewID = definition["id"]?.string ?? ""
        resource = definition["resource"]?.string ?? ""
        guard resource == "messaging", !viewID.isEmpty else { throw ContractError.invalid("Incompatible named view") }
        query = try MessagingQuery(json: definition["query"] ?? .object([:]))
        queryIdentity = json["queryIdentity"]?.string ?? ""
        guard queryIdentity == query.identity else { throw ContractError.invalid("Incompatible named query identity") }
        commands = definition["commands"]?.array?.compactMap(\.string) ?? []
        let slotOrder = ["toolbar.primary.identity", "toolbar.primary.context", "toolbar.primary.search",
                         "toolbar.primary.actions", "toolbar.primary.state", "toolbar.secondary.filters",
                         "toolbar.secondary.sort", "toolbar.secondary.presentation", "toolbar.secondary.selection",
                         "toolbar.secondary.insights"]
        let rawSlots = definition["slots"]?.object ?? [:]
        slots = slotOrder.compactMap { slot in
            guard let controls = rawSlots[slot]?.array else { return nil }
            return (slot, controls.map {
                ViewControl(id: $0["id"]?.string ?? "", widget: $0["widget"]?.string ?? "", label: $0["label"]?.string ?? "",
                            binding: $0["binding"]?.string, command: $0["command"]?.string)
            })
        }
        toolbarMaxRows = definition["toolbar"]?["maxRows"]?.int ?? 2
        initialExpansion = definition["hierarchy"]?["initialExpansion"]?.string ?? "all"
        activePresentation = definition["presentation"]?["active"]?.string ?? "grid"
        renderers = (definition["presentation"]?["renderers"]?.array ?? []).map {
            ViewRenderer(id: $0["id"]?.string ?? "", renderer: $0["renderer"]?.string ?? "", label: $0["label"]?.string ?? "",
                         fields: $0["fields"]?.array?.compactMap(\.string) ?? [], kind: $0["kind"]?.string)
        }
        insightPanels = (definition["insights"]?["panels"]?.array ?? []).map {
            ViewRenderer(id: $0["id"]?.string ?? "", renderer: $0["renderer"]?.string ?? "", label: $0["label"]?.string ?? "",
                         fields: $0["fields"]?.array?.compactMap(\.string) ?? [], kind: nil)
        }
        presentationFeatures = (json["features"]?["presentation"]?.array ?? []).map {
            ResolvedFeature(id: $0["id"]?.string ?? "", implementation: $0["implementation"]?.string, diagnostic: $0["diagnostic"]?.string)
        }
        bindings = (json["interactions"]?["bindings"]?.array ?? []).map { b in
            ResolvedBinding(
                id: b["id"]?.string ?? "", operation: b["operation"]?.string ?? "", label: b["label"]?.string ?? "",
                kind: b["kind"]?.string ?? "", available: b["available"]?.bool ?? false, diagnostic: b["diagnostic"]?.string,
                binding: b["binding"]?.string, command: b["command"]?.string, target: b["target"]?.string,
                keyboard: (b["keyboard"]?.array ?? []).map {
                    KeyboardBinding(key: $0["key"]?.string ?? "", modifiers: $0["modifiers"]?.array?.compactMap(\.string) ?? [], scope: $0["scope"]?.string ?? "collection")
                },
                choices: b["value"]?["choices"]?.array?.compactMap(\.string) ?? [],
                valueType: b["value"]?["type"]?.string)
        }
    }
}

// MARK: - Collection page (GET /api/workbench/inbox)

public struct SourceStatus: Equatable, Sendable, Identifiable {
    public var id: String
    public var status: String
    public var complete: Bool
    public var asOf: String?
    public var errorMessage: String?
}

public struct Summaries: Equatable, Sendable {
    public var total: Int?
    public var unread: Int?
    public var requiresAction: Int?
    public var complete: Bool
}

public struct HierarchyNode: Equatable, Sendable, Identifiable {
    public var id: String
    public var parentId: String?
    public var kind: String
    public var selectable: Bool
    public var data: JSONValue
    public var title: String { data["title"]?.string ?? "" }
    public var summary: String { data["summary"]?.string ?? "" }
    public var timestamp: String? { data["timestamp"]?.string }
    public var source: String? { data["source"]?.string }
    public var unread: Bool { data["unread"]?.bool ?? false }
    public var requiresAction: Bool { data["requiresAction"]?.bool ?? false }
}

public struct MailThread: Equatable, Sendable {
    public var id: String
    public var mailbox: String
    public var revision: String
    public var rootIds: [String]
    public var nodes: [HierarchyNode]
    public var diagnostics: [String]

    public init(json: JSONValue) throws {
        id = json["id"]?.string ?? ""
        mailbox = json["mailbox"]?.string ?? "inbox"
        revision = json["revision"]?.string ?? ""
        let hierarchy = json["hierarchy"]
        guard hierarchy?["schemaVersion"]?.int == 1 else { throw ContractError.invalid("Invalid hierarchy") }
        rootIds = hierarchy?["rootIds"]?.array?.compactMap(\.string) ?? []
        nodes = (hierarchy?["nodes"]?.array ?? []).map {
            HierarchyNode(id: $0["id"]?.string ?? "", parentId: $0["parentId"]?.string, kind: $0["kind"]?.string ?? "",
                          selectable: $0["selectable"]?.bool ?? false, data: $0["data"] ?? .object([:]))
        }
        diagnostics = (json["diagnostics"]?.array ?? []).compactMap { $0["message"]?.string }
        _ = try flattened() // validates parents, roots, cycles, reachability
    }

    /// Depth-first rows plus child map, mirroring `contracts.hierarchy` validation.
    public func flattened() throws -> (rows: [(node: HierarchyNode, depth: Int)], children: [String: [String]]) {
        let byID = Dictionary(nodes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        guard byID.count == nodes.count else { throw ContractError.invalid("Invalid hierarchy") }
        var children: [String: [String]] = Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, [String]()) })
        for node in nodes {
            if let parent = node.parentId {
                guard byID[parent] != nil else { throw ContractError.invalid("Missing hierarchy parent") }
                children[parent, default: []].append(node.id)
            }
        }
        var visited = Set<String>()
        func walk(_ identifier: String, _ depth: Int) throws -> [(HierarchyNode, Int)] {
            guard !visited.contains(identifier), depth <= 500, let node = byID[identifier] else {
                throw ContractError.invalid("Cyclic hierarchy")
            }
            visited.insert(identifier)
            var result: [(HierarchyNode, Int)] = [(node, depth)]
            for child in children[identifier] ?? [] { result += try walk(child, depth + 1) }
            return result
        }
        var rows: [(HierarchyNode, Int)] = []
        for root in rootIds {
            guard let node = byID[root], node.parentId == nil else { throw ContractError.invalid("Invalid hierarchy root") }
            rows += try walk(root, 0)
        }
        guard visited.count == nodes.count else { throw ContractError.invalid("Unreachable hierarchy nodes") }
        return (rows.map { (node: $0.0, depth: $0.1) }, children)
    }
}

public struct InboxItem: Equatable, Sendable, Identifiable {
    public var json: JSONValue
    public var id: String { json["id"]?.string ?? "" }
    public var representation: String { json["representation"]?.string ?? "" }
    public var sourceId: String { json["sourceId"]?.string ?? "" }
    public var title: String { json["title"]?.string ?? "" }
    public var summary: String { json["summary"]?.string ?? "" }
    public var timestamp: String? { json["timestamp"]?.string }
    public var source: String? { json["source"]?.string }
    public var unread: Bool { json["unread"]?.bool ?? false }
    public var requiresAction: Bool { json["requiresAction"]?.bool ?? false }
    public var thread: MailThread? {
        guard let raw = json["thread"] else { return nil }
        return try? MailThread(json: raw)
    }
}

public struct InboxPage: Equatable, Sendable {
    public var queryId: String
    public var cursor: String?
    public var nextCursor: String?
    public var items: [InboxItem]
    public var sources: [SourceStatus]
    public var summaries: Summaries

    public init(json: JSONValue, expectedQuery: MessagingQuery, expectedCursor: String?) throws {
        guard json["schemaVersion"]?.int == 1 else { throw ContractError.invalid("Messaging response belongs to another query/page") }
        queryId = json["queryId"]?.string ?? ""
        cursor = json["cursor"]?.string
        nextCursor = json["nextCursor"]?.string
        let pageQuery = try MessagingQuery(json: json["query"] ?? .object([:]))
        guard queryId == expectedQuery.identity, queryId == pageQuery.identity, cursor == expectedCursor else {
            throw ContractError.invalid("Messaging response belongs to another query/page")
        }
        items = (json["items"]?.array ?? []).map { InboxItem(json: $0) }
        for item in items {
            if item.representation == "thread", item.json["thread"] == nil {
                throw ContractError.invalid("Thread missing context")
            }
            _ = try item.thread?.flattened()
        }
        sources = (json["sources"]?.array ?? []).map {
            SourceStatus(id: $0["id"]?.string ?? "", status: $0["status"]?.string ?? "", complete: $0["complete"]?.bool ?? false,
                         asOf: $0["asOf"]?.string, errorMessage: $0["error"]?["message"]?.string)
        }
        let raw = json["summaries"]
        summaries = Summaries(total: raw?["total"]?.int, unread: raw?["unread"]?.int,
                              requiresAction: raw?["requiresAction"]?.int, complete: raw?["complete"]?.bool ?? false)
    }
}

/// One flattened, displayable row: a top-level item or a loaded thread member.
public struct CollectionRow: Equatable, Sendable, Identifiable {
    public var id: String
    public var parentId: String?
    public var depth: Int
    public var itemID: String
    public var selectable: Bool
    public var title: String
    public var summary: String
    public var timestamp: String?
    public var source: String?
    public var unread: Bool
    public var requiresAction: Bool
    public var hasChildren: Bool
}
