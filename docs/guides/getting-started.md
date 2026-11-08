---
title: Getting started with Coleo
description: Understand the components, choose a client, and set up your first Coleo workspace.
banner:
  src: /coleo-guide-getting-started.png
  alt: An orange octopus welcomes you to a connected underwater workspace.
  eyebrow: First Dive
  position: center 52%
---

# Getting started with Coleo

Coleo coordinates coding agents around a shared project. The central API stores
project state, the Brain plans and coordinates work, and Arm Hosts run agents near
your repository. Choose the interface you prefer: CLI, Python/Textual terminal UI,
Swift/macOS app, or browser. All are clients of the same API.

Setup always includes the CLI. Its checklist lets you add any combination of the
terminal UI, browser client, and native app.

## Choose your setup

| Your goal | Setup path |
| --- | --- |
| Try Coleo on one machine | **Local**: API, Brain, Arm Host, and your selected client |
| Use an existing Coleo workspace | **Client**: connect to its server |
| Run agents on another machine | **Agent**: add an Arm Host to the existing server |

The operations tool guides you through these choices:

```sh
coleo-ops init
```

See [Set up Coleo](./setup) for installation, credentials, and the complete
walkthrough. If your installed release does not include `coleo-ops`, follow
[manual component installation](./installation) or use the source-checkout
instructions in the setup guide.

## What runs where?

- **API server:** application state, client requests, and live updates.
- **Brain:** a separate process that coordinates the project and uses a model
  provider. Starting the API alone does not start the Brain.
- **Arm Host:** manages OpenCode agent processes and connects over NATS.
- **Client:** displays the workspace and submits your actions. Each client owns
  its connection preferences and authentication settings.

`coleo-ops` coordinates setup and diagnostics. `coleo-install` acquires release
components. `coleo-server` and `coleo-agent` retain their individual configuration,
lifecycle, and log commands. `coleo-client` is the workspace CLI, not an operations
backend for other clients.

## Know when it is ready

Setup waits for the central API to report fresh green service checks. A process
starting successfully is only the first step. You can check again at any time:

```sh
coleo-ops doctor --wait
```

The report identifies missing observations, unhealthy services, and planning
blockers. Fix the reported issue and resume setup instead of starting over.

For a quick overview or to explain which settings are in effect:

```sh
coleo-ops status
coleo-ops config show --show-origin
```

These commands discover your workspace from nested directories. Status shows the
selected server and next useful action; configuration inspection explains its
source without exposing credentials.

## Give Coleo its first task

Open your selected client, review your project's direction and plan, and follow
the [Task workflow](./task-workflow). The [Planning gate](./planning-gate) explains
why agent work waits until project planning succeeds.

For container deployment, use the [Docker guide](./docker). For component
boundaries and access controls, see [Components](../architecture/components) and
[Security and trust boundaries](../architecture/security).
