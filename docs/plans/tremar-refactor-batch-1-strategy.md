# Tremar Refactor Batch 1: Strategy Document

**Status Report Link:** sr-1771210300253-gzhlgc  
**Date:** 2026-03-30  
**Coordinator:** Portdex  
**Owner:** Tremar

---

## Executive Summary

This document outlines the splitting strategy, execution order, and rollout plan for Tremar's first refactor batch. The batch targets 5 files across API routes, arm infrastructure, NATS, and harness components. All target files are within acceptable size limits (660-686 lines), allowing direct refactoring without extraction subtasks.

---

## Target File Analysis

### File Inventory

| # | File | Lines | Priority | Dependencies | Extraction Needed |
|---|------|-------|----------|--------------|-------------------|
| 1 | `src/nats/jetstream.ts` | 672 | **Critical** | 20+ imports | No |
| 2 | `src/harness/event-stream.ts` | 660 | High | 5+ imports | No |
| 3 | `src/api/routes/activity.ts` | 686 | High | jetstream | No |
| 4 | `src/api/routes/mail.ts` | 683 | High | jetstream, mail | No |
| 5 | `src/arm/spawner.ts` | 681 | High | None (isolated) | No |

**Key Insight:** All files are under the 800-line policy threshold, enabling direct refactoring without preliminary extraction work.

---

## Splitting Strategy

### Phase 1: Shared Infrastructure (Priority: Critical)

#### 1.1 src/nats/jetstream.ts (672 lines)
**Why First:** This is the most critical shared infrastructure file with 20+ dependents across the codebase.

**Refactoring Approach:**
- Split EventStore class (lines 75-504) into smaller focused methods
- Extract query helpers into separate functions
- Move test utilities (InMemoryEventStore) to `src/nats/__tests__/test-utils.ts`
- Preserve `eventStore` singleton export for backward compatibility

**Potential Modules:**
```
src/nats/
├── jetstream.ts              # Core exports & singleton
├── event-store.ts            # EventStore class implementation
├── query-helpers.ts          # Event querying utilities
└── __tests__/
    └── test-utils.ts         # InMemoryEventStore & helpers
```

**Risk Level:** High (20+ dependents)  
**Rollback Strategy:** Maintain original exports as re-exports from new modules

---

#### 1.2 src/harness/event-stream.ts (660 lines)
**Why Second:** Supports harness components and depends on stable jetstream.

**Refactoring Approach:**
- Extract OpenCodeEventStream class (primary component)
- Move utility functions (filterEvent, truncateLargeFields, shouldPersistEvent) to `src/harness/event-utils.ts`
- Keep event stream orchestration logic in place

**Potential Modules:**
```
src/harness/
├── event-stream.ts           # Main orchestration
├── event-stream-core.ts      # OpenCodeEventStream class
└── event-utils.ts            # Filter & truncation utilities
```

**Dependencies:** jetstream.ts  
**Risk Level:** Medium (5 dependents)

---

### Phase 2: API Routes (Parallel Work)

#### 2.1 src/api/routes/activity.ts (686 lines)
**Refactoring Approach:**
- Extract activity query builders to `src/api/routes/activity-queries.ts`
- Move activity transformation logic to `src/api/routes/activity-transform.ts`
- Keep route handlers and middleware in main file

**Parallel Safe:** Yes (after jetstream is stable)

---

#### 2.2 src/api/routes/mail.ts (683 lines)
**Refactoring Approach:**
- Extract mail route handlers to `src/api/routes/mail-handlers.ts`
- Move Postmark gateway integration to `src/mail/postmark-routes.ts`
- Keep route registration and middleware in main file

**Parallel Safe:** Yes (after jetstream is stable)

---

### Phase 3: Arm Infrastructure

#### 3.1 src/arm/spawner.ts (681 lines)
**Refactoring Approach:**
- Extract spawn logic into `src/arm/spawn-logic.ts`
- Move MCP config utilities to `src/arm/mcp-config.ts`
- Keep spawner orchestration and state management in main file

**Dependencies:** Minimal (isolated arm component)  
**Parallel Safe:** Yes (can work in parallel with routes)

---

## Execution Order

```
Phase 1 (Sequential - Infrastructure)
├── 1.1 src/nats/jetstream.ts [CRITICAL - Must complete first]
│   └── BLOCKS: All other work
│
└── 1.2 src/harness/event-stream.ts [After jetstream]
    └── BLOCKS: harness/* work

Phase 2 (Parallel - API Routes)
├── 2.1 src/api/routes/activity.ts [After Phase 1]
│
└── 2.2 src/api/routes/mail.ts [After Phase 1]
    └── Can run in parallel with activity.ts

Phase 3 (Isolated - Arm Infrastructure)
└── 3.1 src/arm/spawner.ts [After Phase 1]
    └── Can run in parallel with Phase 2
```

---

## Owner Assignment

### Tremar (Primary Owner)
- **Overall coordination** and final review
- **Phase 1.1:** src/nats/jetstream.ts (most critical)
- **Phase 2.2:** src/api/routes/mail.ts

### Portdex (Supporting)
- **Phase 1.2:** src/harness/event-stream.ts
- **Phase 2.1:** src/api/routes/activity.ts

