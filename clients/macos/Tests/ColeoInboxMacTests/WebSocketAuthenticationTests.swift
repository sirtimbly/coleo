import XCTest
@testable import ColeoInboxMac

final class WebSocketAuthenticationTests: XCTestCase {
    func testSilentPeerIsClosedAndDeadlineReturns() async {
        let io = SuspendedIO()
        do {
            try await withAuthenticationDeadline(nanoseconds: 20_000_000, cancel: { io.cancel() }) {
                try await io.receive()
            }
            XCTFail("Silent authentication must fail")
        } catch {
            XCTAssertTrue(io.cancelled)
        }
    }

    func testSuccessfulAuthenticationDoesNotCloseSocket() async throws {
        let io = SuspendedIO()
        try await withAuthenticationDeadline(cancel: { io.cancel() }) {}
        XCTAssertFalse(io.cancelled)
    }

    func testCancellationUnblocksPendingReceive() async {
        let io = SuspendedIO()
        let task = Task {
            try await withAuthenticationDeadline(cancel: { io.cancel() }) { try await io.receive() }
        }
        task.cancel()
        _ = await task.result
        XCTAssertTrue(io.cancelled)
    }
}

private final class SuspendedIO: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Error>?
    private var closed = false
    var cancelled: Bool { lock.withLock { closed } }

    func receive() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            lock.withLock {
                if closed { continuation.resume(throwing: CancellationError()) }
                else { self.continuation = continuation }
            }
        }
    }

    func cancel() {
        lock.withLock {
            closed = true
            continuation?.resume(throwing: CancellationError())
            continuation = nil
        }
    }
}
