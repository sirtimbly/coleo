import AppKit
import ColeoInboxCore
import SwiftUI
import UserNotifications

struct NotificationWatch: Codable, Equatable, Identifiable {
    var id = UUID()
    var namedView = "inbox-triage"
    var facet = "messages"
    var mailbox = "inbox"
    var enabled = true

    var label: String { "\(namedView) → \(facet)" + (facet == "messages" ? " (\(mailbox))" : "") }
}

struct NotificationPreferences: Codable, Equatable {
    var enabled = true
    var bounceDock = true
    var sound = true
    var watches = [NotificationWatch()]
}

/// Baseline complete snapshots only. Thread member IDs detect replies even when
/// the top-level thread ID is unchanged. Updates/read-state changes are not arrivals.
struct MessageArrivalTracker {
    private var seen: [UUID: Set<String>] = [:]
    private var announced = Set<String>()

    mutating func arrivals(watch: UUID, profile: String, items: [InboxItem], mailbox: String = "inbox") -> [String] {
        var candidates: [String: String] = [:]
        for item in items where item.sourceId == "mail" {
            if let thread = item.thread {
                for node in thread.nodes where node.kind == "resource" && node.data["messageId"]?.string != nil {
                    let locations = node.data["locations"]?.array ?? []
                    guard locations.contains(where: { $0["mailbox"]?.string == mailbox })
                        || (locations.isEmpty && node.data["mailbox"]?.string == mailbox) else { continue }
                    let id = node.data["messageId"]?.string ?? node.id
                    candidates[profile + ":" + id] = node.title
                }
            } else {
                let id = item.json["detail"]?["messageId"]?.string ?? item.id
                candidates[profile + ":" + id] = item.title
            }
        }
        let ids = Set(candidates.keys)
        guard let previous = seen[watch] else {
            seen[watch] = ids
            announced.formUnion(ids)
            return []
        }
        seen[watch, default: []].formUnion(ids)
        let fresh = ids.subtracting(previous).subtracting(announced)
        announced.formUnion(fresh)
        return fresh.sorted().compactMap { candidates[$0] }
    }
}

