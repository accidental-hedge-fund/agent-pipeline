## Context

See `proposal.md` for motivation.

`core/test/fixtures/frg/` does not exist yet. The `clean-docs` pack
template (`core/scripts/frg-packs/factory-gate-v1/templates/clean-docs.md`)
already names the fixture path
`core/test/fixtures/frg/{{pack_run_id}}/clean-docs.json` and the
assertion on `release_version`. This instance substitutes
`pack-1393-goal-ship-1.39.3` and `1.39.3`.

The repo's unit-test convention still applies: no real network, git,
or subprocess as the pass path. Reading a committed fixture file is
allowed.

## Goals / Non-Goals

**Goals:**

- Add one JSON fixture at the exact run-scoped path.
- Add one unit test that reads that file and asserts `release_version`.
- Keep the implementation test-only.

**Non-Goals:**

- Changing `factory-reliability-gate` living requirements.
- Changing classifier, recipe, gate, or controller law.
- Shared fixture loaders or a multi-pack fixture schema.
- Production docs, CHANGELOG, or pipeline stage edits.

## Decisions

### 1. New capability, not a factory-reliability-gate delta

**Choice:** Spec this instance as `frg-1393-clean-docs`.

**Why:** The living FRG spec already owns the pack template. This
issue is one run-scoped fixture. A delta on `factory-reliability-gate`
would bake `pack-1393-goal-ship-1.39.3` into pack law.

**Alternative considered:** Modify `factory-reliability-gate`.
Rejected because the next pack run uses a new `pack_run_id`.

### 2. Committed JSON at the template path; test reads that file

**Choice:** Write
`core/test/fixtures/frg/pack-1393-goal-ship-1.39.3/clean-docs.json`
with at least `{ "release_version": "1.39.3" }`. Add a `core/test/`
unit test that reads that path and asserts the field.

**Why:** The pack template names that path. The acceptance criterion
is "the test fails if the fixture version changes." That is true only
if the test reads the fixture.

**Alternative considered:** Hard-code `1.39.3` in the test and skip
the file. Rejected because a fixture edit would not fail the test.

**Alternative considered:** A production helper that loads FRG
fixtures. Rejected because production behavior must not change.

### 3. No extra required fixture fields

**Choice:** Require only `release_version`. Extra keys are allowed
and unused.

**Why:** The issue names one field. A larger schema is not needed
for a synthetic clean path.

## Risks / Trade-offs

- [Risk] Implementer edits production docs or FRG scoring to "help"
  the pack. → Mitigation: tasks and spec forbid production behavior
  change. Review treats those edits as out of scope.
- [Risk] Fixture lands under a shared `fixtures/frg/clean-docs.json`
  path. → Mitigation: spec requires the `pack-1393-goal-ship-1.39.3`
  directory segment.
- [Risk] Test asserts a literal without reading the file. →
  Mitigation: spec requires the test to read the run-scoped fixture.

## Migration Plan

Additive test-only change. No deploy or rollback steps.
