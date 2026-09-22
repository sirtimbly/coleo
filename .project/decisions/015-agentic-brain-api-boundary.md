# ADR-015: Agentic Brain API Boundary

## Status

Accepted

## Decision

The Brain Agent is an API client. It may use authenticated, validated Coleo API
routes and API-owned mediated adapters only. SQLite, filesystem access to a
workspace, NATS/JetStream, MCP transport, harnesses, and external side effects
are service implementation details, not Brain Agent capabilities.

| Brain capability | Permitted interface | Prohibited bypass |
|---|---|---|
| Plan and task context | Authenticated plan/task/history API | SQLite or workspace reads |
| Discoveries, reports, arms, and events | API query and inbox/event routes | NATS/JetStream clients or DB queries |
| Determine next work | API-backed task/pass scoring and mutation | Direct scheduler or storage mutation |
| Report dependency or proposal | Validated API mutation with audit record | Direct database/event writes |
| Workspace files | API-mediated `WorkspaceAccess` operations | Direct checkout filesystem access |
| Arm execution and status | API routes mediated by ArmAgent/HarnessManager | Harness or OpenCode calls |
| Human messages and notifications | API/Maildir service endpoints | Direct mail transport |
| Deployment or destructive actions | Proposal/approval API and service executor | Shell, cloud, or transport calls |

Inference requests to the configured model provider and local `.coleo/` runtime
configuration/log output are allowed. They must not be used to bypass service
authorization or mutate authoritative task, arm, event, or workspace state.

## Consequences

- Phase 9 tools must accept typed API-facing inputs and return API-shaped data.
  Historical diagrams or tool descriptions that name SQLite, files, MCP, NATS,
  or JetStream describe service internals only.
- The API owns authentication, authorization, validation, persistence,
  idempotency, event schema evolution, and audit records for Brain actions.
- ArmAgent alone owns distributed harness/OpenCode traffic. The API may mediate
  it, but the Brain Agent cannot call it directly.
- New Brain capabilities require an API or mediated-adapter contract before the
  tool is implemented. Direct access is not an acceptable temporary shortcut.

## Related Records

- `docs/architecture/brain-api-boundary.md`
- Phase 1 Brain/API boundary tasks and Phase 9 Agentic Brain in `.project/plan.md`
