---
title: Harness Contract
description: Learn how a stable adapter contract lets Coleo coordinate different command-line agent runtimes.
banner:
  src: /coleo-architecture-harness-contract.png
  alt: An orange octopus demonstrates a standard glowing coupling that lets several different agent craft connect through interchangeable brass adapters.
  eyebrow: Adapter Workshop
  position: center 49%
---

# Harness Contract

Coleo is the self-hosted control plane for coding agents: run on your hardware, plug in any CLI agent, and coordinate long-running work with full local visibility.

The harness contract defines the integration boundary between the Brain and each agent adapter.

## What This Contract Defines

The contract is split across two layers:

1. Runtime harness interface in `src/harness/types.ts` (`AgentHarness`, `HarnessCapabilities`, lifecycle and control methods)
2. Brain and event contract in `src/harness/contracts.ts` (`HarnessReportedState`, `ArmEventType`, `HarnessCapabilityContract`, and test scenario types)

In practical terms, a harness must:

- Spawn and kill agent sessions
- Accept prompts and report when it returns to idle
- Report state transitions (`initializing`, `idle`, `processing`, `executing`, `waiting_approval`, `error`, `dead`)
- Emit lifecycle, status, and task/session events that the Brain can observe
- Declare capabilities so the Brain knows what features are safe to use

## Current Status

Registered harnesses in `src/harness/registry.ts`:

- `opencode`
- `opencode-api`
- `opencode-tui`

The type system already leaves room for additional harness types, and the extension point is the registry plus the shared contract.

## Why This Matters

This contract is how Coleo stays model-vendor portable over time:

- Your plans and prompt strategy stay in Coleo
- Harnesses become adapters, not architecture lock-in
- New CLI agents can be added incrementally without rewriting the Brain

## Harness Test Coverage (Today)

Harness coverage exists now, with unit-level confidence and scenario scaffolding:

- `src/harness/__tests__/opencode-tui.test.ts`
- `src/harness/__tests__/event-stream.test.ts`
- `src/harness/__tests__/model-resolver.test.ts`
- `src/harness/__tests__/scenarios.ts`

Notes:

- Integration/scenario execution scaffolding is present, but some end-to-end harness scenario runs are currently disabled in `src/harness/__tests__/opencode-tui.test.ts` pending test-framework wiring.
- This means core behavior is tested today, while full conformance automation is still being tightened.

## Build A New Harness (Checklist)

1. Implement `AgentHarness` in `src/harness/types.ts`
2. Define capability + transition declaration in `src/harness/contracts.ts`
3. Register the harness in `src/harness/registry.ts`
4. Cover event mapping and lifecycle behavior in `src/harness/__tests__/`
5. Verify spawn/prompt/idle/interrupt behavior against the shared scenario expectations

## Related Docs

- [Architecture Overview](/architecture/overview)
- [Harnesses](/architecture/harnesses)
- [CLI Guide](/guides/cli)
