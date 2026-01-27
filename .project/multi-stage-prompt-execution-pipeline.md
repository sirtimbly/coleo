# Multi-Stage Prompt Generation and Task Execution Pipeline

## Overview

A sophisticated orchestration system that validates, explores, implements, and verifies tasks through multiple arm sessions. The system uses a validation-first approach to ensure tasks have sufficient context before execution, with automatic retry logic and verification workflows.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    MULTI-STAGE TASK EXECUTION PIPELINE                          │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  STAGE 1: VALIDATION                    STAGE 2: EXPLORATION                    │
│  ───────────────────                    ────────────────────                    │
│       │                                          │                               │
│       ▼                                          ▼                               │
│  ┌──────────────────┐                 ┌──────────────────┐                      │
│  │ Context          │                 │ Exploration    │                      │
│  │ Aggregator       │                 │ Arm Session    │                      │
│  │ (Brain-side)     │                 │ (User's        │                      │
│  └────────┬─────────┘                 │ coding model)  │                      │
│           │                           └────────┬───────┘                      │
│           │                                    │                               │
│           ▼                                    ▼                               │
│  ┌──────────────────┐                 ┌──────────────────┐                      │
│  │ Validation       │  Score 50-69    │ MCP Tools:       │                      │
│  │ (Cheap/Fast      │ ───────────────►│ - report_        │                      │
│  │  Model like      │  "Explore Mode" │   discovery      │                      │
│  │  GLM 4.7)        │                 │ - add_task_      │                      │
│  └────────┬─────────┘                 │   discussion     │                      │
│           │                           └────────┬───────┘                      │
│           │                                    │                               │
│     Score │                                    │ Find answers                   │
│           │                                    │ Update task                    │
│           │                                    │ discussions                    │
│           │                                    │                               │
│           │                                    ▼                               │
│           │                           ┌──────────────────┐                      │
│           │                           │ Return to Brain  │                      │
│           │                           │ with findings    │                      │
│           │                           └────────┬───────┘                      │
│           │                                    │                               │
│           │                                    │ Next arm session               │
│           │                                    │ triggers re-validation         │
│           │                                    │                               │
│           │                                    ▼                               │
│           │                           ┌──────────────────┐                      │
│           │                           │ Re-validate      │                      │
│           │                           │ (Score 70+)      │                      │
│           │                           └────────┬───────┘                      │
│           │                                    │                               │
│           │                                    │ Score 70+                     │
│           │                                    ▼                               │
│           │                           STAGE 3: IMPLEMENTATION                   │
│           │                           ─────────────────────                     │
│           │                                    │                               │
│           │                                    ▼                               │
│           │                           ┌──────────────────┐                      │
│           │                           │ Implementation │                      │
│           │                           │ Arm Session    │                      │
│           │                           │ (User's        │                      │
│           │                           │ coding model)  │                      │
│           │                           └────────┬───────┘                      │
│           │                                    │                               │
│           │                                    │ Execute task                   │
│           │                                    │ - Write code                   │
│           │                                    │ - Run tests                    │
│           │                                    │ - Update docs                  │
│           │                                    │                               │
│           │                                    ▼                               │
│           │                           ┌──────────────────┐                      │
│           │                           │ complete_task    │                      │
│           │                           │ or submit_status │                      │
│           │                           │ _report          │                      │
│           │                           └────────┬───────┘                      │
│           │                                    │                               │
│           │                                    │ Report success                 │
│           │                                    │ or failure                     │
│           │                                    │                               │
│           │                                    ▼                               │
│           │                           STAGE 4: VERIFICATION                     │
│           │                           ───────────────────                       │
│           │                                    │                               │
│           │                                    ▼                               │
│           │                           ┌──────────────────┐                      │
│           │                           │ Brain detects    │                      │
│           │                           │ task completion  │                      │
│           │                           └────────┬───────┘                      │
│           │                                    │                               │
│           │                                    │ Queue verification             │
│           │                                    │ task                           │
│           │                                    │                               │
│           │                                    ▼                               │
│           │                           ┌──────────────────┐                      │
│           │                           │ Verification   │                      │
│           │                           │ Arm Session    │                      │
│           │                           │ (Different     │                      │
│           │                           │ arm instance)  │                      │
│           │                           └────────┬───────┘                      │
│           │                                    │                               │
│           │                                    │ Review changes                 │
│           │                                    │ Validate acceptance            │
│           │                                    │ criteria                       │
│           │                                    │                               │
│           │                                    ▼                               │
│           │                           ┌──────────────────┐                      │
│           │                           │ Verification   │                      │
│           │                           │ Result         │                      │
│           │                           └────────┬───────┘                      │
│           │                                    │                               │
│           └────────────────────────────────────┼───────────────────────────────┘
│                                                │                               │
│                                         Success│Failure                        │
│                                                │                               │
│                     ┌──────────────────────────┼──────────────────────────┐   │
│                     │                          │                          │   │
│                     ▼                          ▼                          │   │
│              ┌──────────────┐          ┌──────────────┐                   │   │
│              │ Mark task    │          │ Retry with   │                   │   │
│              │ complete     │          │ new arm      │                   │   │
│              │ Notify human │          │ (same task,  │                   │   │
│              └──────────────┘          │ new session) │                   │   │
│                                        └──────────────┘                   │   │
│                                                                           │   │
│                     (If retry limit exceeded)                             │   │
│                     ┌──────────────────────────────────┐                  │   │
│                     │ Escalate to human                │                  │   │
│                     │ Create "fix required" task       │                  │   │
│                     └──────────────────────────────────┘                  │   │
│                                                                            │   │
└────────────────────────────────────────────────────────────────────────────┘   │
```

## Stage Details

### Stage 1: Validation

**Trigger**: Arm requests task (new session)

**Process**:
1. Brain aggregates context (task + discussions + notes + previous attempts)
2. Validation model (cheap/fast) scores prompt completeness 0-100
3. Based on score, determine next action:

**Score Interpretation**:
- **0-49**: Insufficient - Blocked, needs human intervention
- **50-69**: Exploration Mode - Arm should investigate to fill gaps
- **70-100**: Ready for Implementation - Proceed to execution

**Temperature by Score**:
- 0-49: N/A (blocked)
- 50-69: 0.7-0.9 (exploration requires creativity)
- 70-100: Task-type dependent:
  - UI/TypeScript: 0.1-0.3 (strict patterns)
  - Architecture: 0.4-0.6 (balanced)
  - Research: 0.7-0.9 (creative)

**Output**:
- Validation result with score and specific gaps
- Recommended temperature
- Mode: "explore" or "implement"

### Stage 2: Exploration (Score 50-69)

**Trigger**: Validation returns score 50-69

**Arm Session**:
- Same arm instance or new instance (user's coding model)
- Receives "exploration prompt" with specific questions to answer
- Uses MCP tools to investigate codebase

**Exploration Prompt Structure**:
```markdown
# EXPLORATION MODE

