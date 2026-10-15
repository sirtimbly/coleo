import Foundation

/// Native hosts pass semantic key names and normalized modifier names. Prefer
/// tree bindings over item bindings when both describe the same key (Space).
public func keyboardOperation(bindings: [ResolvedBinding], key: String,
                              modifiers: Set<String>, tree: Bool) -> String? {
    let scopes = tree ? ["tree", "item", "collection"] : ["item", "collection"]
    for scope in scopes {
        for binding in bindings where binding.available {
            for shortcut in binding.keyboard where shortcut.scope == scope {
                guard shortcut.key.lowercased() == key.lowercased() else { continue }
                let expected = Set(shortcut.modifiers.map {
                    switch $0 {
                    case "primary", "meta": return "command"
                    case "alt": return "option"
                    default: return $0
                    }
                })
                var actual = modifiers
                // '?' is already the resulting character; its physical Shift
                // must not make the declarative '?' binding fail on US keyboards.
                if key.count == 1, key.unicodeScalars.allSatisfy({ CharacterSet.punctuationCharacters.contains($0) }),
                   !expected.contains("shift") { actual.remove("shift") }
                if actual == expected { return binding.operation }
            }
        }
    }
    return nil
}
