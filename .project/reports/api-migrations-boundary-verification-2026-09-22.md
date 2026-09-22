# API Migrations + SQLite Boundary Verification (2026-09-22)

Task: `phase1co-d955af`.

## Verdict: VERIFIED

### Migrations run automatically

API startup (`src/api/server.ts:361`) unconditionally calls
`initDatabase(config.dbPath)`, which sets `busy_timeout`/`WAL`/
`foreign_keys` pragmas and runs `migrateDatabase` over the catalogued
migrations with sha256 checksums and `DATABASE_COMPATIBILITY_EPOCH`
gating (`src/db/migration-runner.ts`). Incompatible databases fail
closed with `DatabaseCompatibilityError` (restore a compatible
backup — no auto-downgrade). Fresh databases are seeded
(`seedDatabase`) only when zero migrations are recorded.
`openDatabase` (non-migrating open) re-validates compatibility.

Evidence: `bun test src/db/__tests__/` — **46/46 pass** (runner,
migrations, schema validation, transactions, arm-context-defaults).

### API-owned SQLite boundary preserved

- Only `src/api/**` (+ `src/db/**`, tests, tooling fixtures) opens
  SQLite directly. `src/brain/**` runtime has zero direct opens —
  enforced by `src/brain/__tests__/api-boundary.test.ts` (static
  import scan, passing).
- Known exception (unchanged, documented): `src/mcp/**` runtime still
  uses `getDatabase` directly as the ADR-012 migration bridge; must
  move to API-backed access and must not spread to new handlers.

No code changes required.
