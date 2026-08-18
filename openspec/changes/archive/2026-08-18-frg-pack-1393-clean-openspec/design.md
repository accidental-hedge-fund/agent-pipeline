## Context

See `proposal.md` for why. Pack `pack-1393-goal-ship-1.39.3` is a synthetic
Factory Reliability Gate (FRG) item (`template_id=clean-openspec`). It
exercises propose, implement, archive, and ready-to-deploy.

`core/test/fixtures/frg/` does not exist yet. No production module reads
that path.

**Class vs site:** the site is issue #1122. The class is one clean OpenSpec
path with a run-scoped fixture. This is not an engine recover. Shared
classifier, recipe, gate, and controller law do not change. The next
identical pack run uses the same template with a new `pack_run_id`. It does
not need a new mole issue.

## Goals / Non-Goals

**Goals:**

- Keep the fixture and test on the pack-run path only.
- Use one dedicated capability so archive does not edit Factory Reliability
  Gate law.
- Keep the implement step to fixture plus unit test.

**Non-Goals:**

- Production behavior change.
- Shared FRG scoring, classifier, recipe, or controller edits.
- Merge in advance or loop.
- Reuse of this fixture by a later pack run.

## Decisions

### 1. New capability, not a factory-reliability-gate delta

**Choice:** Add `frg-pack-1393-clean-openspec`. Do not add a pack-run
requirement to `factory-reliability-gate`.

**Why:** the requirement is pack-run specific (`1.39.3` /
`pack-1393-goal-ship-1.39.3`). Factory Reliability Gate law stays general.

**Why not skip specs:** the issue requires one OpenSpec requirement that
the fixture names release `1.39.3`.

### 2. Fixture is a committed JSON object with `release_version`

**Choice:** Write
`core/test/fixtures/frg/pack-1393-goal-ship-1.39.3/clean-openspec.json`
as JSON. The required field is `"release_version": "1.39.3"`. Optional
identity fields (`pack_run_id`, `template_id`) MAY be present. Production
code SHALL NOT import this file.

**Why not a TypeScript constant:** the issue names a JSON fixture path.

**Why not a shared `fixtures/frg/clean-openspec.json`:** acceptance forbids
a path that is not run-scoped.

### 3. One colocated unit test reads the fixture from disk

**Choice:** Add `core/test/frg-pack-1393-clean-openspec.test.ts`. The test
reads the run-scoped file with `node:fs` / `node:path` relative to the
test file. It asserts `release_version === "1.39.3"`. No network, git, or
subprocess calls.

**Why not inject a fake `readFile`:** the artifact under test is the
committed file. A fake would not catch a missing or wrong fixture.

**Why not edit an existing FRG test:** those files cover driver and
observation law. This pack item stays isolated.

## Risks / Trade-offs

- [Archive adds a pack-run living spec] → Accept. The FRG clean-OpenSpec
  path requires an archived change and a living spec. The spec is narrow.
- [A later pack copies the same fixture path] → Each pack run uses its own
  `pack_run_id` directory. Do not reuse this path.
- [Implementer edits production modules] → Tasks and this design forbid it.
  Review treats a production-behavior diff as out of scope.

## Migration Plan

- Implement on this issue branch only.
- Pre-merge archives `frg-pack-1393-clean-openspec` into
  `openspec/specs/frg-pack-1393-clean-openspec/`.
- No rollback of production behavior. The fixture and test are additive.
