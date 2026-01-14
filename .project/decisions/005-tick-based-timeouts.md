# ADR-005: Tick-Based Proposal Timeouts

**Status**: Accepted  
**Date**: 2025-01-13  
**Deciders**: Human

## Context

Proposals need timeouts to prevent indefinite blocking. Originally considered wall-clock timeouts (e.g., "5 minutes"), but this doesn't scale well:

- Fast systems would wait unnecessarily
- Slow systems might timeout too quickly
- Different agents have different response times

## Decision

Use **tick-based timeouts** where one tick = one brain poll cycle.

## Schema

```sql
ALTER TABLE proposals ADD COLUMN timeout_ticks INTEGER DEFAULT 10;
ALTER TABLE proposals ADD COLUMN ticks_elapsed INTEGER DEFAULT 0;
```

## Default Ticks by Type

| Proposal Type | Default Ticks | Rationale |
|---------------|---------------|-----------|
| deploy (local) | 2 | Fast, low risk |
| deploy (other) | 10 | Needs review time |
| claim | 4 | Quick arbitration |
| refactor | 20 | Needs discussion |
| dependency | 10 | Security consideration |
| breaking_change | 30 | High impact, more eyes |
| creative_override | 2 | Trust the arm |

## Configuration

All defaults are user-configurable in `.octopai/config.toml`:

```toml
[proposals.timeouts]
deploy_local = 2
deploy_other = 10
claim = 4
refactor = 20
dependency = 10
breaking_change = 30
creative_override = 2
```

## Consequences

- More flexible across different system speeds
- Brain poll interval affects all timeouts proportionally
- Admins can tune poll interval to match their preference
- Need to increment `ticks_elapsed` each poll cycle