/// One app-owned monitor, independent of visible tabs, selection, and pagination.
@MainActor
final class MessageNotifications: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    @Published var preferences: NotificationPreferences
    @Published private(set) var status = "Not started"
    @Published private(set) var permission = "Not requested"
    private var task: Task<Void, Never>?
    private var tracker = MessageArrivalTracker()
    private var generation = UUID()
    private var started = false
    private let defaults: UserDefaults
    private static let settingsKey = "coleo.messageNotifications"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        preferences = defaults.data(forKey: Self.settingsKey)
            .flatMap { try? JSONDecoder().decode(NotificationPreferences.self, from: $0) }
            ?? NotificationPreferences()
        super.init()
    }

    func start() {
        guard !started else { return }
        // SwiftPM tests/command-line executables have no notification bundle.
        guard Bundle.main.bundleIdentifier != nil else { return }
        started = true
        UNUserNotificationCenter.current().delegate = self
        NotificationCenter.default.addObserver(self, selector: #selector(connectionChanged),
            name: .inboxSettingsChanged, object: nil)
        restart()
    }

    @objc private func connectionChanged() { restart() }

    func save() {
        do {
            for watch in preferences.watches {
                guard !watch.namedView.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw ContractError.invalid("Enter a named view for every watch")
                }
            }
            defaults.set(try JSONEncoder().encode(preferences), forKey: Self.settingsKey)
            restart()
        } catch { status = error.localizedDescription }
    }

    func restart() {
        task?.cancel()
        generation = UUID()
        tracker = MessageArrivalTracker()
        guard preferences.enabled else { task = nil; status = "Notifications off"; return }
        let current = generation
        let watches = preferences.watches.filter(\.enabled)
        let settings = InboxSettings.load()
        let api = InboxAPI(transport: URLSessionTransport(baseURL: settings.url, apiKey: settings.key))
        status = "Connecting to watched views…"
        task = Task { [weak self] in
            await self?.requestPermission()
            var queries: [UUID: MessagingQuery] = [:]
            while !Task.isCancelled {
                var failures: [String] = []
                for watch in watches {
                    do {
                        var query: MessagingQuery
                        if let cached = queries[watch.id] { query = cached }
                        else {
                            let view = try await api.namedView(id: watch.namedView.trimmingCharacters(in: .whitespacesAndNewlines))
                            query = view.query
                            query.facet = watch.facet
                            query.mailbox = watch.mailbox
                            query.limit = 200
                            query.sortDirection = "desc"
                            query = try query.normalized.validated()
                            queries[watch.id] = query
                        }
                        var items: [InboxItem] = []
                        var cursor: String?
                        var cursors = Set<String>()
                        repeat {
                            let page = try await api.page(query: query, cursor: cursor)
                            try Task.checkCancellation()
                            guard page.sources.contains(where: { $0.id == "mail" && $0.status == "fresh" && $0.complete }) else {
                                throw ContractError.invalid("Mail source unavailable; preserving notification baseline")
                            }
                            guard page.items.filter({ $0.sourceId == "mail" && $0.representation == "thread" })
                                .allSatisfy({ $0.json["thread"]?["hierarchy"]?["complete"]?.bool == true }) else {
                                throw ContractError.invalid("Mail thread incomplete; preserving notification baseline")
                            }
                            items += page.items
                            cursor = page.nextCursor
                            if let cursor {
                                guard cursors.insert(cursor).inserted, cursors.count < 100 else {
                                    throw ContractError.invalid("Notification scan exceeded 100 pages or repeated a cursor")
                                }
                            }
                        } while cursor != nil
                        guard let self, self.generation == current else { return }
                        let arrivals = self.tracker.arrivals(watch: watch.id, profile: query.profileId,
                            items: items, mailbox: query.mailbox)
                        if !arrivals.isEmpty { await self.deliver(titles: arrivals, watch: watch) }
                    } catch {
                        if Task.isCancelled { return }
                        failures.append("\(watch.label): \(error.localizedDescription)")
                    }
                }
                guard let self, self.generation == current else { return }
                self.status = failures.isEmpty ? "Watching \(watches.count) collection(s) · every 15 seconds" : failures.joined(separator: "\n")
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
            }
        }
    }

    func requestPermission() async {
        let center = UNUserNotificationCenter.current()
        do {
            let settings = await center.notificationSettings()
            if settings.authorizationStatus == .notDetermined {
                _ = try await center.requestAuthorization(options: [.alert, .sound])
            }
            let updated = await center.notificationSettings()
            permission = updated.authorizationStatus == .denied
                ? "Notifications denied. Enable Coleo Workbench in System Settings → Notifications."
                : "Notification permission enabled"
        } catch { permission = "Notification permission: \(error.localizedDescription)" }
    }

    private func deliver(titles: [String], watch: NotificationWatch) async {
        if preferences.bounceDock, !NSApp.isActive {
            NSApp.requestUserAttention(.informationalRequest)
        }
        let content = UNMutableNotificationContent()
        content.title = titles.count == 1 ? "New message" : "\(titles.count) new messages"
        content.subtitle = watch.label
        content.body = String(titles.prefix(3).map { $0.isEmpty ? "Untitled message" : $0 }.joined(separator: "\n").prefix(500))
        if preferences.sound { content.sound = .default }
        do {
            try await UNUserNotificationCenter.current().add(UNNotificationRequest(
                identifier: UUID().uuidString, content: content, trigger: nil))
        } catch { permission = "Could not deliver notification: \(error.localizedDescription)" }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        Task { @MainActor in
            NSApp.activate(ignoringOtherApps: true)
            NSApp.windows.first(where: { $0.tabbingIdentifier == "coleo.workbench" })?.makeKeyAndOrderFront(nil)
        }
        completionHandler()
    }
}

struct NotificationSettingsSection: View {
    @ObservedObject var notifications: MessageNotifications

    var body: some View {
        Section("Message notifications") {
            Toggle("Notify for new messages", isOn: $notifications.preferences.enabled)
            Toggle("Bounce Dock icon when Coleo is in the background", isOn: $notifications.preferences.bounceDock)
            Toggle("Play notification sound", isOn: $notifications.preferences.sound)
            ForEach($notifications.preferences.watches) { $watch in
                VStack(alignment: .leading) {
                    HStack {
                        Toggle("Watch", isOn: $watch.enabled)
                        TextField("Named view ID", text: $watch.namedView)
                            .accessibilityLabel("Named view ID")
                        Button(role: .destructive) {
                            notifications.preferences.watches.removeAll { $0.id == watch.id }
                        } label: { Image(systemName: "minus.circle") }
                        .accessibilityLabel("Remove watched view")
                    }
                    HStack {
                        Picker("Collection", selection: $watch.facet) {
                            Text("Messages").tag("messages")
                            Text("Attention").tag("attention")
                            Text("All").tag("all")
                        }
                        if watch.facet == "messages" {
                            Picker("Mailbox", selection: $watch.mailbox) {
                                Text("Inbox").tag("inbox")
                                Text("Sent").tag("sent")
                                Text("Archive").tag("archive")
                            }
                        }
                    }
                }
            }
            HStack {
                Button("Add view") { notifications.preferences.watches.append(NotificationWatch()) }
                Button("Save notification settings") { notifications.save() }
            }
            Text("Monitors while Coleo is running, including background tabs. Saving starts a fresh baseline without notifying for existing messages.")
                .font(.caption).foregroundStyle(.secondary)
            Text(notifications.status).font(.caption)
            Text(notifications.permission).font(.caption).foregroundStyle(.secondary)
            Button("Check notification permission") { Task { await notifications.requestPermission() } }
        }
    }
}
