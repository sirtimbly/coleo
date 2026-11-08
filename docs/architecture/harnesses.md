# Agent harnesses

Coleo currently registers **`opencode-api`**, a headless OpenCode integration.
The registry does not offer the older `opencode` or `opencode-tui` harnesses for
new arms.

## Runtime ownership

An Arm Host manages harness processes near the project workspace. The API sends
host commands over NATS; clients use the API to create, observe, prompt, and
recover arms. Configure and start the host with `coleo-agent`.

Use `coleo-client arms --help` for the supported client operations and flags.
Terminal-window spawning is not part of the supported harness selection.

## Recovery

Recovery uses persisted runtime metadata and the availability of the responsible
host. A recover request can reattach to a live runtime or restart work when the
runtime cannot be recovered. Inspect the resulting arm state rather than
assuming a request guarantees successful reattachment.

Runtime status and activity are exposed through the API. A visible connection
does not imply that an arm is making progress; consult activity and task status
as well as host availability.

## Extending the integration

The [harness contract](./harness-contract) describes the adapter interfaces.
Adding a new adapter requires implementation, registration, and validation;
Coleo does not automatically support an arbitrary CLI executable.

The current registry is in
[`server/src/harness/registry.ts`](https://github.com/sirtimbly/coleo/blob/master/server/src/harness/registry.ts).
