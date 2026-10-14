import Foundation
import XCTest
@testable import ColeoInboxCore

/// Registry and document contracts keep real modules distinct from Inbox facets.
final class WorkbenchModuleTests: XCTestCase {
    private func catalog(_ modules: String) throws -> ModuleCatalog {
        try ModuleCatalog.decode(Data("{\"schemaVersion\":1,\"modules\":[\(modules)]}".utf8))
    }

    func testDomainModulesDoNotNeedAnInboxTemplate() throws {
        let entries = ["tasks", "bugs", "brain", "dashboard"].map {
            "{\"id\":\"\($0)\",\"title\":\"\($0)\",\"description\":\"Domain module\",\"symbol\":\"square\",\"renderer\":\"\($0)\"}"
        }.joined(separator: ",")
        let result = try catalog(entries)
        XCTAssertEqual(result.modules.map(\.renderer), ["tasks", "bugs", "brain", "dashboard"])
        XCTAssertTrue(result.modules.allSatisfy { $0.namedView == nil && $0.facet == nil })
    }

    func testRepeatedModuleDocumentsHaveIndependentRestorableIdentity() throws {
        let first = ModuleDocument(module: .inbox)
        let second = ModuleDocument(module: .inbox)
        XCTAssertNotEqual(first.id, second.id)
        XCTAssertEqual(try JSONDecoder().decode(ModuleDocument.self, from: JSONEncoder().encode(first)), first)
    }

    func testCatalogRejectsUnsupportedAndDuplicateModules() throws {
        let entry = #"{"id":"tasks","title":"Tasks","description":"Work","symbol":"checklist","renderer":"tasks"}"#
        XCTAssertThrowsError(try catalog("\(entry),\(entry)"))
        XCTAssertThrowsError(try catalog(entry.replacingOccurrences(of: #""renderer":"tasks""#, with: #""renderer":"unknown""#)))
        XCTAssertThrowsError(try catalog(entry.replacingOccurrences(of: #""renderer":"tasks""#, with: #""renderer":"messaging""#)))
    }

    func testTaskAndBugPagesPreserveDomainDetails() throws {
        let tasks = try JSONValue.decode(Data(#"{"tasks":[{"id":"task_1","subject":"Ship native modules","description":"Full task description","status":"blocked","blockedReason":"Waiting for review","priority":"high","assignedTo":"arm_1"}],"pagination":{"total":125}}"#.utf8))
        let page = try ModuleRecordPage(json: tasks, renderer: "tasks")
        XCTAssertEqual(page.total, 125)
        XCTAssertEqual(page.records.first?.title, "Ship native modules")
        XCTAssertEqual(page.records.first?.owner, "arm_1")
        XCTAssertEqual(page.records.first?.card.body, "Full task description")
        XCTAssertEqual(page.records.first?.card.sections.first?.value, "Waiting for review")
        XCTAssertThrowsError(try ModuleRecordPage(json: tasks, renderer: "bugs"))
        let bugs = try JSONValue.decode(Data(#"{"bugs":[{"id":"bug_1","title":"Inspect this","description":"Full report","status":"resolved","resolution":"Fixed encoding"}],"pagination":{"total":1}}"#.utf8))
        let bug = try XCTUnwrap(ModuleRecordPage(json: bugs, renderer: "bugs").records.first)
        XCTAssertEqual(bug.card.sections.first?.value, "Fixed encoding")
    }
}