### Available Arms (Parallel Work)
- **Phase 3.1:** src/arm/spawner.ts (isolated, can be parallel)

---

## Rollout Plan

### Stage 1: Infrastructure Stabilization (Day 1)
**Goal:** Ensure shared infrastructure is stable before route work

**Checkpoints:**
1. ✅ jetstream.ts refactored and tested
2. ✅ All 20+ dependents still work
3. ✅ eventStore singleton maintained
4. ✅ Tests pass: `bun test src/nats/`

**Rollback:** Revert to original jetstream.ts, keep exports compatible

---

### Stage 2: Harness Support (Day 1-2)
**Goal:** Refactor event-stream.ts after jetstream is stable

**Checkpoints:**
1. ✅ event-stream.ts refactored
2. ✅ Harness components (manager, opencode-api, opencode-tui) still work
3. ✅ Tests pass: `bun test src/harness/`

---

### Stage 3: API Routes (Day 2-3) - Parallel
**Goal:** Refactor activity.ts and mail.ts simultaneously

**Checkpoints:**
1. ✅ activity.ts refactored and tested
2. ✅ mail.ts refactored and tested
3. ✅ Routes still respond correctly
4. ✅ Integration tests pass

**Parallel Work:** Portdex takes activity.ts, Tremar takes mail.ts

---

### Stage 4: Arm Infrastructure (Day 3-4) - Parallel
**Goal:** Refactor spawner.ts

**Checkpoints:**
1. ✅ spawner.ts refactored
2. ✅ Arm spawning still works
3. ✅ Tests pass: `bun test src/arm/`

**Parallel Work:** Can be done simultaneously with Phase 3

---

### Stage 5: Integration & Validation (Day 5)
**Goal:** Full system validation

**Checkpoints:**
1. ✅ All tests pass: `bun test`
2. ✅ TypeScript compiles: `bun run typecheck`
3. ✅ Services start and communicate
4. ✅ Brain/arm lifecycle works end-to-end
5. ✅ No regressions in existing functionality

---

## Risk Management

### Identified Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| jetstream.ts breaks dependents | Medium | Critical | Comprehensive tests, backward-compatible exports |
| File claims from other arms | Medium | High | Coordinate via brain, use claim_file tool |
| Test failures after refactor | Medium | High | Run tests after each file, not just at end |
| Services not running | High | Blocker | Start services before validation, document in plan |

### Conflict Avoidance
- Use `claim_file` MCP tool before editing any target file
- Check `coleo_check_conflicts` before starting work
- Coordinate via brain status reports
- Work on different phases in parallel to minimize conflicts

---

## Success Criteria

- [ ] All 5 target files refactored and under 600 lines
- [ ] All TypeScript compilation passes
- [ ] All tests pass (no regressions)
- [ ] Services start and communicate properly
- [ ] Brain/arm lifecycle works end-to-end
- [ ] No breaking changes to public APIs
- [ ] Documentation updated (if needed)

---

## Rollback Procedures

### Per-File Rollback
```bash
# If a refactor causes issues:
git checkout HEAD -- src/nats/jetstream.ts
bun run typecheck
bun test src/nats/
```

### Full Batch Rollback
```bash
# Return to pre-refactor state:
git checkout refactor/tremar-batch-sr-1771210300253-gzhlgc -- .
bun run typecheck
bun test
```

---

## Monitoring

### Metrics to Track
1. **Build Status:** `bun run typecheck` passes/fails
2. **Test Status:** Number of passing/failing tests
3. **File Sizes:** Lines of code per target file
4. **Dependency Count:** Number of imports per module
5. **Service Health:** API/Brain/Qdrant availability

### Status Updates
- Daily status reports via `submit_status_report`
- Blockers reported immediately via `report_discovery`
- Completion updates via `complete_task`

---

## Appendix: Dependencies

### jetstream.ts Dependents (20+ files)
```
src/api/routes/arms.ts
src/api/routes/activity.ts
src/api/routes/mail.ts
src/api/routes/garden.ts
src/api/routes/tasks.ts
src/api/routes/system.ts
src/api/routes/brain.ts
src/api/routes/events.ts
src/api/server.ts
src/mcp/server.ts
src/mcp/utils.ts
src/brain/health-monitor.ts
src/brain/event-window.ts
src/brain/permission-engine.ts
src/brain/activity-types.ts
src/brain/activity-analyzer.ts
src/arm/claim-enforcement.ts
src/harness/manager.ts
src/harness/opencode-api.ts
src/harness/opencode-tui.ts
src/db/transactions.ts
src/vector/indexing-pipeline.ts
```

### event-stream.ts Dependents (5 files)
```
src/harness/manager.ts
src/harness/opencode-api.ts
src/harness/opencode-tui.ts
src/agent/arm-agent.ts
src/api/server.ts
```

---

## Next Steps

1. **Tremar reviews this plan** and confirms approach
2. **Start Phase 1.1** (jetstream.ts) - highest priority
3. **Portdex prepares** for Phase 1.2 (event-stream.ts)
4. **Coordinate with other arms** before starting parallel work
5. **Begin Stage 1** once prerequisites are complete

---

*Document Version: 1.0*  
*Last Updated: 2026-03-30*  
*Ready for Implementation: Yes*
