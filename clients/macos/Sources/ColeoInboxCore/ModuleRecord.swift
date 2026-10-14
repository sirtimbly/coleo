import Foundation

/// Native Tasks/Bugs collection boundary. Preserve the domain payload for full
/// detail cards while giving SwiftUI Table stable identity and typed columns.
public struct ModuleRecord: Identifiable, Sendable {
    public let id: String
    public let json: JSONValue
    public let kind: String
    public var title: String { json["subject"]?.string ?? json["title"]?.string ?? id }
    public var status: String { json["status"]?.string ?? "unknown" }
    public var priority: String { json["priority"]?.string ?? "—" }
    public var owner: String { json["assignedArmName"]?.string ?? json["assigneeArmName"]?.string
        ?? json["assignedTo"]?.string ?? json["assigneeArmId"]?.string ?? "Unassigned" }

    public init(json: JSONValue, kind: String) throws {
        guard let id = json["id"]?.string, !id.isEmpty else { throw ContractError.invalid("Resource has no ID") }
        self.id = id
        self.json = json
        self.kind = kind
    }

    public var card: DetailCard {
        let row = CollectionRow(id: "\(kind):\(id)", parentId: nil, depth: 0, itemID: id, selectable: true,
            title: title, summary: json["description"]?.string ?? "", timestamp: json["updatedAt"]?.string,
            source: owner, unread: false, requiresAction: status == "blocked" || status == "failed", hasChildren: false)
        var item = json.object ?? [:]
        item["title"] = .string(title)
        item["kind"] = .string(kind)
        item["source"] = .string(owner)
        return DetailCard.present(.object(item), fallback: row)[0]
    }
}

public struct ModuleRecordPage: Sendable {
    public let records: [ModuleRecord]
    public let total: Int

    public init(json: JSONValue, renderer: String) throws {
        guard ["tasks", "bugs"].contains(renderer), let items = json[renderer]?.array,
              let total = json["pagination"]?["total"]?.int, total >= 0 else {
            throw ContractError.invalid("Invalid \(renderer) collection response")
        }
        records = try items.map { try ModuleRecord(json: $0, kind: renderer == "tasks" ? "task" : "bug") }
        guard Set(records.map(\.id)).count == records.count else { throw ContractError.invalid("Repeated resource IDs") }
        self.total = total
    }
}
