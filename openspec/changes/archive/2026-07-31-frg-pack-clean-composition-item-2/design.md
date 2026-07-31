## Context

FRG Layer B for release **1.29.1** runs a fixed multi-item factory-gate pack. Scenario
`clean-item-throughput` requires at least **K = 2** pack items to reach
`pipeline:ready-to-deploy` without an engine-class block (see
`docs/factory-reliability-gate-runbook.md`). Issue **#750** is synthetic pack
composition item 2: intentionally minimal so the pack can score multi-item clean
ready outcomes without product feature risk.

This design is deliberately small. The only lasting repo artifact is a provenance
note; the main deliverable for the gate is the ready-to-deploy outcome itself.

## Goals / Non-Goals

**Goals:**

- Leave a checked-in, human-readable provenance marker that names this item as
  FRG pack clean composition item 2 for v1.29.1.
- Keep the implementation diff docs/comment-only so review and CI stay low-risk.
- Complete the OpenSpec change lifecycle (validate → implement → archive at
  pre-merge) without engine-class failure.

**Non-Goals:**

- Any product feature, behavior change, or API surface.
- Changes to FRG scoring, driver CLI, thresholds, or evidence schema.
- Expanding the factory-gate scenario inventory or release packaging.
- Auto-merge or tag creation.

## Decisions

1. **Docs/README one-liner over code or config**
   - **Choice:** Prefer a short note in `docs/factory-reliability-gate-runbook.md`
     (e.g. a "Pack provenance" / composition-item line) or a single README line
     referencing issue #750 / v1.29.1 pack item 2.
   - **Why:** Issue acceptance criteria require docs or comment-only; FRG runbook
     already owns pack inventory and thresholds, so provenance fits there first.
   - **Alternative considered:** Empty commit / no file change — rejected because
     the pack item must leave observable, reviewable provenance in the PR diff.

2. **ADDED requirement under existing `factory-reliability-gate` (not a new capability)**
   - **Choice:** Spec delta adds a narrow provenance requirement; no new
     `openspec/specs/<capability>/` capability.
   - **Why:** Behavior belongs to FRG pack hygiene, not a standalone product area;
     avoids capability sprawl for synthetic pack items.
   - **Alternative considered:** No OpenSpec at all — issue allows "not required,"
     but an active change keeps the planning path consistent with other pack
     members and still archives cleanly.

3. **No engine or test code for the note itself**
   - **Choice:** No unit tests for the one-line note beyond existing `npm run ci`
     (docs freshness / openspec validate as applicable).
   - **Why:** There is no runtime logic; over-testing a provenance string is noise
     for a synthetic throughput item.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| OpenSpec multi-change stacking honesty (`empty-depends-on-stack-honesty`) if pack items stack unrelated active changes | Keep this change self-contained and archive at pre-merge; do not leave foreign active changes in the worktree. |
| Scope creep into FRG driver/scoring "while we're here" | Hard non-goals; surgical-fix and issue AC forbid product/FRG scoring edits. |
| Docs generator freshness if README/docs are generated | Prefer editing the FRG runbook (checked-in operator doc) unless a README one-liner is clearly non-generated; run `npm run ci` including docs:check. |

## Migration Plan

N/A — additive docs note only. Rollback is deleting the provenance line and
closing/superseding the PR.

## Open Questions

None — synthetic pack item; scope fixed by issue #750.
