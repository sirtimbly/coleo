# ADR-001: Use Bun as Runtime

**Status**: Accepted  
**Date**: 2024-01-10  
**Deciders**: Human (Tim)

## Context

Need to choose a JavaScript/TypeScript runtime for Octopai. The system will spawn multiple AI agent processes and manage communication between them.

## Decision

Use **Bun** as the primary runtime.

## Rationale

1. **First-party SQLite support** - `bun:sqlite` is built-in and extremely fast
2. **Fast startup time** - Important when spawning arm processes
3. **TypeScript native** - No separate compilation step
4. **Built-in test runner** - Fewer dependencies
5. **Growing ecosystem** - Most npm packages work

## Consequences

### Positive
- Simplified stack (no separate bundler/transpiler needed)
- Fast development iteration
- Native SQLite without dependencies
- Single binary for distribution

### Negative
- Newer ecosystem, some edge cases may not work
- Team may need to learn Bun-specific APIs
- Less battle-tested than Node.js in production

## Alternatives Considered

### Node.js
More mature and battle-tested, but requires more tooling (esbuild/swc, better-sqlite3 native module).

### Deno
Good security model with permissions, but smaller ecosystem and different module system.

## References

- [Bun documentation](https://bun.sh/docs)
- [bun:sqlite docs](https://bun.sh/docs/api/sqlite)