You are in EXPLORATION MODE. Your goal is to answer critical questions
about this task before implementation can begin.

## Task
[Task details]

## Critical Questions to Answer
1. [Specific question] - Check [specific file/location]
2. [Specific question] - Review [specific component/pattern]
3. [Specific question] - Examine [specific API/structure]

## Instructions
1. Use report_discovery to document findings
2. Use add_task_discussion to share answers
3. Focus on answering questions, NOT implementing
4. When you have answers, submit_status_report with findings

## Success Criteria
- All critical questions answered
- Findings documented in task discussions
- Ready for implementation arm to proceed
```

**MCP Tools Available**:
- `report_discovery` - Document findings (missing_context, ambiguous_requirement, etc.)
- `add_task_discussion` - Add answers to task discussions
- `get_task_discussions` - Read existing context
- `submit_status_report` - Report exploration completion

**End Condition**:
- Arm submits status report with findings
- Brain updates task discussions with answers
- Next arm session triggers re-validation

### Stage 3: Implementation (Score 70+)

**Trigger**: Validation returns score 70+

**Arm Session**:
- User's preferred coding model and harness
- Receives full implementation prompt with all context
- Executes task to completion

**Implementation Prompt Structure**:
```markdown
# IMPLEMENTATION MODE

You are ready to implement. All critical questions have been answered.

## Task
[Full task details]

## Context
[Aggregated context with answers]

## Previous Attempts
[If any, with learnings]

## Validation Checklist
✅ All critical questions answered
✅ Requirements clear
✅ Context sufficient

## Instructions
[Task-specific instructions]

## Completion Criteria
- [ ] All requirements met
- [ ] Tests pass
- [ ] Documentation updated
- [ ] Use complete_task when done
```

**MCP Tools Available**:
- All standard tools (file operations, git, etc.)
- `complete_task` - Mark task complete with summary
- `submit_status_report` - Report issues or partial completion

**End Conditions**:
- Success: `complete_task` called
- Failure: `submit_status_report` with failure status

### Stage 4: Verification

**Trigger**: Brain detects task completion (via `complete_task` or status report)

**Automatic Queue**:
- Brain creates verification task
- Different arm instance (fresh context, no implementation bias)
- Same task classification but "verification" subtype

**Verification Prompt Structure**:
```markdown
# VERIFICATION MODE

