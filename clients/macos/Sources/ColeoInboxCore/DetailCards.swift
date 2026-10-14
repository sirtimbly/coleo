import Foundation

/// Native presentation model following the web workbench.message/event/resource
/// presenters. Keep the full payload available rather than flattening it into prose.
public struct DetailCard: Identifiable, Sendable {
    public struct Fact: Identifiable, Sendable {
        public var id: String { label }
        public let label: String
        public let value: String
    }

    public let id: String
    public let title: String
    public let creator: String
    public let kind: String
    public let body: String
    public let timestamp: String?
    public let unread: Bool
    public let requiresAction: Bool
    public let severity: String?
    public let facts: [Fact]
    public let sections: [Fact]
    public let raw: JSONValue

    public var technicalDetails: String {
        guard let data = try? raw.encoded(),
              let object = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: pretty, encoding: .utf8) else { return raw.compactSorted }
        return text
    }

    public static func present(_ detail: JSONValue, fallback: CollectionRow) -> [DetailCard] {
        let messages = detail["messages"]?.array ?? detail["message"].map { [$0] } ?? []
        if !messages.isEmpty {
            return messages.enumerated().map { index, message in
                let messageID = message["id"]?.string
                let node = detail["thread"]?["hierarchy"]?["nodes"]?.array?.first { node in
                    guard let messageID else { return false }
                    return node["id"]?.string == messageID || node["data"]?["messageId"]?.string == messageID
                        || node["data"]?["locations"]?.array?.contains(where: { $0["messageId"]?.string == messageID }) == true
                }
                let matchesSelection = messageID == fallback.id
                let facts = ["to", "cc"].compactMap { key -> Fact? in
                    guard let value = text(message[key]) else { return nil }
                    return Fact(label: key == "to" ? "To" : "Cc", value: value)
                }
                return DetailCard(
                    id: "\(message["id"]?.string ?? fallback.id):\(index)",
                    title: text(message["subject"]) ?? fallback.title,
                    creator: text(message["from"]) ?? "Unknown sender", kind: "Message",
                    body: text(message["body"]) ?? "", timestamp: message["timestamp"]?.string,
                    unread: message["unread"]?.bool ?? node?["data"]?["unread"]?.bool
                        ?? message["flags"]?["seen"]?.bool.map { !$0 } ?? (matchesSelection && fallback.unread),
                    requiresAction: message["requiresAction"]?.bool ?? node?["data"]?["requiresAction"]?.bool
                        ?? (matchesSelection && fallback.requiresAction), severity: nil,
                    facts: facts, sections: [], raw: message)
            }
        }

        let item = detail["item"] ?? detail["statusReport"] ?? detail["report"] ?? detail["event"] ?? detail
        let data = item["data"] ?? item
        let kind = text(item["kind"]) ?? (fallback.id.hasPrefix("status:") ? "Status report" : "Event")
        let facts: [Fact] = [
            ("Status", item["status"] ?? data["status"]),
            ("Arm", item["armId"] ?? data["armId"]),
            ("Task", item["taskId"] ?? data["taskId"]),
            ("Tests", item["testsStatus"] ?? data["testsStatus"]),
            ("Priority", item["priority"]),
        ].compactMap { label, value in
            text(value).map { Fact(label: label, value: ["Status", "Tests"].contains(label)
                ? $0.replacingOccurrences(of: "_", with: " ") : $0) }
        }
        let sections: [Fact] = [
            ("Issues", data["issues"]), ("Blockers", data["blockers"]),
            ("Next steps", data["nextSteps"]), ("Files changed", data["filesChanged"]),
            ("Blocked reason", data["blockedReason"]), ("Resolution", data["resolution"]),
        ].compactMap { label, value in text(value).map { Fact(label: label, value: $0) } }
        return [DetailCard(
            id: fallback.id, title: text(item["title"]) ?? fallback.title,
            creator: text(item["source"]) ?? text(item["armId"]) ?? fallback.source ?? kind.capitalized,
            kind: kind.capitalized,
            body: text(item["description"]) ?? text(item["summary"]) ?? text(data["summary"])
                ?? text(data["message"]) ?? fallback.summary,
            timestamp: text(item["timestamp"]) ?? text(item["createdAt"]) ?? fallback.timestamp,
            unread: item["unread"]?.bool ?? fallback.unread,
            requiresAction: item["requiresAction"]?.bool ?? fallback.requiresAction,
            severity: text(item["severity"]), facts: facts, sections: sections, raw: detail)]
    }

    private static func text(_ value: JSONValue?) -> String? {
        guard let value else { return nil }
        if let string = value.string { return string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : string }
        if let values = value.array {
            let joined = values.compactMap { text($0) }.joined(separator: "\n")
            return joined.isEmpty ? nil : joined
        }
        return nil
    }
}
