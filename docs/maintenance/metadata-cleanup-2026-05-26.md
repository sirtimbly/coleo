# Metadata cleanup & alignment report (2026-05-26)

## Discoveries reviewed

- `disc-1770386637408-1bri` – Clarified the Git worktree isolation plan by recording the current phase and next deliverable; the .project plan file now documents the status.
- `disc-1770386673018-ngo8` – Added guidance to `.project/plan.md` that task determination treats `.project/plan.md` and explicitly referenced plan fragments as the canonical sources.
- `disc-1770846889520-pvaq` & `disc-1770846889521-sh3p` – Documented which Phase 2.8 (Status History Search) deliverables are tracked via existing backlog tasks so readers know how to continue the work.

Handling comments were added to each discovery record (status set to `resolved` or `acknowledged`) so subsequent runs know they have been covered.

## Plan updates

- `git-worktree-isolation.md` gained a "Current Status" section that outlines which phases remain unimplemented and points to the backlog items that are tracking Phase 1 & 2 work.
- `plan.md` now explains the canonical scope for Phase 2.1 and spells out which tasks own the Phase 2.8 deliverables; these changes should make the Brain’s plan references and future maintenance runs easier to interpret.

## Docs alignment

- This report documents the maintenance pass itself for the "docs" slice, providing visibility into which discoveries were handled and where the status notes live.

## Next steps

1. Continue tracking the Git worktree plan by completing the Phase 1 migration/service work before moving on to Phase 2 tools.
2. Keep the Phase 2.8 architecture deliverables tied to the referenced status-history tasks so future maintenance passes can mark them complete with confidence.
