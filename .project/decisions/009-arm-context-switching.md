# ADR-009: Arms Are Not Specialized - Context-Based Task Classification

## Status

Accepted

## Context

We needed to decide how arms should behave when working on different types of tasks. The original design considered specialized arms (frontend arm, backend arm, etc.), but this created artificial boundaries and context silos.

## Decision

Arms are **general-purpose** AI agents that adapt their behavior based on **task classification**. When an arm is assigned a task, the Brain provides:

1. A **task classification** (architect, development, qa, etc.)
2. A **context bundle** (relevant discoveries, docs, decisions)
3. **Instructions** appropriate to the classification

The arm then operates with the mindset and tools appropriate to that classification.

## Consequences

### Positive

- **Flexibility**: Same arm handles architect, dev, and QA tasks
- **Context sharing**: No artificial barriers between task types
- **Resource efficiency**: Mixed workloads handled by any arm
- **Simplicity**: No arm "type" management required
- **Adaptability**: Arms can pivot to urgent tasks immediately

### Negative

- **Prompt complexity**: Must have clear classification prompts
- **Context management**: Brain must build appropriate context bundles
- **Tool access**: Arms need access to all tools, not just domain-specific ones

## Implementation

### Task Classifications

1. **Architect Task**: Transform requirements into plans
2. **Development Task**: Transform tasks into code
3. **QA Task**: Ensure quality through testing
4. **Project Management Task**: Coordinate and track

### Context Provided

When assigning any task, Brain includes:
- Relevant discoveries (from SQLite)
- Appropriate documentation
- Task-specific instructions
- Reference to requirements/decisions/plans

### API Changes

- Task interface now includes `context.discoveries`
- Arm receives full context bundle when task is assigned
- Brain queries discoveries by domain before task assignment

## Related Decisions

- ADR-006: Arm personality (supplements context switching with personality traits)
- Future: Context budget enforcement (prevents context overflow)

## References

- [Requirements & Philosophy](../requirements.md)
- [Plan](../plan.md)
