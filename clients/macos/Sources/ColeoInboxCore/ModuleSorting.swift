import Foundation

public struct ModuleSortField: Codable, Hashable, Sendable {
    public let field: String
    public let values: [String]?
}

public struct ModuleSortOrder: Codable, Hashable, Sendable {
    public let field: String
    public let direction: String
}

public struct ModuleSorting: Codable, Hashable, Sendable {
    public let fields: [ModuleSortField]
    public let defaultOrder: [ModuleSortOrder]

    public func validated() throws {
        let names = fields.map(\.field)
        guard Set(names).count == names.count,
              names.allSatisfy({ ["title", "status", "priority", "owner"].contains($0) }),
              Set(defaultOrder.map(\.field)).count == defaultOrder.count,
              defaultOrder.allSatisfy({ names.contains($0.field) && ["asc", "desc"].contains($0.direction) }),
              fields.allSatisfy({ field in
                  guard let values = field.values else { return true }
                  return !values.isEmpty && Set(values).count == values.count && values.allSatisfy { !$0.isEmpty }
              }) else {
            throw ContractError.invalid("Invalid module sorting fields, value order, or default order")
        }
    }

    public func comparator(for field: String) -> ModuleRecordComparator? {
        fields.first { $0.field == field }.map { ModuleRecordComparator(field: $0) }
    }

    public func columnComparator(for field: String) -> KeyPathComparator<ModuleRecord>? {
        comparator(for: field).map { KeyPathComparator(\.self, comparator: $0) }
    }

    public var columnComparators: [KeyPathComparator<ModuleRecord>] {
        comparators.map { comparator in
            var forward = comparator
            forward.order = .forward
            return KeyPathComparator(\.self, comparator: forward, order: comparator.order)
        }
    }

    public var comparators: [ModuleRecordComparator] {
        defaultOrder.compactMap { item in
            guard var comparator = comparator(for: item.field) else { return nil }
            comparator.order = item.direction == "desc" ? .reverse : .forward
            return comparator
        }
    }
}

/// Native column headers change direction; the catalog owns field semantics.
public struct ModuleRecordComparator: SortComparator, Sendable {
    public let field: ModuleSortField
    public var order: SortOrder = .forward

    public func compare(_ lhs: ModuleRecord, _ rhs: ModuleRecord) -> ComparisonResult {
        func value(_ record: ModuleRecord) -> String {
            switch field.field {
            case "title": return record.title
            case "status": return record.status
            case "priority": return record.priority
            case "owner": return record.owner
            default: return ""
            }
        }
        let left = value(lhs), right = value(rhs)
        let result: ComparisonResult
        if let values = field.values,
           (values.firstIndex(of: left) ?? values.count) != (values.firstIndex(of: right) ?? values.count) {
            result = (values.firstIndex(of: left) ?? values.count) < (values.firstIndex(of: right) ?? values.count)
                ? .orderedAscending : .orderedDescending
        } else {
            result = left.localizedStandardCompare(right)
        }
        if order == .forward { return result }
        switch result {
        case .orderedAscending: return .orderedDescending
        case .orderedDescending: return .orderedAscending
        case .orderedSame: return .orderedSame
        }
    }
}
