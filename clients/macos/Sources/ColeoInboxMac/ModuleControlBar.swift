import SwiftUI

/// Content-level controls: AppKit's tab strip stays above this entire surface.
struct ModuleControlBar<Controls: View>: View {
    private let controls: Controls

    init(@ViewBuilder controls: () -> Controls) { self.controls = controls() }

    var body: some View {
        HStack(spacing: 8) {
            controls
        }
        .controlSize(.small)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
    }
}

struct ModuleSidebarToggle: View {
    @Binding var isVisible: Bool

    var body: some View {
        Button { isVisible.toggle() } label: {
            Label(isVisible ? "Hide Sidebar" : "Show Sidebar", systemImage: "sidebar.left")
        }
        .labelStyle(.iconOnly)
        .help(isVisible ? "Hide Sidebar" : "Show Sidebar")
        .keyboardShortcut("s", modifiers: [.command, .control])
    }
}
