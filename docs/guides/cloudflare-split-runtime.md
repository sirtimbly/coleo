# Cloudflare split runtime

Coleo's hosted Cloudflare deployment runs the control service and arm execution
in separate images:

- `Dockerfile.cloudflare-control` runs Qdrant, `coleo serve`, the transcript
  indexer, and `coleo brain run`.
- `Dockerfile.cloudflare-agent` runs the Arm Host: NATS/JetStream and the
  dedicated Arm Host process plus the MCP server used by spawned arms.

The images have independent immutable tags:

- `coleo-control:<commit-sha>` identifies the complete control-plane source
  revision.
- `coleo-agent:runtime-<sha256>` identifies only the Arm Host runtime inputs.

`src/scripts/cloudflare-agent-image-tag.ts` asks Bun for the dedicated Arm Host
bundle's transitive input graph, adds the container entrypoint and native
`bun-pty` runtime, and hashes the contents. The publication workflow checks the
Cloudflare registry before building. If that exact content tag already exists,
it does not build or push the Arm Host image. Changes confined to the web UI,
control API, Brain, documentation, or unrelated repository files therefore do
not create a new Arm Host image or roll its Cloudflare Container application.

The Arm Host image intentionally contains the dedicated bundle rather than the
full Coleo checkout. The same bundle runs in host mode at container startup and
in `mcp serve` mode for spawned arms, keeping both execution paths in the hashed
runtime boundary.

OpenCode is pinned to an exact version directly in
`Dockerfile.cloudflare-agent`. Upgrading it is a deliberate source change, not
a build argument or `latest` resolution. Because the Dockerfile participates in
the Arm Host content hash, that edit produces a new immutable runtime tag.

This is a real remote Arm Host topology. The control image must set:

```text
COLEO_NATS_URL=wss://<workspace-host>/.reef/nats
COLEO_NATS_TOKEN=<workspace-token>
COLEO_AUTO_START_AGENT=0
COLEO_REMOTE_ARMS_ONLY=1
COLEO_REMOTE_WORKDIR=/home/coleo/runtime/workspace
COLEO_WORKSPACE_AGENT_ID=<workspace-arm-host-id>
```

The Arm Host image uses its local TCP NATS listener:

```text
COLEO_NATS_URL=nats://127.0.0.1:4222
COLEO_NATS_TOKEN=<same-workspace-token>
COLEO_AGENT_WORKDIR=/home/coleo/runtime/workspace
COLEO_API_URL=https://<workspace-host>/.reef/internal
COLEO_API_KEY=<workspace-internal-api-key>
```

`src/nats/transport.ts` selects the native NATS client for `nats://` and
`tls://` URLs and the WebSocket client for `ws://` and `wss://` URLs. The token
is passed to every NATS connection, including the API server, Arm Host process,
MCP tools, and transcript indexer.

When `COLEO_REMOTE_ARMS_ONLY=1`, all harnesses are forced through the registered
Arm Host and local fallback is disabled. The control container therefore never
spawns or signals a harness PID itself. `COLEO_REMOTE_WORKDIR` is the path sent
in spawn requests; `COLEO_AGENT_WORKDIR` pins it to the corresponding checkout
inside the Arm Host container.

## Workspace access

The Arm Host is the only runtime that owns the customer Git checkout. Brain
features that inspect or update that checkout use the `WorkspaceAccess`
boundary instead of opening repository paths directly:

```text
Brain -> authenticated Coleo API -> NATS request/reply -> Arm Host -> checkout
```

The API targets `COLEO_WORKSPACE_AGENT_ID`, which must match the Arm Host's
stable `COLEO_AGENT_ID`. The protocol intentionally exposes a small set of
path-confined operations: read a text file, compare-and-swap a text file, scan
file metadata, and read Git porcelain status. The Arm Host rejects traversal,
symlink escapes, oversized text payloads, and unbounded scans.

This keeps plan synchronization, inbox parsing, documentation tracking, prompt
context, and large-file discovery working when the Brain and Arm Host run in
different containers. It also avoids trying to synchronize two live Git
checkouts.

For a normal local deployment, `COLEO_REMOTE_ARMS_ONLY` remains unset and the
same interface uses `LocalWorkspaceAccess` directly. No API or NATS round trip
is introduced for local development.

The Arm Host exposes TCP `4222`, monitoring `8222`, and WebSocket `9222`. Only the
monitor and WebSocket ports need to be made reachable through the Cloudflare
Container binding; TCP remains local to the Arm Host image. TLS is terminated by
the edge Worker before port `9222`.

Both images synchronize state to separate R2 prefixes. The control image uses
`control/`; the Arm Host uses the stable internal `agent/` prefix and uploads
its JetStream store only during a graceful shutdown.

The control image keeps Qdrant's live storage on the Container's local SSD and
never copies those actively-mutating files to R2. Qdrant creates a consistent
full-storage snapshot every five minutes and during graceful shutdown. The
entrypoint stores the newest snapshot as `control/qdrant/latest.snapshot` in
the workspace R2 bucket and restores it when a new Container starts with an
empty disk. The durable JetStream consumer acknowledges events only after the
Qdrant upsert succeeds, so events that fail during an outage remain available
for redelivery. The default snapshot interval can be changed with
`COLEO_QDRANT_SNAPSHOT_INTERVAL_SECONDS`.

## Local production-topology test

`docker-compose.cloudflare-local.yml` runs the production Control and Arm Host
Dockerfiles together with the same environment contract used by Reef. NATS is
reached by Control over WebSocket, just as it is through the Cloudflare Worker,
while the Arm Host uses its local TCP listener.

The customer checkout volume is mounted only into the Arm Host. Control has a
separate state volume and cannot read the checkout directly. This makes local
testing exercise the remote onboarding and workspace-access paths instead of
silently falling back to a shared filesystem.

Start from empty persistent state and run the onboarding smoke test:

```bash
bash bin/cloudflare-split-local.sh reset
bash bin/cloudflare-split-local.sh up
bash bin/cloudflare-split-local.sh smoke
```

The smoke test calls Control's authenticated onboarding API, clones a small
public repository through the Arm Host, and verifies that `.git` exists only in
the Arm Host container. The dashboard is available at
`http://127.0.0.1:13000`; use `local-reef-api-key` if it asks for an API key.

Use `status`, `logs`, `down`, or `reset` for the corresponding lifecycle
operation. Run `build` after changing code that belongs in either image. Set
`COLEO_LOCAL_TEST_REPOSITORY` to exercise a different HTTPS repository.
