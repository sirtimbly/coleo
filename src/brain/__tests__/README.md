# Brain Test Suite

This directory contains test suites for the Brain component and related functionality.

## Running Tests

```bash
# Run all brain tests
bun test

# Run tests in watch mode
bun test:watch

# Run specific test file
bun test src/brain/__tests__/doc-tracker.test.ts
bun test src/brain/__tests__/agent.test.ts
```

## Test Coverage

### DocUpdateTracker (`doc-tracker.test.ts`)

Tests for the documentation update tracking functionality:

- **getLastDocUpdateTime**: Returns completion time of most recent doc update
- **countChangedFilesSince**: Counts files changed since a given time
- **getChangedFilesSince**: Returns list of changed files sorted by time
- **checkDocUpdateTrigger**: Detects threshold and periodic triggers
- **createDocUpdate**: Creates new doc update records
- **startDocUpdate/completeDocUpdate**: Tracks doc update status
- **getRecentDocUpdates**: Returns recent doc update history
- **generateFutureWorkNote**: Creates "Future Work" note templates
- **generatePartialImplementationNote**: Creates partial implementation notes
- **findFeatureDocs**: Finds feature documentation files

### BrainAgent (`agent.test.ts`)

Tests for the agentic brain implementation:

- **invoke**: Basic message processing
- **getToolNames**: Returns list of available tools
- **executeAction**: Executes tool actions with error handling

#### Intent Recognition

Tests that the agent correctly recognizes user intents:

- **Next task determination**: "What should I do next?"
- **Plan queries**: "What needs to be done according to the plan?"
- **Arm status queries**: "How are the arms doing?", "Check the system status"
- **Discovery queries**: "What discoveries have been found?"
- **Task history queries**: "What tasks have been completed?"

#### Tool Execution

Tests that tools execute correctly:

- **readPlan**: Reads plan documents from `.project/plans/`
- **getTaskHistory**: Returns completed/in-progress tasks
- **getDiscoveries**: Returns open discoveries with optional filtering
- **getArmStatus**: Returns active arms with optional filtering

## Acceptance Criteria Coverage

These tests validate key acceptance criteria from `.project/acceptance/`:

| Criterion | Test Coverage |
|-----------|---------------|
| SQLite persistence | DocUpdateTracker database operations |
| Activity logging | Tasks table operations in agent tools |
| Progressive planning hooks | Intent recognition for next task |
| Human-facing status | Discovery and task query tools |

## Test Data

Tests use temporary directories and in-memory SQLite databases. All test data is cleaned up after each test.

## Adding New Tests

When adding tests for new Brain functionality:

1. Follow the existing pattern using `describe`, `it`, `beforeEach`, `afterEach`
2. Use Bun's built-in `expect` assertions
3. Create temporary test databases for isolation
4. Clean up resources in `afterEach`
5. Cover both success and error paths
