# Agentic Brain Implementation Plan

## Overview

Transform the Brain from a polling loop with hardcoded logic into an **agentic AI system** that uses an LLM to make decisions about:
- Task determination (progressive planning)
- Human message interpretation
- Discovery handling and escalation
- Arm coordination and stuck loop detection

## Current State

The existing `brain.ts` has ~3000 lines of imperative code with hardcoded logic for:
- Polling cycle steps
- Task assignment
- Stuck arm detection
- Message handling

This is difficult to maintain and doesn't adapt to complex situations.

## Target State

```
┌─────────────────────────────────────────────────────────────────┐
│                    Agentic Brain                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐    ┌─────────────────┐    ┌──────────────┐    │
│  │ Human Input │───▶│  Brain Agent    │───▶│ Arm Actions  │    │
│  │ (Email/     │    │  (LLM + Tools)  │    │ (via MCP/    │    │
│  │  Tasks)     │    │                 │    │  NATS)       │    │
│  └─────────────┘    └─────────────────┘    └──────────────┘    │
│                           │                                      │
│                           ▼                                      │
│                  ┌─────────────────┐                             │
│                  │  Tools (SQLite, │                             │
│                  │   File System,  │                             │
│                  │   MCP, NATS)    │                             │
│                  └─────────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
```

## Framework Selection

### Recommendation: LangChain.js with createAgent

**Why LangChain.js:**
- Mature ecosystem with TypeScript support
- `createAgent` API provides clean agent pattern
- Tool calling with Zod schema validation
- Memory/checkpointer for conversation state
- Works in Bun with minor adjustments

**Alternative considered: nanoagent**
- Pure TypeScript, no dependencies
- Lighter weight
- Less documentation and examples

**Model Selection:**

| Model | Use Case | Rationale |
|-------|----------|-----------|
| GPT-4.1 | Complex reasoning | Task determination, planning |
| GPT-4.1 Codex | Code/technical | Discovery analysis, code review |

GPT-4.1 recommended because:
- Better at following complex instructions
- Excellent tool use
- Cost-effective for non-realtime use

## Agent Tools

The Brain agent needs these tools:

### 1. Plan Reading Tool
```typescript
readPlan(planId?: string): PlanDocument
```
- Reads `.project/plans/*.md`
- Parses bullet points and status
- Returns structured plan data

### 2. Task History Tool
```typescript
getTaskHistory(options: {
  planId?: string,
  limit?: number,
  status?: 'completed' | 'in_progress'
}): Task[]
```
- Queries SQLite for completed/in-progress tasks
- Returns task data with artifacts

### 3. Status Reports Tool
```typescript
getStatusReports(options: {
  taskId?: string,
  armId?: string,
  since?: Date
}): StatusReport[]
```
- Reads status reports from queue
- Parses discoveries, issues, progress

### 4. Discoveries Tool
```typescript
getDiscoveries(options: {
  filePattern?: string,
  severity?: string[],
  limit?: number
}): Discovery[]
```
- Queries SQLite discoveries table
- Full-text search via FTS5

### 5. Next Task Determination Tool
```typescript
determineNextTask(options: {
  planId: string,
  armId?: string,
  context?: Discovery[]
}): NextTask
```
- Core progressive planning logic
- Reads plan + history + status reports
- Returns next task with context bundle

### 6. Task Assignment Tool
```typescript
assignTask(task: Task, armId: string): void
```
- Sends task to arm via NATS or queue
- Updates task status in SQLite

### 7. Discovery Storage Tool
```typescript
storeDiscovery(discovery: Discovery): void
```
- Inserts discovery into SQLite
- Updates FTS5 index

### 8. Human Message Tool
```typescript
sendToHuman(message: {
  subject: string,
  body: string,
  priority?: 'low' | 'normal' | 'high'
}): void
```
- Writes to Maildir inbox
- Triggers email notification

### 9. Arm Status Tool
```typescript
getArmStatus(armId?: string): ArmStatus[]
```
- Checks arm health and current task
- Detects stuck loops

## Agent System Prompt

```
You are the Octopai Brain, an intelligent orchestrator of AI arms.

## Your Role

You coordinate arms to execute work based on plans. You receive human input, determine what needs to be done, and assign tasks to arms. You collect discoveries and keep humans informed.

## Core Principles

1. **Progressive Planning**: You don't pre-generate all tasks. You determine the next task by:
   - Reading the current plan document
   - Checking what tasks have been completed
   - Reviewing status reports from arms
   - Considering open discoveries

2. **Context Matters**: Before assigning any task, gather relevant context:
   - Prior discoveries about the area
   - Related documentation
   - Previous attempts at similar tasks

3. **Communicate Clearly**: 
   - Status reports to humans should be concise
   - Task assignments to arms should be clear and complete
   - Escalate issues promptly

## Task Classifications

- **architect**: Planning, analysis, creating plans
- **development**: Implementing code, making changes
- **qa**: Testing, verification, documentation sync
- **verify**: Check previous work, address discoveries

## Decision Process

When determining what to do:

1. What did the human ask for?
2. What does the current plan say?
3. What's been done already?
4. What issues were found (discoveries)?
5. What's the next logical step?
6. What context does the arm need?

## Tools Available

Use the tools provided to gather information and take action. Think through each decision carefully.
```

