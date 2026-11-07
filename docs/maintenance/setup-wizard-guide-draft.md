# Set up your first Coleo workspace

**Historical draft.** The initial implementation and current instructions are
in [Set up Coleo](../guides/setup.md). This repository-only draft records the
intended onboarding narrative; use the public guide for implemented behavior.

Publication target: `docs/guides/setup.md`, linked from Getting Started and
Component Installation after the wizard ships.

## Before you begin

Install Coleo using the component installer for your release. Keep the printed
bin directory on your `PATH`. For a local workspace, have a repository directory
and the model-provider credentials you intend to use. The wizard will check the
remaining prerequisites and explain anything missing.

## Choose what this machine does

```sh
coleo-ops setup
```

Choose one:

- **Run everything here** — start a local control plane and an Arm Host that can
  work in your repository. This is the simplest first setup.
- **Connect to an existing server** — use a server someone has already set up.
- **Add an Arm Host** — let an existing control plane run agents on this machine.

## Run everything here

1. Choose your repository and confirm the runtime directory. Existing settings
   are shown so you can reuse them.
2. Choose the Brain's model provider and model. Enter credentials in the hidden
   prompt. The wizard checks the agent harness separately; it may need its own
   provider configuration.
3. Choose the CLI, Python/Textual terminal UI, Swift/macOS app, or browser client.
   Each client owns its connection settings. The wizard installs missing selected
   components and explains any client-specific connection steps.
4. Review the paths, local addresses, and services, then apply.

The default local setup listens on loopback. The wizard waits for the central
API to report fresh, green health checks for every enabled service, including
the Brain and Arm Host. Disabled services are shown as not applicable. A started
process alone does not count as success. Complete any selected-client connection
steps as well. The final result shows your workspace connection and commands for
opening it, inspecting logs, and stopping its services.

Open the workspace and review the project's plan before assigning work. Follow
[Task workflow](../guides/task-workflow.md) and the
[Planning gate](../guides/planning-gate.md) for your first task.

## Connect to a server

Choose **Connect to an existing server**, then enter the server origin, a
connection name, and the API key supplied by its operator. For example, the
origin is `https://coleo.example.com`, without `/api` or credentials in the URL.

The wizard verifies API access and hands the connection to your selected client
through its supported connection flow. CLI/Python, Swift/macOS, and browser
settings remain client-owned. It also waits for the central server's enabled
service checks to turn green; successful client authentication alone does not
mean the whole server is ready. You do not need a local Brain, database, or Arm
Host to use an existing server.

After setup, these existing client commands let you revisit the connection:

```sh
coleo-client connections
coleo-client --connection production doctor --json
coleo-client --connection production tasks
```

Replace `production` with the connection name you chose.

## Add an Arm Host

Choose **Add an Arm Host** on the machine that will execute agent work. Supply
the workspace, server address, and the NATS address and credentials from the
server operator. HTTP and NATS use separate connection settings.

The wizard checks the local harness and waits for the server to observe the
host's registration. Once verified, the host becomes available for agent work.

## Resume an incomplete setup

```sh
coleo-ops setup --resume
```

Use the full resume command printed by the wizard if you selected a custom
prefix or runtime directory. Completed steps are checked again; existing data
and credentials are preserved. The failure summary identifies services still
running and the next action needed.

## Check health at any time

```sh
coleo-ops doctor
coleo-ops --doctor
coleo-ops doctor --wait --timeout 180
```

The first two commands are equivalent. Doctor combines component diagnostics
with the central API's health results without changing configuration or starting
services. `--wait` waits for fresh green results; add `--json` for automation.
If the deadline expires, the report lists the remaining blockers and next steps.

For focused checks, the existing `coleo-server doctor`, `coleo-agent doctor`,
and `coleo-client doctor` commands remain available. `coleo-install` handles
installation; `coleo-ops` coordinates setup and diagnosis; each component CLI
retains its own configuration and lifecycle commands.

| Check failed | What to do |
| --- | --- |
| API port occupied | Reuse the intended running server or choose another port. |
| Server unavailable | Check the origin, network route, and server status. |
| Authentication rejected | Re-enter the server API key; a successful health probe alone is insufficient. |
| Model access failed | Check provider credentials and model access, then resume. |
| Host not registered | Check the NATS address/credential and host logs. |
| Setting overridden | Resolve the environment variable named in the summary, then resume. |

## Next steps

- [Workspace CLI and TUI](../guides/workspace-client.md)
- [Server and clients](../architecture/client-server-separation.md)
- [Security and trust boundaries](../architecture/security.md)
- [Component installation and upgrades](../guides/installation.md)
