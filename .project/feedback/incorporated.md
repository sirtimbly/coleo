# Incorporated Feedback

Feedback that has been addressed and incorporated into the project.

---

## 2024-01-15

### [FB-001] Radial coordinate system for Garden
**Received**: 2024-01-15  
**Source**: Human (Tim)  
**Priority**: High

> The 3D coordinate system should change so recently touched things are closer to the center. A radial system where each category is a slice of 360 degrees, and distance from center = activity level.

**Status**: ✅ Incorporated  
**Action Taken**: Updated `docs/architecture/components.md` with radial coordinate system design. Center = active, edge = dormant, angle = category.  
**Completed**: 2024-01-15

---

### [FB-002] Emergency pause like Toyota andon cord
**Received**: 2024-01-15  
**Source**: Human (Tim)  
**Priority**: High

> Brain should have the ability to pause all operations like the Toyota assembly line where anyone can pause work for a quality defect issue. These pause actions should be emergency signals from any arm.

**Status**: ✅ Incorporated  
**Action Taken**: Added Emergency Stop (Andon Cord) section to `docs/architecture/governance.md`. Any arm can trigger system-wide pause. Different from proposals - immediate action.  
**Completed**: 2024-01-15

---

### [FB-003] Loop detection with backoff
**Received**: 2024-01-15  
**Source**: Human (Tim)  
**Priority**: High

> Brain should deal with arms stuck in a loop by pausing their work, telling them to compact their session and try again. Include backoff throttling so loops don't consume infinite tokens.

**Status**: ✅ Incorporated  
**Action Taken**: Added Loop Detection & Backoff section to `docs/architecture/components.md`. Exponential backoff: 1, 5, 15, 30, 60 minutes. Token budget protection included.  
**Completed**: 2024-01-15

---

### [FB-004] Optional file claims with thrashing detection
**Received**: 2024-01-15  
**Source**: Human (Tim)  
**Priority**: High

> File claims seem slow. Have a toggle to turn off claims so updates can be parallel until an arm experiences thrashing where their changes get overwritten.

**Status**: ✅ Incorporated  
**Action Taken**: Added claim modes (strict/lazy/disabled) and thrashing detection to `docs/architecture/context.md`. Auto-enables claims when conflicts detected.  
**Completed**: 2024-01-15

---

### [FB-005] Arm API security
**Received**: 2024-01-15  
**Source**: Human (Tim)  
**Priority**: High

> How do we make sure arms don't start calling APIs with curl and kill each other or take over the brain?

**Status**: ✅ Incorporated  
**Action Taken**: Added Arm API Isolation section to `docs/architecture/api.md`. Arms use MCP only, blocked from HTTP API. Network isolation + scoped keys.  
**Completed**: 2024-01-15

---

### [FB-006] Add project management arm
**Received**: 2024-01-15  
**Source**: Human (Tim)  
**Priority**: High

> Need an arm that updates docs, tasks, acceptance criteria, and ensures human feedback is incorporated. Watches other arms and handles communication.

**Status**: ✅ Incorporated  
**Action Taken**: Created `docs/architecture/project-management.md` documenting PM arm role. Created `.project/` directory structure for Octopai.  
**Completed**: 2024-01-15

---

### [FB-007] Agent harness flexibility
**Received**: 2024-01-15  
**Source**: Human (Tim)  
**Priority**: High

> Need pluggable agent harnesses to support any terminal-based AI tool. Focus on keystrokes and text-based interactive terminal UIs first.

**Status**: ✅ Incorporated  
**Action Taken**: Created `docs/architecture/harnesses.md` with harness interface, PTY management, example implementations, and test suite specification.  
**Completed**: 2024-01-15

---

*Additional feedback items from the session also incorporated: observability MCP, Bun ORM options, blue/green deployments, local dev vs deployment, rollback pause, Docker Swarm, secret detection, exfiltration monitoring.*
