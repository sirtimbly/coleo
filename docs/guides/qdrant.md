# Qdrant Vector Store

Coleo uses [Qdrant](https://qdrant.tech/) for vector storage and semantic search
(status history, transcripts, arm context).

## Production decision

Qdrant is approved for the Cloudflare split-runtime control container only. It is
not approved as a public managed endpoint or as an independently exposed service.
The control image starts Qdrant on `127.0.0.1:6333`; the authenticated Coleo API
is the only supported access path for clients and arms. `COLEO_API_KEY` protects
the API, but it does not protect a directly reachable Qdrant endpoint.

Production coupling requires all of the following:

- Keep Qdrant loopback-only, with no public HTTP or gRPC port, and restrict
  control-container and R2 credentials to the service identity. Do not use a
  remote `COLEO_QDRANT_URL` unless Qdrant TLS and authentication are configured
  separately and an architecture review approves that change.
- Keep live Qdrant storage on the control container's local SSD. Store only
  consistent Qdrant snapshots in the private `control/qdrant/` R2 prefix; never
  sync the live storage directory. The entrypoint snapshots every five minutes
  and on graceful shutdown, and restores the newest snapshot only to an empty
  Qdrant storage directory.
- Test a restore from the newest snapshot before release and after any Qdrant
  image upgrade. Record the snapshot age and restore result in the deployment
  runbook. A missing or stale snapshot blocks production rollout.
- Run `bun run retention:status-history -- --dry-run`, review the per-event-type
  result, then run the retention job on the production schedule. Retention must
  match the workspace data-retention policy; `forever` is not an implicit
  production default.
- Treat Qdrant payloads and R2 snapshots as sensitive workspace data. Limit
  access to the control service and backup operators, audit R2 access, and
  delete snapshots according to the same retention policy.
- Set and monitor a capacity budget for control-container disk/CPU/memory, R2
  storage and request costs, and snapshot duration. A deployment must have an
  owner and alert thresholds before it can rely on semantic search.

Qdrant is optional infrastructure. An outage must leave SQLite, Maildir, task,
and lifecycle writes intact: the search API falls back to keyword-only results,
and the JetStream consumer acknowledges an event only after its Qdrant upsert
succeeds, allowing later redelivery. Restore service by restarting the control
container and validating Qdrant readiness and search; restore the latest
snapshot when its local storage is empty. To roll back Qdrant entirely, disable
semantic traffic and retain SQLite keyword search while the queued events remain
available for reindexing after recovery.

## Quick start (local Docker)

```bash
# Start only Qdrant from the root compose file
docker compose up -d qdrant

# Optional: confirm REST is up
curl -sS http://localhost:6333/collections | head

# Functional smoke (create collection → upsert → search → delete)
bun run test:qdrant
```

Default local URL: `http://localhost:6333`  
Override with `COLEO_QDRANT_URL` (see `.env.example`).

Inside the full stack, containers reach Qdrant at `http://qdrant:6333`.

## Client API

```ts
import { qdrantStore } from "../qdrant";
import { getProjectCollectionName } from "../project-scope";

const collection = getProjectCollectionName("demo");
await qdrantStore.initialize();
await qdrantStore.createCollection(collection, 8, "Cosine");
await qdrantStore.upsertPoints(collection, [
  { id: "11111111-1111-4111-8111-111111111111", vector: [1, 0, 0, 0, 0, 0, 0, 0], payload: { label: "a" } },
]);
const hits = await qdrantStore.search(collection, [1, 0, 0, 0, 0, 0, 0, 0], { limit: 5 });
```

Application collections are suffixed with a stable hash of the canonical project directory. Set
`COLEO_PROJECT_DIR` when launching Coleo outside the project root; child arm and MCP processes inherit this scope.

Module layout:

| Path | Role |
|------|------|
| `src/qdrant/client.ts` | REST client wrapper (`QdrantVectorStore`) |
| `src/qdrant/embedding-integration.ts` | Embed + index helpers |
| `src/vector/` | Status-history indexing pipeline |
| `src/scripts/qdrant-smoke.ts` | Live upsert/search smoke test |

## Environment

| Variable | Default | Notes |
|----------|---------|--------|
| `COLEO_QDRANT_URL` | `http://localhost:6333` | REST endpoint |
| `COLEO_QDRANT_SMOKE_KEEP` | unset | Set to `1` to keep the smoke collection |

## Compose notes

- Root `docker-compose.yml` and `deploy/self-host/docker-compose.hosting.yml` both define a `qdrant` service with a named volume for storage.
- The official `qdrant/qdrant` image does **not** ship `curl`/`wget`. Do not use command-based Docker healthchecks against it; use `service_started` for ordering and application-level health (API `/api/status` probes `/collections`).

## Verification checklist

1. `docker compose up -d qdrant`
2. `curl -sf http://localhost:6333/collections`
3. `bun test src/qdrant/__tests__/client.test.ts` (unit, no Docker)
4. `bun run test:qdrant` (live functional)

## Rollback

```bash
docker compose stop qdrant
docker compose rm -f qdrant
# optional: drop data volume
docker volume rm coleo-qdrant-data
```

Application code treats Qdrant as optional infrastructure: API status reports
`infrastructure.qdrant.optional: true` when the service is down.

## Status-history filters

Each project's `status-history-<projectKey>` collection creates Qdrant payload indexes for event type,
source, task, arm, timestamp, and classification. The server's durable
JetStream consumer stores the original event envelope and delivery metadata,
then acknowledges only after the vector upsert succeeds.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|--------|-----|
| `Cannot connect to the Docker daemon` | Docker Desktop/OrbStack not running | Start Docker, retry |
| `Sign in to continue using Docker Desktop` / org membership required | Corporate Docker Desktop policy blocks image pull | Sign into the required org, or pull `qdrant/qdrant` on a machine that can, then load the image |
| Smoke fails: `Qdrant not ready` | Container not up or wrong URL | Check `docker ps`, ports `6333/6334`, and `COLEO_QDRANT_URL` |
| `Bind for 0.0.0.0:6333 failed: port is already allocated` | Another Qdrant (or process) already owns 6333 | Reuse it (`curl localhost:6333/collections`) or stop the other container / remap ports |
| Collection already exists warnings | Expected on re-create | Client logs and continues |
| Client/server version compatibility warning | npm `@qdrant/js-client-rest` newer than image | Client sets `checkCompatibility: false`; pin image tag if you need exact parity |

## Measured smoke timings (local, 2026-07-10)

Against a running Qdrant on `localhost:6333` (`bun run test:qdrant`):

| Step | Time |
|------|------|
| Ready probe | ~70ms |
| Initialize | ~65ms |
| Create collection | ~270ms |
| Upsert 3 points | ~6ms |
| Search top-3 | ~5ms |
| Delete collection | ~60ms |
| **Total** | **~480ms** |

## Related tasks

Follow-on deliverables (separate tasks): embeddings, hybrid search API, MCP search tool, UI, retention, backfill.
