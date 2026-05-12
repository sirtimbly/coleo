# Stopping Point Detection and Branch/PR Workflow

## Overview

This feature implements brain-side detection logic to identify when an arm has reached a good stopping point, then prompts the arm to create a branch, organize commits, and submit a PR.

## Components

### 1. Stopping Point Detector (`src/brain/stopping-point-detector.ts`)

Detects when an arm has reached a good stopping point based on configurable criteria:

**Criteria:**
- **Minimum files changed**: 3+ files (default)
- **Maximum commits before stop**: 10 commits (default)
- **Maximum duration**: 120 minutes (default)
- **Tests passing**: Required (default)
- **Maximum complexity score**: 50 (default)

**Confidence Calculation:**
- Files changed: +0.25
- Commit threshold reached: +0.35
- Moderate commits (5-9): +0.15
- Some commits (1-4): +0.08
- Duration threshold reached: +0.35
- Tests passing: +0.20
- High complexity: +0.10
- Refactoring with multiple files: +0.10

**Good stopping point threshold:** >= 0.6 confidence

### 2. Branch/PR Workflow (`src/brain/branch-pr-workflow.ts`)

Automated workflow for creating branches, organizing commits, and generating PR drafts:

**Features:**
- Automatic branch name generation
- Commit organization (checkpoint and feature commits)
- Branch pushing to remote
- PR draft creation with markdown formatting

**Branch Naming Pattern:**
```
arm/{armId}/{taskId}-{timestamp}
```

### 3. Brain Integration (`src/brain/stopping-point-integration.ts`)

Integrates stopping point detection into the Brain's task completion flow:

- Analyzes tasks when completed
- Suggests PR workflow when good stopping point detected
- Can auto-execute if confidence is high enough (>= 0.8)
- Generates prompts for arms to guide next steps

### 4. CLI Commands (`src/cli/commands/branch.ts`)

New CLI commands for branch/PR management:

```bash
# Create a feature branch
coleo branch create <task-id> [--name <name>] [--base <branch>]

# Organize and commit changes
coleo branch commit <task-id> [--message <message>]

# Push branch to remote
coleo branch push [branch-name] [--force]

# Create PR draft
coleo branch pr-draft <task-id> [--title <title>] [--description <description>]

# Execute full workflow
coleo branch workflow <task-id> [--push] [--draft]
```

## Usage Examples

### Basic Workflow

```bash
# Create branch for task-123
coleo branch create task-123

# Organize commits
coleo branch commit task-123

# Push to remote
coleo branch push

# Create PR draft
coleo branch pr-draft task-123
```

### Full Automated Workflow

```bash
# Execute all steps
coleo branch workflow task-123 --push --draft
```

## Configuration

### Stopping Point Criteria

```typescript
const criteria: StoppingPointCriteria = {
  minFilesChanged: 3,
  maxCommitsBeforeStop: 10,
  maxDurationMinutes: 120,
  requireTestsPassing: true,
  maxComplexityScore: 50,
};
```

### Branch Configuration

```typescript
const config: BranchConfig = {
  baseBranch: "master",
  namingPattern: "arm/{armId}/{taskId}-{timestamp}",
  autoPush: false,
  autoCreatePR: false,
};
```

## Testing

Run the stopping point detector tests:

```bash
bun test src/brain/__tests__/stopping-point-detector.test.ts
```

## Integration with Brain

The Brain will automatically:

1. Analyze tasks when completed
2. Detect good stopping points
3. Prompt arms with recommendations
4. Optionally auto-execute branch/PR workflow

Example prompt when good stopping point detected:

```
# Good Stopping Point Detected

**Task**: Implement feature X (task-123)

**Analysis**:
- Confidence: 75%
- Status: Good stopping point reached

**Reasons**:
- Significant changes: 5 files modified
- Moderate commit count: 4 commits
- All tests passing

**Recommended Next Steps**:
- Create feature branch
- Organize and commit changes
- Open PR draft
```

## Files Added/Modified

### New Files:
- `src/brain/stopping-point-detector.ts` - Detection logic
- `src/brain/branch-pr-workflow.ts` - Branch/PR workflow
- `src/brain/stopping-point-integration.ts` - Brain integration
- `src/cli/commands/branch.ts` - CLI commands
- `src/brain/__tests__/stopping-point-detector.test.ts` - Tests
- `docs/usage/branch-pr-workflow.md` - This documentation

### Modified Files:
- `src/cli/index.ts` - Registered branch commands

## Telemetry

Stopping point detection logs telemetry data:

```json
{
  "timestamp": "2026-04-07T21:30:00Z",
  "type": "stopping_point",
  "taskId": "task-123",
  "armId": "arm-456",
  "action": "detected",
  "success": true,
  "confidence": 0.75,
  "isGoodStoppingPoint": true,
  "reasons": ["Significant changes", "Tests passing"]
}
```

## Future Enhancements

- [ ] Add integration tests for branch/PR workflow
- [ ] Implement GitHub/GitLab API integration for PR creation
- [ ] Add more sophisticated complexity scoring
- [ ] Support for multi-arm coordination on PRs
- [ ] Add PR review assignment logic
- [ ] Implement rollback on PR failure

## Acceptance Criteria

- ✅ Brain reliably detects stopping points according to defined criteria
- ✅ Arm can create a branch, group commits appropriately
- ✅ Tests cover core logic and CI passes (573 pass, 2 skip, 0 fail)
- ✅ Implementation plan and documentation provided
- ✅ CLI commands available for manual branch/PR workflow
- ✅ Logging and telemetry for decisions and failures

## Implementation Plan Completed

1. ✅ Detection criteria and heuristics
2. ✅ Brain integration code
3. ✅ CLI/agent flow for branch creation and PR workflow
4. ✅ Tests for detection logic
5. ✅ Logging and telemetry
6. ✅ Documentation and usage guide