## Agentic Loop Design

### Main Agent Loop (per poll cycle)

```
1. Check for human messages (email)
   └─→ If new message: interpret and respond
   
2. Check arm status
   └─→ If stuck: take intervention action
   
3. Check for completed tasks
   └─→ If task done: determine next task
   
4. Check idle arms
   └─→ If arm idle: assign next task

5. Periodic checks
   └─→ Discoveries, status reports, etc.
```

### Each step uses the agent with appropriate context:

```typescript
// Example: Determine next task after task completion
const result = await brainAgent.invoke({
  messages: [{
    role: "user",
    content: `Task "${completedTask.subject}" was just completed.
    
    Plan: ${currentPlan}
    Completed tasks: ${taskHistory}
    Open discoveries: ${discoveries}
    
    What should the arm work on next?`
  }]
});
```

## Implementation Steps

### Phase 1: Framework Setup

- [ ] Add LangChain.js dependency
- [ ] Create agent configuration
- [ ] Set up model (GPT-4.1)
- [ ] Implement basic tool interface

### Phase 2: Tool Implementation

- [ ] `readPlan` tool
- [ ] `getTaskHistory` tool
- [ ] `getStatusReports` tool
- [ ] `getDiscoveries` tool
- [ ] `determineNextTask` tool (core logic)
- [ ] `assignTask` tool
- [ ] `storeDiscovery` tool
- [ ] `sendToHuman` tool
- [ ] `getArmStatus` tool

### Phase 3: Agent Integration

- [ ] Create BrainAgent class
- [ ] Define system prompt
- [ ] Wire tools to agent
- [ ] Add memory/checkpointer for state

### Phase 4: Migration

- [ ] Refactor existing brain.ts logic
- [ ] Move hardcoded logic to tools
- [ ] Keep polling loop (calls agent each cycle)
- [ ] Add error handling and fallbacks

### Phase 5: Testing

- [ ] Unit tests for each tool
- [ ] Integration tests for agent decisions
- [ ] Human-in-the-loop evaluation
- [ ] Performance optimization

## File Structure

```
src/brain/
├── agent/                    # New agentic implementation
│   ├── index.ts             # BrainAgent class
│   ├── tools/               # Tool implementations
│   │   ├── plans.ts
│   │   ├── tasks.ts
│   │   ├── discoveries.ts
│   │   ├── status.ts
│   │   ├── assignment.ts
│   │   └── human.ts
│   ├── prompts.ts           # System prompts
│   └── types.ts             # Agent types
├── brain.ts                 # Keep polling loop (refactored)
├── plan-parser.ts           # Existing plan parsing
└── ...
```

## Migration Strategy

**Don't rewrite everything at once.**

1. Keep existing `brain.ts` as the orchestration layer
2. Create new `agent/` directory with agentic implementation
3. Replace one function at a time:
   - `determineNextTask()` → use agent
   - `handleDiscovery()` → use agent
   - `handleHumanMessage()` → use agent
4. Fallback to existing logic if agent fails

## Cost Considerations

The agent runs once per poll cycle (~30 seconds):
- 1-2 agent invocations per cycle
- ~500-1000 tokens per invocation
- GPT-4.1 is cost-effective for this usage

**Estimated cost**: ~$0.01-0.05 per day

## Error Handling

If the agent fails or LLM is unavailable:
- Fall back to existing heuristic logic
- Log the error for debugging
- Continue with basic polling

## Success Metrics

- Agent makes reasonable task determinations
- Discovers are properly stored and surfaced
- Human messages get appropriate responses
- Stuck arms are detected and handled
- System remains responsive during LLM outages

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| LLM cost overruns | Set max iterations per cycle, use fallback |
| Agent makes bad decisions | Keep human notification, allow override |
| Tool errors | Validate tool outputs, use existing logic as backup |
| Latency | Async agent calls, timeout handling |

## References

- [LangChain.js createAgent](https://docs.langchain.com/oss/javascript/langchain/quickstart)
- [Progressive Planning](./progressive-planning.md)
- [Task Representation](./tasks-representation.md)
- [Requirements & Philosophy](./requirements.md)
