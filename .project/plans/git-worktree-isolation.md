# Git Worktree Isolation for Arms - Implementation Plan

## Overview

Enable arms to work in isolated git worktrees while maintaining visibility and coordination through the Brain. This provides true filesystem isolation for parallel work without the complexity of multiple clones.

## Goals

1. **Isolation**: Arms can work in separate git worktrees without interfering with each other
2. **Visibility**: Users can see all worktree activity as separate folders
3. **Coordination**: Brain manages worktree lifecycle and merging
4. **Backward Compatibility**: Shared branch remains the default; worktrees are opt-in

## Architecture

```
project-repo/
├── .git/                          # Shared git history
├── src/, docs/, etc.              # Main worktree (shared branch - default)
└── .octopai/
    └── worktrees/
        ├── arm-auth-refactor/     # Worktree for auth refactoring
        ├── arm-api-migration/     # Worktree for API changes
        └── arm-docs-update/       # Worktree for documentation
```

## Implementation Phases

### Phase 1: Core Worktree Infrastructure
**Dependencies**: None (foundational)
**Estimated Effort**: 2-3 days

#### 1.1 Database Schema
Add worktree tracking to SQLite:

```sql
-- Worktrees table
CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,
  arm_id TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' 
    CHECK (status IN ('active', 'merging', 'merged', 'abandoned')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (arm_id) REFERENCES arms(id)
);

-- Index for quick lookups
CREATE INDEX idx_worktrees_arm ON worktrees(arm_id);
CREATE INDEX idx_worktrees_status ON worktrees(status);
```

**Files to modify**:
- `src/db/index.ts` - Add migration

#### 1.2 Worktree Service
Create worktree management service:

```typescript
// src/services/worktree.ts
export interface Worktree {
  id: string;
  armId: string;
  name: string;
  path: string;
  branch: string;
  baseCommit: string;
  status: 'active' | 'merging' | 'merged' | 'abandoned';
}

export interface CreateWorktreeOptions {
  armId: string;
  name?: string;           // Auto-generated if not provided
  branch?: string;         // Auto-generated if not provided
  baseCommit?: string;     // Defaults to current HEAD
}

export class WorktreeService {
  async createWorktree(options: CreateWorktreeOptions): Promise<Worktree>;
  async destroyWorktree(worktreeId: string): Promise<void>;
  async mergeWorktree(worktreeId: string): Promise<MergeResult>;
  async listWorktrees(armId?: string): Promise<Worktree[]>;
  async syncToMain(worktreeId: string): Promise<void>;  // Pull main changes
}
```

**Files to create**:
- `src/services/worktree.ts`
- `src/services/__tests__/worktree.test.ts`

#### 1.3 Git Operations
Wrapper for git worktree commands:

```typescript
// src/lib/git/worktree.ts
export async function createGitWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string
): Promise<void>;

export async function removeGitWorktree(
  repoPath: string,
  worktreePath: string
): Promise<void>;

export async function listGitWorktrees(repoPath: string): Promise<GitWorktreeInfo[]>;

export async function mergeWorktreeBranch(
  repoPath: string,
  branch: string,
  strategy?: 'merge' | 'rebase' | 'squash'
): Promise<MergeResult>;
```

**Files to create**:
- `src/lib/git/worktree.ts`
- `src/lib/git/__tests__/worktree.test.ts`

**Dependencies for Phase 1**:
- None - this is foundational

---

### Phase 2: MCP Tools for Arms
**Dependencies**: Phase 1 (WorktreeService)
**Estimated Effort**: 1-2 days

#### 2.1 Worktree MCP Tools
Add tools to MCP server:

```typescript
// src/mcp/server.ts - Add new tools

// Tool: create_worktree
// Allows arm to request a new worktree
{
  name: "create_worktree",
  description: "Create a new git worktree for isolated work",
  inputSchema: {
    name: { type: "string", description: "Optional name for the worktree" },
    reason: { type: "string", description: "Why isolation is needed" }
  }
}

// Tool: get_worktree_status
// Query current worktree and available worktrees
{
  name: "get_worktree_status",
  description: "Get status of current and other worktrees",
  inputSchema: {
    includeOtherArms: { type: "boolean" }
  }
}

// Tool: request_merge
// Request Brain to merge this worktree back to main
{
  name: "request_merge",
  description: "Request merge of current worktree to main branch",
  inputSchema: {
    strategy: { type: "string", enum: ["merge", "rebase", "squash"] },
    description: { type: "string" }
  }
}

// Tool: sync_worktree
// Pull latest changes from main into worktree
{
  name: "sync_worktree",
  description: "Sync current worktree with latest main changes",
  inputSchema: {}
}
```

