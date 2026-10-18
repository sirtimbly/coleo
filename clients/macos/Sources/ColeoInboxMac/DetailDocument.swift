import SwiftUI

/// Lightweight native document typography for the API's Markdown/text details.
/// Preserve body whitespace, render headings and rules, and keep code literal.
struct DetailDocument: View {
    let text: String

    private struct Block: Identifiable {
        let id: Int
        let text: String
        let heading: Int
        let code: Bool
    }

    private var blocks: [Block] {
        var result: [Block] = []
        var paragraph: [String] = []
        var code = false
        func flush() {
            guard !paragraph.isEmpty else { return }
            result.append(Block(id: result.count, text: paragraph.joined(separator: "\n"), heading: 0, code: code))
            paragraph = []
        }
        for line in text.components(separatedBy: "\n") {
            if line.hasPrefix("```") {
                flush()
                code.toggle()
            } else if code {
                paragraph.append(line)
            } else if line.isEmpty {
                flush()
            } else {
                let level = line.prefix(while: { $0 == "#" }).count
                if (1...6).contains(level), line.dropFirst(level).hasPrefix(" ") {
                    flush()
                    result.append(Block(id: result.count, text: String(line.dropFirst(level + 1)), heading: level, code: false))
                } else if line == "---" {
                    flush()
                    result.append(Block(id: result.count, text: "", heading: -1, code: false))
                } else {
                    paragraph.append(line)
                }
            }
        }
        flush()
        return result
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(blocks) { block in
                if block.heading == -1 {
                    Divider()
                } else if block.code {
                    Text(block.text).font(.system(.callout, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 4))
                } else {
                    Text((try? AttributedString(markdown: block.text,
                          options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(block.text))
                        .font(block.heading == 0 ? .body : block.heading <= 2 ? .title3 : .headline)
                        .fontWeight(block.heading == 0 ? .regular : .semibold)
                        .padding(.top, block.heading > 0 ? 6 : 0)
                }
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
