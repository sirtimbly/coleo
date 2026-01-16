# Task Backlog

Ideas and future work that aren't scheduled yet.

This backlog is a **rough outline** for the Brain Agent. It points to likely areas where the next tasks will come from, but the actual tasks should be generated at runtime from:

- The main project plan (`.project/plan.md`)
- Phase-specific plans in `.project/plans/`
- Phase acceptance criteria in `.project/acceptance/`
- Status reports and discoveries

---

## Phase 1: Observatory Foundation (Next)

High-level work to extend and refine the Observatory (API + Web UI + CLI).

### API & Health

- Harden `/api/system/health` to surface degraded states (DB down, brain not running, NATS disconnected) without crashing the server.
- Add basic version/build info to a system endpoint for debugging.

### Arm & Activity Surface

- Expand `/api/arms` to include richer status (current task classification, last task result, last error if any).
- Improve `/api/activity` filters (by arm, by classification, by severity) to support a useful timeline in the UI.

### Web UI Improvements

- Add a simple **Activity Timeline** view that shows recent events with filters (arm, type, time range).
- Add an **Arm Detail** sidebar/panel (status, recent tasks, last errors) linked from the arm list.
- Expose a minimal **Config** view for API key and environment information (read-only for now).

### CLI / API Alignment

- Ensure `octopai status` maps cleanly to the same data the dashboard shows (arms + system health + recent activity).
- Document and align error messages between CLI and API for common failure cases (API unreachable, auth failed).

---

## Phase 1.5: Email Gateway

Work toward the IMAP/SMTP bridge described in `.project/plan.md`.

### IMAP/SMTP Skeleton

- Sketch and stub an IMAP server that reads from the existing Maildir structure.
- Define configuration format for IMAP/SMTP credentials and ports.

### Mail API Surface

- Add `/api/mail/*` endpoints that expose Maildir metadata needed by an eventual email gateway:
  - List threads / conversations.
  - Fetch message metadata (subject, from, to, date, tags).

### Coordinator Logic (Design Level)

- Outline the "mail dispatcher" behavior:
  - How to mirror relevant human ↔ brain messages to working arms.
  - How to tag or route messages by task or phase.

(Implementation of full IMAP/SMTP behavior is later; these items help architect tasks define concrete plan bullets.)

---

## Phase 2: Task Classification & Context (Follow-ups)

Phase 2 is mostly implemented, but some items remain or will need refinement.

### Classification-Specific Prompts

- Define and validate prompt templates for each classification:
  - `architect` (including project-management flavor)
  - `development`
  - `qa`
  - `documentation`

### Classification Execution

- Ensure arms can **actually run tasks** under each classification end-to-end (not just data model support).
- Add minimal tests or smoke checks to prove each classification path works.

---

## Phase 2.1: Progressive Planning

Backlog items that move us from design to implementation for progressive planning.

### Plan & History Wiring

- Implement storage for completed task history that matches the needs of the decision logic in `progressive-planning.md`.
- Implement a minimal plan-reader that can parse Phase plan documents in `.project/plans/` into structured bullets, including dependencies.

### Status & Discoveries

- Add status report parsing in the Brain so it can:
  - Detect "completed successfully" vs. "completed with issues" vs. "blocked" vs. "need clarification".
- Connect discovery records to plan bullets where possible (e.g., by feature or file path).

### Task Assignment Loop

- Implement `determineNextTask` using the algorithm in `progressive-planning.md`.
- Add a way to trace why a given task was assigned (brief explanation for humans).

---

## Phase 2.2: Documentation Updates

These are design-level tasks to support the documentation-update flow.

### Doc Update Triggering

- Implement a simple mechanism to compute "files changed since last doc update" (even if it is a rough heuristic at first).
- Track "last doc update" timestamps in SQLite or `.project` so documentation tasks can be scheduled.

### Documentation Task Context

- Wire a documentation classification task to receive:
  - List of changed files.
  - Pointers to feature docs likely affected.
  - Relevant plan bullets for "future work" notes.

---

## Phase 2.5: Status Reports

### Status Message Shape

- Define and document the canonical status report JSON shape (fields for done, discovered, blocking, next steps).

### Routing & Storage

- Implement storage of status reports in SQLite so the Brain can query them for progressive planning.
- Add an API endpoint to view recent status reports for debugging.

---

## Phase 2.6: Agentic Brain

These are **design and integration** ideas, not immediate implementation tasks.

- Evaluate and possibly prototype LangChain.js integration for the Brain Agent in a separate module.
- Identify a minimal set of tools (`readPlan`, `getTaskHistory`, `determineNextTask`, etc.) to wrap first.
- Design a safe fallback path when LLM calls fail so the existing polling logic can still operate.

---

## Phase 3: Governance

High-level backlog for when governance work becomes active.

- Design the proposal lifecycle with clear states and transitions.
- Define the minimal argument / signal model used in debates.
- Sketch how governance decisions will be surfaced in the Observatory (proposal list, argument view, decision log).

---

## Phase 4: Garden Visualization

Backlog items aligned with the radial 3D garden design.

- Map file activity and ownership data from SQLite into the `GardenNode` model in the architecture docs.
- Implement a basic 3D view (React Three Fiber) that can visualize a subset of files.
- Add simple camera controls (orbit, zoom) and basic coloring by owner.

---

## Phase 5: Notifications & Deployment

- Define and stub a push notification API in the server that the web UI could subscribe to later.
- Design the deployment proposal flow and state model (requested → approved → in-progress → complete/failed).

---

## Phase 6: Harnesses (Deferred)

Per the updated plan, focus is on `opencode-api`; PTY harnesses are deferred.

- Refine and document the `opencode-api` harness as the primary harness.
- Capture known pain points and open questions about PTY-based harnesses for Phase 7+.

---

## Ideas / Nice to Have

Still unscheduled ideas; may be pulled into a phase later.

- Mobile-responsive Observatory UI.
- Dark mode toggle.
- Slack or chat-based notification integration.
- Project templates for common setups.
- Multi-project support in the Observatory.
- Team features and roles for multiple humans.

---

## Rejected / Deferred

- PTY-heavy harnesses (Cursor, full GUI automation) – deferred until core opencode-api flow is robust and stable.
- Voice interface – not a priority; text is sufficient for now.
