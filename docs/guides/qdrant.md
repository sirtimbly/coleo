# Qdrant Vector Store

Coleo uses [Qdrant](https://qdrant.tech/) for vector storage and semantic search
(status history, transcripts, arm context).

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

await qdrantStore.initialize();
await qdrantStore.createCollection("demo", 8, "Cosine");
await qdrantStore.upsertPoints("demo", [
  { id: "11111111-1111-4111-8111-111111111111", vector: [1, 0, 0, 0, 0, 0, 0, 0], payload: { label: "a" } },
]);
const hits = await qdrantStore.search("demo", [1, 0, 0, 0, 0, 0, 0, 0], { limit: 5 });
```

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
