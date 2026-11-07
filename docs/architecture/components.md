---
title: Components
description: Responsibilities of the API, Brain, Arm Hosts, coding agents, clients, and stores.
banner:
  src: /coleo-architecture-components.png
  alt: Connected underwater habitats represent the components of Coleo.
  eyebrow: System Anatomy
  position: center 48%
---

# Components

Coleo separates the processes that coordinate work, execute it, and present it.
They can run on one machine or communicate across hosts.

| Component | Responsibility | Operator interface |
| --- | --- | --- |
| API server | Application requests, persistence, live updates, and Arm Host communication | `coleo-server` |
| Brain | Planning, task coordination, activity review, and human communication | `coleo-server brain` |
| Arm Host | Manage local coding-agent runtimes and advertise availability over NATS | `coleo-agent` |
| Arm | Execute assigned work through the supported harness | Managed through the API/client |
| Clients | Inspect state and submit user actions | Web, `coleo-client`, Textual, and macOS |

## API server and storage

The API is the shared application boundary. It manages SQLite-backed records,
Maildir-backed messages, and NATS/JetStream integration. Qdrant provides vector
search when configured. These stores have different responsibilities; they are
not a single cross-store transaction.

The API process does not serve browser assets. The separately installed web host
serves the browser application and proxies API, uploads, and socket traffic.

## Brain

The Brain reads project direction, prepares and coordinates tasks, and reviews
activity through API procedures. Starting the API does not start the Brain;
its process has a separate lifecycle.

The [planning gate](../guides/planning-gate) controls when work can begin.
[Task workflow](../guides/task-workflow) explains runnable, active, blocked, and
completed work, including how human replies affect blocked-task review.

Activity monitoring can prompt arms and request recovery actions. It is not
continuous inspection of every filesystem change or shell command. The actual
permission-decision integration is described in [Security and trust
boundaries](./security).

## Arm Hosts and arms

An Arm Host runs near the repository and tools an arm needs. It registers with
the control plane over NATS and manages local harness processes. Stopping the
host process and terminating an individual arm are distinct operations.

An arm is a general-purpose coding agent. Its task classification and current
context guide its work; it is not permanently assigned a specialist role. The
currently registered harness is `opencode-api`. See [Agent harnesses](./harnesses).

## Clients and the Garden

Clients connect to the selected API rather than reading its database directly.
The web workbench, Python CLI, Textual TUI, and native macOS application each
provide their documented subset of operations. See [Workbench across
clients](./workbench-clients) for shared contracts and client differences.

The Garden represents the shared project environment. Task assignments and file
claims coordinate work; they do not establish operating-system file isolation.

## Next steps

- [Install components](../guides/installation)
- [Configure server and client connections](./client-server-separation)
- [Understand the Brain/API boundary](./brain-api-boundary)
- [Review security and trust boundaries](./security)
