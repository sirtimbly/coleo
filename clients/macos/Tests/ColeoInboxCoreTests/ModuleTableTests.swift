import Foundation
import XCTest
@testable import ColeoInboxCore

final class ModuleTableTests: XCTestCase {
    func testSeveritySortingAcrossTaskAndBugPriorities() throws {
        let records = try ["low", "normal", "critical", "medium", "high", "unknown"].enumerated().map { index, priority in
            try ModuleRecord(json: .object([
                "id": .string(String(index)), "priority": .string(priority)
            ]), kind: priority == "medium" ? "bug" : "task")
        }
        let sorting = try JSONDecoder().decode(ModuleSorting.self, from: Data("""
        {"fields":[{"field":"priority","values":["critical","high","normal","medium","low"]}],
         "defaultOrder":[{"field":"priority","direction":"asc"}]}
        """.utf8))
        try sorting.validated()
        let sorted = records.sorted(using: sorting.comparators)
        XCTAssertEqual(sorted.map(\.priority), ["critical", "high", "normal", "medium", "low", "unknown"])
        var comparator = try XCTUnwrap(sorting.comparator(for: "priority"))
        comparator.order = .reverse
        let reversed = records.sorted(using: comparator)
        XCTAssertEqual(reversed.map(\.priority), ["unknown", "low", "medium", "normal", "high", "critical"])
        XCTAssertNil(sorting.comparator(for: "title"))
    }

    func testCustomJSONOrderAndValidation() throws {
        let data = Data("""
        {"fields":[{"field":"status","values":["blocked","in_progress","pending"]}],
         "defaultOrder":[{"field":"status","direction":"asc"}]}
        """.utf8)
        let sorting = try JSONDecoder().decode(ModuleSorting.self, from: data)
        let records = try ["pending", "blocked", "in_progress"].map {
            try ModuleRecord(json: .object(["id": .string($0), "status": .string($0)]), kind: "task")
        }
        XCTAssertEqual(records.sorted(using: sorting.comparators).map(\.status), ["blocked", "in_progress", "pending"])
        let invalid = try JSONDecoder().decode(ModuleSorting.self, from: Data("""
        {"fields":[{"field":"title"}],"defaultOrder":[{"field":"priority","direction":"asc"}]}
        """.utf8))
        XCTAssertThrowsError(try invalid.validated())
    }

    func testCopyRowRemainsOneTabSeparatedLine() throws {
        let record = try ModuleRecord(json: .object([
            "id": .string("task-1"), "subject": .string("Fix\tsearch\nresults"),
            "status": .string("in_progress"), "priority": .string("high"),
            "assignedArmName": .string("Worker A")
        ]), kind: "task")
        XCTAssertEqual(record.clipboardSummary, "task-1\tFix search results\tin_progress\thigh\tWorker A")
    }
}
