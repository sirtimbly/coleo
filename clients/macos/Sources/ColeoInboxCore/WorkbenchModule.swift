import Foundation

/// File-backed launch recipe. The server still owns the named view definition;
/// modules select its initial projection and the native renderer that hosts it.
public struct WorkbenchModule: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let description: String
    public let symbol: String
    public let renderer: String
    public let namedView: String?
    public let facet: String?
    public let mailbox: String?
    public let brainCategory: String?
    public let presentation: String?
    public var sorting: ModuleSorting? = nil

    public static let inbox = WorkbenchModule(id: "inbox", title: "Inbox", description: "Items needing your attention",
        symbol: "tray.full", renderer: "messaging", namedView: "inbox-triage", facet: "attention",
        mailbox: nil, brainCategory: nil, presentation: nil)

    public func initialQuery(from query: MessagingQuery) throws -> MessagingQuery {
        var result = query
        if let facet { result.facet = facet }
        if let mailbox { result.mailbox = mailbox }
        if let brainCategory { result.brainCategory = brainCategory }
        return try result.normalized.validated()
    }
}

public struct ModuleCatalog: Codable, Sendable {
    public let schemaVersion: Int
    public let modules: [WorkbenchModule]

    public static func decode(_ data: Data) throws -> ModuleCatalog {
        let catalog = try JSONDecoder().decode(ModuleCatalog.self, from: data)
        guard catalog.schemaVersion == 1 else { throw ContractError.invalid("Unsupported module catalog version") }
        guard !catalog.modules.isEmpty, Set(catalog.modules.map(\.id)).count == catalog.modules.count else {
            throw ContractError.invalid("Module IDs must be unique and the catalog must not be empty")
        }
        for module in catalog.modules {
            guard !module.id.isEmpty, !module.title.isEmpty, !module.symbol.isEmpty else {
                throw ContractError.invalid("Each module needs an ID, title, and symbol")
            }
            guard ["messaging", "tasks", "bugs", "brain", "dashboard"].contains(module.renderer) else {
                throw ContractError.invalid("Unsupported native module renderer: \(module.renderer)")
            }
            if module.renderer == "messaging", module.namedView?.isEmpty != false {
                throw ContractError.invalid("Messaging modules need a named view")
            }
            _ = try module.initialQuery(from: MessagingQuery())
            if let sorting = module.sorting {
                guard ["tasks", "bugs"].contains(module.renderer) else {
                    throw ContractError.invalid("Module sorting is supported for Tasks and Bugs")
                }
                try sorting.validated()
            }
        }
        return catalog
    }
}

/// Unique identity allows several copies of the same module to coexist and lets
/// SwiftUI restore a document without depending on an imported catalog file.
public struct ModuleDocument: Codable, Hashable, Identifiable, Sendable {
    public let id: UUID
    public let module: WorkbenchModule

    public init(module: WorkbenchModule) {
        id = UUID()
        self.module = module
    }
}
