import Foundation
import XCTest
@testable import ColeoInboxCore

final class ColeoInboxCoreTests: XCTestCase {
    private func fixture(_ name: String) throws -> JSONValue {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
        return try JSONValue.decode(Data(contentsOf: url))
    }

    func testReferenceMatchesSharedContract() {
        // Same algorithm as Python contracts.reference: "@" + sha256(id)[:8]
        XCTAssertEqual(shortReference("thread:<first@example.test>").count, 9)
        XCTAssertTrue(shortReference("thread:<first@example.test>").hasPrefix("@"))
        XCTAssertEqual(shortReference("abc"), shortReference("abc"))
        XCTAssertNotEqual(shortReference("abc"), shortReference("abd"))
    }

    func testNativeViewResolvesDynamically() throws {
        let view = try ResolvedView(json: fixture("native-view"))
        XCTAssertEqual(view.client, "native")
        XCTAssertEqual(view.viewID, "inbox-triage")
        XCTAssertEqual(view.query.facet, "attention")
        // Native capabilities resolve the real renderers, not TUI fallbacks.
        XCTAssertEqual(view.feature(forPresentation: "cards")?.implementation, "collection.cards")
        XCTAssertEqual(view.feature(forPresentation: "timeline")?.implementation, "messaging.timeline")
        XCTAssertFalse(view.slots.isEmpty)
        // Like the TUI: mark-read has no keyboard binding in the named view, so it is
        // reported unavailable as a shortcut; the toolbar button is the host control.
        XCTAssertEqual(view.binding(forOperation: "inbox.mark-read")?.available, false)
        XCTAssertNotNil(view.binding(forOperation: "inbox.mark-read")?.diagnostic)
        XCTAssertTrue(view.commands.contains("inbox.mark-read"))
        XCTAssertEqual(view.binding(forOperation: "collection.next")?.keyboard.first?.key, "ArrowDown")
    }

    func testQueryIdentityMatchesFixturePage() throws {
        let page = try fixture("page")
        let query = try MessagingQuery(json: page["query"]!)
        XCTAssertEqual(query.identity, page["queryId"]?.string)
    }

    func testPageValidationAndHierarchy() throws {
        let pageJSON = try fixture("page")
        let query = try MessagingQuery(json: pageJSON["query"]!)
        let page = try InboxPage(json: pageJSON, expectedQuery: query, expectedCursor: nil)
        XCTAssertEqual(page.items.count, 1)
        let thread = try XCTUnwrap(page.items.first?.thread)
        let (rows, children) = try thread.flattened()
        XCTAssertEqual(rows.count, 4)
        XCTAssertEqual(children["message:<first@example.test>"]?.count, 2)
    }

    func testQueryChangeResetsFacetDependentFields() throws {
        var query = MessagingQuery()
        query.facet = "messages"
        query.mailbox = "archive"
        query.facet = "attention"
        XCTAssertEqual(query.normalized.mailbox, "inbox")
        XCTAssertThrowsError(try MessagingQuery(json: .object(["limit": .number(0)])))
    }

    func testSelectionFreezesRevisionAndBranch() throws {
        let pageJSON = try fixture("page")
        let query = try MessagingQuery(json: pageJSON["query"]!)
        let page = try InboxPage(json: pageJSON, expectedQuery: query, expectedCursor: nil)

        let member = try selectionTargets(items: page.items, complete: true, profileId: "local", refs: ["message:<first@example.test>"])
        XCTAssertEqual(member.threads.values.first?.memberIds, ["message:<first@example.test>"])
        XCTAssertEqual(member.threads.values.first?.revision, "fixture-revision-1")

        let branch = try selectionTargets(items: page.items, complete: true, profileId: "local", refs: ["message:<first@example.test>"], branch: true)
        XCTAssertEqual(Set(branch.threads.values.first?.memberIds ?? []),
                       ["message:<first@example.test>", "message:<reply@example.test>", "message:<branch@example.test>"])

        var state = SelectionState()
        try state.toggle(items: page.items, complete: true, profileId: "local", identifier: "message:<branch@example.test>")
        XCTAssertEqual(state.count, 1)
        let plan = try state.plan(complete: true, profileId: "local")
        XCTAssertEqual(plan.threads.values.first?.revision, "fixture-revision-1")

        XCTAssertThrowsError(try selectionTargets(items: page.items, complete: false, profileId: "local", refs: ["message:<first@example.test>"]))
        XCTAssertThrowsError(try selectionTargets(items: page.items, complete: true, profileId: "local", refs: ["@missing0"]))
    }

    func testSelectAllIncludesLoadedMembersAndIsIdempotent() throws {
        let json = try fixture("page")
        let page = try InboxPage(json: json, expectedQuery: MessagingQuery(json: json["query"]!), expectedCursor: nil)
        var state = SelectionState()
        try state.toggle(items: page.items, complete: true, profileId: "local", identifier: "message:<branch@example.test>")
        let existing = state.entries["message:<branch@example.test>"]
        try state.selectAll(items: page.items, complete: true, profileId: "local")
        XCTAssertEqual(state.count, 3)
        XCTAssertEqual(state.entries["message:<branch@example.test>"], existing)
        let selected = state
        try state.selectAll(items: page.items, complete: true, profileId: "local")
        XCTAssertEqual(state, selected)
        XCTAssertThrowsError(try state.selectAll(items: page.items, complete: false, profileId: "local"))
        XCTAssertEqual(state, selected)
        XCTAssertEqual(try state.plan(complete: true, profileId: "local").threads.values.first?.revision, "fixture-revision-1")
    }

    func testCollectionRowsRespectFolding() throws {
        let pageJSON = try fixture("page")
        let query = try MessagingQuery(json: pageJSON["query"]!)
        let page = try InboxPage(json: pageJSON, expectedQuery: query, expectedCursor: nil)
        var initialized = Set<String>()
        let expanded = collectionRows(items: page.items, expansion: "all", folded: [], initializedThreads: &initialized)
        XCTAssertEqual(expanded.count, 5) // item + thread group node + 3 members, as in the TUI
        let collapsed = collectionRows(items: page.items, expansion: "all", folded: [page.items[0].id], initializedThreads: &initialized)
        XCTAssertEqual(collapsed.count, 1)
    }

    func testDetailRenderingShape() throws {
        let detail = try fixture("detail")
        XCTAssertEqual(detail["thread"]?["hierarchy"]?["nodes"]?.array?.count, 4)
    }
}
