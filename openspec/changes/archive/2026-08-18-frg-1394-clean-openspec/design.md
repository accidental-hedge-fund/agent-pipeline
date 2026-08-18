## Context

See `proposal.md` for motivation.

`core/test/fixtures/frg/` may already hold sibling pack fixtures (for
example `clean-docs` under the same `pack_run_id`). The `clean-openspec`
pack template (`core/scripts/frg-packs/factory-gate-v1/templates/clean-openspec.md`)
already names the fixture path
`core/test/fixtures/frg/{{pack_run_id}}/clean-openspec.json` and the
assertion on `release_version`. This instance substitutes
`pack-1394-tugboat-ship-1.39.4` and `1.39.4`.

The repo's unit-test convention still applies: no real network, git,
or subprocess as the pass path. Reading a committed fixture file is
allowed.

This pack item also exercises the OpenSpec propose → archive path.
Pre-merge archives this change into living specs. That is existing
pipeline behavior, not new production code in this change.

## Goals / Non-Goals

**Goals:**

- Add one JSON fixture at the exact run-scoped path.
- Add one unit test that reads that file and asserts `release_version`.
- Keep the OpenSpec change scoped to this synthetic issue only.
- Keep the implementation test-only.

**Non-Goals:**

- Changing `factory-reliability-gate` living requirements.
- Changing classifier, recipe, gate, or controller law.
- Shared fixture loaders or a multi-pack fixture schema.
- Production docs, CHANGELOG, or pipeline stage edits.

## Decisions

### 1. New capability, not a factory-reliability-gate delta

**Choice:** Spec this instance as `frg-1394-clean-openspec`.

**Why:** The living FRG spec already owns the pack template. This
issue is one run-scoped fixture plus its OpenSpec path exercise. A
delta on `factory-reliability-gate` would bake
`pack-1394-tugboat-ship-1.39.4` into pack law.

**Alternative considered:** Modify `factory-reliability-gate`.
Rejected because the next pack run uses a new `pack_run_id`.

### 2. Committed JSON at the template path; test reads that file

**Choice:** Write
`core/test/fixtures/frg/pack-1394-tugboat-ship-1.39.4/clean-openspec.json`
with at least `{ "release_version": "1.39.4" }`. Add a `core/test/`
unit test that reads that path and asserts the field.

**Why:** The pack template names that path. The acceptance criterion
requires a unit test that verifies the release value. That is true
only if the test reads the fixture.

**Alternative considered:** Hard-code `1.39.4` in the test and skip
the file. Rejected because a fixture edit would not fail the test.

**Alternative considered:** A production helper that loads FRG
fixtures. Rejected because production behavior must not change.

### 3. No extra required fixture fields

**Choice:** Require only `release_version`. Extra keys are allowed
and unused.

**Why:** The issue names one field. A larger schema is not needed
for a synthetic clean path.

### 4. One active change only

**Choice:** Author exactly one OpenSpec change
(`frg-1394-clean-openspec`) for issue #1137.

**Why:** Acceptance requires the active change to belong only to this
synthetic issue, and pre-merge must leave no foreign active change.

## Risks / Trade-offs

- [Risk] Implementer edits production docs or FRG scoring to "help"
  the pack. → Mitigation: tasks and spec forbid production behavior
  change. Review treats those edits as out of scope.
- [Risk] Fixture lands under a shared `fixtures/frg/clean-openspec.json`
  path. → Mitigation: spec requires the `pack-1394-tugboat-ship-1.39.4`
  directory segment.
- [Risk] Test asserts a literal without reading the file. →
  Mitigation: spec requires the test to read the run-scoped fixture.
- [Risk] A second active OpenSpec change is left open. → Mitigation:
  proposal and tasks require a single change for this issue; pre-merge
  archives it.

## Migration Plan

Additive test-only change plus OpenSpec archive at pre-merge. No
deploy or rollback steps.