**Files to modify**:
- `src/mcp/server.ts` - Add tool definitions and handlers

#### 2.2 Worktree Context in Prompts
Update arm prompts to include worktree context:

```typescript
// src/arm/prompts.ts
export interface WorktreeContext {
  currentWorktree?: {
    id: string;
    name: string;
    branch: string;
    baseCommit: string;
    path: string;
  };
  otherWorktrees: Array<{
    armId: string;
    name: string;
    branch: string;
    status: string;
  }>;
}

// Include in system prompt when arm is in worktree
export function generateWorktreePrompt(context: WorktreeContext): string {
  return `
You are working in a git worktree: ${context.currentWorktree.name}
Branch: ${context.currentWorktree.branch}
Base commit: ${context.currentWorktree.baseCommit}

Your changes are isolated from the main branch. When ready, use the 
'request_merge' tool to propose merging your work back.

Other active worktrees:
${context.otherWorktrees.map(w => `- ${w.name} (${w.armId}): ${w.branch}`).join('\n')}
`;
}
```

**Files to modify**:
- `src/arm/prompts.ts`
- `src/brain/prompt-generator.ts` - Include worktree context in bundles

**Dependencies for Phase 2**:
- ✅ Phase 1 (WorktreeService must exist)

---

### Phase 3: Brain Worktree Orchestration
**Dependencies**: Phase 1, Phase 2
**Estimated Effort**: 2-3 days

#### 3.1 Brain Worktree Manager
Add worktree coordination to Brain:

```typescript
// src/brain/worktree-manager.ts
export class BrainWorktreeManager {
  constructor(
    private worktreeService: WorktreeService,
    private permissionEngine: PermissionEngine
  ) {}

  // Called when arm requests a worktree
  async handleWorktreeRequest(
    armId: string,
    reason: string,
    name?: string
  ): Promise<WorktreeRequestResult> {
    // Check if arm should get a worktree
    const decision = await this.permissionEngine.evaluate({
      type: 'create_worktree',
      armId,
      reason
    });

    if (decision === 'deny') {
      return { approved: false, reason: decision.reason };
    }

    // Auto-generate name if not provided
    const worktreeName = name || this.generateWorktreeName(armId);
    
    // Create the worktree
    const worktree = await this.worktreeService.createWorktree({
      armId,
      name: worktreeName,
      branch: `octopai/${worktreeName}`
    });

    // Notify arm of new worktree
    await this.notifyArmOfWorktree(armId, worktree);

    return { approved: true, worktree };
  }

  // Called when arm requests merge
  async handleMergeRequest(
    armId: string,
    worktreeId: string,
    strategy: MergeStrategy
  ): Promise<MergeRequestResult> {
    // Get worktree info
    const worktree = await this.worktreeService.getWorktree(worktreeId);
    
    // Check for conflicts with other worktrees
    const conflicts = await this.detectInterWorktreeConflicts(worktree);
    
    if (conflicts.length > 0) {
      return {
        canMerge: false,
        conflicts,
        message: `Conflicts detected with: ${conflicts.map(c => c.worktreeName).join(', ')}`
      };
    }

    // Create proposal for merge
    const proposal = await this.createMergeProposal(worktree, strategy);
    
    return {
      canMerge: true,
      proposalId: proposal.id,
      message: 'Merge proposal created. Awaiting approval.'
    };
  }

  // Detect conflicts between worktrees
  private async detectInterWorktreeConflicts(worktree: Worktree): Promise<Conflict[]> {
    // Compare file changes between worktrees
    // Return list of conflicting worktrees
  }
}
```

**Files to create**:
- `src/brain/worktree-manager.ts`

#### 3.2 Worktree Lifecycle Integration
Integrate with existing Brain lifecycle:

