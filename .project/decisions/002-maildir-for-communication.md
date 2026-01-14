# ADR-002: Maildir for Human-Agent Communication

**Status**: Accepted  
**Date**: 2024-01-10  
**Deciders**: Human (Tim)

## Context

Need a way for humans to communicate with the Octopai system. Want something that integrates with existing email workflows and tools.

## Decision

Use **Maildir** format for human-agent communication. The brain polls a Maildir inbox for human messages and writes responses.

## Rationale

1. **Standard format** - Maildir is well-documented and widely supported
2. **Tool compatibility** - Works with himalaya, luk, mutt, and other email clients
3. **File-based** - Easy to inspect, debug, and backup
4. **No server required** - Just files on disk
5. **Atomic writes** - Maildir's tmp→new flow prevents corruption

## Consequences

### Positive
- Humans can use familiar email tools
- Messages are persistent and searchable
- Easy to integrate with notification systems
- Works offline

### Negative
- Polling introduces latency (configurable, default 5s)
- Requires filesystem access
- Email format is more complex than simple JSON

## Implementation

```
~/.octopai/mail/
├── inbox/
│   ├── cur/     # Read messages
│   ├── new/     # Unread messages
│   └── tmp/     # Messages being written
└── outbox/
    ├── cur/
    ├── new/
    └── tmp/
```

## Alternatives Considered

### Unix domain sockets
Faster, but requires running process. Doesn't persist.

### HTTP API only
Requires Observatory to be running. No offline access.

### SQLite messages table
Could work, but less tooling available. Chose Maildir for ecosystem.

## References

- [Maildir specification](https://cr.yp.to/proto/maildir.html)
- [himalaya CLI](https://github.com/soywod/himalaya)
