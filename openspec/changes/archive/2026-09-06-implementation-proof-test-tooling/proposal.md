## Why

Implementing-stage recovery rejects exact candidate commits when their only material changes are tests, fixtures, examples, or executable repository tooling. That makes legitimate CI and tooling fixes look like incomplete planning work and can re-invoke an implementer against stale state, as happened during #1470 recovery.

## What Changes

- Treat candidate-bound code artifacts under test, fixture, example, script, tool, and mock paths as implementation-role evidence.
- Preserve the fail-closed distinction for OpenSpec, documentation, workflow-only, empty, and unknown non-code configuration candidates.
- Add regression coverage for test-only and tooling-only implementation candidates.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `implementing-resume`: Define which exact candidate artifact paths can satisfy implementation-role proof during interrupted-stage recovery.

## Impact

Affected code is the shared implement-deliverable path classifier in `core/scripts/unpublished-stage-commit.ts` and its unit coverage. The change affects implementing-stage resume and unpublished-stage publication decisions; it does not weaken candidate-SHA binding, planning-only rejection, ownership reconciliation, or required gates.
