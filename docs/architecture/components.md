---
title: Components
description: Meet the major parts of Coleo and see how coordination, agent work, the web UI, mail, messaging, and semantic memory fit together.
banner:
  src: /coleo-architecture-components.png
  alt: Five distinct underwater habitats for coordination, gateways, agent work, message flow, and shared data surround a central orange octopus and connect with luminous paths.
  eyebrow: System Anatomy
  position: center 48%
---

# Components

Coleo separates coordination, execution, human interaction, communication, and semantic memory into components with clear boundaries. Each can evolve without turning the whole system into one inseparable process.

## [Brain](/architecture/components/brain)

The coordinator that assigns tasks, monitors arm health, protects token budgets, and keeps the living plan connected to current work.

## [Arms](/architecture/components/arms)

General-purpose coding agents whose temporary roles come from task classification, briefing context, and the tools available for the assignment.

## [Observatory](/architecture/components/observatory)

The flexible web workbench that functions like an operating system for agent work, with composable panels, saved layouts, live projections, and shared controls.

## [Mail](/architecture/components/mail)

A durable, human-readable communication channel backed by local Maildir storage and exposed through the Workbench, API, gateways, and IMAP.

## [Message Flow](/architecture/components/message-flow)

The command, event, database-projection, and browser-update paths that move information between the Brain, arms, API, and Observatory.

## [Qdrant & Indexer](/architecture/components/qdrant-indexer)

The optional semantic-memory layer that embeds project activity, indexes it by project, and makes earlier work searchable by meaning as well as keywords.
