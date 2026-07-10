# Search API (Hybrid)

Coleo exposes two search surfaces:

1. **General hybrid search** — SQLite FTS (keyword) + Qdrant (semantic) over tasks, bugs, arms, and indexed docs.
2. **Status history search** — Qdrant semantic search over arm status reports / completions with keyword boost and filters.

## General hybrid search

`POST /api/search`

```json
{
  "query": "authentication issues",
  "types": ["task", "bug"],
  "limit": 20,
  "offset": 0,
  "minScore": 0.1,
  "keywordWeight": 0.5,
  "semanticWeight": 0.5,
  "filters": { "priority": "high" }
}
```

Response includes per-result `keywordScore`, `semanticScore`, and combined `score`.  
If Qdrant/embeddings fail, search degrades to keyword-only (`semanticUsed: false`).

Related:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/search/suggestions?q=` | Title suggestions |
| POST | `/api/search/index` | Upsert document into Qdrant `search-index` |

Implementation: `src/api/routes/search.ts`  
Tests: `src/api/routes/__tests__/search.test.ts`

## Status history hybrid search

`POST /api/status-history/search`

```json
{
  "query": "problems with database migrations",
  "filters": {
    "arm_ids": ["arm-alpha"],
    "event_types": ["status_report", "task_completion"],
    "from": "2026-07-01T00:00:00Z",
    "to": "2026-07-10T23:59:59Z",
    "task_id": "phase28g-d4c3d1"
  },
  "limit": 20,
  "keywordWeight": 0.35,
  "semanticWeight": 0.65,
  "include_context": true
}
```

Response:

```json
{
  "results": [
    {
      "event": { "id": "...", "type": "status_report", "title": "...", "content": "..." },
      "score": 0.84,
      "keywordScore": 0.66,
      "semanticScore": 0.91,
      "highlights": ["... migration ..."]
    }
  ],
  "total": 1,
  "query": "problems with database migrations",
  "semanticUsed": true,
  "query_time_ms": 42
}
```

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/status-history/stats?period=week` | Collection health / point count |
| GET | `/api/status-history/by-arm/:armId` | Filtered list for one arm |
| POST | `/api/status-history/index` | Manual / backfill index |

Implementation: `src/api/routes/status-history.ts`  
Pipeline: `src/vector/indexing-pipeline.ts`  
Collection: `status-history` (see `STATUS_HISTORY_CONFIG`)

## Weights (hybrid ranking)

Combined score:

```
score = keywordScore * keywordWeight_norm + semanticScore * semanticWeight_norm
```

Weights are normalized to sum to 1. Defaults:

- General search: 0.5 / 0.5  
- Status history: 0.35 keyword / 0.65 semantic  

Set `semanticWeight: 0` for pure keyword; `keywordWeight: 0` for pure semantic.

## Verification

```bash
bun test src/api/routes/__tests__/search.test.ts
bun test src/api/routes/__tests__/status-history.test.ts
```

Live Qdrant + embeddings (optional):

```bash
docker compose up -d qdrant
bun run test:qdrant
bun run test:embedding
```

## MCP tools (brain/arms)

Registered on the Coleo MCP server (`src/mcp/server.ts`):

| Tool | Backend |
|------|---------|
| `search` | `POST /api/search` — hybrid keyword + semantic over tasks/bugs/arms/index |
| `search_status_history` | `POST /api/status-history/search` — hybrid over status history collection |

Example arm call shape (status history):

```json
{
  "query": "previous attempts at database migration",
  "filters": {
    "arm_ids": ["arm-alpha"],
    "event_types": ["status_report", "task_completion"],
    "days_back": 30
  },
  "limit": 10
}
```

## Dependencies

- Embeddings: [embeddings.md](./embeddings.md)
- Qdrant: [qdrant.md](./qdrant.md)
