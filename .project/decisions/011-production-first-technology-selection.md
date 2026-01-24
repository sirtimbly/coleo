# ADR-011: Production-First Technology Selection

## Status

Accepted

## Date

2026-01-23

## Context

When selecting technologies for new features, there's a temptation to "start simple" with embedded or lightweight solutions, planning to migrate to production-grade alternatives later. This pattern has hidden costs:

1. **Migration cost is real** - You write the integration twice
2. **Migration rarely happens** - The "simple" solution becomes load-bearing before migration occurs
3. **Edge cases surface late** - Production issues appear after significant investment
4. **Architecture mismatch** - Embedded solutions may not fit a distributed system

Octopai is architecturally distributed:
- NATS for messaging between brain and arms
- Multiple concurrent arms (containers, terminals)
- API server separate from brain
- Designed for long-running autonomous operation

Example: When adding vector search for status history, the choice was between LanceDB (embedded, "simpler") and Qdrant (containerized, production-ready). The "start with LanceDB, migrate to Qdrant later" approach would mean:
- Writing LanceDB integration
- Hitting limitations (filtering, scale, maturity)
- Rewriting for Qdrant
- Total cost: 2x integration work + migration bugs

## Decision

**Select production-grade technologies from the start when:**

1. **The system is already distributed** - Adding a container/service fits the existing architecture
2. **Migration cost exceeds setup cost** - Rewriting integration > running `docker run`
3. **The feature is core, not experimental** - It will be load-bearing
4. **Scale is expected** - Long-running autonomous operation generates data

**Prefer simpler/embedded solutions only when:**

1. The feature is truly experimental/throwaway
2. The system is single-process by design
3. External dependencies are genuinely problematic (air-gapped, embedded devices)
4. The "production" option has no clear winner

## Consequences

### Positive

- Single integration, no migration
- Production issues surface early when they're cheap to fix
- Architecture remains consistent (distributed components)
- Teams don't accumulate "migrate X to Y" tech debt

### Negative

- Higher initial setup (containers, configuration)
- More moving parts in development environment
- May over-engineer truly simple features

## Examples

| Feature | Simple Option | Production Option | Choose |
|---------|---------------|-------------------|--------|
| Vector search | LanceDB (embedded) | Qdrant (container) | **Qdrant** - distributed system, core feature |
| Key-value cache | In-memory Map | Redis | **Depends** - if persistence needed, Redis |
| Task queue | JSON files | NATS JetStream | **NATS** - already integrated |
| SQLite | SQLite | PostgreSQL | **SQLite** - sufficient for single-brain, Phase 7 adds Postgres |

## Related

- ADR-001: Use Bun (chose production-ready runtime)
- ADR-008: Docker Image Strategy (containers are normal)
- AGENTS.md: Technology Selection Principles
