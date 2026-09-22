# Brain classification bake-off

This offline experiment compares the **unmodified** `ArmOutputProcessor` and
`MailProcessor` against JEV via `@typesafe-ai/sdk`. It does not start a Brain,
connect to NATS, read live messages, create tasks, send mail, or change production
classification. Only synthetic fixture messages and their rendered classifier
prompts are sent to the two configured inference providers.

```sh
# Bun loads .env. Set JEV_API_KEY plus the existing brain/OpenAI credentials there.
bun run bakeoff:classification

# Connectivity smoke test: one case from each channel, once.
bun run bakeoff:classification --limit 1 --repeats 1

# Optional explicit current-model override; otherwise use the normal brain config.
bun run bakeoff:classification --current-model MODEL_ID --repeats 3

bun test src/scripts/__tests__/classification-bakeoff.test.ts
```

See `--help` for concurrency, timeout, model, and output options. Defaults are two
repetitions, three concurrent pairs (up to six requests), and a 60-second request
deadline. JEV retries are disabled so failures remain visible. Both providers are
called together for each pair. The runner's current-provider fetch instrumentation
is confined to this standalone process and restored when the run ends.

The baseline resolves `loadConfig(cwd).brain` with `resolveBrainModelConfig`, just
like Brain initialization. Missing credentials fail before inference. A processor
fallback is identified separately and makes the run exit with status 2; never
interpret fallback timing as model latency. Status 1 indicates a runner failure.

## Corpus and scoring

`fixtures.ts` contains 20 arm-output cases and 24 human-to-brain cases, labeled
before model calls. These are author-labeled synthetic challenge cases, **not a
production sample or independently adjudicated benchmark**. Review the labels
before drawing adoption conclusions. Repeated runs measure stability; they do not
increase the number of independent examples. No per-case prompt tuning occurs.

Both classifiers receive the same message, task/arm context, and unchanged
production policy template. JEV replaces the JSON-generation instruction with
typed questions. The human choice vocabulary follows the seven actions in the
current mail template; the legacy `arm_instruction` TypeScript member is not
advertised by that prompt and has no fixture. Unknown baseline labels fail scoring.

Primary scoring measures the action/intent label. Exact scoring also checks the
follow-up flag for `no_action`, approval polarity, or task ID where a fixture has
that expectation. No automatic action is taken, even for approvals or completion.
Generated descriptions, follow-up prose quality, arbitrary extraction, and lifecycle
safety are outside the experiment. The baseline generates those extra fields;
JEV does not, so timing is an actual-workflow comparison, not equal-output inference.

## Results

Each timestamped directory under ignored `test-results/classification-bakeoff/`
contains:

- `inputs.json`: labels, exact prompts/queries, configuration without keys, and a
  SHA-256 fingerprint written **before inference**.
- `attempts.jsonl`: incremental predictions, successful raw responses, model IDs,
  token usage, elapsed time, status, and fallback/error information.
- `results.json`: aggregate machine-readable run data.
- `report.md`: accuracy, latency, fallback/error counts, mismatches, confusion
  counts, and repeat stability.

Keys and request headers are never recorded. Outputs remain local and ignored.
Existing output directories with inputs are not overwritten. Token usage is
recorded as reported by each provider; this is not a billed-dollar estimate.

JEV confidence is retained for inspection but never used to tune thresholds on this
small set. Model aliases may change; served IDs are captured when providers supply
them. Add a separately labeled holdout set before tuning or making deployment claims.

API reference: https://docs.typesafe.ai/api
SDK reference: https://docs.typesafe.ai/sdk/javascript
