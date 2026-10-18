## Brain Unit Tests

This directory covers brain behavior that is exercised by the current product runtime:

- arm lifecycle and health handling
- poll-cycle orchestration
- status report and discovery processing
- task follow-up creation and completion flows
- prompt generation and assistant-output interpretation
- task deletion, claim conflicts, and doc tracking

Guidelines for this suite:

1. Prefer behavior tests over coverage-only smoke tests.
2. Keep each test tied to a live brain code path that the CLI, web UI, or runtime actually uses.
3. Assert concrete effects when possible: task state changes, emitted prompts, persisted records, or human notifications.
4. Avoid catch-all tests unless they exercise one coherent workflow.

Useful commands:

```bash
bun test src/brain/__tests__
bun test src/brain/__tests__/claim-conflicts.test.ts
bun test src/brain/__tests__/task-deletion-handler.test.ts
bun run typecheck
```

The broader runtime integration coverage moved to `src/integration/__tests__/brain-runtime-flows.test.ts`.
