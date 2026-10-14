import Foundation

public struct ThreadSelectionPlan: Equatable, Sendable {
    public var threadId: String
    public var mailbox: String
    public var revision: String
    public var memberIds: [String]
}

public struct SelectionPlan: Equatable, Sendable {
    public var records: [String]
    public var threads: [String: ThreadSelectionPlan] // keyed by top-level item ID
    public var profileId: String
}

/// Resolves explicit references to an exact write plan. Mirrors `selection.targets`:
/// thread refs select all loaded roots, member refs select one member (or its loaded
/// descendants with `branch`), and nothing is resolved against an incomplete window.
public func selectionTargets(items: [InboxItem], complete: Bool, profileId: String, refs: [String], branch: Bool = false) throws -> SelectionPlan {
    guard complete else { throw ContractError.invalid("Cannot act on an incomplete Inbox window. Retry the read before selecting IDs.") }
    var records: [String] = []
    var threads: [String: ThreadSelectionPlan] = [:]
    for ref in refs {
        var matches: [(InboxItem, String?)] = []
        for item in items {
            if ref == item.id || ref == shortReference(item.id) { matches.append((item, nil)) }
            if let thread = item.thread {
                for node in thread.nodes where node.selectable && node.id != item.id {
                    if ref == node.id || ref == shortReference(node.id) { matches.append((item, node.id)) }
                }
            }
        }
        guard matches.count == 1, let (item, member) = matches.first else {
            throw ContractError.invalid("Selection not loaded or ambiguous: \(ref)")
        }
        guard let thread = item.thread else {
            if !records.contains(item.id) { records.append(item.id) }
            continue
        }
        let (rows, children) = try thread.flattened()
        var chosen = Set<String>()
        func visit(_ identifier: String) {
            chosen.insert(identifier)
            for child in children[identifier] ?? [] { visit(child) }
        }
        if let member, !branch {
            chosen.insert(member)
        } else {
            for root in member.map { [$0] } ?? thread.rootIds { visit(root) }
        }
        var entry = threads[item.id] ?? ThreadSelectionPlan(threadId: thread.id, mailbox: thread.mailbox, revision: thread.revision, memberIds: [])
        for (node, _) in rows where node.selectable && chosen.contains(node.id) && !entry.memberIds.contains(node.id) {
            entry.memberIds.append(node.id)
        }
        guard entry.memberIds.count <= 1000 else { throw ContractError.invalid("Thread action accepts at most 1000 members") }
        threads[item.id] = entry
    }
    return SelectionPlan(records: records, threads: threads, profileId: profileId)
}

public struct SelectionEntry: Equatable, Sendable {
    public var record: String?
    public var itemID: String?
    public var thread: ThreadSelectionPlan?
    public var member: String?
}

/// Focus is distinct from selection. Entries freeze member IDs *and* the thread
/// revision they were selected under; refresh never widens them (new replies stay
/// unselected), and a revision change makes the plan fail loudly instead of
/// silently upgrading, matching `selection.Selection`/`Session` in Python.
public struct SelectionState: Equatable, Sendable {
    public init() {}
    public private(set) var entries: [String: SelectionEntry] = [:]
    public var count: Int { entries.count }
    public var isEmpty: Bool { entries.isEmpty }

    public mutating func clear() { entries.removeAll() }

    public mutating func toggle(items: [InboxItem], complete: Bool, profileId: String, identifier: String, branch: Bool = false) throws {
        let plan = try selectionTargets(items: items, complete: complete, profileId: profileId, refs: [identifier], branch: branch)
        var members: [(String, SelectionEntry)] = plan.records.map { ($0, SelectionEntry(record: $0)) }
        for (itemID, thread) in plan.threads {
            for member in thread.memberIds {
                members.append((member, SelectionEntry(itemID: itemID, thread: ThreadSelectionPlan(threadId: thread.threadId, mailbox: thread.mailbox, revision: thread.revision, memberIds: thread.memberIds), member: member)))
            }
        }
        let remove = members.allSatisfy { entries[$0.0] != nil }
        for (id, entry) in members {
            if remove { entries[id] = nil } else if entries[id] == nil { entries[id] = entry }
        }
    }

    public func plan(complete: Bool, profileId: String) throws -> SelectionPlan {
        guard complete else { throw ContractError.invalid("Cannot act on incomplete or retained data") }
        guard !entries.isEmpty else { throw ContractError.invalid("Select explicit items first") }
        var result = SelectionPlan(records: [], threads: [:], profileId: profileId)
        for entry in entries.values {
            if let record = entry.record {
                result.records.append(record)
            } else if let itemID = entry.itemID, let thread = entry.thread, let member = entry.member {
                var existing = result.threads[itemID] ?? ThreadSelectionPlan(threadId: thread.threadId, mailbox: thread.mailbox, revision: thread.revision, memberIds: [])
                guard existing.revision == thread.revision else {
                    throw ContractError.invalid("Selection spans thread revisions; clear and reselect")
                }
                existing.memberIds.append(member)
                result.threads[itemID] = existing
            }
        }
        if result.threads.values.contains(where: { $0.memberIds.count > 1000 }) {
            throw ContractError.invalid("Thread action accepts at most 1000 members; select a smaller set")
        }
        return result
    }
}

public struct ActionResult: Equatable, Sendable {
    public var selectedMemberIds: [String] = []
    public var completedItemIds: [String] = []
    public var completedMessageIds: [String] = []
    public var skippedMemberIds: [String] = []
    public var error: String?
}
