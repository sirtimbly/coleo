---
title: Observatory
description: How Coleo's flexible web workbench acts as an operating system for coordinated agent work.
outline: [2,3]
banner:
  src: /coleo-architecture-components.png
  alt: Five connected underwater habitats represent coordination, gateways, agent work, message flow, and shared data around a central orange octopus.
  eyebrow: The Agent Workbench
  position: right 48%
---

# Observatory

The Observatory is Coleo's browser-based operating environment. It is not a fixed dashboard with one prescribed workflow; it is a workbench in which people arrange the views, resources, and controls they need for the work at hand.

That flexibility matters because overseeing several agents resembles operating a small computing environment. Tasks are moving, processes are starting and stopping, messages require attention, and the useful view changes from moment to moment. The Observatory gives that activity one coherent surface.

## An Operating System for Agent Work

The comparison is practical rather than decorative:

| Operating-system role | Observatory equivalent |
|---|---|
| Window manager | Route-backed panels that can be opened, split, resized, reordered, and restored |
| Applications | Tasks, Bugs, Brain, Arms, Processes, Mail, Inbox, Search, Settings, and other registered views |
| Files and resources | Stable task, bug, message, event, report, and arm identities that can open in different projections |
| Process monitor | Live Brain, arm, host, and process views |
| Notification center | A unified Inbox for mail and operational attention |
| Shell and launcher | Sidebar navigation and a command palette that open views in the current or a new pane |
| User profile | Saved layouts, views, filters, columns, and presentation preferences |

The Observatory does not replace the underlying control plane. It makes that control plane legible and operable.

## A Composable Workspace

Golden Layout provides the browser's window manager. Each panel hosts a normal application route, so the same Tasks or Mail view can run alone, beside another view, or as another instance with its own route state.

Layouts belong to Workbench profiles and can be saved and restored. A developer can keep a compact operational layout, a planning layout with Tasks and Bugs side by side, or a communication layout centered on Inbox and Mail without requiring separate products.

## Views Are Projections, Not Silos

Coleo resources can appear as sheets, adaptive cards, timelines, detail panels, editors, or focused pages. These presentations share stable resource identifiers and allowed actions, which lets information move between surfaces without each view inventing its own data model.

For example, a task can be found through search, inspected in a detail panel, edited in a sheet, and followed in an activity projection. A mail thread can appear in the Mail view or alongside Brain and arm attention in the unified Inbox.

## Shared Live Services

The Workbench uses shared infrastructure rather than letting every view behave like a separate application:

- a route registry defines the views the shell can host;
- one authenticated WebSocket connection fans live updates out to interested projections;
- database-backed profiles preserve layouts and view preferences;
- shared resource and adaptive-card contracts keep actions predictable;
- the API remains the boundary for durable state changes.

This makes new views relatively inexpensive to add. They contribute a route and a projection while inheriting navigation, panel management, live updates, attention signals, and persistence from the shell.

## Durable State Stays Below the UI

The Observatory is flexible because it is not the source of truth. SQLite, Maildir, JetStream, project files, and service APIs retain the durable state. Panels can close, layouts can change, and the browser can reload without changing the meaning of the underlying work.

That separation lets the interface behave like an operating system: adaptable at the surface, consistent at the resource and control boundaries beneath it.
