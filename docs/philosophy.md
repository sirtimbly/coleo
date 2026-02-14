---
title: Philosophy
outline: [2,3]
---

# Philosophy

Coleo’s approach is inspired by soft, adaptable architectures found in nature — particularly the octopus: a central brain coordinating semi‑autonomous arms. The goal is a system that is coordinated, transparent, and resilient without rigid hierarchies.

## Soft Architecture

Most agent frameworks rely on rigid control hierarchies or chaotic autonomy. Coleo occupies the evolutionary niche between: coordinated independence. Arms act with local initiative while the Brain shapes direction through proposals, evaluation, and shared context.

## System Goals

1. Coordinate cognitive work across multiple arms over time.
2. Preserve shared context through discoveries and structured plans.
3. Enable human oversight with clear checkpoints and approvals.
4. Support creative autonomy so arms can push work forward thoughtfully.

## Key Metaphors

| Metaphor | Meaning |
|----------|---------|
| Octopus | The whole system — a central brain coordinating semi‑autonomous arms |
| Brain | Central coordinator that assigns tasks, manages context, and interfaces with the human |
| Arms | General‑purpose AI agents whose behavior changes with task classification |
| Garden | The shared workspace (code, docs, configs, environments) tended by arms |
| Observatory | The web UI where humans observe and configure the system |
| Nerve System | Communication layer (MCP, WebSocket, message queues) |

## Design Principles

### 1. Arms Are Not Specialized
Arms are general‑purpose and adapt behavior based on task classification (architect, development, QA, PM, etc.). The same arm may behave like an architect for one task and like a QA engineer for the next.

### 2. Progressive Planning
The Brain does not maintain a static backlog. It progressively determines the single next task for an arm at runtime by re‑evaluating plan documents, completed tasks, discoveries, and status reports.

### 3. Observable by Default
All activity is logged and visualizable across clients. The Observatory makes agent behavior and coordination transparent.

### 4. Human‑in‑the‑Loop
Humans provide requirements and decisions; arms execute and report. Critical decisions can require explicit human approval.

### 5. Client Agnostic
CLI, Web, and gateway-backed email workflows all interact with the same core API and Maildir state.

### 6. Linear, Shared Git Workflow
Many arms, one garden, one branch. Maintain a mostly linear git history with humans in control of commits, rebases, and merges. Advanced flows (temporary branches, stashes) can be layered on, but coordination is handled through tasks, claims, and proposals rather than Git topology.

## See Also

- [Architecture Overview](/architecture/overview)
- [Components](/architecture/components)
- [Observatory](/architecture/components#observatory-web-ui-api)