```typescript
// src/brain/brain.ts - Add worktree handling

export class Brain {
  private worktreeManager: BrainWorktreeManager;

  async processArmMessage(armId: string, message: ArmMessage) {
    switch (message.type) {
      case 'create_worktree_request':
        return this.worktreeManager.handleWorktreeRequest(
          armId,
          message.reason,
          message.name
        );
      
      case 'merge_request':
        return this.worktreeManager.handleMergeRequest(
          armId,
          message.worktreeId,
          message.strategy
        );
      
      // ... existing message types
    }
  }

  // When spawning arm, check if it should use a worktree
  async spawnArm(options: SpawnArmOptions): Promise<Arm> {
    if (options.useWorktree) {
      const worktree = await this.worktreeManager.createWorktreeForArm(options);
      options.workdir = worktree.path;
    }
    
    return super.spawnArm(options);
  }
}
```

**Files to modify**:
- `src/brain/brain.ts` - Integrate worktree manager

**Dependencies for Phase 3**:
- ✅ Phase 1 (WorktreeService)
- ✅ Phase 2 (MCP tools for arms to request worktrees)

---

### Phase 4: CLI Commands
**Dependencies**: Phase 1, Phase 2, Phase 3
**Estimated Effort**: 1-2 days

#### 4.1 Worktree CLI Commands

```typescript
// src/cli/commands/worktree.ts

program
  .command('worktree:list')
  .description('List all worktrees')
  .action(async () => {
    // Display worktrees in table format
  });

program
  .command('worktree:create')
  .description('Create a new worktree for an arm')
  .requiredOption('-a, --arm <armId>', 'Arm ID')
  .option('-n, --name <name>', 'Worktree name')
  .option('-b, --branch <branch>', 'Branch name')
  .action(async (options) => {
    // Create worktree via API
  });

program
  .command('worktree:merge')
  .description('Merge a worktree back to main')
  .requiredOption('-w, --worktree <worktreeId>', 'Worktree ID')
  .option('-s, --strategy <strategy>', 'Merge strategy', 'merge')
  .action(async (options) => {
    // Initiate merge via API
  });

program
  .command('worktree:destroy')
  .description('Destroy a worktree')
  .requiredOption('-w, --worktree <worktreeId>', 'Worktree ID')
  .option('-f, --force', 'Force destroy even if unmerged')
  .action(async (options) => {
    // Destroy worktree via API
  });
```

**Files to create**:
- `src/cli/commands/worktree.ts`

**Files to modify**:
- `src/cli/index.ts` - Register new commands

#### 4.2 Arm Spawn with Worktree
Update arm spawn command:

```typescript
// src/cli/commands/arm.ts - Add worktree option

armCmd
  .command('spawn')
  .option('--worktree', 'Spawn arm in a new worktree for isolation')
  .option('--worktree-name <name>', 'Name for the worktree')
  .action(async (options) => {
    if (options.worktree) {
      // Request Brain to create worktree first
      const worktree = await createWorktreeForArm(options);
      options.workdir = worktree.path;
    }
    // ... rest of spawn logic
  });
```

**Dependencies for Phase 4**:
- ✅ Phase 1 (WorktreeService)
- ✅ Phase 3 (Brain orchestration)

---

### Phase 5: Web UI Integration
**Dependencies**: Phase 1, Phase 2, Phase 3, Phase 4
**Estimated Effort**: 2-3 days

#### 5.1 API Endpoints

```typescript
// src/api/routes/worktrees.ts

// GET /api/worktrees - List all worktrees
// GET /api/worktrees/:id - Get worktree details
// POST /api/worktrees - Create new worktree
// POST /api/worktrees/:id/merge - Request merge
// DELETE /api/worktrees/:id - Destroy worktree
// POST /api/worktrees/:id/sync - Sync with main
```

**Files to create**:
- `src/api/routes/worktrees.ts`

**Files to modify**:
- `src/api/server.ts` - Register routes

#### 5.2 React Components

```typescript
// src/web/src/components/WorktreeList.tsx
// Display worktrees in a list/table

// src/web/src/components/WorktreeCard.tsx
// Card showing worktree status, arm, branch, etc.

// src/web/src/components/CreateWorktreeDialog.tsx
// Dialog for creating new worktrees

// src/web/src/components/MergeWorktreeDialog.tsx
// Dialog for merging worktrees with conflict preview
```

