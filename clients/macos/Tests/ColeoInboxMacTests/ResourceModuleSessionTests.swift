import Combine
import ColeoInboxCore
import XCTest
@testable import ColeoInboxMac

final class ResourceModuleSessionTests: XCTestCase {
    private func module() throws -> WorkbenchModule {
        try ModuleCatalog.decode(Data(#"{"schemaVersion":1,"modules":[{"id":"tasks","title":"Tasks","description":"Work","symbol":"checklist","renderer":"tasks"}]}"#.utf8)).modules[0]
    }

    @MainActor
    private func waitForRefresh(_ session: ResourceModuleSession, action: () -> Void) async {
        let finished = expectation(description: "Refresh completed")
        let subscription = session.$isLoading.dropFirst().filter { !$0 }.prefix(1).sink { _ in finished.fulfill() }
        action()
        await fulfillment(of: [finished], timeout: 3)
        subscription.cancel()
    }

    @MainActor
    func testRefreshUpdatesTheRetainedSelectionDetail() async throws {
        let transport = ModuleTransport()
        let session = ResourceModuleSession(module: try module(), transport: transport)
        await waitForRefresh(session) { session.reload() }
        session.focusID = "task-0"
        await session.loadDetail()
        XCTAssertEqual(session.detail?.status, "pending")
        await transport.completeTask()
        await waitForRefresh(session) { session.reload() }
        XCTAssertEqual(session.focusID, "task-0")
        XCTAssertEqual(session.detail?.status, "completed")
        session.stop()
    }

    @MainActor
    func testDraftSearchCannotMixQueriesAcrossPages() async throws {
        let transport = ModuleTransport()
        let session = ResourceModuleSession(module: try module(), transport: transport)
        session.search = "initial"
        await waitForRefresh(session) { session.reload(reset: true) }
        await transport.setPageHook { await MainActor.run { session.search = "unsubmitted draft" } }
        await waitForRefresh(session) { session.loadMore() }
        let searches = await transport.searches
        XCTAssertEqual(Array(searches.suffix(2)), ["initial", "initial"])
        XCTAssertEqual(session.records.count, 2)
        session.stop()
    }
}

private actor ModuleTransport: InboxTransport {
    private var status = "pending"
    private var hook: (@Sendable () async -> Void)?
    private(set) var searches: [String] = []

    func completeTask() { status = "completed" }
    func setPageHook(_ hook: @escaping @Sendable () async -> Void) { self.hook = hook }

    func request(path: String, body: JSONValue?, queryItems: [(String, String)]) async throws -> JSONValue {
        if path == "/api/tasks" {
            let query = Dictionary(uniqueKeysWithValues: queryItems)
            searches.append(query["search"] ?? "")
            let offset = query["offset"] ?? "0"
            if offset == "0", let hook { await hook() }
            return .object(["tasks": .array([record(id: "task-\(offset)")]),
                            "pagination": .object(["total": .number(200)])])
        }
        return .object(["task": record(id: "task-0")])
    }

    private func record(id: String) -> JSONValue {
        .object(["id": .string(id), "subject": .string("Test task"), "status": .string(status),
                 "description": .string("Full detail")])
    }
}
