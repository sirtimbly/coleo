import Charts
import ColeoInboxCore
import SwiftUI

/// Brain owns orchestration controls; Dashboard combines independently refreshed
/// domain summaries. Both use authoritative API snapshots, not Inbox activity.
struct ModuleOverview: View {
    @ObservedObject var session: ResourceModuleSession
    private var brain: JSONValue? { session.snapshots["brain"]?["brain"] }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(session.module.title).font(.largeTitle).fontWeight(.semibold)
                        Text(session.module.description).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if session.isLoading { ProgressView().controlSize(.small) }
                }
                brainSection
                if session.module.renderer == "dashboard" {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 300), alignment: .top)], alignment: .leading, spacing: 16) {
                        statsSection("Tasks", source: "tasks")
                        statsSection("Bugs", source: "bugs")
                    }
                }
            }
            .padding(24).frame(maxWidth: 1100).frame(maxWidth: .infinity)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var brainSection: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 16) {
                sourceError("brain")
                if let brain {
                    HStack {
                        Label(display(brain["status"]), systemImage: "brain").font(.headline)
                        Spacer()
                        if session.module.renderer == "brain" {
                            Button("Start", systemImage: "play.fill") { Task { await session.setBrainRunning(true) } }
                                .disabled(session.isActing || brain["status"]?.string == "running" || session.sourceErrors["brain"] != nil)
                            Button("Stop", systemImage: "stop.fill") { Task { await session.setBrainRunning(false) } }
                                .disabled(session.isActing || !["running", "paused"].contains(brain["status"]?.string ?? "") || session.sourceErrors["brain"] != nil)
                        }
                    }
                    Divider()
                    LabeledContent("Active arms", value: display(brain["activeArmsCount"]))
                    LabeledContent("Pending tasks", value: display(brain["pendingTasksCount"]))
                    LabeledContent("Completed today", value: display(brain["completedToday"]))
                    if let date = brain["lastPollAt"]?.string { LabeledContent("Last poll", value: date) }
                    if let plan = brain["plan"] {
                        Divider()
                        Label("Planning · \(display(plan["status"]))", systemImage: "list.bullet.clipboard").font(.headline)
                        if let detail = plan["detail"]?.string { Text(detail).textSelection(.enabled) }
                        if let next = plan["nextStep"]?.string { Text(next).foregroundStyle(.secondary).textSelection(.enabled) }
                    }
                    if let access = brain["modelAccess"] {
                        Divider()
                        LabeledContent("Model access", value: display(access["status"]))
                        if let message = access["message"]?.string { Text(message).textSelection(.enabled) }
                    }
                } else if session.sourceErrors["brain"] == nil {
                    Text("Loading Brain status…").foregroundStyle(.secondary)
                }
            }
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        } label: { Label("Brain", systemImage: "brain") }
    }

    private func statsSection(_ title: String, source: String) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                sourceError(source)
                if let snapshot = session.snapshots[source] {
                    if source == "tasks" {
                        LabeledContent("Total", value: display(snapshot["total"]))
                        LabeledContent("Active", value: display(snapshot["active"]))
                        LabeledContent("Blocked", value: display(snapshot["blocked"]))
                    } else {
                        LabeledContent("Unresolved", value: display(snapshot["unresolved"]))
                        LabeledContent("Reported in 24 hours", value: display(snapshot["recent24h"]))
                    }
                    Divider()
                    let counts = (snapshot["byStatus"]?.object ?? [:]).sorted { $0.key < $1.key }
                    Chart(counts, id: \.key) { entry in
                        BarMark(x: .value("Count", entry.value.int ?? 0), y: .value("Status", entry.key.replacingOccurrences(of: "_", with: " ").capitalized))
                            .foregroundStyle(Color.accentColor)
                            .annotation(position: .trailing) { Text("\(entry.value.int ?? 0)").font(.caption) }
                    }
                    .frame(height: max(140, CGFloat(counts.count) * 30))
                    .accessibilityLabel("\(title) by status")
                } else if session.sourceErrors[source] == nil {
                    Text("Loading \(title.lowercased())…").foregroundStyle(.secondary)
                }
            }
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        } label: { Text(title) }
    }

    @ViewBuilder
    private func sourceError(_ source: String) -> some View {
        if let error = session.sourceErrors[source] {
            Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).font(.callout)
            if session.snapshots[source] != nil { Text("Showing the last successful snapshot.").font(.caption).foregroundStyle(.secondary) }
        }
    }

    private func display(_ value: JSONValue?) -> String {
        if let text = value?.string { return text.replacingOccurrences(of: "_", with: " ").capitalized }
        if let count = value?.int { return count.formatted() }
        return "Unknown"
    }
}