**Files to create**:
- `src/web/src/components/WorktreeList.tsx`
- `src/web/src/components/WorktreeCard.tsx`
- `src/web/src/components/CreateWorktreeDialog.tsx`
- `src/web/src/components/MergeWorktreeDialog.tsx`
- `src/web/src/pages/WorktreesPage.tsx`

#### 5.3 Garden Visualization Update
Update the 3D garden view to show worktrees:

```typescript
// src/web/src/components/Garden3D.tsx
// Add worktree nodes as separate "islands" in the garden
// Show connections between worktrees and main branch
// Visual indicators for merge status
```

**Dependencies for Phase 5**:
- ✅ Phase 1 (WorktreeService)
- ✅ Phase 4 (CLI commands - reuse API endpoints)

---

### Phase 6: Advanced Features
**Dependencies**: All previous phases
**Estimated Effort**: 3-5 days (optional)

#### 6.1 Inter-Worktree Conflict Detection
Detect when two worktrees modify the same files:

```typescript
// src/services/worktree-conflicts.ts
export async function detectWorktreeConflicts(
  worktreeA: Worktree,
  worktreeB: Worktree
): Promise<FileConflict[]> {
  // Compare changed files between worktrees
  // Return overlapping files
}
```

#### 6.2 Worktree Sync Strategies
Multiple strategies for keeping worktrees updated:

```typescript
export type SyncStrategy = 
  | 'manual'      // Arm must explicitly sync
  | 'auto-pull'   // Auto-pull main changes (safe)
  | 'auto-rebase' // Auto-rebase on main (risky)
  | 'notify';     // Notify arm of new changes
```

#### 6.3 Worktree Templates
Pre-configured worktrees for common scenarios:

```typescript
// .octopai/worktree-templates/
// ├── refactor.json
// ├── feature.json
// └── hotfix.json
```

#### 6.4 Worktree Archival
Archive merged worktrees instead of deleting:

```typescript
// Move to .octopai/worktrees/archive/
// Keep history for audit/debugging
```

**Dependencies for Phase 6**:
- ✅ All previous phases

---

## Testing Strategy

### Unit Tests
- `src/services/__tests__/worktree.test.ts` - Worktree service
- `src/lib/git/__tests__/worktree.test.ts` - Git operations
- `src/brain/__tests__/worktree-manager.test.ts` - Brain coordination

### Integration Tests
- Create worktree → Make changes → Merge → Verify on main
- Multiple worktrees → Detect conflicts → Resolve
- Worktree lifecycle (create, sync, merge, destroy)

### Regression Tests
- Existing shared branch workflow still works
- Arms without worktrees unaffected
- Claims system works across worktrees

## Migration Path

### For Existing Projects
1. No changes required - shared branch remains default
2. Arms can opt-in to worktrees via MCP tools
3. Existing claims system continues to work

### For New Projects
1. Consider worktrees for long-running tasks from day 1
2. Document when to use worktrees vs shared branch

## Documentation Updates

### Files to Update
- `docs/architecture/overview.md` - Add worktree section
- `docs/guides/getting-started.md` - Document worktree usage
- `AGENTS.md` - Add worktree coordination guidelines

### New Documentation
- `docs/guides/worktrees.md` - Complete worktree guide
- `.project/decisions/012-git-worktrees.md` - ADR

## Rollout Plan

1. **Phase 1-2** (Week 1): Core infrastructure + MCP tools
2. **Phase 3** (Week 2): Brain orchestration
3. **Phase 4** (Week 2): CLI commands
4. **Phase 5** (Week 3): Web UI
5. **Phase 6** (Week 4+): Advanced features (optional)

## Success Criteria

- [ ] Arms can create worktrees via MCP tools
- [ ] User can see all worktrees in Web UI
- [ ] Worktrees can be merged back to main
- [ ] Conflicts between worktrees are detected
- [ ] Shared branch workflow still works
- [ ] All tests pass

## Open Questions

1. Should worktrees be auto-cleaned up after merge?
2. How to handle binary files across worktrees?
3. Should we support nested worktrees (worktree in a worktree)?
4. How to visualize worktree relationships in Garden 3D?

## Related ADRs

- ADR-010: Layered Communication Model
- ADR-011: Production-First Technology Selection
- (Future) ADR-012: Git Worktree Isolation
