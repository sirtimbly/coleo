# Startup + Shutdown Ordering Verification (2026-09-22)

Task: `phase1co-e7761f`.

## Verdict: VERIFIED

### API boot order (`src/api/server.ts`)

migrations (`initDatabase`, fail-closed) → NATS connect → bridge
projector → orphan cleanup → WS handlers + heartbeat → listen.
Migration failure prevents serving; nothing listens half-initialized.

### Topology order (entrypoint + smoke)

Repo setup → init state → API → web → brain → agent, with trap
cleanup killing children on INT/TERM/EXIT. Proven live by
`bun run smoke:topology` — **10/10 pass**: migrations, Maildir,
JetStream, API health, auth, CLI status, brain publish/read/queue,
WS in-band auth, shutdown (ports closed, temp workspace removed).

### Brain polling + ArmAgent startup

- Brain: `run()` → `poll()` loop with interval sleep; `runOnce` /
  `runCycles` for tests. Poll-order + runtime-flows suites: 14/14.
- ArmAgent: `agent start` owns harness traffic and publishes arm
  lifecycle events via the NATS client; harness manager mirrors the
  same subject contract with truncation and best-effort logging.

### WebSocket registration

`/ws` upgrade with proxy-aware + in-band key auth, heartbeat
cleanup, client backoff reconnect (verified separately).

No code changes required.
