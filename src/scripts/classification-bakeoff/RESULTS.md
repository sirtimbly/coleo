# Initial bake-off: September 18, 2026 (America/New_York)

44 synthetic cases, two repetitions per provider: **176 successful inference calls**.
No API errors or processor fallbacks. Labels and queries were frozen before inference.

- Current configured/served model: `gpt-5.6-luna`.
- JEV requested: `jev-latest`; served: `jev-1.13.0`.
- TypeSafe SDK: `0.6.0`; retries disabled; three concurrent pairs.
- Corpus/query SHA-256: `2afb062c069a5ff33ef9d57e997dfe0b6ecb42f06221b1ec58f56e8cf7057b3f`.
- Raw run: `test-results/classification-bakeoff/2026-09-19T00-03-18-696Z/` (local, ignored).

| Channel | Current correct | JEV correct | Current p50 / p95 | JEV p50 / p95 |
|---|---:|---:|---:|---:|
| Arm output | 40/40 | 36/40 | 1604 / 2309 ms | 204 / 663 ms |
| Human to brain | 48/48 | 48/48 | 988 / 1496 ms | 193 / 227 ms |

Exact scored auxiliary fields produced the same totals. These include no-action
follow-up flags, approval polarity, and existing update-task targets where specified.
Neither provider changed its scored decisions across the two repetitions.

## What failed

JEV made two false-positive arm-action decisions in both repetitions:

- “The implementation is complete and tests passed. I already called complete_task.”
  became `update_task`, with target `none`, instead of `no_action`.
- “I logged bug bug-91 using the reporting tool. Continuing the current task now.”
  became `log_bug` instead of `no_action`.

The current classifier correctly recognized both as reports of already performed
actions. JEV's primary confidence on these failures was 0.53–0.68. No threshold was
tuned on these results; selecting one now would require a separate holdout set.

## Interpretation

Human-message classification is the stronger candidate for a subsequent shadow
trial: matching accuracy here and approximately 5.1x lower median latency. Arm
classification was approximately 7.9x faster at the median but regressed on
completed-action narration. Keep its current classifier pending another experiment
with explicit action-already-performed evaluation and unseen examples.

This small author-labeled challenge set is not a production accuracy estimate.
There are 20 distinct arm examples and 24 human examples, not 88 independent ones.
Current processors also generate prose and other fields; JEV only classifies, so
these timings compare the actual tested workflows rather than identical outputs.
Human classification success does not establish parity for generated task bodies,
direct-message content, or arbitrary identifier extraction.

Reported usage across the full run: current 52,348 input / 8,663 output tokens;
JEV 186,942 input / 10,940 output tokens. JEV questions repeat the full production
policy to preserve context. These counts are not billed-dollar estimates.

The experiment made no production classifier changes or live message/task actions.
