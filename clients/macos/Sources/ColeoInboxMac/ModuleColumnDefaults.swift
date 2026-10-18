import AppKit
import SwiftUI

/// Set initial divider positions on SwiftUI's native split view, then leave
/// sizing to the user. Ideal frame widths alone are redistributed by HSplitView.
struct ModuleColumnDefaults: NSViewRepresentable {
    let sidebarWidth: CGFloat
    let collectionWidth: CGFloat
    let sidebarVisible: Bool

    struct Configuration: Equatable {
        let sidebarWidth: CGFloat
        let collectionWidth: CGFloat
        let sidebarVisible: Bool
    }

    final class Probe: NSView {
        var configuration: Configuration?
        private var applied: Configuration?
        private var scheduled = false

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            scheduleDefaults()
        }

        override func layout() {
            super.layout()
            scheduleDefaults()
        }

        func scheduleDefaults() {
            guard window != nil, applied != configuration, !scheduled else { return }
            scheduled = true
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.scheduled = false
                self.applyDefaults()
            }
        }

        private func applyDefaults() {
            guard let configuration, applied != configuration else { return }
            var ancestor = superview
            while let view = ancestor, !(view is NSSplitView) { ancestor = view.superview }
            guard let split = ancestor as? NSSplitView,
                  split.arrangedSubviews.count == (configuration.sidebarVisible ? 3 : 2),
                  split.bounds.width > 0 else { return }
            let sidebar = configuration.sidebarVisible ? configuration.sidebarWidth : 0
            let separators = split.dividerThickness * CGFloat(split.arrangedSubviews.count - 1)
            let available = split.bounds.width - sidebar - separators
            guard available >= 580 else { return } // 300 pt collection + 280 pt detail
            // Mark first: positioning invokes layout again.
            applied = configuration
            if configuration.sidebarVisible { split.setPosition(sidebar, ofDividerAt: 0) }
            let collection = min(configuration.collectionWidth, available - 280)
            split.setPosition(sidebar + (configuration.sidebarVisible ? split.dividerThickness : 0) + collection,
                              ofDividerAt: configuration.sidebarVisible ? 1 : 0)
        }
    }

    func makeNSView(context: Context) -> Probe { Probe() }

    func updateNSView(_ probe: Probe, context: Context) {
        probe.configuration = Configuration(sidebarWidth: sidebarWidth, collectionWidth: collectionWidth,
                                            sidebarVisible: sidebarVisible)
        probe.scheduleDefaults()
    }
}
