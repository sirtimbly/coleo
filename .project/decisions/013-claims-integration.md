# Claims System Integration Design Notes

## Implementation Summary

This PR implements conservative integration between the Brain and the file claims system to prevent conflicts when multiple arms attempt to work on the same files.

## Default Behavior (Passive Mode)

By default (`brain.resolveClaimsActive = false`):

1. **Claim Conflict Detection**: The Brain checks pending tasks for file conflicts with active claims during the `assignTasks()` cycle
2. **Task Blocking**: Tasks with conflicting file claims are marked as `blocked` status
3. **Human Notification**: The Brain sends notifications to humans about blocked tasks with details of the conflicts
4. **No Auto-Resolution**: The Brain does NOT attempt to automatically resolve conflicts

## Files Changed

- `src/brain/brain.ts`: Added claim conflict checking logic
  - `checkAndBlockTasksForClaimConflicts()`: Main entry point for conflict detection
  - `getActiveFileClaims()`: Queries the API for active file claims
  - `extractFilePathsFromTask()`: Extracts file paths from task artifacts, discoveries, and description
  - `findClaimConflicts()`: Identifies conflicts between task files and active claims
  - `notifyHumanOfClaimConflict()`: Sends notifications about blocked tasks
  - `attemptClaimConflictResolution()`: Placeholder for future active resolution

- `src/brain/__tests__/claims-integration.test.ts`: Unit tests for the new functionality

## Configuration

The `resolveClaimsActive` flag controls the behavior:

```typescript
// In Brain class
private resolveClaimsActive = false; // Default: passive mode
```

When set to `true`, the Brain will attempt active conflict resolution (not yet implemented).

## Open Questions / Future Work

1. **Active Resolution Policy**: What should the Brain do when conflicts are detected?
   - Transfer claims from idle arms to active arms?
   - Coordinate work between arms on the same file?
   - Split tasks based on file boundaries?
   - Prioritize tasks based on urgency/importance?

2. **UX for Resolution**: How should humans interact with blocked tasks?
   - Manual unblocking via CLI/API?
   - Web UI for viewing and managing conflicts?
   - Automatic unblocking when claims are released?

3. **Claim Scope**: Should claims be more granular?
   - Line-level claims (arm A claims lines 1-50, arm B claims lines 51-100)?
   - Function-level claims?
   - Directory-level claims with automatic sub-file tracking?

4. **Conflict Detection Accuracy**: 
   - Current implementation uses regex to extract file paths from descriptions
   - Could be improved with explicit file associations in task metadata
   - Should we parse imports/dependencies to detect indirect conflicts?

5. **Performance**: 
   - Current implementation queries all active claims for each task check
   - Could be optimized with caching or incremental updates
   - Should we use JetStream events for real-time claim notifications?

## Testing

Run the claims integration tests:

```bash
bun test src/brain/__tests__/claims-integration.test.ts
```

## Migration Path

This is a backward-compatible change:
- Existing tasks without file associations will not be affected
- Tasks will only be blocked if file conflicts are detected
- Humans can manually unblock tasks if needed
- The feature can be disabled by setting `resolveClaimsActive = false` (default)

## Related Code

- MCP claims tools: `src/mcp/server.ts` (lines 2251-2750)
- Claims database schema: `src/db/index.ts` (migration 003)
- Garden API for claims: `src/api/routes/garden.ts`
