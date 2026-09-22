# Historical human-to-brain classification experiment

See [RESULTS.md](./RESULTS.md) for the completed 59-message comparison.

```sh
# Read mail only and prepare the corpus/review sheet (no inference).
bun run eval:human-history --prepare-only

# Check the three user-labeled development messages.
bun run eval:human-history --labeled-only

# Evaluate all recovered direct messages against three backends.
bun run eval:human-history

# Compare proposed clarification frequency at a different cutoff.
bun run eval:human-history --min-action-probability 0.7

bun test src/scripts/__tests__/historical-classification.test.ts
```

Uses `JEV_API_KEY` and the existing configured brain model/key, loaded through Bun
and Coleo's normal config resolver. `--help` lists output, mail-root, concurrency,
timeout and JEV model options. SDK retries are disabled. Keys are not recorded.

## Corpus

The read-only importer reads `inbox` and `sent`, including `new`, `cur`, and monthly
archives under `.coleo/mail`. It selects messages to `brain@coleo.local` explicitly
marked `human-message`, plus untyped mail from `human@local`/`human@coleo.local`.
It excludes system and arm messages and deduplicates by Message-ID. It never marks
mail seen or modifies the maildir. The initial scan recovered 59 unique messages
from February 5 through September 18, 2026. Deleted mail cannot be reconstructed.

Replies retain their original quoted context. The structured pipelines distinguish
authored text from the UI's quoted-reply delimiter. Exact target candidates are
extracted from that source, not from today's mutable task/bug/arm state. Missing
historical entity context remains unresolved rather than being invented.

Legacy uses the unchanged **MailProcessor component**, not a running Brain or the
full ingress (which can route task-thread replies before classification). The initial
59-message corpus contains no explicit task-thread bypass headers. Historical live
arm status and queue counts are unavailable; the legacy template uses empty/zero
values with an explicit historical-replay note. This is a current-code replay, not
a claim to recreate exactly what the historical deployment decided.

## Comparators

1. `legacy`: original MailProcessor, original prompt and single-action vocabulary.
2. `expanded-current`: configured current model, expanded actions and field contract.
3. `jev`: TypeSafe SDK, same expanded policy and questions as expanded-current.

The richer action vocabulary supports task/bug creation, updates, cancellation and
reprioritization; documentation/plan changes; queries; approval responses; targeted
arm prompts/stops/recovery; brain pause/resume; clarification; and no action.

Routing asks an independent `choice` for each action type: include that action or
`no_action`. This supports multiple different action types without assuming that
independent model questions can coordinate numbered action slots. Repeated requests
of the same type are grouped for review; this experiment does not split them into
multiple executable mutations. An empty action set means no action.

The second request is built from the selected actions and evaluates their relevant
fields. The action selection is explicitly in its state. This experiment measures
both routing latency and complete two-stage latency, so a faster first stage does
not hide a slower field evaluation.

## Complete schema accounting, not fabricated complete payloads

`schema.ts` exhaustively accounts for the API `Task` and `Bug` model keys using
TypeScript `satisfies Record<keyof ..., FieldSpec>`. Relevant control-action request
fields are included too. Read-only/model fields are not all accepted by every API
mutation, and successful classification is not validation of a writable payload.

Each field is categorized as:

- **Choice:** select an enum/boolean value or explicitly mark it not provided/unclear.
- **Evidence:** select a grounded source passage for free text, identifiers, dates,
  numbers, arrays or arbitrary objects. This is an extraction assessment, not a
  final parsed value or a newly generated summary.
- **Derived:** calculate/copy in code, such as provenance or fractional ordering.
- **System:** IDs, timestamps, counters and actual lifecycle/notification state.
- **Unsupported:** an operation outside the offered action set, explicitly reported.

The original mail subject/body are preserved. JEV does not generate new task titles,
descriptions or clarification prose. Evidence anchors for these fields can later
feed deterministic extraction or a separate generator; neither is hidden inside
the reported timings. Missing optional fields are not clarification triggers.

Task priority uses `normal`; bug priority uses `medium`. Cancellation of a bug is
a proposed closure, not proof of resolution. Restart means a recovery proposal;
dispatch strategy is not executed. Permission, state and ownership validation are
outside this offline evaluation.

## Labels and clarification tuning

Three explicit user labels are in `history.ts`. They are **development examples**:
their policy implications informed the questions. Do not report these as held-out
accuracy. All other historical messages remain unlabeled. Model agreement or a
historical task created by Coleo is not ground truth.

The user specified: separate a feature and an incidental bug; lower/reorder a task
without answering the approval embedded in its subject; and interpret the arm
status question plus prompt request as only an arm prompt.

The report separates action correctness from labeled field correctness. A proposed
clarification is driven by essential ambiguity, unresolved required targets, an
explicit clarification classification, or selected action/target probabilities
below the configured cutoff. The default 0.8 is provisional, not fitted to the
three examples. The threshold table is descriptive. User-rated necessary versus
annoying follow-ups and a held-out labeled set are required before tuning it.
The threshold only checks selected actions/targets: it cannot reliably catch an
omitted action. The report also compares latency on matching action sets, since
no-action decisions skip the second request and otherwise make a model look faster.

The source-only target candidate builder currently recognizes task/bug/approval
identifiers and simple arm-name mentions. It does not resolve named tasks against
historical database snapshots, nor enumerate document/plan paths as target choices.
Those limitations can create follow-ups even when a human could infer a target;
review them separately from model uncertainty before changing a threshold.

## Artifacts and privacy

Each run writes to an ignored `test-results/human-history/<timestamp>/` directory:

- `inputs.json`: corpus, human labels, full policy/schema coverage, model config
  without keys, and a fingerprint saved before inference.
- `review-labels.json`: authored message text and empty labels for future review.
- `requests.jsonl`: exact expanded questions/state for each stage.
- `results.jsonl` and `results.json`: outcomes, probabilities, fields, successful
  provider responses/usage, timings and errors.
- `report.md`: labeled development scores, latency, proposed follow-up rates,
  threshold sweep and unlabeled disagreements.

These files contain real private message text and remain local/ignored. Running the
evaluation sends the selected message content to the configured current provider
and TypeSafe. It never starts Brain, creates tasks/bugs, sends mail, prompts arms,
changes permissions, or performs any proposed action. Exit status 2 flags inference
errors or fallback behavior; status 1 indicates a runner failure.

TypeSafe reference: https://docs.typesafe.ai/primitives
