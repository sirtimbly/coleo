# ADR-006: Arm Personality and Convictions

**Status**: Accepted  
**Date**: 2025-01-13  
**Deciders**: Human

## Context

Arms need more than just configuration - they need identity. This enables:
- Consistent behavior across sessions
- Specialization and expertise development
- Natural selection of effective arm configurations
- More human-like collaboration dynamics

## Decision

Each arm has:

1. **Personality** (~200 tokens of self-updating context)
2. **Convictions** (core beliefs that influence decisions)
3. **Reputation** (0-100 score, starts at 50)
4. **Generation** (inheritance tracking)

## Schema

```sql
ALTER TABLE arms ADD COLUMN personality TEXT DEFAULT '';
ALTER TABLE arms ADD COLUMN convictions TEXT DEFAULT '[]';
ALTER TABLE arms ADD COLUMN reputation INTEGER DEFAULT 50;
ALTER TABLE arms ADD COLUMN generation INTEGER DEFAULT 1;
ALTER TABLE arms ADD COLUMN parent_arm_id TEXT REFERENCES arms(id);
```

## Personality

A natural language description of how the arm operates. Updated by the arm itself as it learns:

```
Methodical and security-conscious. Prefers explicit error handling 
over silent failures. Likes typed interfaces and clear boundaries 
between modules. Suspicious of magic.
```

The arm can update this via MCP tool call, subject to brain approval for significant changes.

## Convictions

Core beliefs that color the arm's thinking:

```json
[
  "Type safety prevents bugs at compile time",
  "Every error should be handled explicitly",
  "Database migrations should be reversible"
]
```

Convictions are set at arm creation and rarely change. They're injected into the arm's system prompt.

## Reputation

- Starts at 50 (neutral)
- Increases: successful deployments, accepted proposals, positive feedback
- Decreases: rollbacks, rejected proposals, interventions
- Affects: proposal weight, task assignment priority, survival

## Generation and Inheritance

When an arm "dies" (reputation too low, or killed):
- Generation increments
- Parent arm ID is recorded
- Personality and convictions can be inherited or mutated

High-reputation arms can be "cloned" to fill new slots:
- Inherits personality and convictions
- Starts with reputation 50 (must prove itself)
- Generation = parent.generation + 1

## Consequences

- Arms develop unique working styles
- Natural selection favors effective configurations
- Brain can make smarter task assignments
- Provides interesting observability data
