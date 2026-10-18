import Foundation

/// The cancellation callback must unblock pending I/O, including an unresponsive
/// WebSocket receive. A task-group timeout alone would wait for that child forever.
func withAuthenticationDeadline(
    nanoseconds: UInt64 = 10_000_000_000,
    cancel: @escaping @Sendable () -> Void,
    operation: @escaping @Sendable () async throws -> Void
) async throws {
    try await withTaskCancellationHandler {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(nanoseconds: nanoseconds)
                cancel()
                throw URLError(.timedOut)
            }
            defer { group.cancelAll() }
            try await group.next()
        }
    } onCancel: {
        cancel()
    }
}
