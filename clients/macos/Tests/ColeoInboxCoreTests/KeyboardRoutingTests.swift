import Foundation
import XCTest
@testable import ColeoInboxCore

final class KeyboardRoutingTests: XCTestCase {
    private func bindings() throws -> [ResolvedBinding] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "native-view", withExtension: "json", subdirectory: "Fixtures"))
        return try ResolvedView(json: JSONValue.decode(Data(contentsOf: url))).bindings
    }

    func testNavigationAndLiteralQuestionMark() throws {
        let bindings = try bindings()
        XCTAssertEqual(keyboardOperation(bindings: bindings, key: "ArrowDown", modifiers: [], tree: false), "collection.next")
        XCTAssertEqual(keyboardOperation(bindings: bindings, key: "j", modifiers: [], tree: false), "collection.next")
        XCTAssertEqual(keyboardOperation(bindings: bindings, key: "?", modifiers: ["shift"], tree: false), "collection.help")
        XCTAssertEqual(keyboardOperation(bindings: bindings, key: "/", modifiers: [], tree: false), "collection.search")
        XCTAssertNil(keyboardOperation(bindings: bindings, key: "r", modifiers: ["command"], tree: false))
        XCTAssertNil(keyboardOperation(bindings: bindings, key: "r", modifiers: ["shift"], tree: false))
    }

    func testTreeSpaceSelectsBranchAndHelpScopeDoesNotLeak() throws {
        let bindings = try bindings()
        XCTAssertEqual(keyboardOperation(bindings: bindings, key: "Space", modifiers: [], tree: false), "collection.select")
        XCTAssertEqual(keyboardOperation(bindings: bindings, key: "Space", modifiers: [], tree: true), "collection.select-branch")
        XCTAssertNil(keyboardOperation(bindings: bindings, key: "Escape", modifiers: [], tree: false))
    }

    func testPrimaryModifierMapsToCommandAndUnavailableBindingsStayDisabled() throws {
        var binding = try XCTUnwrap(bindings().first { $0.operation == "collection.refresh" })
        binding.keyboard = [KeyboardBinding(key: "r", modifiers: ["primary", "shift"], scope: "collection")]
        XCTAssertEqual(keyboardOperation(bindings: [binding], key: "R", modifiers: ["command", "shift"], tree: false), "collection.refresh")
        XCTAssertNil(keyboardOperation(bindings: [binding], key: "r", modifiers: ["control", "shift"], tree: false))
        binding.available = false
        XCTAssertNil(keyboardOperation(bindings: [binding], key: "r", modifiers: ["command", "shift"], tree: false))
    }
}
