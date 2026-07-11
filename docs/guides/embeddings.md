# Embedding Generation

Coleo turns text (status reports, task completions, transcripts) into vectors
before writing them to Qdrant. The embedding module lives under `src/embedding/`.

## Providers

| Provider | When selected | Dimensions | Notes |
|----------|---------------|------------|--------|
| **OpenAI** | `OPENAI_API_KEY` set (or `COLEO_EMBEDDING_PROVIDER=openai`) | 1536 (`text-embedding-3-small`) / 3072 (`text-embedding-3-large`) | Network call to OpenAI-compatible `/embeddings` |
| **Local** | No OpenAI key, or `COLEO_EMBEDDING_PROVIDER=local` | 384 (`Xenova/all-MiniLM-L6-v2`) | Uses `@xenova/transformers` when installed |
| **Mock (local fallback)** | Local path without transformers | 384 | Deterministic hash-based unit vectors for offline/dev/tests |

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
