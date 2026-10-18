import ColeoInboxCore
import SwiftUI

/// SwiftUI adaptation of AdaptiveCardView's creator strip, body, FactSet, and
/// technical-details footer. Semantic system colors replace the web host palette.
struct WorkbenchCard: View {
    let card: DetailCard
    @State private var detailsExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                CardCreator(name: card.creator)
                VStack(alignment: .leading, spacing: 2) {
                    Text(card.creator).font(.callout).fontWeight(.semibold).textSelection(.enabled)
                    Text(card.kind).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                if card.unread {
                    Label("Unread", systemImage: "circle.fill")
                        .font(.caption2).foregroundStyle(Color.accentColor)
                }
                Menu {
                    Button("Copy text", systemImage: "doc.on.doc") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(card.body, forType: .string)
                    }
                    Button(detailsExpanded ? "Hide details" : "More details", systemImage: "info.circle") {
                        detailsExpanded.toggle()
                    }
                } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton).fixedSize()
                .help("Message options").accessibilityLabel("Options for \(card.title)")
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(Color(nsColor: .controlBackgroundColor))
            Divider()

            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(card.title).font(.title3).fontWeight(.semibold).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    if card.requiresAction {
                        Label {
                            Text("Needs action")
                        } icon: {
                            Image(systemName: "flag.fill")
                                .foregroundStyle(card.severity == "danger" ? Color.red : Color.orange)
                        }
                        .font(.callout)
                    }
                    if let timestamp = card.timestamp {
                        CardTimestamp(timestamp: timestamp)
                    }
                }

                if !card.facts.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(card.facts) { fact in
                            ViewThatFits(in: .horizontal) {
                                HStack(alignment: .firstTextBaseline, spacing: 12) {
                                    Text(fact.label).foregroundStyle(.secondary).frame(width: 44, alignment: .leading)
                                    Text(fact.value).textSelection(.enabled)
                                }
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(fact.label).foregroundStyle(.secondary)
                                    Text(fact.value).textSelection(.enabled)
                                }
                            }
                            .font(.callout)
                        }
                    }
                }
                Divider()
                if card.body.isEmpty {
                    Text("No message content.").foregroundStyle(.secondary)
                } else {
                    DetailDocument(text: card.body)
                }
                ForEach(card.sections) { section in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(section.label).font(.headline)
                        DetailDocument(text: section.value)
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)

            Divider()
            DisclosureGroup(isExpanded: $detailsExpanded) {
                Text(card.technicalDetails)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 10)
            } label: {
                Text("Technical details").font(.caption).foregroundStyle(.secondary)
            }
            .padding(12)
        }
        .background(Color(nsColor: .textBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(nsColor: .separatorColor), lineWidth: 1))
    }
}

/// Creator identity mirrors web creator avatars without guessing user imagery.
struct CardCreator: View {
    let name: String

    var body: some View {
        Group {
            if name.localizedCaseInsensitiveContains("brain") {
                Image(systemName: "brain")
            } else if name.localizedCaseInsensitiveContains("arm") {
                Image(systemName: "bolt.horizontal.circle")
            } else {
                Text(String(name.split(separator: " ").prefix(2).compactMap(\.first)).uppercased())
                    .font(.caption).fontWeight(.semibold)
            }
        }
        .foregroundStyle(Color.accentColor)
        .frame(width: 30, height: 30)
        .background(Color.accentColor.opacity(0.1), in: Circle())
        .accessibilityHidden(true)
    }
}

private struct CardTimestamp: View {
    let timestamp: String

    private var date: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: timestamp) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: timestamp)
    }

    var body: some View {
        Label {
            if let date { Text(date.formatted(date: .abbreviated, time: .shortened)) }
            else { Text(timestamp) }
        } icon: { Image(systemName: "clock") }
        .font(.caption).foregroundStyle(.secondary)
    }
}

/// Thread messages share the same outer spacing as the web detail surface.
struct DetailCardsView: View {
    let cards: [DetailCard]

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                if cards.count > 1 {
                    Label("\(cards.count) messages in this conversation", systemImage: "bubble.left.and.bubble.right")
                        .font(.callout).foregroundStyle(.secondary)
                }
                ForEach(cards) { card in WorkbenchCard(card: card) }
            }
            .padding(20)
            .frame(maxWidth: 800)
            .frame(maxWidth: .infinity)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }
}
