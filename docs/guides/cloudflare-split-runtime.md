# Cloudflare split runtime

Coleo's hosted Cloudflare deployment runs the control service and arm execution
in separate images:

- `Dockerfile.cloudflare-control` runs `coleo serve` and `coleo brain run`.
- `Dockerfile.cloudflare-agent` runs the Arm Host: NATS/JetStream and the
  internal `coleo agent start` process.

This is a real remote Arm Host topology. The control image must set:

```text
COLEO_NATS_URL=wss://<workspace-host>/.reef/nats
COLEO_NATS_TOKEN=<workspace-token>
COLEO_AUTO_START_AGENT=0
COLEO_REMOTE_ARMS_ONLY=1
COLEO_REMOTE_WORKDIR=/home/coleo/runtime/workspace
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

The Arm Host exposes TCP `4222`, monitoring `8222`, and WebSocket `9222`. Only the
monitor and WebSocket ports need to be made reachable through the Cloudflare
Container binding; TCP remains local to the Arm Host image. TLS is terminated by
the edge Worker before port `9222`.

Both images synchronize state to separate R2 prefixes. The control image uses
`control/`; the Arm Host uses the stable internal `agent/` prefix and uploads
its JetStream store only during a graceful shutdown.