You are verifying work completed by another arm. Be critical and thorough.

## Original Task
[Task requirements]

## Implementation Summary
[Summary from completing arm]

## Artifacts
[Files changed, commits, etc.]

## Verification Checklist
- [ ] All requirements from original task met
- [ ] Code follows project conventions
- [ ] Tests exist and pass
- [ ] No obvious bugs or issues
- [ ] Documentation accurate

## Instructions
1. Review all artifacts
2. Check against original requirements
3. Run tests if applicable
4. Verify acceptance criteria
5. Report: VERIFIED or ISSUES_FOUND

## If Issues Found
Use submit_status_report with:
- Specific issues discovered
- Severity (blocking vs minor)
- Recommendations for fix
```

**Verification Result Handling**:

**VERIFIED**:
- Mark task as complete
- Notify human of success
- Archive task discussions as "completed"

**ISSUES_FOUND**:
- If minor: Log issues for future fix tasks
- If blocking: Retry implementation with new arm
- If retry limit exceeded: Escalate to human

## Model Rotation and Token Distribution

**User Configuration**:
```typescript
interface ModelRotationConfig {
  // List of models/providers to rotate through
  models: {
    provider: string;      // "opencode", "anthropic", "openai", etc.
    model: string;         // "claude-sonnet-4", "gpt-4", etc.
    priority: number;      // Order in rotation
    maxTokensPerDay?: number;  // Optional daily limit
  }[];
  
  // Rotation strategy
  rotationStrategy: "round-robin" | "least-recently-used" | "cost-optimized";
  
  // Stage-specific overrides
  stageOverrides?: {
    validation?: string;    // Always use this model for validation
    exploration?: string;   // Override for exploration
    implementation?: string; // Override for implementation
    verification?: string;  // Override for verification
  };
}
```

**Default Rotation**:
- Round-robin through user's configured models
- Each arm session gets next model in rotation
- Verification arm always uses different model than implementation arm (if possible)

## Retry Logic

**Failure Detection**:
- Arm reports failure via `submit_status_report`
- Brain detects failure from status
- Verification finds blocking issues

**Retry Process**:
1. Increment retry counter on task
2. Select next model in rotation
3. Spawn new arm session
4. Re-validate (context may have improved)
5. Proceed to implementation

**Retry Limits**:
- Default: 3 retries per task
- Configurable per task classification
- After limit: Escalate to human

**Retry Context Enhancement**:
Each retry includes:
- Previous attempt summaries
- Mistakes made
- What was tried
- Verification findings (if applicable)

## Database Schema

### Task Attempts Table
```sql
CREATE TABLE task_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  arm_id TEXT NOT NULL,
  arm_session_id TEXT NOT NULL,  -- Unique per session
  model_used TEXT NOT NULL,      -- Provider:model
  harness_used TEXT NOT NULL,    -- opencode, claude-code, etc.
  stage TEXT NOT NULL CHECK (stage IN ('validation', 'exploration', 'implementation', 'verification')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT CHECK (status IN ('success', 'failure', 'abandoned', 'in_progress')),
  validation_score INTEGER,      -- 0-100
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  summary TEXT,
  key_learnings TEXT,
  mistakes TEXT DEFAULT '[]',    -- JSON array
  artifacts TEXT DEFAULT '[]',   -- JSON array
  verification_result TEXT CHECK (verification_result IN (NULL, 'verified', 'issues_found')),
  verification_issues TEXT       -- JSON array of issues
);

CREATE INDEX idx_task_attempts_task ON task_attempts(task_id);
CREATE INDEX idx_task_attempts_arm ON task_attempts(arm_id);
CREATE INDEX idx_task_attempts_stage ON task_attempts(stage);
```

### Task State Machine

```
PENDING → VALIDATING → [EXPLORING → VALIDATING] → IMPLEMENTING → VERIFYING → COMPLETED
              ↓                ↓                      ↓              ↓
           BLOCKED ←─────── RETRY ←──────────────── RETRY ←───── RETRY_LIMIT
                                                        ↓
                                                   ESCALATED
