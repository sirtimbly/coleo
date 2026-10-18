import Foundation
import XCTest
@testable import ColeoInboxCore

/// Exercise URLSession's actual request construction, not just a mocked InboxTransport.
final class APITransportTests: XCTestCase {
    private func api() -> InboxAPI {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MailDetailProtocol.self]
        let transport = URLSessionTransport(baseURL: URL(string: "https://coleo.test/proxy/")!,
                                            session: URLSession(configuration: configuration))
        return InboxAPI(transport: transport)
    }

    func testThreadAndMessageIDsAreEncodedExactlyOnce() async throws {
        for kind in ["thread", "message"] {
            let reference = "\(kind):\(MailDetailProtocol.mailID)"
            let result = try await api().inspect(reference: reference, profileId: "profile + 日本語")
            XCTAssertEqual(result.detail["body"]?.string, "Full message content")
            XCTAssertEqual(result.detail["mailbox"]?.string, "archive")
            XCTAssertEqual(result.target["id"]?.string, reference)
        }
    }

    func testHTTPErrorReachesLocalizedDescription() async throws {
        do {
            _ = try await api().transport.request(path: "/missing")
            XCTFail("Expected HTTP failure")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Message not found in this thread")
        }
    }

    func testContractErrorReachesLocalizedDescription() {
        let error: Error = ContractError.invalid("Reference lookup returned another resource")
        XCTAssertEqual(error.localizedDescription, "Reference lookup returned another resource")
    }
}

private final class MailDetailProtocol: URLProtocol {
    static let mailID = "<first+part/50%?日本語@example.test>"

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
        // Model the server's single URL decoding. A double-encoded ID won't match.
        let path = components.percentEncodedPath.removingPercentEncoding!
        let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        var payload: JSONValue = .object(["error": .string("Message not found in this thread")])
        var status = 404
        for kind in ["thread", "message"] {
            let reference = "\(kind):\(Self.mailID)"
            if path == "/proxy/api/workbench/inbox/references/\(reference)", query["profileId"] == "profile + 日本語" {
                status = 200
                payload = .object([
                    "schemaVersion": .number(1), "id": .string(reference),
                    "detail": .object(["kind": .string(kind), "threadId": .string(Self.mailID),
                                       "messageId": .string(Self.mailID), "mailbox": .string("archive")]),
                ])
            }
        }
        let threadPath = "/proxy/api/mail/threads/\(Self.mailID)"
        if [threadPath, "\(threadPath)/messages/\(Self.mailID)"].contains(path), query["mailbox"] == "archive" {
            status = 200
            payload = .object(["body": .string("Full message content"), "mailbox": .string("archive")])
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! payload.encoded())
        client?.urlProtocolDidFinishLoading(self)
    }
}
