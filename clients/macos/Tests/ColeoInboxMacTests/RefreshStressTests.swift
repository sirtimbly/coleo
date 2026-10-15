import ColeoInboxCore
import Foundation
import XCTest
@testable import ColeoInboxMac

/// Exercise real URLSession async completion and JSON decoding while document
/// sessions replace/cancel refresh tasks. Mocking InboxTransport skips this path.
final class RefreshStressTests: XCTestCase {
    @MainActor
    func testConcurrentDocumentRefreshAndCancellation() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RefreshStressProtocol.self]
        let network = URLSession(configuration: configuration)
        defer { network.invalidateAndCancel() }
        let transport = URLSessionTransport(baseURL: URL(string: "https://refresh.test")!, session: network)
        let modules = try ModuleCatalog.decode(Data(#"{"schemaVersion":1,"modules":[{"id":"tasks","title":"Tasks","description":"Tasks","symbol":"checklist","renderer":"tasks"},{"id":"dashboard","title":"Dashboard","description":"Overview","symbol":"chart.bar","renderer":"dashboard"}]}"#.utf8)).modules
        let sessions = (0..<12).map { ResourceModuleSession(module: modules[$0 % 2], transport: transport) }
        defer { sessions.forEach { $0.stop() } }
        for session in sessions { session.start() }
        for iteration in 0..<40 {
            for (index, session) in sessions.enumerated() {
                if (iteration + index) % 3 == 0 { session.stop(); session.start() }
                else { session.reload() }
            }
            try await Task.sleep(for: .milliseconds(5))
        }
        for session in sessions { session.reload() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while sessions.contains(where: { $0.updatedAt == nil || $0.isLoading }), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        for session in sessions {
            XCTAssertNil(session.error)
            XCTAssertFalse(session.isLoading)
            XCTAssertNotNil(session.updatedAt)
            if session.isCollection { XCTAssertEqual(session.records.count, 100) }
            else {
                XCTAssertEqual(Set(session.snapshots.keys), ["brain", "tasks", "bugs"])
                XCTAssertEqual(session.snapshots["brain"]?["brain"]?["status"]?.string, "running")
                XCTAssertEqual(session.snapshots["tasks"]?["total"]?.int, 100)
                XCTAssertEqual(session.snapshots["bugs"]?["total"]?.int, 100)
                XCTAssertTrue(session.sourceErrors.isEmpty)
            }
        }
    }
}

private final class RefreshStressProtocol: URLProtocol {
    private static let records = try! JSONValue.object([
        "tasks": .array((0..<100).map { index in .object([
            "id": .string("task-\(index)"), "subject": .string("Task \(index) 🐙"),
            "description": .string(String(repeating: "Unicode 日本語 and nested detail. ", count: 100)),
            "status": .string("pending"), "metadata": .object(["tags": .array([.string("stress")])]),
        ]) }),
        "pagination": .object(["total": .number(100)]),
    ]).encoded()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        let data: Data
        switch request.url!.path {
        case "/api/tasks": data = Self.records
        case "/api/brain/status": data = Data(#"{"brain":{"status":"running"}}"#.utf8)
        default: data = Data(#"{"total":100,"byStatus":{"pending":100}}"#.utf8)
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}
