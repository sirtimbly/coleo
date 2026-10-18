import ColeoInboxCore
import Foundation
import XCTest
@testable import ColeoInboxMac

final class MessageNotificationTests: XCTestCase {
    private func items(_ messages: [(String, String)], revision: String = "1") throws -> [InboxItem] {
        let query = MessagingQuery()
        let nodes: [JSONValue] = messages.map { id, mailbox in
            .object([
                "id": .string(id), "kind": .string("resource"), "selectable": .bool(true),
                "data": .object(["messageId": .string(id), "title": .string(id),
                    "locations": .array([.object(["mailbox": .string(mailbox)])])]),
            ])
        }
        let page = try InboxPage(json: .object([
            "schemaVersion": .number(1), "queryId": .string(query.identity), "query": query.json,
            "items": .array([.object([
                "id": .string("thread:one"), "sourceId": .string("mail"), "representation": .string("thread"),
                "thread": .object([
                    "id": .string("one"), "revision": .string(revision),
                    "hierarchy": .object(["schemaVersion": .number(1),
                        "rootIds": .array(messages.map { .string($0.0) }), "nodes": .array(nodes)]),
                ]),
            ])]),
        ]), expectedQuery: query, expectedCursor: nil)
        return page.items
    }

    func testInitialBaselineAndReplyInExistingThread() throws {
        var tracker = MessageArrivalTracker()
        let watch = UUID()
        XCTAssertEqual(tracker.arrivals(watch: watch, profile: "local", items: try items([("old", "inbox")])), [])
        let reply = try items([("old", "inbox"), ("new", "inbox"), ("sent-context", "sent")])
        XCTAssertEqual(tracker.arrivals(watch: watch, profile: "local", items: reply), ["new"])
        XCTAssertEqual(tracker.arrivals(watch: watch, profile: "local", items: reply), [])
        XCTAssertEqual(tracker.arrivals(watch: watch, profile: "local",
            items: try items([("old", "inbox"), ("new", "inbox")], revision: "read-state-change")), [])
    }

    func testOverlappingWatchesDoNotNotifyTwiceAndRemovalsDoNotForgetIDs() throws {
        var tracker = MessageArrivalTracker()
        let first = UUID(), second = UUID()
        for watch in [first, second] {
            XCTAssertEqual(tracker.arrivals(watch: watch, profile: "local", items: try items([])), [])
        }
        let message = try items([("new", "inbox")])
        XCTAssertEqual(tracker.arrivals(watch: first, profile: "local", items: message), ["new"])
        XCTAssertEqual(tracker.arrivals(watch: second, profile: "local", items: message), [])
        XCTAssertEqual(tracker.arrivals(watch: first, profile: "local", items: []), [])
        XCTAssertEqual(tracker.arrivals(watch: first, profile: "local", items: message), [])
    }

    func testEmptyInitialCollectionAndMailboxFiltering() throws {
        var tracker = MessageArrivalTracker()
        let watch = UUID()
        XCTAssertEqual(tracker.arrivals(watch: watch, profile: "local", items: []), [])
        XCTAssertEqual(tracker.arrivals(watch: watch, profile: "local",
            items: try items([("sent", "sent"), ("received", "inbox")])), ["received"])
    }
}
