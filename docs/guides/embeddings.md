# Embedding Generation

Coleo turns text (status reports, task completions, transcripts) into vectors
before writing them to Qdrant. The embedding module lives under `src/embedding/`.

## Providers

| Provider | When selected | Dimensions | Notes |
|----------|---------------|------------|--------|
| **OpenAI** | `OPENAI_API_KEY` set (or `COLEO_EMBEDDING_PROVIDER=openai`) | 1536 (`text-embedding-3-small`) / 3072 (`text-embedding-3-large`) | Network call to OpenAI-compatible `/embeddings` |
| **Local** | No OpenAI key, or `COLEO_EMBEDDING_PROVIDER=local` | 384 (`Xenova/all-MiniLM-L6-v2`) | Uses `@xenova/transformers` when installed |
| **Mock (local fallback)** | Local path without transformers | 384 | Deterministic hash-based unit vectors for offline/dev/tests |

## Production decision and data boundary

The approved production provider for the Cloudflare control runtime is the local
`Xenova/all-MiniLM-L6-v2` model at **384 dimensions**, with
`COLEO_EMBEDDING_PROVIDER=local`. The real `@xenova/transformers` runtime must be
present and load successfully. The deterministic mock fallback is development
and test plumbing only and must not index production data.

Do not enable the OpenAI-compatible provider in production for status history,
transcripts, task descriptions, bug reports, or arm context. The indexing
pipeline embeds event text and stores the full event payload in Qdrant, so that
content can include workspace paths, operational details, or other sensitive
data. Sending it to an external embedding endpoint requires a separate approved
data-processing exception, documented redaction rules, a provider-specific
retention agreement, and a collection migration plan.

The required deployment configuration is:

```bash
COLEO_EMBEDDING_PROVIDER=local
LOCAL_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
```

`OPENAI_API_KEY` may still be used by unrelated arm/model features, but it must
not select the embedding provider. Set the explicit local provider value above
because provider auto-detection otherwise prefers OpenAI whenever that key is
present.

If the local model cannot load or embedding fails, do not substitute mock or
external embeddings. Keep core writes working, let the JetStream consumer retry
the unacknowledged indexing event, and serve SQLite keyword-only search until
the provider recovers. Before changing providers or dimensions, snapshot the
current Qdrant data, create a new collection with the new vector size, backfill
from the durable SQLite/JetStream source, validate search and filters, then
switch traffic. Roll back by restoring the matching snapshot or by routing back
to the prior collection; never mix vector dimensions in one collection.

## Environment

```bash
# Prefer OpenAI when key present
OPENAI_API_KEY=sk-...

# Optional overrides
# COLEO_EMBEDDING_PROVIDER=local   # force local even if key is set
# OPENAI_BASE_URL=https://api.openai.com/v1
# OPENAI_EMBEDDING_MODEL=text-embedding-3-small
# LOCAL_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
```

See also `.env.example`.

## Usage

```ts
import { embeddingService } from "../embedding";

const { embedding, model } = await embeddingService.embed("status: blocked on deploy");
const batch = await embeddingService.embedBatch(["a", "b", "c"]);

// Ensure Qdrant collection size matches:
// embeddingService.getVectorSize()
```

Module layout:

| Path | Role |
|------|------|
| `src/embedding/service.ts` | Auto-select provider, public API |
| `src/embedding/openai-provider.ts` | OpenAI `/v1/embeddings` client |
| `src/embedding/local-provider.ts` | Transformers.js + mock fallback |
| `src/embedding/types.ts` | Shared types |
| `src/scripts/embedding-smoke.ts` | Live smoke (`bun run test:embedding`) |

## Verification

```bash
# Unit tests (no network)
bun test src/embedding/__tests__/embedding.test.ts

# Smoke: local always; OpenAI if OPENAI_API_KEY is set
bun run test:embedding
```

## Collection size warning

OpenAI small = **1536** dims; local MiniLM = **384** dims.  
Do not mix providers against the same Qdrant collection without recreating it
with the matching `vectorSize` from `embeddingService.getVectorSize()`.

## Optional local model install

```bash
bun add @xenova/transformers
```

Without it, the local provider still works via deterministic mock embeddings
(good enough for plumbing tests; not for production semantic search).

## Related

- [Qdrant guide](./qdrant.md) — vector store + Docker
- Consumers: `src/vector/indexing-pipeline.ts`, `src/qdrant/embedding-integration.ts`, `src/api/routes/search.ts`
