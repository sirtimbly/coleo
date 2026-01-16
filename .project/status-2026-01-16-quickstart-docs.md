# Status Report: Quickstart & Adoption Docs

**Date:** 2026-01-16

## Summary

Documented two primary onboarding paths for Octopai:
- Partially adopting Octopai into an existing repository.
- Starting a brand new project with Octopai as the coordination layer from day one.

Also clarified the recommended git workflow when multiple general-purpose arms share a single working tree, using a shared `octopai` branch by default.

## Changes Planned

- `docs/index.md`
  - Add a short “Why Octopai is easy to start with” pitch on the front page, highlighting that you can:
    - Point Octopai at an existing repository (partial adoption).
    - Or start a new project with Octopai from the first commit.

- `docs/guides/getting-started.md`
  - Add two concrete flows:
    - Quickstart: Existing Codebase.
    - Quickstart: New Project (Greenfield).
  - Use `octopai` as the suggested shared branch name instead of `gpt`.
  - Emphasize the simple, single-branch, shared-working-tree model.

- `docs/architecture/overview.md`
  - Add a design principle about the linear, shared git workflow:
    - Multiple arms share a single `octopai` branch and working tree.
    - We prefer a mostly linear history over heavy branching.

This status entry records the intent; the actual file edits follow this note and should be kept in sync as the CLI and arm behaviors evolve.