import Foundation
import XCTest
@testable import ColeoInboxCore

/// The presentation boundary must preserve full content across API detail shapes.
final class DetailCardsTests: XCTestCase {
    private var row: CollectionRow {
        CollectionRow(id: "status:report", parentId: nil, depth: 0, itemID: "status:report",
                      selectable: true, title: "Review requested", summary: "List preview", timestamp: nil,
                      source: "Brain", unread: true, requiresAction: true, hasChildren: false)
    }

    func testConversationKeepsEveryFullMessageInOrder() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "detail", withExtension: "json", subdirectory: "Fixtures"))
        let payload = try JSONValue.decode(Data(contentsOf: url))
        let cards = DetailCard.present(payload, fallback: row)
        XCTAssertEqual(cards.count, 3)
        XCTAssertEqual(cards.map(\.creator), ["Tim", "Brain", "Arm"])
        XCTAssertTrue(cards[0].title.contains("日本語"))
        XCTAssertTrue(cards[0].body.contains("Full **Markdown** content"))
        XCTAssertEqual(cards[0].facts.first?.value, "Tim")
        XCTAssertEqual(Set(cards.map(\.id)).count, 3)
        XCTAssertEqual(cards.map(\.unread), [true, false, true])
        XCTAssertEqual(cards.map(\.requiresAction), [true, false, true])
    }

    func testSingleMessageUsesFlagsAndPreservesUnknownFields() throws {
        let payload = try JSONValue.decode(Data(#"{"message":{"id":"1","from":"A","subject":"Subject","body":"Full body","flags":{"seen":false},"custom":"retained"}}"#.utf8))
        let card = try XCTUnwrap(DetailCard.present(payload, fallback: row).first)
        XCTAssertTrue(card.unread)
        XCTAssertEqual(card.body, "Full body")
        XCTAssertTrue(card.technicalDetails.contains("retained"))
        XCTAssertFalse(card.requiresAction)
    }

    func testStatusReportUsesSummaryFactsAndSections() throws {
        let payload = try JSONValue.decode(Data(#"{"report":{"armId":"arm_1","taskId":"task_1","status":"needs_review","summary":"Full report","issues":["First issue","Second issue"],"nextSteps":"Review the change","testsStatus":"passing"}}"#.utf8))
        let card = try XCTUnwrap(DetailCard.present(payload, fallback: row).first)
        XCTAssertEqual(card.body, "Full report")
        XCTAssertEqual(card.creator, "arm_1")
        XCTAssertEqual(card.facts.first { $0.label == "Task" }?.value, "task_1")
        XCTAssertEqual(card.facts.first?.value, "needs review")
        XCTAssertEqual(card.sections.first?.value, "First issue\nSecond issue")
        XCTAssertTrue(card.technicalDetails.contains("nextSteps"))
    }

    func testEventUsesProjectionAndRetainsRawEvent() throws {
        let payload = try JSONValue.decode(Data(#"{"item":{"title":"Poll skipped","summary":"No work available","severity":"warning","requiresAction":false},"event":{"data":{"reason":"idle"}}}"#.utf8))
        let card = try XCTUnwrap(DetailCard.present(payload, fallback: row).first)
        XCTAssertEqual(card.title, "Poll skipped")
        XCTAssertEqual(card.body, "No work available")
        XCTAssertFalse(card.requiresAction)
        XCTAssertTrue(card.technicalDetails.contains("idle"))
    }
}