```

**State Transitions**:
- `PENDING` → `VALIDATING`: Arm requests task
- `VALIDATING` → `EXPLORING`: Score 50-69
- `VALIDATING` → `IMPLEMENTING`: Score 70+
- `VALIDATING` → `BLOCKED`: Score <50
- `EXPLORING` → `VALIDATING`: Exploration complete
- `IMPLEMENTING` → `VERIFYING`: Implementation complete
- `VERIFYING` → `COMPLETED`: Verification passed
- `VERIFYING` → `RETRY`: Verification found issues
- Any → `RETRY`: Failure reported (up to limit)
- `RETRY` → `ESCALATED`: Retry limit exceeded

## MCP Tools

### New Tools

**`get_validated_task`** (replaces `get_full_briefing`):
```typescript
{
  name: "get_validated_task",
  description: "Get a task with validation. May return exploration mode if context insufficient.",
  input: {
    armSessionId: string;  // Unique per arm session
  },
  output: {
    mode: "exploration" | "implementation";
    task: Task;
    context: TaskContext;
    validationScore: number;
    criticalQuestions?: string[];  // If exploration mode
    temperature: number;
    estimatedTokens: number;
  }
}
```

**`submit_exploration_findings`**:
```typescript
{
  name: "submit_exploration_findings",
  description: "Submit findings from exploration mode",
  input: {
    taskId: string;
    answers: {
      question: string;
      answer: string;
      source: string;  // File/location where found
    }[];
    discoveries: Discovery[];
    readyForImplementation: boolean;
  }
}
```

**`submit_verification_result`**:
```typescript
{
  name: "submit_verification_result",
  description: "Submit verification result for completed task",
  input: {
    taskId: string;
    result: "verified" | "issues_found";
    issues?: {
      severity: "blocking" | "minor";
      description: string;
      location?: string;
      recommendation: string;
    }[];
    artifactsReviewed: string[];
  }
}
```

## Implementation Phases

### Phase 1: Validation System
1. Implement context aggregator
2. Implement validation model integration
3. Add validation scoring logic
4. Update `get_full_briefing` to use validation

### Phase 2: Exploration Mode
1. Add exploration prompt template
2. Implement `submit_exploration_findings` tool
3. Add re-validation after exploration
4. Update task state machine

### Phase 3: Verification System
1. Add verification task auto-creation
2. Implement verification prompt template
3. Add `submit_verification_result` tool
4. Implement retry logic

### Phase 4: Model Rotation
1. Add model rotation configuration
2. Implement rotation strategies
3. Add per-stage model overrides
4. Track token usage per model

## Success Metrics

- **Validation Acceptance Rate**: % of tasks passing validation on first try
- **Exploration Success Rate**: % of exploration sessions that lead to implementation
- **Implementation Success Rate**: % of implementations passing verification
- **Average Attempts per Task**: Target < 1.5 (including verification)
- **Verification Pass Rate**: % of verifications that pass
- **Token Efficiency**: Average tokens per completed task

## Configuration

```typescript
interface PipelineConfig {
  validation: {
    model: string;              // Cheap validation model
    minScoreForImplementation: number;  // Default 70
    minScoreForExploration: number;     // Default 50
  };
  
  exploration: {
    maxDurationMinutes: number; // Default 30
    maxDiscoveries: number;     // Default 10
  };
  
  implementation: {
    temperatureByClassification: {
      [classification: string]: number;
    };
  };
  
  verification: {
    alwaysDifferentArm: boolean;  // Default true
    autoQueue: boolean;           // Default true
  };
  
  retry: {
    maxAttempts: number;          // Default 3
    backoffStrategy: "immediate" | "linear" | "exponential";
  };
  
  models: ModelRotationConfig;
}
```

## Files to Create/Modify

**Create:**
1. `src/brain/validation-engine.ts` - Validation scoring logic
2. `src/brain/exploration-controller.ts` - Exploration mode management
3. `src/brain/verification-controller.ts` - Verification workflow
4. `src/brain/model-rotator.ts` - Model rotation logic
5. `src/brain/__tests__/validation-engine.test.ts`

**Modify:**
1. `src/brain/prompt-generator.ts` - Add validation step
2. `src/mcp/server.ts` - Add new MCP tools
3. `src/db/state.ts` - Add task attempt tracking
4. `src/db/index.ts` - Add migration for new tables
5. `src/types/index.ts` - Add new types

## Notes

- This system ensures tasks have sufficient context before execution
- Exploration mode prevents arms from starting work with insufficient information
- Verification ensures quality and catches issues early
- Model rotation allows users to distribute token usage across providers
- All stages use the same arm harness system (OpenCode, Claude Code, etc.)
- The brain orchestrates the flow, arms execute the work
