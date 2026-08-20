## Context

See `proposal.md` for why.

This is a synthetic FRG pack item (`template_id=clean-openspec`, pack
`pack-1396-tugboat-ship-1.39.6`). It exercises the OpenSpec plan →
implement → archive path. It is not engine-dogfood recovery. No
classifier, recipe, gate, or controller change is in scope.

## Goals / Non-Goals

**Goals:**

- Add one run-scoped JSON fixture and one unit test.
- Keep exactly one active OpenSpec change for issue #1170 until
  pre-merge archives it.

**Non-Goals:**

- Production behavior, FRG driver, ship, merge, or recovery changes.
- A shared (non-run-scoped) fixture path.
- A second OpenSpec change.

## Decisions

### 1. New capability, not a `factory-reliability-gate` delta

**Choice:** New capability `frg-pack-1396-clean-openspec`.

**Why:** The requirement is pack-run-scoped (release `1.39.6` at
`pack-1396-tugboat-ship-1.39.6`). The living FRG spec is driver law,
not a per-pack fixture inventory. FRG closes this PR without merge, so
the archived spec does not land on `main`.

**Why not modify `factory-reliability-gate`:** that would mix a
one-run fixture rule into release-gate requirements.

### 2. Fixture field is `release_version`

**Choice:** JSON object with `release_version: "1.39.6"`. Optional
pack identity fields may be present (`pack_run_id`, `template_id`) but
the spec only requires `release_version`.

**Why:** The sibling `clean-docs` template names the same field. One
field is enough for the unit test to fail when the release string
changes.

### 3. Test reads the run-scoped file; no production seam

**Choice:** A `core/test/*.test.ts` file reads the JSON from
`core/test/fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-openspec.json`
and asserts `release_version === "1.39.6"`. No `core/scripts/` module
loads this fixture.

**Why:** The issue forbids production behavior change. Reading a
repo-local file is the existing pattern for static fixtures. No
network, git, or subprocess calls.

### 4. One change id, archive at pre-merge

**Choice:** Change id `frg-pack-1396-clean-openspec` only. Pre-merge
archives it. The resulting PR has `openspec/changes/archive/` and
`openspec/specs/` files and no active `openspec/changes/<id>/` path.

**Why:** FRG live observation requires archived change + living spec
and rejects a remaining active change path.

## Risks / Trade-offs

- **[Risk]** A second active OpenSpec change from another issue would
  fail FRG observation. → **Mitigation:** this change introduces only
  `frg-pack-1396-clean-openspec`. Implement does not add another.
- **[Risk]** A shared fixture path would collide with other pack runs.
  → **Mitigation:** the path includes `pack-1396-tugboat-ship-1.39.6`.
- **[Trade-off]** The archived living spec is pack-run-specific. That
  is acceptable because FRG closes without merge.

## Migration Plan

No production migration. The fixture and test land on this branch only.
FRG records the run and closes the PR and issue without merge.
