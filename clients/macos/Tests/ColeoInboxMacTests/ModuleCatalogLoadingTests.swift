import Foundation
import XCTest
@testable import ColeoInboxMac

final class ModuleCatalogLoadingTests: XCTestCase {
    private func catalog(_ id: String, title: String) -> Data {
        Data("""
        {"schemaVersion":1,"modules":[{"id":"\(id)","title":"\(title)","description":"Work","symbol":"checklist","renderer":"tasks"}]}
        """.utf8)
    }

    @MainActor
    func testStartupAndExplicitReloadUseTheExternalFileAsAuthority() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("modules.json")
        try catalog("tasks", title: "Original").write(to: url)
        let workspace = WorkbenchWorkspace(catalogURL: url)
        XCTAssertEqual(workspace.modules.map(\.id), ["tasks"])
        XCTAssertEqual(workspace.modules.first?.title, "Original")

        try catalog("other-tasks", title: "Edited on disk").write(to: url, options: .atomic)
        XCTAssertEqual(workspace.modules.first?.title, "Original") // No implicit file watching.
        workspace.reloadCatalog()
        XCTAssertEqual(workspace.modules.map(\.id), ["other-tasks"])
        XCTAssertEqual(workspace.modules.first?.title, "Edited on disk")
        XCTAssertEqual(WorkbenchWorkspace(catalogURL: url).modules, workspace.modules)

        try Data("not valid JSON".utf8).write(to: url)
        workspace.reloadCatalog()
        XCTAssertNotNil(workspace.error)
        XCTAssertEqual(workspace.modules.first?.title, "Edited on disk")
        try catalog("tasks", title: "Repaired").write(to: url)
        workspace.reloadCatalog()
        XCTAssertNil(workspace.error)
        XCTAssertEqual(workspace.modules.first?.title, "Repaired")
    }

    @MainActor
    func testMissingExplicitCatalogReportsItsPathWithoutReplacingIt() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".json")
        let workspace = WorkbenchWorkspace(catalogURL: url)
        XCTAssertTrue(workspace.error?.contains(url.path) == true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }
}
