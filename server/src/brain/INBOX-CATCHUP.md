# Inbox catch-up

The production route uses `planCatalogueCatchup`. Analysis is read-only; Apply
requires explicit archive/retain dispositions and revalidates source and fact
fingerprints before moving mail.

## Bounded calls, unlimited mailbox count

Defaults live in `inbox-catchup-batching.ts`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `COLEO_INBOX_CATCHUP_BATCH_MESSAGES` | 64 | Maximum message parts per discovery call (1–256) |
| `COLEO_INBOX_CATCHUP_CONCURRENCY` | 4 | Concurrent discovery or message-evaluation jobs (1–8) |
| Input payload | 100,000 UTF-8 bytes | Discovery, thread comparison and summary batches; prompts have additional headroom |
| Message part | 12,000 serialized UTF-8 bytes | Long bodies are split without removing any text |
| Thread comparison page | 24 candidates | Bounded cross-batch duplicate reconciliation |

Discovery receives every message part and batch-relevant authoritative facts.
Identical cross-batch proposals collapse in code; semantic duplicate proposals
are compared in bounded pages. All distinct criteria variants remain available
to JEV, while final operator actions use their canonical thread identity.
There is no global message or thread count cap. Many genuinely distinct thread
candidates increase pairwise reconciliation work.

JEV question packets are bounded separately. Large catalogues are routed first,
then checked for uncovered issues against relevant scopes. A message evaluated
in several parts always remains unarchived: partial context cannot authorize
full-message closure. Oversized metadata is retained for manual review.
Large action summaries use bounded evidence notes over every original part,
then reduce those notes as needed; original source links remain complete.

Subjects containing `infrastructure health issues detected` (case insensitive)
use the stable `coleo:infrastructure-health` thread in the mail projection.
Catch-up excludes those messages from both models, combines them into one
health-review action, and archives their unread originals only on Apply. This
grouping does not assert that a historical failure is still occurring or fixed.

Progress reports discovery and reconciliation batch counts. Private job
diagnostics record actual model calls and discovery batches. Tests use isolated
mailboxes; analysis alone never changes live mail.
