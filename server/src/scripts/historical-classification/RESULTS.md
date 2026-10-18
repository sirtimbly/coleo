# Historical message bake-off — September 18, 2026

**JEV was faster, but this experiment does not establish better classification.**
It correctly resolved the arm prompt and task reprioritization examples, but missed
the separate bug in the combined feature-and-bug message. The current model using
the expanded contract matched all three user labels in the final run.

Recovered 59 unique direct human-to-brain messages, including replies, from local
mail dated February 5 through September 18, 2026. Three messages have user-confirmed
development labels; 56 remain unlabeled. These are not held-out accuracy results.

## Final comparison

All 177 message/backend evaluations succeeded without fallback or response-format
errors. Two-stage pipelines produced 269 total HTTP requests across the three
backends. No proposed action was executed and production classifiers were unchanged.

| Backend | Matches on 3 development labels | End-to-end p50 | End-to-end p95 | Proposed follow-ups |
|---|---:|---:|---:|---:|
| Current MailProcessor | 1/3 | 1,384 ms | 2,151 ms | 1/59 |
| Current model, expanded contract | 3/3 | 5,547 ms | 11,532 ms | 4/59 |
| JEV, expanded contract | 2/3 | 411 ms | 683 ms | 17/59 |

Action and explicitly labeled field scores were identical. The labels cover:

- **Arm reply:** only `prompt_arm`, with target `default`. All three matched.
- **Approval-thread reply:** `reprioritize_task`, priority `low`, queue position
  `bottom`, target `refactor-1771210128869-kwfm`. Both expanded classifiers matched;
  legacy incorrectly selected an approval response.
- **Feature plus bug:** `new_task` and `bug_report`. Expanded-current matched;
  legacy and JEV returned only `new_task`.

The legacy action vocabulary cannot express every expected outcome. The
expanded-current comparator separates gains from the richer vocabulary/policy
from gains attributable to JEV itself.

JEV's median was approximately 3.4x faster than the current workflow and 13.5x
faster than the expanded current-model workflow. On the 37 messages where both
expanded pipelines chose identical action sets, their medians were 416 ms for JEV
and 5,106 ms for expanded-current: approximately 12.3x faster. Matching action sets
do not establish matching field quality or correctness.

JEV selected no action on 20/59 messages; expanded-current did so on 6/59. Such
decisions skip the detail request, so aggregate timing also reflects different
work performed. There were 39 JEV and 53 expanded-current two-stage evaluations.
This is one final pass at three concurrent message groups, not a load benchmark.

## Follow-up burden

The default minimum probability is 0.8 for selected actions and required targets.
Missing optional schema fields never trigger follow-ups.

| Threshold | JEV proposed follow-ups |
|---|---:|
| 0, essential ambiguity/unresolved targets only | 7/59 (11.9%) |
| 0.6 | 10/59 (16.9%) |
| 0.7 | 12/59 (20.3%) |
| 0.8, default | 17/59 (28.8%) |
| 0.9 | 23/59 (39.0%) |

These are descriptive proposals, not user-rated annoyance or calibrated risk.
The threshold did not catch the missing bug at 0.8: it checks selected actions,
not whether another action was omitted. Lowering it cannot repair missed actions.
Some unresolved targets also reflect limited source-only candidate extraction,
not an ambiguous user request. Do not tune it solely against these three labels.

## What the two passes evaluate

1. Independent include/omit `choice` questions select each action type, allowing
   combinations without coordinating numbered slots across independent questions.
2. Questions for the selected actions assess all relevant model fields. Task and
   bug model coverage is checked against their actual TypeScript interfaces.

Enums and booleans become choices. Free text, numbers, dates, arrays and objects
select source evidence; they are not finished generated titles, descriptions or
parsed API payloads. System-owned fields remain system-owned. Ordering and source
provenance remain deterministic. Multiple requests of the same type are grouped
for review, not split into separate executable mutations.

Historical arm inventories and task/bug snapshots were unavailable. The replay
uses the original message, quoted context and literal target candidates; it does
not inject today's mutable database state into old messages. Legacy uses its
original prompt with empty arms/zero pending tasks and an explicit replay note.
This tests the MailProcessor component, not every Brain ingress shortcut.

## Preserved development runs

- `2026-09-19T00-31-01-594Z`: three-label calibration using numbered action slots.
  JEV repeated actions. Replaced slots with independent include/omit questions.
- `2026-09-19T00-34-07-229Z`: revised three-label calibration. JEV matched 2/3;
  expanded-current matched 3/3. JEV still missed the incidental bug.
- `2026-09-19T00-37-41-458Z`: first full replay. Expanded-current had six invalid
  choice responses; some returned option descriptions instead of keys. All errors
  were retained. Clarified its output-format instruction before the final run;
  no action policy or JEV questions changed between full replays.
- `2026-09-19T00-40-09-409Z`: final full replay reported above, no errors.

The two full passes also differed on some decisions. Neither model's outputs nor
follow-up counts should be assumed stable from a single evaluation.

## Reproducibility and next experiment

- Current configured/served model: `gpt-5.6-luna`.
- JEV requested: `jev-latest`; served: `jev-1.13.0`; SDK `0.6.0`, retries disabled.
- Final corpus/config fingerprint:
  `c721022c962069d3f774ebea9c9e1a8378d6de921803bb200cdb5a8455a610dd`.
- Local ignored run directory: `test-results/human-history/2026-09-19T00-40-09-409Z/`.
  Contains inputs, exact expanded requests, responses/usage, timing, review labels
  and the per-message report. Raw messages remain outside tracked documentation.
- Reported input/output tokens: legacy 41,019 / 7,276; expanded-current
  719,320 / 49,684; JEV 736,299 / 95,991. These are provider-reported counts,
  not comparable billed-dollar estimates; this experiment does not prove cheaper.
- Validation: `bun run typecheck`; 16 focused tests passed across both experiment
  test files; `git diff --check` passed.

Next, label a blind sample of the 22 expanded-classifier disagreements, especially
JEV no-action decisions and combined requests, plus an agreement sample. Label
which proposed follow-ups are necessary. Reserve an untouched test set before
changing prompts or fitting the threshold. Expand target retrieval separately
and score field extraction with explicit labels before considering integration.

```sh
bun run eval:human-history --prepare-only
bun run eval:human-history --labeled-only
bun run eval:human-history
```

See [README.md](./README.md) for scope, field semantics and runner options.
