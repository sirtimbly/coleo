# Current Tasks

## Ready to Start

### [TASK-001] Hono API Server Setup
- **Priority**: High
- **Estimate**: 4 hours
- **Assigned**: Unassigned

**Description**: Set up Hono server with basic middleware, health endpoint, and CORS configuration.

**Acceptance Criteria**:
- [ ] Hono installed and configured
- [ ] Server starts on configurable port (default 8080)
- [ ] `GET /api/health` returns `{ status: "ok" }`
- [ ] `GET /api/status` returns basic system status
- [ ] CORS configured for local development
- [ ] Request logging middleware
- [ ] Error handling middleware
- [ ] API key authentication middleware (X-API-Key header)

**Dependencies**: None

**Notes**: This is the foundation for all Observatory API endpoints.

---

### [TASK-002] SQLite Database Schema
- **Priority**: High
- **Estimate**: 3 hours
- **Assigned**: Unassigned

**Description**: Create SQLite database with initial schema for arms, proposals, and activity.

**Acceptance Criteria**:
- [ ] Database file created at configurable path
- [ ] `arms` table with all fields from ArmProfile type
- [ ] `proposals` table with arguments and signals
- [ ] `claims` table for file ownership
- [ ] `activity` table for audit log
- [ ] `config` table for system settings
- [ ] Migration system (numbered SQL files)
- [ ] WAL mode enabled for better concurrency

**Dependencies**: None

**Notes**: Use `bun:sqlite` directly for now. Consider Drizzle later if complexity grows.

---

### [TASK-003] React App Shell
- **Priority**: High
- **Estimate**: 3 hours
- **Assigned**: Unassigned

**Description**: Create React application shell with Vite, routing, and basic layout.

**Acceptance Criteria**:
- [ ] Vite + React + TypeScript setup
- [ ] React Router with routes for: Dashboard, Arms, Garden, Proposals, Settings
- [ ] Basic layout component with header and sidebar
- [ ] Tailwind CSS configured
- [ ] Placeholder pages for each route
- [ ] API client utility (fetch wrapper with auth)

**Dependencies**: TASK-001 (for API client to connect to)

**Notes**: Keep it simple. No component library yet - just basic HTML/Tailwind.

---

### [TASK-004] WebSocket Server
- **Priority**: Medium
- **Estimate**: 3 hours
- **Assigned**: Unassigned

**Description**: Add WebSocket support for real-time updates.

**Acceptance Criteria**:
- [ ] WebSocket endpoint at `/ws`
- [ ] Authentication via query param or first message
- [ ] Channel subscription system (arms, garden, proposals, activity)
- [ ] Broadcast utility for sending to all subscribers
- [ ] Heartbeat/ping-pong for connection health
- [ ] Graceful handling of disconnections

**Dependencies**: TASK-001

**Notes**: Hono has WebSocket support via `hono/ws`.

---

### [TASK-005] Dashboard View
- **Priority**: Medium
- **Estimate**: 4 hours
- **Assigned**: Unassigned

**Description**: Create the main dashboard showing system overview.

**Acceptance Criteria**:
- [ ] Shows brain status (running/stopped)
- [ ] Lists active arms with status indicators
- [ ] Shows count of open proposals
- [ ] Shows recent activity feed
- [ ] Shows any pending human approvals
- [ ] Real-time updates via WebSocket

**Dependencies**: TASK-001, TASK-003, TASK-004

**Notes**: This is the first thing users see. Keep it clean and informative.

---

## In Progress

*No tasks currently in progress.*

---

## Blocked

*No blocked tasks.*

---

## Notes

Tasks are ordered roughly by dependency. TASK-001 and TASK-002 can be done in parallel. TASK-003 can start once TASK-001 has basic endpoints. TASK-004 and TASK-005 build on earlier work.

Estimated total for Phase 1 initial sprint: ~17 hours of focused work.
